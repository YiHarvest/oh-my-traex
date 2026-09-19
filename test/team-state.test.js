import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acknowledgeMailboxMessage, addTeamWorker, claimTaskMessage, claimTeamTask, completeClaimedTask, completeMailboxDelivery, createTeamTask, enqueueMailboxMessage, enqueueTaskMessage, initTeamState, listTeamTasks, readMailbox, readTeamState, reclaimExpiredMailboxDelivery, reclaimExpiredTask, recoverDeliveryTransactions, removeTeamWorker, renewMailboxDelivery, renewTaskClaim, sanitizeTeamName, updateMailboxMessage, updateTaskState, updateWorkerState, writeJsonAtomic } from '../src/team/state.js';

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

test('allows one delivery receipt winner across 64 concurrent consumers', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-mailbox-receipt-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'task', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const message = enqueueMailboxMessage(stateDir, 'worker-1', 'only once');
    const fixture = new URL('./fixtures/ack-message.js', import.meta.url);
    const results = await Promise.all(Array.from({ length: 64 }, () =>
      runJsonProcess(fixture, [stateDir, 'worker-1', message.id])));
    const winner = results.find((result) => result.ok);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.error === 'message_not_pending').length, 63);
    assert.equal(completeMailboxDelivery(stateDir, 'worker-1', message.id, 'wrong', { status: 'completed' }).error, 'receipt_mismatch');
    assert.equal(completeMailboxDelivery(stateDir, 'worker-1', message.id, winner.token, { status: 'completed' }).ok, true);
    assert.equal(readMailbox(stateDir, 'worker-1').messages[0].delivery_attempts, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('renews, fences, and reclaims mailbox delivery leases', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-mailbox-lease-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'task', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const message = enqueueMailboxMessage(stateDir, 'worker-1', 'retry me');
    const first = acknowledgeMailboxMessage(stateDir, 'worker-1', message.id);
    assert.ok(Date.parse(first.message.receipt.leased_until) > Date.now());
    assert.equal(renewMailboxDelivery(stateDir, 'worker-1', message.id, first.token).ok, true);
    updateMailboxMessage(stateDir, 'worker-1', message.id, {
      receipt: { ...first.message.receipt, leased_until: new Date(0).toISOString() },
    });
    const reclaimed = reclaimExpiredMailboxDelivery(stateDir, 'worker-1', message.id);
    assert.equal(reclaimed.reclaimed, true);
    assert.equal(reclaimed.message.status, 'pending');
    const second = acknowledgeMailboxMessage(stateDir, 'worker-1', message.id);
    assert.equal(completeMailboxDelivery(stateDir, 'worker-1', message.id, first.token, { status: 'completed' }).error, 'receipt_mismatch');
    assert.equal(completeMailboxDelivery(stateDir, 'worker-1', message.id, second.token, { status: 'completed' }).ok, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('atomically claims one task message across 64 concurrent consumers', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-task-message-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'initial', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const message = enqueueTaskMessage(stateDir, 'worker-1', '1', 'claim together');
    const fixture = new URL('./fixtures/claim-message.js', import.meta.url);
    const results = await Promise.all(Array.from({ length: 64 }, () =>
      runJsonProcess(fixture, [stateDir, 'worker-1', message.id])));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(readTeamState(cwd, 'demo').tasks[0].status, 'in_progress');
    assert.equal(readMailbox(stateDir, 'worker-1').messages[0].status, 'working');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('replays an interrupted task-message delivery transaction idempotently', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-delivery-recovery-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'initial', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const message = enqueueTaskMessage(stateDir, 'worker-1', '1', 'recover together');
    const task = readTeamState(cwd, 'demo').tasks[0];
    const now = new Date().toISOString();
    const claimedTask = { ...task, status: 'in_progress', claim: { owner: 'worker-1', token: 'task-token', leased_until: new Date(Date.now() + 60_000).toISOString() } };
    const claimedMessage = { ...message, status: 'working', receipt: { worker: 'worker-1', token: 'receipt-token', acknowledged_at: now, leased_until: new Date(Date.now() + 60_000).toISOString() } };
    writeJsonAtomic(join(stateDir, 'delivery-transactions', 'interrupted.json'), {
      schema_version: 1, id: 'interrupted', status: 'active', worker: 'worker-1',
      task_id: '1', message_id: message.id, task: claimedTask, message: claimedMessage, created_at: now,
    });
    assert.deepEqual(recoverDeliveryTransactions(stateDir), ['interrupted']);
    assert.equal(readTeamState(cwd, 'demo').tasks[0].claim.token, 'task-token');
    assert.equal(readMailbox(stateDir, 'worker-1').messages[0].receipt.token, 'receipt-token');
    assert.deepEqual(recoverDeliveryTransactions(stateDir), []);
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

test('allows only one claim winner across 64 concurrent processes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-concurrent-claim-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'starting', role: 'explorer', assignment: 'initial', requires_commit: false };
    const { stateDir } = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader-id', workers: [worker] });
    const fixture = new URL('./fixtures/claim-task.js', import.meta.url);
    const results = await Promise.all(Array.from(
      { length: 64 },
      () => runClaimProcess(fixture, stateDir, '1', 'worker-1'),
    ));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.error === 'claim_conflict').length, 63);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an old lock owner cannot delete a replacement lock', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-lock-aba-'));
  try {
    const stateDir = join(cwd, 'state');
    const lockRoot = join(stateDir, '.locks');
    const lockPath = join(lockRoot, 'shared.lock');
    const displacedPath = join(lockRoot, 'shared.displaced');
    const firstReady = join(cwd, 'first-ready');
    const firstRelease = join(cwd, 'first-release');
    const secondReady = join(cwd, 'second-ready');
    const secondRelease = join(cwd, 'second-release');
    const fixture = new URL('./fixtures/hold-state-lock.js', import.meta.url);
    const first = runLockProcess(fixture, stateDir, 'shared', firstReady, firstRelease);
    await waitForFile(firstReady);
    mkdirSync(lockRoot, { recursive: true });
    renameSync(lockPath, displacedPath);
    const second = runLockProcess(fixture, stateDir, 'shared', secondReady, secondRelease);
    await waitForFile(secondReady);
    writeFileSync(firstRelease, 'release');
    await first;
    assert.equal(existsSync(lockPath), true);
    writeFileSync(secondRelease, 'release');
    await second;
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function runClaimProcess(scriptUrl, stateDir, taskId, workerName) {
  return runJsonProcess(scriptUrl, [stateDir, taskId, workerName]);
}

function runJsonProcess(scriptUrl, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptUrl.pathname, ...args], {
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

function runLockProcess(scriptUrl, stateDir, recordName, readyPath, releasePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptUrl.pathname, stateDir, recordName, readyPath, releasePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || 'lock process failed')));
  });
}

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
