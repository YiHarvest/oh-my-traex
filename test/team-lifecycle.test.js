import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initTeamState, updateTaskState, updateWorkerState, createTeamTask, claimTeamTask, readTeamState, enqueueTaskMessage, readMailbox } from '../src/team/state.js';
import { reconcileTeam } from '../src/team/runtime.js';
function fixture(workers) {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-lifecycle-'));
  spawnSync('git', ['init', '-q'], { cwd });
  const data = initTeamState({ cwd, name: 'demo', task: 'test', leaderPaneId: '%1', leaderSessionId: 'leader',
    workers: workers.map((worker, i) => ({ name: 'worker-' + (i + 1), index: i + 1, worktree_path: cwd, ...worker })) });
  return { cwd, ...data };
}
const dead = () => ({ status: 1, stdout: '' });
test('follow-up crash preserves completed initial task and terminates current task/message', () => {
  const { cwd, stateDir } = fixture([{ status: 'completed', role: 'reviewer' }]);
  try {
    updateTaskState(stateDir, '1', { status: 'completed' });
    const task = createTeamTask(stateDir, { owner: 'worker-1', subject: 'next', description: 'next' });
    claimTeamTask(stateDir, task.id, 'worker-1');
    const message = enqueueTaskMessage(stateDir, 'worker-1', task.id, 'next');
    updateWorkerState(stateDir, 'worker-1', { status: 'working', current_task_id: task.id, current_message_id: message.id }, { allowTerminalReset: true, reason: 'followup' });
    reconcileTeam(cwd, 'demo', dead);
    const state = readTeamState(cwd, 'demo');
    assert.equal(state.tasks[0].status, 'completed');
    assert.equal(state.tasks[1].status, 'failed');
    assert.equal(state.tasks[1].claim, null);
    assert.equal(readMailbox(stateDir, 'worker-1').messages[0].status, 'failed');
    assert.equal(state.config.status, 'failed');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('failed dependencies terminate blocked descendants and a dead blocked worker', () => {
  const { cwd, stateDir } = fixture([{ status: 'failed', role: 'executor', requires_commit: true },
    { status: 'blocked', role: 'reviewer', requires_commit: false, depends_on: ['1'] }]);
  try {
    updateTaskState(stateDir, '1', { status: 'failed' });
    claimTeamTask(stateDir, '2', 'worker-2');
    reconcileTeam(cwd, 'demo', dead);
    const state = readTeamState(cwd, 'demo');
    assert.equal(state.tasks[1].status, 'failed');
    assert.equal(state.workers[1].status, 'failed');
    assert.equal(state.config.status, 'failed');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('scheduler refuses transfers outside the target file boundary', () => {
  const { cwd, stateDir, config } = fixture([{ status: 'failed', role: 'executor', requires_commit: true, file_paths: ['src/a'] },
    { status: 'completed', role: 'executor', requires_commit: true, file_paths: ['src/b'] }]);
  try {
    updateTaskState(stateDir, '1', { status: 'failed' }); updateTaskState(stateDir, '2', { status: 'completed' });
    updateWorkerState(stateDir, 'worker-2', { pane_id: '%2', pane_pid: 222 });
    const run = (_command, args) => args.includes('%2') ? { status: 0, stdout: 'demo\tworker-2\t' + config.run_id + '\t222\t0\n' } : dead();
    assert.deepEqual(reconcileTeam(cwd, 'demo', run).rescheduled, []);
    assert.equal(readTeamState(cwd, 'demo').tasks[0].owner, 'worker-1');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('pending tasks prevent false ready even when workers are completed', () => {
  const { cwd, stateDir } = fixture([{ status: 'completed', role: 'reviewer' }]);
  try {
    assert.equal(reconcileTeam(cwd, 'demo', dead).config.status, 'running');
    updateTaskState(stateDir, '1', { status: 'completed' });
    assert.equal(reconcileTeam(cwd, 'demo', dead).config.status, 'ready');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
