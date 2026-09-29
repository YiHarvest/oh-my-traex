import { spawnSync } from 'node:child_process';
import { teamStatus } from './runtime.js';

export const DEFAULT_HUD_INTERVAL_MS = 1000;

export function buildTeamHud(state, { width = 100 } = {}) {
  const workers = state.workers || [];
  const counts = countBy(workers, (worker) => worker.status || 'unknown');
  const unhealthy = workers.filter((worker) => ['failed', 'cancelled', 'dead', 'stale', 'stalled'].includes(worker.health)).length;
  const header = [
    `OTX ${state.config.name}`, state.config.status, `workers ${workers.length}`,
    `working ${counts.working || 0}`, `done ${counts.completed || 0}`, `attention ${unhealthy}`,
  ].join(' | ');
  const lines = workers.map((worker) => {
    const task = worker.current_task_id || worker.initial_task_id || '-';
    const health = worker.health || worker.status || 'unknown';
    const activity = formatAge(worker.activity_age_ms ?? worker.heartbeat_age_ms);
    return `${statusMark(health)} ${worker.name} [${worker.role}] ${worker.status} task=${task} activity=${activity}`;
  });
  return [truncate(header, width), ...lines.map((line) => truncate(line, width))].join('\n');
}

export function readTeamHud(cwd, name, { run = spawnSync } = {}) {
  return teamStatus(cwd, name, run);
}

export async function watchTeamHud(cwd, name, {
  intervalMs = DEFAULT_HUD_INTERVAL_MS, run = spawnSync, signal, output = process.stdout, width = output.columns || 100,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 250) throw new Error('HUD interval must be an integer of at least 250ms.');
  let first = true;
  try {
    while (!signal?.aborted) {
      const frame = buildTeamHud(readTeamHud(cwd, name, { run }), { width });
      output.write(`${first ? '\x1b[?25l' : ''}\x1b[H\x1b[2J${frame}\n`);
      first = false;
      if (signal?.aborted) break;
      await delay(intervalMs, signal);
    }
  } finally {
    if (!first) output.write('\x1b[?25h');
  }
}

export function openTeamHud(cwd, name, {
  env = process.env, run = spawnSync, cliPath = process.argv[1], intervalMs = DEFAULT_HUD_INTERVAL_MS,
} = {}) {
  if (!env.TMUX || !env.TMUX_PANE?.startsWith('%')) throw new Error('otx team hud --tmux requires running in the team leader tmux pane.');
  const state = readTeamHud(cwd, name, { run });
  if (state.config.mux_backend !== 'tmux' || state.config.leader_pane_id !== env.TMUX_PANE) {
    throw new Error('otx team hud --tmux must be launched from this team leader pane.');
  }
  const marker = '#{pane_id}\t#{@otx_hud_team}\t#{@otx_hud_leader}\t#{@otx_hud_run_id}';
  const panes = tmux(run, ['list-panes', '-t', env.TMUX_PANE, '-F', marker]).stdout.trim().split(/\r?\n/);
  for (const line of panes) {
    const [paneId, team, leader, runId] = line.split('\t');
    if (paneId?.startsWith('%') && team === name && leader === env.TMUX_PANE && runId === state.config.run_id) {
      return { pane_id: paneId, reused: true };
    }
  }
  const command = shellJoin([process.execPath, cliPath, 'team', 'hud', name, '-C', cwd, '--watch', '--interval-ms', String(intervalMs)]);
  const split = tmux(run, [
    'split-window', '-v', '-l', String(Math.min(8, Math.max(3, state.workers.length + 2))),
    '-d', '-P', '-F', '#{pane_id}', '-t', env.TMUX_PANE, '-c', cwd, command,
  ]);
  const paneId = split.stdout.trim().split(/\r?\n/)[0];
  if (!paneId?.startsWith('%')) throw new Error('tmux did not return a HUD pane ID.');
  tmux(run, ['set-option', '-p', '-t', paneId, '@otx_hud_team', name]);
  tmux(run, ['set-option', '-p', '-t', paneId, '@otx_hud_leader', env.TMUX_PANE]);
  tmux(run, ['set-option', '-p', '-t', paneId, '@otx_hud_run_id', state.config.run_id]);
  tmux(run, ['select-pane', '-t', paneId, '-T', `otx ${name} HUD`]);
  return { pane_id: paneId, reused: false };
}

function countBy(items, select) {
  const counts = {};
  for (const item of items) counts[select(item)] = (counts[select(item)] || 0) + 1;
  return counts;
}

function statusMark(health) {
  if (health === 'completed') return '✓';
  if (['failed', 'cancelled', 'dead', 'stale', 'stalled'].includes(health)) return '!';
  return '·';
}

function formatAge(value) {
  if (!Number.isFinite(value)) return '-';
  if (value < 1000) return '<1s';
  if (value < 60_000) return `${Math.floor(value / 1000)}s`;
  return `${Math.floor(value / 60_000)}m`;
}

function truncate(value, width) {
  if (!Number.isInteger(width) || width < 10 || value.length <= width) return value;
  return `${value.slice(0, width - 1)}…`;
}

function tmux(run, args) {
  const result = run('tmux', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(String(result.error?.message || result.stderr || 'tmux failed').trim());
  return result;
}

function shellJoin(parts) {
  return parts.map((value) => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ');
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
