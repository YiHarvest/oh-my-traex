import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function startDashboardUi({ cwd, remoteUrl, env = process.env, run = spawnSync }) {
  const leaderPaneId = env.TMUX_PANE?.trim();
  if (!env.TMUX || !leaderPaneId) {
    throw new Error('--ui dashboard requires running otx inside tmux.');
  }

  const dashboardCommand = shellJoin([
    'exec',
    'traex',
    'dashboard',
    '--no-alt-screen',
    ...(remoteUrl ? ['--remote', remoteUrl] : []),
  ]);
  const split = run(
    'tmux',
    [
      'split-window',
      '-h',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      leaderPaneId,
      '-c',
      cwd,
      dashboardCommand,
    ],
    { cwd, env, encoding: 'utf8' },
  );
  if (split.error) throw split.error;
  if (split.status !== 0) {
    throw new Error(`failed to create TraeX dashboard pane: ${commandError(split)}`);
  }

  const dashboardPaneId = split.stdout.trim().split('\n')[0];
  if (!dashboardPaneId?.startsWith('%')) {
    throw new Error('tmux did not return a dashboard pane id.');
  }

  run('tmux', ['select-pane', '-t', leaderPaneId, '-T', 'otx leader'], { cwd, env, encoding: 'utf8' });
  run('tmux', ['select-pane', '-t', dashboardPaneId, '-T', 'TraeX dashboard'], { cwd, env, encoding: 'utf8' });
  run('tmux', ['select-layout', '-t', leaderPaneId, 'even-horizontal'], { cwd, env, encoding: 'utf8' });

  return { leaderPaneId, dashboardPaneId };
}

export function scheduleDashboardPrompt({ leaderPaneId, prompt, env = process.env, launch = spawn }) {
  if (!leaderPaneId?.startsWith('%')) throw new Error('invalid tmux leader pane id.');
  if (!prompt?.trim()) throw new Error('dashboard prompt must not be empty.');

  const promptDir = mkdtempSync(join(tmpdir(), 'otx-dashboard-'));
  const promptPath = join(promptDir, 'prompt.txt');
  writeFileSync(promptPath, prompt, { encoding: 'utf8', mode: 0o600 });

  const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'dashboard-submit.js');
  const child = launch(process.execPath, [helperPath, leaderPaneId, promptPath], {
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { promptPath, pid: child.pid };
}

export function startDashboardRuntime({ cwd, env = process.env, run = spawnSync, launch = spawn }) {
  const leaderPaneId = env.TMUX_PANE?.trim();
  if (!env.TMUX || !leaderPaneId) throw new Error('--ui dashboard requires running otx inside tmux.');

  const runDir = mkdtempSync(join(tmpdir(), 'otx-run-'));
  const port = reservePort(run);
  const remoteUrl = `ws://127.0.0.1:${port}`;
  const server = launch('traex', ['app-server', '--listen', remoteUrl, '--session-source', 'vscode'], {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
  });
  server.unref();

  waitForServer(port, run);
  const supervisor = launch(process.execPath, [
    join(dirname(fileURLToPath(import.meta.url)), 'supervisor-run.js'),
    '--remote', remoteUrl,
    '--cwd', cwd,
    '--leader-pane', leaderPaneId,
    '--state-dir', runDir,
  ], { cwd, env, detached: true, stdio: 'ignore' });
  supervisor.unref();

  return { leaderPaneId, remoteUrl, runDir, serverPid: server.pid, supervisorPid: supervisor.pid };
}

export function stopDashboardRuntime(runtime, { cwd, run = spawnSync } = {}) {
  if (runtime.dashboardPaneId?.startsWith('%')) {
    run('tmux', ['kill-pane', '-t', runtime.dashboardPaneId], { cwd, encoding: 'utf8' });
  }
  const childrenPath = join(runtime.runDir, 'children.json');
  if (existsSync(childrenPath)) {
    try {
      const children = JSON.parse(readFileSync(childrenPath, 'utf8'));
      for (const child of children) {
        if (child.paneId?.startsWith('%')) run('tmux', ['kill-pane', '-t', child.paneId], { cwd, encoding: 'utf8' });
      }
    } catch {
      // Best-effort cleanup; preserve run artifacts for diagnosis.
    }
  }
  for (const pid of [runtime.supervisorPid, runtime.serverPid]) {
    if (!Number.isInteger(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

function reservePort(run) {
  const script = [
    'const net=require("node:net")',
    'const s=net.createServer()',
    's.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})',
  ].join(';');
  const result = run(process.execPath, ['-e', script], { encoding: 'utf8' });
  const port = Number(result.stdout?.trim());
  if (result.error || result.status !== 0 || !Number.isInteger(port)) throw new Error('failed to reserve app-server port.');
  return port;
}

function waitForServer(port, run) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = run('curl', ['--silent', '--fail', `http://127.0.0.1:${port}/readyz`], { encoding: 'utf8' });
    if (result.status === 0) return;
    sleepSync(100);
  }
  throw new Error('TraeX app-server did not become ready.');
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function shellJoin(parts) {
  return parts.map(shellQuote).join(' ');
}

function shellQuote(value) {
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function commandError(result) {
  return String(result.stderr || result.stdout || `exit ${result.status}`).trim();
}
