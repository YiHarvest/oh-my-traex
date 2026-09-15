import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function assertCleanWorkspace(repoRoot) {
  const result = git(repoRoot, ['status', '--porcelain']);
  if (result.status !== 0) throw new Error(commandError(result));
  if (result.stdout.trim()) throw new Error('otx team requires a clean leader workspace; commit or stash changes first.');
}

export function createWorkerWorktrees({ repoRoot, teamName, workers }) {
  const bucket = join(dirname(repoRoot), `${basename(repoRoot)}.otx-worktrees`, teamName);
  mkdirSync(bucket, { recursive: true });
  const created = [];
  try {
    for (const worker of workers) {
      const worktreePath = join(bucket, worker.name);
      const branch = `otx/${teamName}/${worker.name}`;
      if (existsSync(worktreePath)) throw new Error(`worktree path already exists: ${worktreePath}`);
      const result = git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
      if (result.status !== 0) throw new Error(commandError(result));
      const entry = { ...worker, worktree_path: worktreePath, branch };
      entry.base_commit = git(worktreePath, ['rev-parse', 'HEAD']).stdout.trim();
      created.push(entry);
    }
    return created;
  } catch (error) {
    rollbackWorkerWorktrees(repoRoot, created);
    throw error;
  }
}

export function rollbackWorkerWorktrees(repoRoot, workers) {
  const preserved = [];
  for (const worker of [...workers].reverse()) {
    const head = git(worker.worktree_path, ['rev-parse', 'HEAD']);
    const status = git(worker.worktree_path, ['status', '--porcelain']);
    const unchanged = head.status === 0 && head.stdout.trim() === worker.base_commit;
    const clean = status.status === 0 && status.stdout.trim() === '';
    if (!unchanged || !clean) {
      preserved.push({
        worker: worker.name,
        worktree_path: worker.worktree_path,
        branch: worker.branch,
        reason: !unchanged ? 'branch_advanced' : 'worktree_dirty',
      });
      continue;
    }
    const removed = git(repoRoot, ['worktree', 'remove', worker.worktree_path]);
    if (removed.status !== 0) {
      preserved.push({
        worker: worker.name,
        worktree_path: worker.worktree_path,
        branch: worker.branch,
        reason: commandError(removed),
      });
      continue;
    }
    git(repoRoot, ['branch', '-D', worker.branch]);
  }
  return preserved;
}

export function worktreeStatus(path) {
  const result = git(path, ['status', '--porcelain']);
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

export function cleanupWorkerWorktree(repoRoot, worker) {
  const head = git(worker.worktree_path, ['rev-parse', 'HEAD']);
  const status = git(worker.worktree_path, ['status', '--porcelain']);
  if (head.status !== 0) return { status: 'preserved', reason: 'worktree_unreadable' };
  if (status.status !== 0 || status.stdout.trim() !== '') return { status: 'preserved', reason: 'worktree_dirty' };
  if (worker.commit && head.stdout.trim() !== worker.commit) return { status: 'preserved', reason: 'worktree_head_changed' };
  const removed = git(repoRoot, ['worktree', 'remove', worker.worktree_path]);
  if (removed.status !== 0) return { status: 'preserved', reason: commandError(removed) };
  const branch = git(repoRoot, ['branch', '-D', worker.branch]);
  if (branch.status !== 0) return { status: 'preserved', reason: commandError(branch) };
  return { status: 'removed', worktree_path: worker.worktree_path, branch: worker.branch };
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function commandError(result) {
  return String(result.stderr || result.stdout || `git exited ${result.status}`).trim();
}
