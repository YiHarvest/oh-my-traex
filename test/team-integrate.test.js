import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initTeamState, readTeamState, updateWorkerState } from '../src/team/state.js';
import { cleanupTeam, integrateTeam, reconcileTeam, stopTeam } from '../src/team/runtime.js';
import { createWorkerWorktrees } from '../src/team/worktree.js';

test('integrates the complete validated worker commit range', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'otx-integrate-'));
  const bucket = join(dirname(repoRoot), basename(repoRoot) + '.otx-worktrees');
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'OTX Test']);
  git(repoRoot, ['config', 'user.email', 'otx@example.com']);
  git(repoRoot, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-q', '-m', 'init']);
  const workers = createWorkerWorktrees({
    repoRoot,
    teamName: 'demo',
    workers: [{ name: 'worker-1', index: 1, role: 'executor', assignment: 'task', requires_commit: true, status: 'starting' }],
  });
  let cleaned = false;
  try {
    writeFileSync(join(workers[0].worktree_path, 'one.txt'), 'one\n');
    git(workers[0].worktree_path, ['add', 'one.txt']);
    git(workers[0].worktree_path, ['commit', '-q', '-m', 'one']);
    writeFileSync(join(workers[0].worktree_path, 'two.txt'), 'two\n');
    git(workers[0].worktree_path, ['add', 'two.txt']);
    git(workers[0].worktree_path, ['commit', '-q', '-m', 'two']);
    const commit = git(workers[0].worktree_path, ['rev-parse', 'HEAD']).stdout.trim();
    const initialized = initTeamState({
      cwd: repoRoot, name: 'demo', task: 'task', leaderPaneId: '%1',
      leaderSessionId: 'leader', workers,
    });
    updateWorkerState(initialized.stateDir, 'worker-1', { status: 'completed', commit });

    const result = integrateTeam(repoRoot, 'demo', ['worker-1']);
    assert.equal(result.ok, true);
    assert.equal(result.results[0].source_commits.length, 2);
    assert.equal(readFileSync(join(repoRoot, 'one.txt'), 'utf8'), 'one\n');
    assert.equal(readFileSync(join(repoRoot, 'two.txt'), 'utf8'), 'two\n');
    const repeated = integrateTeam(repoRoot, 'demo', ['worker-1']);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.results[0].status, 'already_integrated');
    stopTeam(repoRoot, 'demo');
    const cleanup = cleanupTeam(repoRoot, 'demo');
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.results[0].status, 'removed');
    cleaned = true;
  } finally {
    if (!cleaned) {
      git(repoRoot, ['worktree', 'remove', '--force', workers[0].worktree_path]);
      git(repoRoot, ['branch', '-D', workers[0].branch]);
    }
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(bucket, { recursive: true, force: true });
  }
});

test('invalidates integration evidence after leader history is reset and preserves the worktree', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'otx-integration-evidence-'));
  const bucket = join(dirname(repoRoot), basename(repoRoot) + '.otx-worktrees');
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'OTX Test']);
  git(repoRoot, ['config', 'user.email', 'otx@example.com']);
  git(repoRoot, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-q', '-m', 'init']);
  const baseCommit = git(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
  const workers = createWorkerWorktrees({
    repoRoot,
    teamName: 'evidence',
    workers: [{ name: 'worker-1', index: 1, role: 'executor', assignment: 'task', requires_commit: true, status: 'starting' }],
  });
  let cleaned = false;
  try {
    writeFileSync(join(workers[0].worktree_path, 'change.txt'), 'worker change\n');
    git(workers[0].worktree_path, ['add', 'change.txt']);
    git(workers[0].worktree_path, ['commit', '-q', '-m', 'worker change']);
    const commit = git(workers[0].worktree_path, ['rev-parse', 'HEAD']).stdout.trim();
    const initialized = initTeamState({
      cwd: repoRoot, name: 'evidence', task: 'task', leaderPaneId: '%1',
      leaderSessionId: 'leader', workers,
    });
    updateWorkerState(initialized.stateDir, 'worker-1', { status: 'completed', commit });

    const integrated = integrateTeam(repoRoot, 'evidence', ['worker-1']);
    assert.equal(integrated.ok, true);
    assert.equal(integrated.results[0].status, 'integrated');
    git(repoRoot, ['reset', '--hard', baseCommit]);
    git(repoRoot, ['cherry-pick', '--no-commit', commit]);
    git(repoRoot, ['commit', '-q', '-m', 'rewritten equivalent change']);
    assert.notEqual(git(repoRoot, ['rev-parse', 'HEAD']).stdout.trim(), integrated.results[0].integrated_commit);
    assert.equal(reconcileTeam(repoRoot, 'evidence').config.status, 'integrated');
    git(repoRoot, ['reset', '--hard', baseCommit]);

    const reconciled = reconcileTeam(repoRoot, 'evidence');
    assert.equal(reconciled.config.status, 'ready');
    assert.equal(reconciled.workers[0].integration.status, 'stale');
    assert.equal(reconciled.workers[0].integration.stale_reason, 'integration_commit_not_reachable');
    assert.equal(readTeamState(repoRoot, 'evidence').config.status, 'ready');

    stopTeam(repoRoot, 'evidence');
    const refused = cleanupTeam(repoRoot, 'evidence');
    assert.equal(refused.ok, false);
    assert.equal(refused.results[0].status, 'preserved');
    assert.equal(refused.results[0].reason, 'commit_not_integrated');

    const reintegrated = integrateTeam(repoRoot, 'evidence', ['worker-1']);
    assert.equal(reintegrated.ok, true);
    assert.equal(reintegrated.results[0].status, 'integrated');
    stopTeam(repoRoot, 'evidence');
    const cleanup = cleanupTeam(repoRoot, 'evidence');
    assert.equal(cleanup.ok, true);
    cleaned = true;
  } finally {
    if (!cleaned) {
      git(repoRoot, ['worktree', 'remove', '--force', workers[0].worktree_path]);
      git(repoRoot, ['branch', '-D', workers[0].branch]);
    }
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(bucket, { recursive: true, force: true });
  }
});

