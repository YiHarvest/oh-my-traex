import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { enqueueMailboxMessage, initTeamState, readMailbox, readTeamState, sanitizeTeamName, updateMailboxMessage, updateTaskState, updateWorkerState } from '../src/team/state.js';

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
