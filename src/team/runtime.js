import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { buildLeaderPrompt, buildWorkerPrompt } from './prompt.js';
import { assertTeamDoesNotExist, defaultTeamName, enqueueMailboxMessage, initTeamState, readMailbox, readTeamState, sanitizeTeamName, updateMailboxMessage, updateTaskState, updateTeamConfig, updateWorkerState } from './state.js';
import { assertCleanWorkspace, createWorkerWorktrees, rollbackWorkerWorktrees, worktreeStatus } from './worktree.js';

export function startTeam({ cwd, task, workerCount, model, teamName, baseRole, env = process.env, run = spawnSync }) {
  if (!env.TMUX || !env.TMUX_PANE) throw new Error('otx team requires running inside tmux.');
  const name = teamName ? sanitizeTeamName(teamName) : defaultTeamName(task);
  const roles = ['executor', 'test-engineer', 'reviewer', 'explorer', 'architect'];
  const workers = Array.from({ length: workerCount }, (_, index) => ({
    name: `worker-${index + 1}`,
    index: index + 1,
    role: baseRole || roles[index % roles.length],
    assignment: assignmentFor(baseRole || roles[index % roles.length], workerCount, task),
    requires_commit: ['executor', 'test-engineer'].includes(baseRole || roles[index % roles.length]),
    status: 'starting',
  }));
  const repoRootResult = run('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (repoRootResult.status !== 0) throw new Error('otx team requires a Git repository.');
  const repoRoot = repoRootResult.stdout.trim();
  assertCleanWorkspace(repoRoot);
  assertTeamDoesNotExist(repoRoot, name);
  const worktreeWorkers = createWorkerWorktrees({ repoRoot, teamName: name, workers });
  const leaderSessionId = randomUUID();
  let stateDir;
  let config;
  try {
    ({ stateDir, config } = initTeamState({
      cwd: repoRoot,
      name,
      task,
      leaderPaneId: env.TMUX_PANE,
      leaderSessionId,
      workers: worktreeWorkers,
    }));
  } catch (error) {
    rollbackWorkerWorktrees(repoRoot, worktreeWorkers);
    throw error;
  }
  const runner = join(dirname(fileURLToPath(import.meta.url)), 'worker-run.js');
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  const createdPanes = [];

  try {
    for (const worker of worktreeWorkers) {
      const workerDir = join(stateDir, 'workers', worker.name);
      mkdirSync(workerDir, { recursive: true });
      const promptPath = join(workerDir, 'prompt.md');
      const resultPath = join(workerDir, 'result.md');
      const sessionId = randomUUID();
      writeFileSync(promptPath, buildWorkerPrompt({ teamName: name, worker, task }), 'utf8');
      const command = shellJoin([process.execPath, runner, stateDir, worker.name, worker.worktree_path, promptPath, resultPath, sessionId, model || '']);
      const split = run('tmux', ['split-window', worker.index === 1 ? '-h' : '-v', '-d', '-P', '-F', '#{pane_id}', '-t', env.TMUX_PANE, '-c', worker.worktree_path, command], { cwd: repoRoot, encoding: 'utf8' });
      if (split.status !== 0) throw new Error(String(split.stderr || 'failed to create worker pane').trim());
      const paneId = split.stdout.trim().split('\n')[0];
      if (!paneId.startsWith('%')) throw new Error('tmux did not return a worker pane ID.');
      createdPanes.push(paneId);
      runTmuxOrThrow(run, ['set-option', '-p', '-t', paneId, '@otx_team', name]);
      runTmuxOrThrow(run, ['set-option', '-p', '-t', paneId, '@otx_worker', worker.name]);
      runTmuxOrThrow(run, ['set-option', '-p', '-t', paneId, '@otx_run_id', config.run_id]);
      run('tmux', ['select-pane', '-t', paneId, '-T', `${worker.name} [${worker.role}]`], { encoding: 'utf8' });
      const panePid = readPanePid(run, paneId);
      updateWorkerState(stateDir, worker.name, { pane_id: paneId, pane_pid: panePid, session_id: sessionId, result_path: resultPath, prompt_path: promptPath });
    }
    run('tmux', ['select-layout', '-t', env.TMUX_PANE, 'main-vertical'], { encoding: 'utf8' });
    return {
      name,
      stateDir,
      config,
      workers: readTeamState(repoRoot, name).workers,
      leaderPrompt: buildLeaderPrompt({ teamName: name, task, stateDir, workers: worktreeWorkers, cliPath }),
    };
  } catch (error) {
    for (const paneId of createdPanes) run('tmux', ['kill-pane', '-t', paneId], { encoding: 'utf8' });
    const cleanupDebt = rollbackWorkerWorktrees(repoRoot, worktreeWorkers);
    if (stateDir) updateTeamConfig(stateDir, {
      status: 'failed',
      error: error.message,
      cleanup_debt: cleanupDebt,
    });
    throw error;
  }
}

export function teamStatus(cwd, name, run = spawnSync) {
  const state = readTeamState(cwd, name);
  state.workers = state.workers.map((worker) => {
    const paneAlive = paneOwnedBy(run, worker, state.config);
    const startupGrace = worker.status === 'starting'
      && Date.now() - Date.parse(worker.updated_at || state.config.created_at) < 10_000;
    if (!paneAlive && !startupGrace && ['starting', 'working'].includes(worker.status)) {
      const failed = updateWorkerState(state.stateDir, worker.name, {
        status: 'failed',
        error: 'worker pane exited before recording a terminal result',
        completed_at: new Date().toISOString(),
        pane_alive: false,
        dirty: worktreeStatus(worker.worktree_path) !== '',
      });
      updateTaskState(state.stateDir, String(worker.index), {
        status: 'failed',
        error: failed.error,
        completed_at: failed.completed_at,
      });
      return failed;
    }
    return { ...worker, pane_alive: paneAlive, dirty: worktreeStatus(worker.worktree_path) !== '' };
  });
  if (state.config.status === 'running' && state.workers.every((worker) => ['completed', 'failed'].includes(worker.status))) {
    state.config = updateTeamConfig(state.stateDir, {
      status: state.workers.some((worker) => worker.status === 'failed') ? 'failed' : 'ready',
      completed_at: new Date().toISOString(),
    });
  }
  return state;
}

export async function awaitTeam(cwd, name, timeoutMs = 3_600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = teamStatus(cwd, name);
    if (state.workers.every((worker) => ['completed', 'failed', 'cancelled'].includes(worker.status))) return state;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`timed out waiting for team ${name}`);
}

