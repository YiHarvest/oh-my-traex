import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  addWorker,
  assignTeamTask,
  integrateTeam,
  readTeamMailbox,
  sendTeamMessage,
  stopTeam,
  teamStatus,
} from '../src/team/runtime.js';
import { listTeamStates } from '../src/team/state.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const options = parseArgs(process.argv.slice(2));
const repoRoot = resolveRepository(options.repo);
const dashboardToken = process.env.OTX_DASHBOARD_TOKEN || randomBytes(32).toString('base64url');
const clients = new Set();
let lastSnapshotHash = '';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/health') {
      authorizeApiRequest(request, url);
      return sendJson(response, 200, { ok: true, clients: clients.size });
    }
    if (request.method === 'GET' && url.pathname === '/api/snapshot') {
      authorizeApiRequest(request, url);
      return sendJson(response, 200, collectSnapshot());
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      authorizeApiRequest(request, url);
      return openEventStream(request, response);
    }
    if (request.method === 'POST' && url.pathname === '/api/actions') {
      authorizeApiRequest(request, url, true);
      const body = await readJsonBody(request);
      const result = runAction(body);
      broadcastSnapshot(true);
      return sendJson(response, 200, { ok: true, result });
    }
    return serveStatic(url.pathname, response);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
  }
});

server.listen(options.port, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  process.stdout.write('oh-my-traex live dashboard: http://127.0.0.1:' + port + '/#token=' + dashboardToken + '\n');
  process.stdout.write('repository: ' + repoRoot + '\n');
});

const poller = setInterval(() => broadcastSnapshot(false), options.pollMs);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function parseArgs(args) {
  const parsed = { port: Number(process.env.PORT || 4173), repo: process.cwd(), pollMs: 1000 };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--repo' || token === '-C') parsed.repo = requireValue(args, ++index, token);
    else if (token === '--port') parsed.port = Number(requireValue(args, ++index, token));
    else if (token === '--poll-ms') parsed.pollMs = Number(requireValue(args, ++index, token));
    else throw new Error('Unknown dashboard option: ' + token);
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 0 || parsed.port > 65535) throw new Error('Invalid dashboard port.');
  if (!Number.isInteger(parsed.pollMs) || parsed.pollMs < 250) throw new Error('--poll-ms must be at least 250.');
  return parsed;
}

function resolveRepository(candidate) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: resolve(candidate), encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Dashboard repository must be a Git worktree.');
  return resolve(result.stdout.trim());
}

function collectSnapshot() {
  const teams = listTeamStates(repoRoot).map((config) => collectTeam(config.name));
  return {
    mode: 'live',
    repo: repoRoot,
    generated_at: new Date().toISOString(),
    teams,
    summary: {
      teams: teams.length,
      running: teams.filter((team) => team.config.status === 'running').length,
      workers: teams.reduce((count, team) => count + team.workers.length, 0),
      unhealthy: teams.reduce((count, team) => count + team.workers.filter((worker) => ['dead', 'stale', 'stalled', 'failed'].includes(worker.health)).length, 0),
    },
  };
}

function collectTeam(name) {
  const state = teamStatus(repoRoot, name);
  const mailboxes = Object.fromEntries(state.workers.map((worker) => [
    worker.name,
    readTeamMailbox(repoRoot, name, worker.name).messages,
  ]));
  return {
    state_dir: state.stateDir,
    config: state.config,
    tasks: state.tasks,
    mailboxes,
    workers: state.workers.map((worker) => ({
      ...worker,
      terminal_lines: readWorkerOutput(worker),
      mailbox_count: mailboxes[worker.name].length,
      mailbox_pending: mailboxes[worker.name].filter((message) => ['pending', 'working'].includes(message.status)).length,
    })),
  };
}

function readWorkerOutput(worker) {
  if (worker.pane_alive && worker.pane_id) {
    const capture = spawnSync('tmux', ['capture-pane', '-p', '-J', '-S', '-80', '-t', worker.pane_id], { encoding: 'utf8' });
    if (capture.status === 0) return capture.stdout.split('\n').filter(Boolean).slice(-80);
  }
  if (worker.result_path && existsSync(worker.result_path)) {
    return readFileSync(worker.result_path, 'utf8').split('\n').filter(Boolean).slice(-40);
  }
  return [];
}

function openEventStream(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write('retry: 1500\n\n');
  clients.add(response);
  writeEvent(response, 'snapshot', collectSnapshot());
  const keepAlive = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
  request.once('close', () => {
    clearInterval(keepAlive);
    clients.delete(response);
  });
}

function broadcastSnapshot(force) {
  let snapshot;
  try {
    snapshot = collectSnapshot();
  } catch (error) {
    for (const client of clients) writeEvent(client, 'monitor-error', { error: error.message, at: new Date().toISOString() });
    return;
  }
  const stable = JSON.stringify({ ...snapshot, generated_at: null });
  const hash = createHash('sha256').update(stable).digest('hex');
  if (!force && hash === lastSnapshotHash) return;
  lastSnapshotHash = hash;
  for (const client of clients) writeEvent(client, 'snapshot', snapshot);
}

function writeEvent(response, event, data) {
  response.write('event: ' + event + '\n');
  response.write('data: ' + JSON.stringify(data) + '\n\n');
}

