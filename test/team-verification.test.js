import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verificationPolicy, runVerification, verificationCurrent } from '../src/team/verification.js';
import { initTeamState, updateWorkerState } from '../src/team/state.js';
import { createWorkerWorktrees } from '../src/team/worktree.js';
import { integrateTeam } from '../src/team/runtime.js';
import { parseTeamArgs } from '../src/team/cli.js';
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-verification-'));
  git(cwd, 'init', '-q'); git(cwd, 'config', 'user.email', 'test@example.com'); git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'commit', '--allow-empty', '-qm', 'base');
  return cwd;
}
test('verification records exit codes and binds evidence to commit and command', () => {
  const cwd = fixture();
  try {
    const policy = verificationPolicy(cwd, ['node -e "process.exit(0)"']);
    const evidence = runVerification(cwd, policy);
    assert.equal(evidence.passed, true);
    assert.equal(verificationCurrent(evidence, evidence.commit, policy), true);
    assert.equal(verificationCurrent(evidence, 'different', policy), false);
    assert.equal(verificationCurrent(evidence, evidence.commit, { commands: ['different'] }), false);
    const failed = runVerification(cwd, { commands: ['node -e "process.exit(7)"'] });
    assert.equal(failed.passed, false);
    assert.equal(failed.commands[0].exit_code, 7);
    const dirty = runVerification(cwd, { commands: ['node -e "require(\'fs\').writeFileSync(\'unexpected\',\'x\')"'] });
    assert.equal(dirty.passed, false);
    assert.match(dirty.error, /dirty/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('verification times out and missing commands never count as passing', () => {
  const cwd = fixture();
  try {
    assert.equal(runVerification(cwd, { commands: [] }).passed, false);
    const result = runVerification(cwd, { commands: ['node -e "setTimeout(()=>{},500)"'], timeout_ms: 25 });
    assert.equal(result.passed, false);
    assert.ok(result.commands[0].error);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.deepEqual(verificationPolicy(cwd).commands, ['npm test']);
    assert.deepEqual(parseTeamArgs(['--verify-command', 'npm test', '--verify-command', 'npm run lint', 'task']).options.verifyCommands, ['npm test', 'npm run lint']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('staging validation failure leaves leader HEAD unchanged even when each worker passed', () => {
  const cwd = fixture();
  const policy = { commands: ['node -e "process.exit(require(\'fs\').existsSync(\'a\') && require(\'fs\').existsSync(\'b\') ? 1 : 0)"'] };
  const workers = createWorkerWorktrees({ repoRoot: cwd, teamName: 'verify', workers: ['a', 'b'].map((file, i) => ({
    name: 'worker-' + (i + 1), index: i + 1, role: 'executor', assignment: file, requires_commit: true, status: 'starting',
  })) });
  try {
    const { stateDir } = initTeamState({ cwd, name: 'verify', task: 'test', leaderPaneId: '%1', leaderSessionId: 'test', workers, verification: policy });
    for (const worker of workers) {
      writeFileSync(join(worker.worktree_path, worker.assignment), 'x');
      git(worker.worktree_path, 'add', '.'); git(worker.worktree_path, 'commit', '-qm', worker.assignment);
      const commit = git(worker.worktree_path, 'rev-parse', 'HEAD');
      const evidence = runVerification(worker.worktree_path, policy);
      assert.equal(evidence.passed, true);
      updateWorkerState(stateDir, worker.name, { status: 'completed', commit, verification: evidence });
    }
    const before = git(cwd, 'rev-parse', 'HEAD');
    const result = integrateTeam(cwd, 'verify');
    assert.equal(result.ok, false); assert.equal(result.rolled_back, true);
    assert.equal(result.verification.passed, false);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), before);
  } finally {
    for (const worker of workers) git(cwd, 'worktree', 'remove', '--force', worker.worktree_path);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(cwd + '.otx-worktrees', { recursive: true, force: true });
  }
});
