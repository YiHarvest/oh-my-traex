import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readMailbox, initTeamState, readTeamState, updateWorkerState } from '../src/team/state.js';
import { reconcileTeam, resumeTeam, stopTeam, teamStatus } from '../src/team/runtime.js';

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

test('reconciler reschedules a failed task once to a compatible live worker', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-runtime-reschedule-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const workers = [
      { name: 'worker-1', index: 1, status: 'working', role: 'executor', assignment: 'build', requires_commit: true, worktree_path: cwd },
      { name: 'worker-2', index: 2, status: 'completed', role: 'executor', assignment: 'help', requires_commit: true, worktree_path: cwd },
    ];
    const initialized = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader', workers });
    updateWorkerState(initialized.stateDir, 'worker-1', { pane_id: '%1', pane_pid: 101, updated_at: new Date(0).toISOString() });
    updateWorkerState(initialized.stateDir, 'worker-2', { pane_id: '%2', pane_pid: 202 });
    const run = (_command, args) => args.includes('%2')
      ? { status: 0, stdout: `demo\tworker-2\t${initialized.config.run_id}\t202\t0\n`, stderr: '' }
      : { status: 1, stdout: '', stderr: 'missing' };

    const first = reconcileTeam(cwd, 'demo', run);
    assert.equal(first.rescheduled.length, 1);
    const state = readTeamState(cwd, 'demo');
    assert.equal(state.tasks[0].owner, 'worker-2');
    assert.equal(state.tasks[0].status, 'pending');
    assert.equal(state.tasks[0].reschedule_count, 1);
    assert.equal(readMailbox(state.stateDir, 'worker-2').messages.length, 1);
    assert.equal(reconcileTeam(cwd, 'demo', run).rescheduled.length, 0);
    assert.equal(readMailbox(state.stateDir, 'worker-2').messages.length, 1);
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

test('resume publishes running only after TraeX actually spawns', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-resume-started-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'task', requires_commit: false, worktree_path: cwd };
    initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: 'process:1', leaderSessionId: 'leader', muxBackend: 'headless', workers: [worker] });
    let child;
    const resumed = resumeTeam(cwd, 'demo', {
      spawnProcess: () => {
        child = new EventEmitter();
        process.nextTick(() => { child.emit('spawn'); child.emit('close', 0); });
        return child;
      },
    });
    assert.equal(readTeamState(cwd, 'demo').config.status, 'resuming');
    assert.equal((await resumed).status, 0);
    const config = readTeamState(cwd, 'demo').config;
    assert.equal(config.status, 'running');
    assert.ok(config.resumed_at);
    assert.ok(config.resume_leader_exited_at);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resume records startup failure without false running state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-resume-failed-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'task', requires_commit: false, worktree_path: cwd };
    initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: 'process:1', leaderSessionId: 'leader', muxBackend: 'headless', workers: [worker] });
    const result = await resumeTeam(cwd, 'demo', {
      spawnProcess: () => {
        const child = new EventEmitter();
        process.nextTick(() => { child.emit('error', new Error('spawn denied')); child.emit('close', 1); });
        return child;
      },
    });
    assert.equal(result.status, 1);
    const config = readTeamState(cwd, 'demo').config;
    assert.equal(config.status, 'resume_failed');
    assert.equal(config.resume_error, 'spawn denied');
    assert.equal(config.resumed_at, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resume records a synchronous process launch failure', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-resume-thrown-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'task', requires_commit: false, worktree_path: cwd };
    initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: 'process:1', leaderSessionId: 'leader', muxBackend: 'headless', workers: [worker] });
    const result = await resumeTeam(cwd, 'demo', {
      spawnProcess: () => { throw new Error('invalid cwd'); },
    });
    assert.equal(result.status, 1);
    assert.equal(readTeamState(cwd, 'demo').config.status, 'resume_failed');
    assert.equal(readTeamState(cwd, 'demo').config.resume_error, 'invalid cwd');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
