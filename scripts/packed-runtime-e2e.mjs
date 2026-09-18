import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) {
  throw new Error('packed runtime E2E requires tmux');
}

const projectRoot = new URL('..', import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'otx-packed-runtime-'));
const installRoot = join(root, 'install');
const repo = join(root, 'repo');
const binDir = join(root, 'bin');
const cache = join(root, 'npm-cache');
const session = `otx-e2e-${process.pid}`;

try {
  run('mkdir', ['-p', installRoot, repo, binDir]);
  const pack = run('npm', ['pack', '--pack-destination', root], {
    cwd: projectRoot,
    env: { ...process.env, npm_config_cache: cache },
  });
  const tarball = join(root, pack.stdout.trim().split('\n').at(-1));
  run('npm', ['install', '--prefix', installRoot, tarball], {
    env: { ...process.env, npm_config_cache: cache },
  });
  const otx = join(installRoot, 'node_modules', '.bin', 'otx');
  const fakeTraex = join(binDir, 'traex');
  writeFileSync(fakeTraex, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Commands: resume app-server\\n--json --sandbox --session-id --output-last-message --config --remote-auth-token-env\\n');
  process.exit(0);
}
if (args[0] === 'exec') {
  const outputIndex = args.indexOf('--output-last-message');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-' + process.pid }) + '\\n');
  if (args[1] === 'resume') await new Promise((resolve) => setTimeout(resolve, 10000));
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, 'packed runtime fixture completed\\n'); }
  process.exit(0);
}
process.exit(0);
`, 'utf8');
  chmodSync(fakeTraex, 0o755);

  run('git', ['init', '-q'], { cwd: repo });
  run('git', ['config', 'user.email', 'otx@example.com'], { cwd: repo });
  run('git', ['config', 'user.name', 'OTX E2E'], { cwd: repo });
  run('git', ['commit', '--allow-empty', '-qm', 'base'], { cwd: repo });
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  const launch = shellJoin([otx, 'team', '2:reviewer', '--no-plan', '--name', 'e2e', '-C', repo, 'packed runtime']);
  run('tmux', ['new-session', '-d', '-s', session, '-c', repo, launch], { env });

  const stateDir = join(repo, '.git', 'otx', 'team', 'e2e');
  await waitFor(() => existsSync(join(stateDir, 'config.json')), 'team config');
  await waitFor(() => readWorker(stateDir, 'worker-1').status === 'completed'
    && readWorker(stateDir, 'worker-2').status === 'completed', 'initial workers');
  const config = readJson(join(stateDir, 'config.json'));
  assert.ok(config.supervisor_pane_id?.startsWith('%'), 'supervisor pane was not persisted');

  run(otx, ['team', 'assign', 'e2e', 'worker-1', '-C', repo, '--', 'crash and reschedule'], { env });
  await waitFor(() => readWorker(stateDir, 'worker-1').current_task_id, 'follow-up claim');
  const crashedPane = readWorker(stateDir, 'worker-1').pane_id;
  run('tmux', ['kill-pane', '-t', crashedPane], { env });
  await waitFor(() => {
    const tasks = taskRecords(stateDir);
    return tasks.some((task) => task.reschedule_count === 1 && task.owner === 'worker-2');
  }, 'supervisor reschedule');

  run(otx, ['team', 'stop', 'e2e', '-C', repo, '--json'], { env });
  const cleanup = run(otx, ['team', 'cleanup', 'e2e', '-C', repo], { env });
  assert.match(cleanup.stdout, /"ok": true/, 'packed runtime cleanup did not complete');
  process.stdout.write('packed runtime E2E passed: install, tmux startup, crash reschedule, stop, cleanup\n');
} finally {
  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result;
}

async function waitFor(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (check()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function readWorker(stateDir, name) {
  return readJson(join(stateDir, 'workers', `${name}.json`));
}

function taskRecords(stateDir) {
  return spawnSync('find', [join(stateDir, 'tasks'), '-name', 'task-*.json', '-print0'], { encoding: 'buffer' }).stdout
    .toString().split('\0').filter(Boolean).map(readJson);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function shellJoin(parts) {
  return parts.map((value) => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ');
}
