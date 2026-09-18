import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addTeamWorker, initTeamState, readTeamState, teamStateDir } from '../src/team/state.js';
import { addWorker, recoverTeam } from '../src/team/runtime.js';
import { beginTeamTransaction, finishTeamTransaction, listTeamTransactions, updateTeamTransaction } from '../src/team/transaction.js';
import { createWorkerWorktree } from '../src/team/worktree.js';

test('persists transaction phases and terminal status', () => {
  const root = mkdtempSync(join(tmpdir(), 'otx-transaction-'));
  try {
    const transaction = beginTeamTransaction(root, 'test-operation', { value: 1 });
    updateTeamTransaction(transaction, { phase: 'resource-created', resources: { ids: ['one'] } });
    finishTeamTransaction(transaction);
    const [record] = listTeamTransactions(root);
    assert.equal(record.status, 'committed');
    assert.equal(record.phase, 'resource-created');
    assert.deepEqual(record.resources.ids, ['one']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovers an interrupted add-worker transaction idempotently', () => {
  const repo = mkdtempSync(join(tmpdir(), 'otx-transaction-recovery-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'otx@example.com'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'OTX Test'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: repo }).status, 0);
    const first = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'review', requires_commit: false, worktree_path: repo };
    const initialized = initTeamState({ cwd: repo, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader', workers: [first] });
    const second = createWorkerWorktree({
      repoRoot: repo, teamName: 'demo',
      worker: { name: 'worker-2', index: 2, status: 'starting', role: 'reviewer', assignment: 'review more', requires_commit: false },
    });
    addTeamWorker(initialized.stateDir, second);
    const transaction = beginTeamTransaction(initialized.stateDir, 'add-worker', { worker: second.name });
    updateTeamTransaction(transaction, { phase: 'worktree-created', resources: { workers: [second] } });

    const firstRecovery = recoverTeam(repo, 'demo', () => ({ status: 1, stdout: '', stderr: 'missing' }));
    assert.equal(firstRecovery.ok, true);
    assert.equal(firstRecovery.recovered.length, 1);
    assert.deepEqual(readTeamState(repo, 'demo').config.workers, ['worker-1']);
    assert.equal(readTeamState(repo, 'demo').config.status, 'running');
    assert.equal(listTeamTransactions(initialized.stateDir, { activeOnly: true }).length, 0);
    assert.deepEqual(recoverTeam(repo, 'demo'), { ok: true, recovered: [], recovered_deliveries: [], cleanup_debt: [] });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('recovers an interrupted start-team before config publication', () => {
  const repo = mkdtempSync(join(tmpdir(), 'otx-start-recovery-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'otx@example.com'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'OTX Test'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: repo }).status, 0);
    const stateDir = teamStateDir(repo, 'demo');
    const transaction = beginTeamTransaction(stateDir, 'start-team', { team: 'demo', cwd: repo });
    const worker = createWorkerWorktree({
      repoRoot: repo, teamName: 'demo',
      worker: { name: 'worker-1', index: 1, status: 'starting', role: 'executor', assignment: 'build', requires_commit: true },
    });
    updateTeamTransaction(transaction, { phase: 'worktrees-created', resources: { workers: [worker] } });

    const recovery = recoverTeam(repo, 'demo');
    assert.equal(recovery.ok, true);
    assert.equal(recovery.recovered.length, 1);
    assert.equal(existsSync(worker.worktree_path), false);
    assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/otx/demo/worker-1'], { cwd: repo }).status, 1);
    assert.equal(listTeamTransactions(stateDir, { activeOnly: true }).length, 0);
    assert.deepEqual(recoverTeam(repo, 'demo'), { ok: true, recovered: [], recovered_deliveries: [], cleanup_debt: [] });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rolls back add-worker transaction when worktree creation fails', () => {
  const repo = mkdtempSync(join(tmpdir(), 'otx-add-worker-failure-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'otx@example.com'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'OTX Test'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: repo }).status, 0);
    const first = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'review', requires_commit: false, worktree_path: repo };
    const initialized = initTeamState({ cwd: repo, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader', workers: [first] });
    const occupied = join(dirname(repo), `${basename(repo)}.otx-worktrees`, 'demo', 'worker-2');
    mkdirSync(occupied, { recursive: true });

    assert.throws(() => addWorker(repo, 'demo', 'reviewer', 'review more', {
      env: { TMUX: '1', TMUX_PANE: '%1' },
      run: () => ({ status: 1, stdout: '', stderr: 'missing' }),
    }), /worktree path already exists/);
    assert.equal(listTeamTransactions(initialized.stateDir, { activeOnly: true }).length, 0);
    assert.equal(listTeamTransactions(initialized.stateDir).at(-1).status, 'rolled-back');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
