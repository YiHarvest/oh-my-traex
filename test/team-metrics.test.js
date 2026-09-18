import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendTeamEvent } from '../src/team/events.js';
import { collectTeamMetrics } from '../src/team/metrics.js';
import { enqueueMailboxMessage, initTeamState, updateTaskState, updateWorkerState } from '../src/team/state.js';

test('collects queue, worker, recovery, and latency metrics', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-metrics-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'task', requires_commit: false, worktree_path: cwd };
    const initialized = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader', workers: [worker] });
    updateWorkerState(initialized.stateDir, 'worker-1', { pane_id: '%2', pane_pid: 202 });
    updateTaskState(initialized.stateDir, '1', {
      status: 'completed', started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:02.000Z',
    });
    enqueueMailboxMessage(initialized.stateDir, 'worker-1', 'pending');
    appendTeamEvent(initialized.stateDir, 'task.rescheduled');
    appendTeamEvent(initialized.stateDir, 'task.lease_reclaimed');
    const run = () => ({ status: 0, stdout: `demo\tworker-1\t${initialized.config.run_id}\t202\t0\n`, stderr: '' });

    const metrics = collectTeamMetrics(cwd, 'demo', run);
    assert.equal(metrics.task_queue_depth, 0);
    assert.equal(metrics.message_queue_depth, 1);
    assert.equal(metrics.workers.completed, 1);
    assert.equal(metrics.reschedules, 1);
    assert.equal(metrics.task_lease_reclaims, 1);
    assert.deepEqual(metrics.task_duration_ms, { count: 1, average: 2000, max: 2000 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