test('rolls back the entire integration batch when a later worker conflicts', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'otx-integration-transaction-'));
  const bucket = join(dirname(repoRoot), basename(repoRoot) + '.otx-worktrees');
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'OTX Test']);
  git(repoRoot, ['config', 'user.email', 'otx@example.com']);
  git(repoRoot, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoRoot, 'shared.txt'), 'base\n');
  git(repoRoot, ['add', 'shared.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'init']);
  const originalHead = git(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
  const workers = createWorkerWorktrees({
    repoRoot, teamName: 'transaction',
    workers: [
      { name: 'worker-1', index: 1, role: 'executor', assignment: 'one', requires_commit: true, status: 'starting' },
      { name: 'worker-2', index: 2, role: 'executor', assignment: 'two', requires_commit: true, status: 'starting' },
    ],
  });
  try {
    writeFileSync(join(workers[0].worktree_path, 'one.txt'), 'one\n');
    git(workers[0].worktree_path, ['add', 'one.txt']);
    git(workers[0].worktree_path, ['commit', '-q', '-m', 'one']);
    writeFileSync(join(workers[1].worktree_path, 'shared.txt'), 'worker two\n');
    git(workers[1].worktree_path, ['add', 'shared.txt']);
    git(workers[1].worktree_path, ['commit', '-q', '-m', 'two']);
    writeFileSync(join(repoRoot, 'shared.txt'), 'leader change\n');
    git(repoRoot, ['add', 'shared.txt']);
    git(repoRoot, ['commit', '-q', '-m', 'leader change']);
    const leaderHead = git(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();

    const initialized = initTeamState({
      cwd: repoRoot, name: 'transaction', task: 'task', leaderPaneId: '%1',
      leaderSessionId: 'leader', workers,
    });
    for (const worker of workers) {
      const commit = git(worker.worktree_path, ['rev-parse', 'HEAD']).stdout.trim();
      updateWorkerState(initialized.stateDir, worker.name, { status: 'completed', commit });
    }

    const result = integrateTeam(repoRoot, 'transaction');
    assert.equal(result.ok, false);
    assert.equal(result.rolled_back, true);
    assert.deepEqual(result.results.map((entry) => entry.status), ['rolled_back', 'conflict']);
    assert.equal(git(repoRoot, ['rev-parse', 'HEAD']).stdout.trim(), leaderHead);
    assert.equal(readFileSync(join(repoRoot, 'shared.txt'), 'utf8'), 'leader change\n');
    assert.equal(git(repoRoot, ['cat-file', '-e', `${originalHead}^{commit}`]).status, 0);
    assert.equal(git(repoRoot, ['status', '--porcelain']).stdout, '');
  } finally {
    for (const worker of workers) {
      git(repoRoot, ['worktree', 'remove', '--force', worker.worktree_path]);
      git(repoRoot, ['branch', '-D', worker.branch]);
    }
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(bucket, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
