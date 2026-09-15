import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertCleanWorkspace, createWorkerWorktrees, rollbackWorkerWorktrees } from '../src/team/worktree.js';

test('creates isolated worker branches and worktrees then rolls them back', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'otx-worktree-'));
  const bucket = join(dirname(repoRoot), basename(repoRoot) + '.otx-worktrees');
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'OTX Test']);
  git(repoRoot, ['config', 'user.email', 'otx@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-q', '-m', 'init']);

  let workers = [];
  try {
    assert.doesNotThrow(() => assertCleanWorkspace(repoRoot));
    workers = createWorkerWorktrees({
      repoRoot,
      teamName: 'demo',
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assignment: 'task', status: 'starting' }],
    });
    assert.equal(workers[0].branch, 'otx/demo/worker-1');
    assert.equal(git(workers[0].worktree_path, ['branch', '--show-current']).stdout.trim(), 'otx/demo/worker-1');
  } finally {
    rollbackWorkerWorktrees(repoRoot, workers);
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(bucket, { recursive: true, force: true });
  }
});

test('preserves worker worktrees that contain uncommitted work', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'otx-worktree-dirty-'));
  const bucket = join(dirname(repoRoot), basename(repoRoot) + '.otx-worktrees');
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'OTX Test']);
  git(repoRoot, ['config', 'user.email', 'otx@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-q', '-m', 'init']);
  const workers = createWorkerWorktrees({
    repoRoot,
    teamName: 'dirty-demo',
    workers: [{ name: 'worker-1', index: 1, role: 'executor', assignment: 'task', status: 'starting' }],
  });
  writeFileSync(join(workers[0].worktree_path, 'work.txt'), 'preserve me\n');

  const debt = rollbackWorkerWorktrees(repoRoot, workers);
  assert.equal(debt[0].reason, 'worktree_dirty');
  assert.equal(git(workers[0].worktree_path, ['status', '--porcelain']).stdout.trim(), '?? work.txt');

  rmSync(workers[0].worktree_path, { recursive: true, force: true });
  git(repoRoot, ['worktree', 'prune']);
  git(repoRoot, ['branch', '-D', workers[0].branch]);
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(bucket, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
