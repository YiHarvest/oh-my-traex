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

test('dry-run forwards safe native TraeX options after managed arguments', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli.js', 'exec', '--dry-run', '--profile', 'work', '--ephemeral',
      '--allowed-tool', 'shell', '--output-last-message', 'result.txt', 'audit the API'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--profile work --ephemeral --allowed-tool shell --output-last-message result.txt/);
});

test('exec rejects native permission overrides managed by OTX', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli.js', 'exec', '--permission-mode', 'bypass_permissions', 'audit the API'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--permission-mode is managed by OTX/);
});

test('exec dry-run reads a task from piped stdin', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'exec', '--dry-run'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', input: 'audit from stdin\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /audit from stdin/);
});

test('exec appends piped stdin to an argument task exactly once', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'exec', '--dry-run', 'base task'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', input: 'extra context\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /base task[\s\S]*<stdin>[\s\S]*extra context[\s\S]*<\/stdin>/);
  assert.equal(result.stdout.match(/extra context/g)?.length, 1);
});

test('exec resume dry-run preserves the session and permission contract', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli.js', 'exec', 'resume', 'session-123', '--dry-run', '--json',
      '--allowed-tool', 'shell', 'finish the tests'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /traex exec resume --skip-git-repo-check/);
  assert.match(result.stdout, /--permission-mode custom/);
  assert.match(result.stdout, /approval_policy=/);
  assert.match(result.stdout, /--json --allowed-tool shell session-123 "<follow-up>"/);
  assert.doesNotMatch(result.stdout, /<oh_my_traex>/);
  assert.match(result.stdout, /finish the tests/);
});

test('exec resume --last reads a follow-up from piped stdin', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'exec', 'resume', '--last', '--dry-run'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', input: 'continue from stdin\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /traex exec resume --skip-git-repo-check .*--last "<follow-up>"/);
  assert.equal(result.stdout.match(/continue from stdin/g)?.length, 1);
});

test('exec resume exposes focused help and rejects permission overrides', () => {
  const help = spawnSync(process.execPath, ['src/cli.js', 'exec', 'resume', '--help'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /otx exec resume --last/);

  const rejected = spawnSync(
    process.execPath,
    ['src/cli.js', 'exec', 'resume', '--last', '--sandbox', 'danger-full-access'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--sandbox is managed by OTX/);
});

test('exec review dry-run forwards a revision selector and permission contract', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli.js', 'exec', 'review', '--base', 'main', '--dry-run', '--json',
      '--output-last-message', 'review.txt'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /traex exec review --skip-git-repo-check/);
  assert.match(result.stdout, /--permission-mode custom/);
  assert.match(result.stdout, /approval_policy=/);
  assert.match(result.stdout, /--base main --json --output-last-message review.txt/);
});

test('exec review reads custom instructions from stdin without orchestration wrapping', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'exec', 'review', '--dry-run', '-'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', input: 'focus on data races\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"<review-prompt>"/);
  assert.match(result.stdout, /focus on data races/);
  assert.doesNotMatch(result.stdout, /<oh_my_traex>/);
});

test('exec review exposes focused help and rejects mixed review scopes', () => {
  const help = spawnSync(process.execPath, ['src/cli.js', 'exec', 'review', '--help'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /otx exec review --uncommitted/);

  const mixed = spawnSync(
    process.execPath, ['src/cli.js', 'exec', 'review', '--base', 'main', 'extra instructions'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /revision selector or custom instructions/);
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

test('dashboard mode rejects native exec passthrough options', () => {
  const result = spawnSync(
    process.execPath,
    ['src/cli.js', 'exec', '--ui', 'dashboard', '--ephemeral', 'audit the API'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /native TraeX exec options cannot be used with --ui dashboard/);
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