function runAction(body) {
  if (!body || typeof body.action !== 'string') throw new Error('action is required.');
  if (body.action === 'start-team') return startTeamFromDashboard(body);
  const team = safeName(body.team, 'team');
  if (body.action === 'stop-team') return stopDashboardTeam(team);
  if (body.action === 'send-message') {
    return sendTeamMessage(repoRoot, team, safeName(body.worker, 'worker'), requireText(body.message, 'message'));
  }
  if (body.action === 'assign-task') {
    const dependencies = Array.isArray(body.depends_on) ? body.depends_on.map((value) => String(value)) : [];
    return assignTeamTask(repoRoot, team, safeName(body.worker, 'worker'), requireText(body.description, 'description'), dependencies);
  }
  if (body.action === 'integrate-team') {
    const workers = Array.isArray(body.workers) ? body.workers.map((value) => safeName(value, 'worker')) : [];
    return integrateTeam(repoRoot, team, workers);
  }
  if (body.action === 'add-worker') {
    const role = safeName(body.role, 'role');
    const state = teamStatus(repoRoot, team);
    const target = state.config.leader_pane_id || state.workers.find((worker) => worker.pane_alive)?.pane_id;
    if (!target) throw new Error('team has no live pane available for worker placement.');
    return addWorker(repoRoot, team, role, requireText(body.assignment, 'assignment'), {
      model: body.model ? requireText(body.model, 'model') : undefined,
      env: { ...process.env, TMUX: process.env.TMUX || 'dashboard-control', TMUX_PANE: target },
    });
  }
  throw new Error('Unsupported dashboard action: ' + body.action);
}

function stopDashboardTeam(team) {
  const stopped = stopTeam(repoRoot, team);
  const sessionName = 'otx-web-' + team;
  const leaderPane = stopped.config.leader_pane_id;
  if (leaderPane) {
    const owner = spawnSync('tmux', ['display-message', '-p', '-t', leaderPane, '#S\t#{@otx_team}\t#{@otx_worker}\t#{@otx_run_id}'], { encoding: 'utf8' });
    const [session, ownerTeam, ownerWorker, runId] = owner.stdout?.trim().split('\t') || [];
    if (owner.status === 0 && session === sessionName && ownerTeam === team
      && ownerWorker === 'leader' && runId === stopped.config.run_id) {
      spawnSync('tmux', ['kill-session', '-t', sessionName], { encoding: 'utf8' });
    }
  }
  return stopped;
}

function startTeamFromDashboard(body) {
  const title = requireText(body.title, 'title');
  const workers = Math.max(1, Math.min(6, Number(body.workers) || 3));
  const teamName = body.team ? safeName(body.team, 'team') : 'dashboard-' + Date.now().toString(36).slice(-6);
  const sessionName = 'otx-web-' + teamName;
  const role = body.role ? safeRole(body.role) : null;
  const descriptor = role ? String(workers) + ':' + role : String(workers);
  const command = [process.execPath, cliPath, 'team', descriptor, '--name', teamName];
  if (body.model) command.push('--model', requireText(body.model, 'model'));
  if (body.auto_plan === false) command.push('--no-plan');
  command.push(title);
  const result = spawnSync('tmux', ['new-session', '-d', '-x', '160', '-y', '48', '-s', sessionName, '-c', repoRoot, shellJoin(command)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Failed to start tmux team.').trim());
  return { team: teamName, tmux_session: sessionName };
}

function safeRole(value) {
  const role = safeName(value, 'role');
  const allowed = new Set(['executor', 'test-engineer', 'reviewer', 'explorer', 'architect']);
  if (!allowed.has(role)) throw new Error('role is not supported.');
  return role;
}

function serveStatic(pathname, response) {
  let relative = pathname === '/' ? 'index.html' : normalize(pathname);
  while (relative.startsWith('/') || relative.startsWith('\\')) relative = relative.slice(1);
  const filePath = resolve(root, relative);
  if (!(filePath === root || filePath.startsWith(root + '/')) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  if (relative === 'index.html') {
    const snapshot = JSON.stringify(collectSnapshot()).replaceAll('<', '\u003c');
    const html = readFileSync(filePath, 'utf8').replace(
      '<!-- OTX_LIVE_BOOTSTRAP -->',
      '<script>window.__OTX_LIVE_SNAPSHOT__=' + snapshot + ';</script>',
    );
    response.writeHead(200, {
      'content-type': contentTypes['.html'],
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    response.end(html);
    return;
  }
  response.writeHead(200, {
    'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(response);
}

function readJsonBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error('Request body is too large.'));
    });
    request.once('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.once('error', reject);
  });
}

function authorizeApiRequest(request, url, requireOrigin = false) {
  const supplied = request.headers['x-otx-token'] || url.searchParams.get('token') || '';
  const expected = Buffer.from(dashboardToken);
  const actual = Buffer.from(String(supplied));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    const error = new Error('Dashboard authorization failed.');
    error.statusCode = 401;
    throw error;
  }
  const expectedOrigin = `http://${request.headers.host}`;
  const origin = request.headers.origin;
  if ((requireOrigin && !origin) || (origin && origin !== expectedOrigin)) {
    const error = new Error('Dashboard origin check failed.');
    error.statusCode = 403;
    throw error;
  }
}

function safeName(value, label) {
  const text = requireText(value, label);
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(text)) throw new Error(label + ' has an invalid format.');
  return text;
}

function requireText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 4000) throw new Error(label + ' is required and must be at most 4000 characters.');
  return text;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('-')) throw new Error(flag + ' requires a value.');
  return value;
}

function shellJoin(parts) {
  return parts.map((value) => /^[a-zA-Z0-9_./:=+-]+$/.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\"'\"'") + "'").join(' ');
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function shutdown() {
  clearInterval(poller);
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}
