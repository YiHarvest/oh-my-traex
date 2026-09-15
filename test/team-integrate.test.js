import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initTeamState, updateWorkerState } from '../src/team/state.js';
import { cleanupTeam, integrateTeam, stopTeam } from '../src/team/runtime.js';
import { createWorkerWorktrees } from '../src/team/worktree.js';

test('integrates the complete validated worker commit range', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'otx-integrate-'));
  const bucket = join(dirname(repoRoot), basename(repoRoot) + '.otx-worktrees');
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'OTX Test']);
  git(repoRoot, ['config', 'user.email', 'otx@example.com']);
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

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
