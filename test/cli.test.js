import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('dry-run renders a safe TraeX exec command without starting a session', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli.js', 'exec', '--dry-run', '--read-only', '-n', '2', 'audit the API'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /traex exec --skip-git-repo-check/);
  assert.match(result.stdout, /--permission-mode custom/);
  assert.match(result.stdout, /approval_policy=/);
  assert.match(result.stdout, /--sandbox read-only/);
  assert.match(result.stdout, /Maximum simultaneously active child agents: 2/);
  assert.match(result.stdout, /audit the API/);
});

test('run remains a compatibility alias for exec', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli.js', 'run', '--dry-run', 'audit the API'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /traex exec --skip-git-repo-check/);
});

test('dashboard dry-run reports the planned UI without requiring tmux', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli.js', 'exec', '--dry-run', '--ui', 'dashboard', 'audit the API'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ui: start a shared TraeX dashboard leader and sibling monitor pane/);
});

test('dashboard mode rejects JSON exec output', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli.js', 'exec', '--ui', 'dashboard', '--json', 'audit the API'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--json cannot be used with --ui dashboard/);
});

test('live dashboard help does not start a server', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'dashboard', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /otx dashboard \[-C repository\]/);
});

test('live doctor help does not start a model call', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'doctor', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /otx doctor [--live]/);
});
