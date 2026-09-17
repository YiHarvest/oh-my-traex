import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initTeamState, readTeamState, updateWorkerState } from '../src/team/state.js';
import { reconcileTeam, stopTeam, teamStatus } from '../src/team/runtime.js';

test('reports a live worker as stalled when TraeX has no recent activity', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-runtime-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = {
      name: 'worker-1', index: 1, status: 'working', role: 'reviewer',
      assignment: 'task', requires_commit: false, worktree_path: cwd,
    };
    const initialized = initTeamState({
      cwd, name: 'demo', task: 'task', leaderPaneId: '%1',
      leaderSessionId: 'leader', workers: [worker],
    });
    const old = new Date(Date.now() - 61_000).toISOString();
    updateWorkerState(initialized.stateDir, 'worker-1', {
      pane_id: '%9', pane_pid: 123, heartbeat_at: new Date().toISOString(),
      child_started_at: old, last_activity_at: old,
    });
    const run = (_command, args) => args[0] === 'display-message'
      ? { status: 0, stdout: 'demo\tworker-1\t' + initialized.config.run_id + '\t123\t0\n', stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
    const state = teamStatus(cwd, 'demo', run);
    assert.equal(state.workers[0].health, 'stalled');
    assert.ok(state.workers[0].activity_age_ms >= 60_000);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('status inspection does not persist dead-worker reconciliation', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-runtime-readonly-status-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = {
      name: 'worker-1', index: 1, status: 'working', role: 'reviewer',
      assignment: 'task', requires_commit: false, worktree_path: cwd,
    };
    const initialized = initTeamState({
      cwd, name: 'demo', task: 'task', leaderPaneId: '%1',
      leaderSessionId: 'leader', workers: [worker],
    });
    updateWorkerState(initialized.stateDir, 'worker-1', {
      pane_id: '%9', pane_pid: 123, updated_at: new Date(0).toISOString(),
    });
    const deadPane = () => ({ status: 1, stdout: '', stderr: 'missing' });
    assert.equal(teamStatus(cwd, 'demo', deadPane).workers[0].status, 'failed');
    assert.equal(readTeamState(cwd, 'demo').workers[0].status, 'working');
    reconcileTeam(cwd, 'demo', deadPane);
    assert.equal(readTeamState(cwd, 'demo').workers[0].status, 'failed');
    assert.equal(readTeamState(cwd, 'demo').tasks[0].status, 'failed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('stop refuses to kill a pane when persisted owner proof does not match', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-runtime-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = {
      name: 'worker-1', index: 1, status: 'working', role: 'executor',
      assignment: 'task', requires_commit: true, worktree_path: cwd,
    };
    const initialized = initTeamState({
      cwd, name: 'demo', task: 'task', leaderPaneId: '%1',
      leaderSessionId: 'leader', workers: [worker],
    });
    updateWorkerState(initialized.stateDir, 'worker-1', { pane_id: '%9', pane_pid: 123 });
    const calls = [];
    const run = (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'display-message') {
        return { status: 0, stdout: 'other-team\tworker-1\trun\t123\t0\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    stopTeam(cwd, 'demo', run);
    assert.equal(calls.some((call) => call.args[0] === 'kill-pane'), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
