import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acknowledgeMailboxMessage, claimTeamTask, enqueueMailboxMessage, initTeamState, readMailbox, readTeamState, updateMailboxMessage, updateTaskState, updateWorkerState } from '../src/team/state.js';
import { runTeamSupervisor, superviseTeamOnce } from '../src/team/supervisor.js';
import { startTeam } from '../src/team/runtime.js';
import { rollbackWorkerWorktrees } from '../src/team/worktree.js';

test('team startup launches an owned supervisor in a detached tmux window', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-supervisor-start-'));
  let runtime;
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'otx@example.com'], { cwd }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'OTX Test'], { cwd }).status, 0);
    assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd }).status, 0);
    const calls = [];
    const run = (command, args) => {
      calls.push({ command, args });
      if (command === 'git') return { status: 0, stdout: `${cwd}\n`, stderr: '' };
      if (args[0] === 'split-window') return { status: 0, stdout: '%2\n', stderr: '' };
      if (args[0] === 'new-window') return { status: 0, stdout: '%3\n', stderr: '' };
      if (args[0] === 'display-message') {
        return { status: 0, stdout: args.includes('%3') ? '303\n' : '202\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    runtime = await startTeam({
      cwd,
      task: 'test supervisor',
      workerCount: 1,
      autoPlan: false,
      env: { TMUX: '1', TMUX_PANE: '%1' },
      run,
    });
    const state = readTeamState(cwd, runtime.name);
    assert.equal(state.config.supervisor_pane_id, '%3');
    assert.equal(state.config.supervisor_pane_pid, 303);
    const launch = calls.find((call) => call.args[0] === 'new-window');
    assert.ok(launch.args.at(-1).includes('team supervise'));
  } finally {
    if (runtime) rollbackWorkerWorktrees(cwd, runtime.workers);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('supervisor reclaims expired task and mailbox leases', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-supervisor-'));
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
    updateWorkerState(initialized.stateDir, 'worker-1', { pane_id: '%9', pane_pid: 123 });
    const taskClaim = claimTeamTask(initialized.stateDir, '1', 'worker-1');
    updateTaskState(initialized.stateDir, '1', {
      claim: { ...taskClaim.task.claim, leased_until: new Date(0).toISOString() },
    });
    const message = enqueueMailboxMessage(initialized.stateDir, 'worker-1', 'retry');
    const delivery = acknowledgeMailboxMessage(initialized.stateDir, 'worker-1', message.id);
    updateMailboxMessage(initialized.stateDir, 'worker-1', message.id, {
      receipt: { ...delivery.message.receipt, leased_until: new Date(0).toISOString() },
    });
    const run = () => ({
      status: 0,
      stdout: `demo\tworker-1\t${initialized.config.run_id}\t123\t0\n`,
      stderr: '',
    });

    const result = superviseTeamOnce(cwd, 'demo', run);
    assert.deepEqual(result.reclaimed_tasks, ['1']);
    assert.equal(result.reclaimed_messages[0].message_id, message.id);
    assert.equal(readTeamState(cwd, 'demo').tasks[0].status, 'pending');
    assert.equal(readMailbox(initialized.stateDir, 'worker-1').messages[0].status, 'pending');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('one-shot supervisor returns without waiting', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-supervisor-once-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = {
      name: 'worker-1', index: 1, status: 'completed', role: 'reviewer',
      assignment: 'task', requires_commit: false, worktree_path: cwd,
    };
    const initialized = initTeamState({
      cwd, name: 'demo', task: 'task', leaderPaneId: '%1',
      leaderSessionId: 'leader', workers: [worker],
    });
    updateTaskState(initialized.stateDir, '1', { status: 'completed' });
    const result = await runTeamSupervisor(cwd, 'demo', {
      once: true,
      run: () => ({ status: 1, stdout: '', stderr: 'missing' }),
    });
    assert.equal(result.state.config.status, 'ready');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
