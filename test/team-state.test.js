import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { addTeamWorker, claimTeamTask, completeClaimedTask, createTeamTask, enqueueMailboxMessage, initTeamState, listTeamTasks, readMailbox, readTeamState, reclaimExpiredTask, removeTeamWorker, renewTaskClaim, sanitizeTeamName, updateMailboxMessage, updateTaskState, updateWorkerState } from '../src/team/state.js';

test('persists team and worker state under the Git common directory', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-state-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'executor', assignment: 'task', requires_commit: true };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    updateWorkerState(stateDir, 'worker-1', { status: 'working' });
    updateTaskState(stateDir, '1', { status: 'in_progress' });
    const state = readTeamState(cwd, 'demo');
    assert.equal(state.config.leader_session_id, 'leader-id');
    assert.equal(state.workers[0].status, 'working');
    assert.equal(state.tasks[0].status, 'in_progress');
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')).schema_version, 1);
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'tasks', 'task-1.json'), 'utf8')).status, 'in_progress');
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'tasks', 'task-1.json'), 'utf8')).requires_commit, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('sanitizes team names and rejects empty names', () => {
  assert.equal(sanitizeTeamName('Feature / Auth'), 'feature-auth');
  assert.equal(sanitizeTeamName('../Feature Auth'), 'feature-auth');
  assert.throws(() => sanitizeTeamName('***'), /letter or number/);
});

test('stores mailbox messages as durable independently updated records', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-mailbox-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'task', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const first = enqueueMailboxMessage(stateDir, 'worker-1', 'first');
    const second = enqueueMailboxMessage(stateDir, 'worker-1', 'second');
    updateMailboxMessage(stateDir, 'worker-1', first.id, { status: 'completed' });
    const mailbox = readMailbox(stateDir, 'worker-1');
    assert.equal(mailbox.messages.length, 2);
    assert.equal(mailbox.messages.find((message) => message.id === first.id).status, 'completed');
    assert.equal(mailbox.messages.find((message) => message.id === second.id).status, 'pending');
    assert.notEqual(first.id, second.id);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('allocates monotonic durable task IDs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-tasks-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'initial', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const created = createTeamTask(stateDir, { subject: 'next', description: 'next', owner: 'worker-1', role: 'explorer', requires_commit: false });
    assert.equal(created.id, '2');
    assert.deepEqual(listTeamTasks(stateDir).map((task) => task.id), ['1', '2']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('adds and removes durable team membership without reusing worker indices', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-membership-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const first = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'initial', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [first] });
    const second = { name: 'worker-2', index: 2, status: 'starting', role: 'verifier', assignment: 'verify', requires_commit: false };
    const task = addTeamWorker(stateDir, second);
    assert.equal(task.id, '2');
    removeTeamWorker(stateDir, 'worker-2');
    const state = readTeamState(cwd, 'demo');
    assert.deepEqual(state.config.workers, ['worker-1']);
    assert.equal(state.config.next_worker_index, 3);
    assert.deepEqual(state.tasks.map((item) => item.id), ['1', '2']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('claims tasks only after dependencies complete and requires the claim token', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-claims-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'initial', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const dependent = createTeamTask(stateDir, {
      subject: 'dependent', description: 'dependent', owner: 'worker-1',
      role: 'explorer', requires_commit: false, depends_on: ['1'],
    });
    const blocked = claimTeamTask(stateDir, dependent.id, 'worker-1');
    assert.equal(blocked.error, 'blocked_dependency');
    const blockedAgain = claimTeamTask(stateDir, dependent.id, 'worker-1');
    assert.equal(blockedAgain.task.version, blocked.task.version);
    updateTaskState(stateDir, '1', { status: 'completed' });
    const claimed = claimTeamTask(stateDir, dependent.id, 'worker-1');
    assert.equal(claimed.ok, true);
    const renewed = renewTaskClaim(stateDir, dependent.id, 'worker-1', claimed.token);
    assert.equal(renewed.ok, true);
    assert.ok(Date.parse(renewed.task.claim.leased_until) > Date.now());
    assert.equal(claimTeamTask(stateDir, dependent.id, 'worker-1').error, 'claim_conflict');
    assert.equal(completeClaimedTask(stateDir, dependent.id, 'worker-1', 'wrong', { status: 'completed' }).error, 'claim_mismatch');
    const completed = completeClaimedTask(stateDir, dependent.id, 'worker-1', claimed.token, { status: 'completed' });
    assert.equal(completed.ok, true);
    assert.equal(completed.task.status, 'completed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('rejects completion after a claim lease expires', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-expired-completion-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'initial', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const claimed = claimTeamTask(stateDir, '1', 'worker-1');
    updateTaskState(stateDir, '1', { claim: { ...claimed.task.claim, leased_until: new Date(0).toISOString() } });
    const completed = completeClaimedTask(stateDir, '1', 'worker-1', claimed.token, { status: 'completed' });
    assert.equal(completed.error, 'lease_expired');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('reclaims only expired task leases', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-lease-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'initial', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const claimed = claimTeamTask(stateDir, '1', 'worker-1');
    assert.equal(reclaimExpiredTask(stateDir, '1').error, 'lease_active');
    updateTaskState(stateDir, '1', { claim: { ...claimed.task.claim, leased_until: new Date(0).toISOString() } });
    const reclaimed = reclaimExpiredTask(stateDir, '1');
    assert.equal(reclaimed.reclaimed, true);
    assert.equal(reclaimed.task.status, 'pending');
    const claimedAgain = claimTeamTask(stateDir, '1', 'worker-1');
    assert.equal(claimedAgain.ok, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('allows only one claim winner across concurrent processes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-concurrent-claim-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'initial', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const fixture = new URL('./fixtures/claim-task.js', import.meta.url);
    const results = await Promise.all([
      runClaimProcess(fixture, stateDir, '1', 'worker-1'),
      runClaimProcess(fixture, stateDir, '1', 'worker-1'),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.error === 'claim_conflict').length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function runClaimProcess(scriptUrl, stateDir, taskId, workerName) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptUrl.pathname, stateDir, taskId, workerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(stderr || 'claim process failed'));
      else resolve(JSON.parse(stdout));
    });
  });
}