export function stopTeam(cwd, name, run = spawnSync) {
  const state = readTeamState(cwd, name);
  for (const worker of state.workers) {
    const terminal = ['completed', 'failed', 'cancelled'].includes(worker.status);
    if (!terminal) {
      const stoppedAt = new Date().toISOString();
      updateWorkerState(state.stateDir, worker.name, {
        status: 'cancelled',
        error: 'stopped by team leader',
        completed_at: stoppedAt,
      });
      if (worker.current_message_id) {
        updateMailboxMessage(state.stateDir, worker.name, worker.current_message_id, {
          status: 'cancelled', error: 'stopped by team leader', completed_at: stoppedAt,
        });
      } else {
        updateTaskState(state.stateDir, String(worker.index), {
          status: 'cancelled', error: 'stopped by team leader', completed_at: stoppedAt,
        });
      }
    }
    if (paneOwnedBy(run, worker, state.config)) run('tmux', ['kill-pane', '-t', worker.pane_id], { encoding: 'utf8' });
  }
  updateTeamConfig(state.stateDir, { status: 'stopped', stopped_at: new Date().toISOString() });
  return teamStatus(cwd, name, run);
}

export function sendTeamMessage(cwd, name, workerName, message) {
  const state = teamStatus(cwd, name);
  const worker = state.workers.find((candidate) => candidate.name === workerName);
  if (!worker) throw new Error(`worker not found: ${workerName}`);
  if (!worker.pane_alive) throw new Error(`worker is not running: ${workerName}`);
  const created = enqueueMailboxMessage(state.stateDir, workerName, message);
  updateWorkerState(state.stateDir, workerName, { status: 'queued', current_message_id: created.id });
  updateTeamConfig(state.stateDir, { status: 'running', completed_at: null });
  return created;
}

