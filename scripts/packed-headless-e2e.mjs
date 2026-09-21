import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = new URL('..', import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'otx-packed-headless-'));
const installRoot = join(root, 'install');
const repo = join(root, 'repo');
const binDir = join(root, 'bin');
const cache = join(root, 'npm-cache');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('packed headless E2E must be started through npm');

try {
  for (const directory of [installRoot, repo, binDir]) mkdirSync(directory, { recursive: true });
  const pack = run(process.execPath, [npmCli, 'pack', '--pack-destination', root], {
    cwd: projectRoot,
    env: { ...process.env, npm_config_cache: cache },
  });
  const tarball = join(root, pack.stdout.trim().split(/\r?\n/).at(-1));
  run(process.execPath, [npmCli, 'install', '--prefix', installRoot, tarball], {
    env: { ...process.env, npm_config_cache: cache },
  });

  const otx = process.execPath;
  const otxEntry = join(installRoot, 'node_modules', 'oh-my-traex', 'src', 'cli.js');
  const fixtureEnv = installFakeTraex(binDir);
  run('git', ['init', '-q'], { cwd: repo });
  run('git', ['config', 'user.email', 'otx@example.com'], { cwd: repo });
  run('git', ['config', 'user.name', 'OTX E2E'], { cwd: repo });
  run('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: repo });

  const env = { ...process.env, ...fixtureEnv, PATH: `${binDir}${delimiter}${process.env.PATH || ''}` };
  run(otx, [otxEntry, 'team', '1:reviewer', '--headless', '--no-plan', '--name', 'headless', '-C', repo, 'packed headless runtime'], { env });
  const stateDir = join(repo, '.git', 'otx', 'team', 'headless');
  await waitFor(() => readWorker(stateDir).status === 'completed', 'headless worker');

  const config = readJson(join(stateDir, 'config.json'));
  const worker = readWorker(stateDir);
  assert.equal(config.mux_backend, 'headless');
  assert.match(worker.pane_id, /^process:/);
  assert.ok(Number.isInteger(worker.pane_pid), 'headless worker PID was not persisted');
  assert.ok(Number.isInteger(config.supervisor_pane_pid), 'headless supervisor PID was not persisted');
  assert.ok(worker.process_identity, 'headless worker process identity was not persisted');
  assert.ok(config.supervisor_process_identity, 'headless supervisor process identity was not persisted');

  run(otx, [otxEntry, 'team', 'stop', 'headless', '-C', repo, '--json'], { env });
  await waitFor(() => !processAlive(worker.pane_pid) && !processAlive(config.supervisor_pane_pid), 'headless shutdown');
  const cleanup = run(otx, [otxEntry, 'team', 'cleanup', 'headless', '-C', repo], { env });
  assert.match(cleanup.stdout, /"ok": true/, 'packed headless cleanup did not complete');
  assert.equal(readJson(join(stateDir, 'config.json')).status, 'cleaned', 'packed headless cleanup did not finalize state');
  assert.equal(existsSync(worker.worktree_path), false, 'packed headless cleanup left its worker worktree behind');
  process.stdout.write(`packed headless E2E passed on ${process.platform}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function installFakeTraex(directory) {
  const fixture = join(directory, 'fake-traex.mjs');
  writeFileSync(fixture, `
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
const isFixtureProcess = process.platform !== 'win32' || basename(process.execPath).toLowerCase() === 'traex.exe';
if (isFixtureProcess) {
  const args = process.platform === 'win32'
    ? [basename(process.argv[1]), ...process.argv.slice(2)]
    : process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Commands: resume app-server\\n--json --sandbox --permission-mode --session-id --output-last-message --config --remote-auth-token-env\\n');
    process.exit(0);
  }
  if (args[0] === 'exec') {
    const outputIndex = args.indexOf('--output-last-message');
    const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-' + process.pid }) + '\\n');
    if (args[1] === 'resume') await new Promise((resolve) => setTimeout(resolve, 10000));
    if (output) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, 'packed headless fixture completed\\n');
    }
    process.exit(0);
  }
  process.exit(0);
}
`, 'utf8');

  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(directory, 'traex.exe'));
    const importOption = `--import=${pathToFileURL(fixture).href}`;
    return { NODE_OPTIONS: [process.env.NODE_OPTIONS, importOption].filter(Boolean).join(' ') };
  }
  const launcher = join(directory, 'traex');
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, 'utf8');
  chmodSync(launcher, 0o755);
  return {};
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result;
}

async function waitFor(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (check()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function readWorker(stateDir) {
  return readJson(join(stateDir, 'workers', 'worker-1.json'));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
