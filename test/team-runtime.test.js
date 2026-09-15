import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initTeamState, updateWorkerState } from '../src/team/state.js';
import { stopTeam } from '../src/team/runtime.js';

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