export function broadcastTeamMessage(cwd, name, message) {
  const state = teamStatus(cwd, name);
  const workers = state.workers.filter((worker) => worker.pane_alive);
  if (workers.length === 0) throw new Error(`team has no running workers: ${name}`);
  const messages = workers.map((worker) => {
    const created = enqueueMailboxMessage(state.stateDir, worker.name, message);
    updateWorkerState(state.stateDir, worker.name, { status: 'queued', current_message_id: created.id });
    return { worker: worker.name, message: created };
  });
  updateTeamConfig(state.stateDir, { status: 'running', completed_at: null });
  return messages;
}

export function readTeamMailbox(cwd, name, workerName) {
  const state = readTeamState(cwd, name);
  if (!state.workers.some((worker) => worker.name === workerName)) {
    throw new Error(`worker not found: ${workerName}`);
  }
  return readMailbox(state.stateDir, workerName);
}

export function resumeTeam(cwd, name, { model, env = process.env, run = spawnSync } = {}) {
  if (!env.TMUX || !env.TMUX_PANE) throw new Error('otx team resume requires running inside tmux.');
  const state = readTeamState(cwd, name);
  updateTeamConfig(state.stateDir, { leader_pane_id: env.TMUX_PANE, status: 'running', resumed_at: new Date().toISOString() });
  const args = ['resume', '--no-alt-screen', '-C', state.config.cwd];
  if (model) args.push('--model', model);
  args.push(state.config.leader_session_id, `Resume leadership of OTX team "${name}". Run team status, inspect worker results, integrate valid commits, verify the objective, then stop the team.`);
  return run('traex', args, { cwd: state.config.cwd, stdio: 'inherit' });
}

function paneOwnedBy(run, workerState, config) {
  const paneId = workerState.pane_id;
  if (!paneId?.startsWith('%')) return false;
  const result = run('tmux', ['display-message', '-p', '-t', paneId, '#{@otx_team}\t#{@otx_worker}\t#{@otx_run_id}\t#{pane_pid}\t#{pane_dead}'], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  const [team, worker, runId, panePid, dead] = result.stdout.trim().split('\t');
  return team === config.name && worker === workerState.name && runId === config.run_id
    && Number(panePid) === workerState.pane_pid && dead === '0';
}

function readPanePid(run, paneId) {
  const result = run('tmux', ['display-message', '-p', '-t', paneId, '#{pane_pid}'], { encoding: 'utf8' });
  const pid = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isInteger(pid)) throw new Error(`failed to read pane PID for ${paneId}`);
  return pid;
}

function runTmuxOrThrow(run, args) {
  const result = run('tmux', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || 'tmux failed';
    throw new Error(String(detail).trim());
  }
}

function assignmentFor(role, count, task) {
  const lanes = {
    executor: 'Implement the primary code path for the objective. Own a coherent, non-overlapping module slice and commit it.',
    'test-engineer': 'Implement or improve tests and independently verify the objective. Avoid editing the primary implementation files unless necessary.',
    reviewer: 'Review architecture, integration risks, regressions, and missing behavior. Produce an evidence-backed review; change files only for a truly independent fix.',
    explorer: 'Explore the repository for the objective and report concrete files, symbols, constraints, and recommended implementation boundaries. Do not edit files.',
    architect: 'Analyze interfaces, sequencing, risks, and integration boundaries for the objective. Produce an actionable architecture report; do not edit files.',
  };
  const instruction = lanes[role] || `Execute the objective as the ${role} specialist in a bounded, independently integrable lane.`;
  return `${instruction} Team size: ${count}. Objective: ${task}`;
}

function shellJoin(parts) {
  return parts.map((value) => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ');
}
