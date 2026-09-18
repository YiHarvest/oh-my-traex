import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { buildLeaderPrompt, buildWorkerPrompt } from './prompt.js';
import { planTeam } from './planner.js';
import { addTeamWorker, assertTeamDoesNotExist, createTeamTask, defaultTeamName, enqueueMailboxMessage, enqueueTaskMessage, initTeamState, listTeamTasks, readMailbox, readTeamState, reassignTeamTask, recoverDeliveryTransactions, removeTeamWorker, sanitizeTeamName, teamStateDir, updateMailboxMessage, updateTaskState, updateTeamConfig, updateWorkerState, withStateLock } from './state.js';
import { assertCleanWorkspace, cleanupWorkerWorktree, createWorkerWorktree, createWorkerWorktrees, inspectWorkerWorktree, rollbackWorkerWorktrees, worktreeStatus } from './worktree.js';
import { beginTeamTransaction, finishTeamTransaction, listTeamTransactions, updateTeamTransaction } from './transaction.js';
import { appendTeamEvent, listTeamEvents } from './events.js';
import { createMuxAdapter, inspectRuntimeOwnership, terminateOwnedRuntime } from './mux.js';

export async function startTeam({ cwd, task, workerCount, model, teamName, baseRole, autoPlan = true, plannerTimeoutMs, muxBackend = 'tmux', env = process.env, run = spawnSync, spawnProcess = spawn }) {
  if (muxBackend === 'tmux' && (!env.TMUX || !env.TMUX_PANE)) throw new Error('otx team requires running inside tmux unless --headless is used.');
  const name = teamName ? sanitizeTeamName(teamName) : defaultTeamName(task);
  const roles = ['executor', 'test-engineer', 'reviewer', 'explorer', 'architect'];
  let workers = Array.from({ length: workerCount }, (_, index) => ({
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
  const statePath = teamStateDir(repoRoot, name);
  const transaction = beginTeamTransaction(statePath, 'start-team', { team: name, cwd: repoRoot });
  let plan = null;
  let plannerFallback = null;
  let planningMode = 'static';
  if (autoPlan && !baseRole) {
    try {
      plan = await planTeam({ cwd: repoRoot, task, workerCount, model, timeoutMs: plannerTimeoutMs });
      workers = materializePlannedWorkers(plan.workers);
      planningMode = 'structured';
    } catch (error) {
      plannerFallback = error.message;
      planningMode = 'fallback';
    }
  }
  let worktreeWorkers = [];
  try {
    worktreeWorkers = createWorkerWorktrees({ repoRoot, teamName: name, workers });
    updateTeamTransaction(transaction, { phase: 'worktrees-created', resources: { workers: worktreeWorkers } });
  } catch (error) {
    finishTeamTransaction(transaction, 'rolled-back', { error: error.message });
    throw error;
  }
  const leaderSessionId = randomUUID();
  let stateDir;
  let config;
  try {
    ({ stateDir, config } = initTeamState({
      cwd: repoRoot,
      name,
      task,
      model,
      plan,
      planningMode,
      plannerFallback,
      leaderPaneId: muxBackend === 'tmux' ? env.TMUX_PANE : `process:${process.pid}`,
      leaderSessionId,
      muxBackend,
      workers: worktreeWorkers,
    }));
    createMuxAdapter({ backend: muxBackend, run, spawnProcess, leaderPaneId: env.TMUX_PANE }).prepareLeader(config);
    updateTeamTransaction(transaction, { phase: 'state-published', run_id: config.run_id });
  } catch (error) {
    rollbackWorkerWorktrees(repoRoot, worktreeWorkers);
    finishTeamTransaction(transaction, 'rolled-back', { error: error.message });
    throw error;
  }
  const runner = join(dirname(fileURLToPath(import.meta.url)), 'worker-run.js');
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  const createdPanes = [];
  const mux = createMuxAdapter({ backend: muxBackend, run, spawnProcess, leaderPaneId: env.TMUX_PANE });

  try {
    for (const worker of worktreeWorkers) {
      worker.team_state_dir = stateDir;
      const workerDir = join(stateDir, 'workers', worker.name);
      mkdirSync(workerDir, { recursive: true });
      const promptPath = join(workerDir, 'prompt.md');
      const resultPath = join(workerDir, 'result.md');
      const sessionId = randomUUID();
      writeFileSync(promptPath, buildWorkerPrompt({ teamName: name, worker, task }), 'utf8');
      const workerArgs = [stateDir, worker.name, worker.worktree_path, promptPath, resultPath, sessionId, model || ''];
      const launched = mux.launchWorker({ cwd: worker.worktree_path, command: process.execPath, args: [runner, ...workerArgs], worker, config });
      createdPanes.push({ name: worker.name, pane_id: launched.id, pane_pid: launched.pid });
      updateWorkerState(stateDir, worker.name, { pane_id: launched.id, pane_pid: launched.pid, session_id: sessionId, result_path: resultPath, prompt_path: promptPath });
      updateTeamTransaction(transaction, {
        phase: 'panes-starting',
        resources: {
          workers: transaction.record.resources.workers.map((candidate) => candidate.name === worker.name
            ? { ...candidate, pane_id: launched.id, pane_pid: launched.pid, session_id: sessionId }
            : candidate),
        },
      });
    }
    const supervisorArgs = [cliPath, 'team', 'supervise', name, '-C', repoRoot, '--interval-ms', '1000'];
    const supervisor = mux.launchSupervisor({ cwd: repoRoot, command: process.execPath, args: supervisorArgs, config });
    createdPanes.push({ name: 'supervisor', pane_id: supervisor.id, pane_pid: supervisor.pid });
    Object.assign(config, updateTeamConfig(stateDir, {
      supervisor_pane_id: supervisor.id,
      supervisor_pane_pid: supervisor.pid,
      supervisor_started_at: new Date().toISOString(),
    }));
    mux.layout();
    finishTeamTransaction(transaction);
    appendTeamEvent(stateDir, 'team.started', { data: { workers: worktreeWorkers.map((worker) => worker.name) } });
    return {
      name,
      stateDir,
      config,
      workers: readTeamState(repoRoot, name).workers,
      leaderPrompt: buildLeaderPrompt({ teamName: name, task, stateDir, workers: worktreeWorkers, cliPath }),
    };
  } catch (error) {
    for (const owner of createdPanes) mux.terminate(owner);
    const cleanupDebt = rollbackWorkerWorktrees(repoRoot, worktreeWorkers);
    if (stateDir) updateTeamConfig(stateDir, {
      status: 'failed',
      error: error.message,
      cleanup_debt: cleanupDebt,
    });
    finishTeamTransaction(transaction, 'rolled-back', { error: error.message, cleanup_debt: cleanupDebt });
    throw error;
  }
}

export function teamStatus(cwd, name, run = spawnSync) {
  return inspectTeam(cwd, name, run, false);
}

export function reconcileTeam(cwd, name, run = spawnSync) {
  return inspectTeam(cwd, name, run, true);
}

function inspectTeam(cwd, name, run, persist) {
  if (persist) recoverDeliveryTransactions(teamStateDir(cwd, name));
  const state = readTeamState(cwd, name);
  state.workers = state.workers.map((worker) => {
    const paneAlive = paneOwnedBy(run, worker, state.config);
    const heartbeatAgeMs = worker.heartbeat_at ? Math.max(0, Date.now() - Date.parse(worker.heartbeat_at)) : null;
    const activityAt = worker.last_activity_at || worker.child_started_at || worker.started_at;
    const activityAgeMs = activityAt ? Math.max(0, Date.now() - Date.parse(activityAt)) : null;
    const health = worker.status === 'completed'
      ? 'completed'
      : worker.status === 'failed' || worker.status === 'cancelled'
        ? worker.status
        : !paneAlive
          ? 'dead'
          : heartbeatAgeMs !== null && heartbeatAgeMs > 30_000
            ? 'stale'
            : worker.status === 'working' && activityAgeMs !== null && activityAgeMs > 60_000
              ? 'stalled'
            : 'healthy';
    const startupGrace = worker.status === 'starting'
      && Date.now() - Date.parse(worker.updated_at || state.config.created_at) < 10_000;
    if (!paneAlive && !startupGrace && ['starting', 'queued', 'working'].includes(worker.status)) {
      const failure = {
        status: 'failed',
        error: 'worker pane exited before recording a terminal result',
        completed_at: new Date().toISOString(),
        pane_alive: false,
        dirty: worktreeStatus(worker.worktree_path) !== '',
      };
      const failed = persist ? updateWorkerState(state.stateDir, worker.name, failure) : { ...worker, ...failure };
      if (persist) {
        updateTaskState(state.stateDir, worker.initial_task_id || String(worker.index), {
          status: 'failed',
          error: failed.error,
          completed_at: failed.completed_at,
        });
      }
      return { ...failed, health: 'dead', heartbeat_age_ms: heartbeatAgeMs };
    }
    return {
      ...worker,
      pane_alive: paneAlive,
      dirty: worktreeStatus(worker.worktree_path) !== '',
      health,
      heartbeat_age_ms: heartbeatAgeMs,
      activity_age_ms: activityAgeMs,
    };
  });
  if (persist) state.rescheduled = rescheduleFailedTasks(state, run);
  if (state.config.status === 'running' && state.rescheduled?.length === 0
    && state.workers.every((worker) => ['completed', 'failed'].includes(worker.status))) {
    const producedWorkers = state.workers
      .filter((worker) => worker.requires_commit && worker.commit && worker.commit !== worker.base_commit);
    const integrationCurrent = producedWorkers.length > 0
      && producedWorkers.every((worker) => ['integrated', 'already_integrated'].includes(worker.integration?.status)
        && worker.integration?.commit === worker.commit);
    const terminalConfig = {
      status: state.workers.some((worker) => worker.status === 'failed')
        ? 'failed'
        : integrationCurrent ? 'integrated' : 'ready',
      completed_at: state.config.completed_at || (persist ? new Date().toISOString() : null),
    };
    state.config = persist
      ? updateTeamConfig(state.stateDir, terminalConfig)
      : { ...state.config, ...terminalConfig };
  }
  return state;
}

export async function awaitTeam(cwd, name, timeoutMs = 3_600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = reconcileTeam(cwd, name);
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
        if (worker.current_task_id) updateTaskState(state.stateDir, worker.current_task_id, {
          status: 'cancelled', claim: null, error: 'stopped by team leader', completed_at: stoppedAt,
        });
      } else if (worker.status === 'queued') {
        for (const message of readMailbox(state.stateDir, worker.name).messages.filter((item) => item.status === 'pending')) {
          updateMailboxMessage(state.stateDir, worker.name, message.id, {
            status: 'cancelled', error: 'stopped by team leader', completed_at: stoppedAt,
          });
          if (message.task_id) updateTaskState(state.stateDir, message.task_id, {
            status: 'cancelled', claim: null, error: 'stopped by team leader', completed_at: stoppedAt,
          });
        }
      } else {
        updateTaskState(state.stateDir, worker.initial_task_id || String(worker.index), {
          status: 'cancelled', claim: null, error: 'stopped by team leader', completed_at: stoppedAt,
        });
      }
    }
    terminateOwnedRuntime(run, worker, state.config);
  }
  const supervisor = {
    name: 'supervisor',
    pane_id: state.config.supervisor_pane_id,
    pane_pid: state.config.supervisor_pane_pid,
  };
  terminateOwnedRuntime(run, supervisor, state.config);
  updateTeamConfig(state.stateDir, { status: 'stopped', stopped_at: new Date().toISOString() });
  return teamStatus(cwd, name, run);
}

export function sendTeamMessage(cwd, name, workerName, message) {
  const state = teamStatus(cwd, name);
  const worker = state.workers.find((candidate) => candidate.name === workerName);
  if (!worker) throw new Error(`worker not found: ${workerName}`);
  if (!worker.pane_alive) throw new Error(`worker is not running: ${workerName}`);
  const created = enqueueMailboxMessage(state.stateDir, workerName, message);
  updateWorkerState(state.stateDir, workerName, {
    status: worker.status === 'working' ? 'working' : 'queued',
  });
  updateTeamConfig(state.stateDir, { status: 'running', completed_at: null });
  appendTeamEvent(state.stateDir, 'message.queued', { actor: 'leader', data: { worker: workerName, message_id: created.id } });
  return created;
}

export function broadcastTeamMessage(cwd, name, message) {
  const state = teamStatus(cwd, name);
  const workers = state.workers.filter((worker) => worker.pane_alive);
  if (workers.length === 0) throw new Error(`team has no running workers: ${name}`);
  const messages = workers.map((worker) => {
    const created = enqueueMailboxMessage(state.stateDir, worker.name, message);
    updateWorkerState(state.stateDir, worker.name, {
      status: worker.status === 'working' ? 'working' : 'queued',
    });
    appendTeamEvent(state.stateDir, 'message.queued', { actor: 'leader', data: { worker: worker.name, message_id: created.id } });
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

export function listTasks(cwd, name) {
  const state = readTeamState(cwd, name);
  return listTeamTasks(state.stateDir);
}

export function readTeamEvents(cwd, name, options = {}) {
  const state = readTeamState(cwd, name);
  return listTeamEvents(state.stateDir, options);
}

export function diagnoseTeam(cwd, name) {
  const state = teamStatus(cwd, name);
  return {
    team: state.config.name,
    status: state.config.status,
    workers: state.workers.map((worker) => ({
      name: worker.name,
      role: worker.role,
      status: worker.status,
      health: worker.health,
      pane_alive: worker.pane_alive,
      heartbeat_age_ms: worker.heartbeat_age_ms,
      activity_age_ms: worker.activity_age_ms,
      child_pid: worker.child_pid ?? null,
      current_task_id: worker.current_task_id ?? null,
      current_message_id: worker.current_message_id ?? null,
      blocked_task_ids: worker.blocked_task_ids ?? [],
      worktree_dirty: worker.dirty,
      error: worker.error ?? null,
    })),
  };
}

export function assignTeamTask(cwd, name, workerName, description, dependsOn = []) {
  const state = teamStatus(cwd, name);
  const worker = state.workers.find((candidate) => candidate.name === workerName);
  if (!worker) throw new Error(`worker not found: ${workerName}`);
  if (!worker.pane_alive) throw new Error(`worker is not running: ${workerName}`);
  const task = createTeamTask(state.stateDir, {
    subject: description,
    description,
    owner: workerName,
    role: worker.role,
    requires_commit: worker.requires_commit,
    depends_on: dependsOn,
  });
  const body = `New OTX team task ${task.id}: ${description} Follow your existing worker contract, verify the result, and ${worker.requires_commit ? 'commit all intended changes.' : 'avoid changes unless essential.'}`;
  const message = enqueueTaskMessage(state.stateDir, workerName, task.id, body);
  updateWorkerState(state.stateDir, workerName, {
    status: worker.status === 'working' ? 'working' : 'queued',
  });
  updateTeamConfig(state.stateDir, { status: 'running', completed_at: null });
  appendTeamEvent(state.stateDir, 'task.queued', {
    actor: 'leader', data: { task_id: task.id, worker: workerName, message_id: message.id },
  });
  return { task, message };
}

function rescheduleFailedTasks(state, run) {
  return withStateLock(state.stateDir, 'scheduler', () => {
    const current = readTeamState(state.config.cwd, state.config.name);
    const liveWorkers = current.workers.filter((worker) => paneOwnedBy(run, worker, current.config)
      && !['failed', 'cancelled'].includes(worker.status));
    const results = [];
    for (const task of current.tasks.filter((candidate) => candidate.status === 'failed')) {
      const failedOwner = current.workers.find((worker) => worker.name === task.owner);
      if (!failedOwner || failedOwner.status !== 'failed' || (task.reschedule_count || 0) >= 1) continue;
      const target = liveWorkers.find((worker) => worker.name !== failedOwner.name
          && worker.requires_commit === task.requires_commit
          && worker.role === task.role)
        || liveWorkers.find((worker) => worker.name !== failedOwner.name
          && worker.requires_commit === task.requires_commit);
      if (!target) continue;
      const reassigned = reassignTeamTask(state.stateDir, task.id, failedOwner.name, target.name);
      if (!reassigned.ok) continue;
      const body = `Rescheduled OTX task ${task.id} from ${failedOwner.name}: ${task.description}`;
      const message = enqueueTaskMessage(state.stateDir, target.name, task.id, body);
      updateWorkerState(state.stateDir, target.name, {
        status: target.status === 'working' ? 'working' : 'queued',
      });
      appendTeamEvent(state.stateDir, 'task.rescheduled', {
        data: { task_id: task.id, from: failedOwner.name, to: target.name, message_id: message.id },
      });
      results.push({ task_id: task.id, from: failedOwner.name, to: target.name, message_id: message.id });
    }
    if (results.length > 0) updateTeamConfig(state.stateDir, { status: 'running', completed_at: null });
    return results;
  });
}

export function integrateTeam(cwd, name, workerNames = [], run = spawnSync) {
  const state = reconcileTeam(cwd, name, run);
  if (state.config.status === 'running') throw new Error('team still has running or queued work; await completion before integration.');
  const leaderStatus = run('git', ['status', '--porcelain'], { cwd: state.config.cwd, encoding: 'utf8' });
  if (leaderStatus.status !== 0) throw new Error(String(leaderStatus.stderr || 'failed to inspect leader workspace').trim());
  if (leaderStatus.stdout.trim()) throw new Error('leader workspace must be clean before integration.');
  const requested = workerNames.length > 0
    ? workerNames
    : state.workers.filter((worker) => worker.requires_commit).map((worker) => worker.name);
  const selected = requested.map((workerName) => {
    const worker = state.workers.find((candidate) => candidate.name === workerName);
    if (!worker) throw new Error(`worker not found: ${workerName}`);
    return worker;
  });
  const results = [];
  for (const worker of selected) {
    if (['integrated', 'already_integrated'].includes(worker.integration?.status)
      && worker.integration?.commit === worker.commit) {
      results.push({ ...worker.integration, status: 'already_integrated' });
      continue;
    }
    if (worker.status !== 'completed') throw new Error(`worker is not completed: ${worker.name}`);
    if (worker.dirty) throw new Error(`worker worktree is dirty: ${worker.name}`);
    if (!worker.commit || worker.commit === worker.base_commit) throw new Error(`worker has no new commit: ${worker.name}`);
    const branchHead = run('git', ['rev-parse', worker.branch], { cwd: state.config.cwd, encoding: 'utf8' });
    if (branchHead.status !== 0 || branchHead.stdout.trim() !== worker.commit) {
      throw new Error(`worker branch head does not match recorded commit: ${worker.name}`);
    }
    const integrationBase = worker.integration?.commit || worker.base_commit;
    const range = run('git', ['rev-list', '--reverse', `${integrationBase}..${worker.commit}`], { cwd: state.config.cwd, encoding: 'utf8' });
    if (range.status !== 0) throw new Error(`worker commit range is invalid: ${worker.name}`);
    const sourceCommits = range.stdout.trim().split('\n').filter(Boolean);
    if (sourceCommits.length === 0) throw new Error(`worker has no commits beyond its base: ${worker.name}`);
    const alreadyIntegrated = run('git', ['merge-base', '--is-ancestor', worker.commit, 'HEAD'], { cwd: state.config.cwd, encoding: 'utf8' });
    if (alreadyIntegrated.status === 0) {
      const record = { worker: worker.name, commit: worker.commit, source_commits: sourceCommits, status: 'already_integrated' };
      updateWorkerState(state.stateDir, worker.name, { integration: record });
      results.push(record);
      continue;
    }
    const cherryPick = run('git', ['cherry-pick', ...sourceCommits], { cwd: state.config.cwd, encoding: 'utf8' });
    if (cherryPick.status !== 0) {
      run('git', ['cherry-pick', '--abort'], { cwd: state.config.cwd, encoding: 'utf8' });
      const record = {
        worker: worker.name,
        commit: worker.commit,
        source_commits: sourceCommits,
        status: 'conflict',
        error: String(cherryPick.stderr || cherryPick.stdout || 'cherry-pick failed').trim(),
      };
      updateWorkerState(state.stateDir, worker.name, { integration: record });
      updateTeamConfig(state.stateDir, { status: 'integration_failed', integration_error: record });
      return { ok: false, results: [...results, record] };
    }
    const integratedHead = run('git', ['rev-parse', 'HEAD'], { cwd: state.config.cwd, encoding: 'utf8' });
    const record = {
      worker: worker.name,
      commit: worker.commit,
      source_commits: sourceCommits,
      integrated_commit: integratedHead.stdout.trim(),
      status: 'integrated',
    };
    updateWorkerState(state.stateDir, worker.name, { integration: record });
    results.push(record);
  }
  updateTeamConfig(state.stateDir, { status: 'integrated', integrated_at: new Date().toISOString(), integration_results: results });
  return { ok: true, results };
}

export function cleanupTeam(cwd, name) {
  const state = teamStatus(cwd, name);
  if (state.config.status !== 'stopped') throw new Error('team must be stopped before cleanup.');
  const results = [];
  for (const worker of state.workers) {
    if (worker.pane_alive) {
      results.push({ worker: worker.name, status: 'preserved', reason: 'pane_alive' });
      continue;
    }
    if (worker.dirty) {
      results.push({ worker: worker.name, status: 'preserved', reason: 'worktree_dirty' });
      continue;
    }
    const producedCommit = Boolean(worker.commit && worker.commit !== worker.base_commit);
    const integrated = ['integrated', 'already_integrated'].includes(worker.integration?.status)
      || !producedCommit;
    if (!integrated) {
      results.push({ worker: worker.name, status: 'preserved', reason: 'commit_not_integrated', commit: worker.commit });
      continue;
    }
    const cleaned = cleanupWorkerWorktree(state.config.cwd, worker);
    results.push({ worker: worker.name, ...cleaned });
  }
  const complete = results.every((result) => result.status === 'removed');
  updateTeamConfig(state.stateDir, {
    status: complete ? 'cleaned' : 'cleanup_pending',
    cleanup_at: new Date().toISOString(),
    cleanup_results: results,
  });
  return { ok: complete, results };
}

export function addWorker(cwd, name, role, assignment, options = {}) {
  const state = readTeamState(cwd, name);
  return withStateLock(state.stateDir, 'team-membership', () => addWorkerLocked(cwd, name, role, assignment, options));
}

function addWorkerLocked(cwd, name, role, assignment, { model, env = process.env, run = spawnSync, spawnProcess = spawn } = {}) {
  const state = teamStatus(cwd, name, run);
  const muxBackend = state.config.mux_backend || 'tmux';
  if (muxBackend === 'tmux' && (!env.TMUX || !env.TMUX_PANE)) throw new Error('otx team add-worker requires running inside tmux for the tmux backend.');
  const mux = createMuxAdapter({ backend: muxBackend, run, spawnProcess, leaderPaneId: env.TMUX_PANE });
  if (['stopped', 'cleaned', 'cleanup_pending'].includes(state.config.status)) {
    throw new Error(`cannot add a worker to team in status ${state.config.status}`);
  }
  if (state.workers.length >= 6) throw new Error('team already has the maximum of 6 workers.');
  assertCleanWorkspace(state.config.cwd);
  const index = state.config.next_worker_index || Math.max(0, ...state.workers.map((worker) => worker.index)) + 1;
  const workerBase = {
    name: `worker-${index}`,
    index,
    role,
    assignment,
    requires_commit: ['executor', 'test-engineer'].includes(role),
    status: 'starting',
  };
  const transaction = beginTeamTransaction(state.stateDir, 'add-worker', { team: name, worker: workerBase.name });
  let worker;
  let task;
  let paneId = null;
  let panePid = null;
  let membershipAdded = false;
  try {
    worker = createWorkerWorktree({ repoRoot: state.config.cwd, teamName: name, worker: workerBase });
    updateTeamTransaction(transaction, { phase: 'worktree-created', resources: { workers: [worker] } });
    task = addTeamWorker(state.stateDir, worker);
    membershipAdded = true;
    worker.initial_task_id = task.id;
    const workerDir = join(state.stateDir, 'workers', worker.name);
    mkdirSync(workerDir, { recursive: true });
    const promptPath = join(workerDir, 'prompt.md');
    const resultPath = join(workerDir, 'result.md');
    const sessionId = randomUUID();
    writeFileSync(promptPath, buildWorkerPrompt({ teamName: name, worker, task: assignment }), 'utf8');
    const runner = join(dirname(fileURLToPath(import.meta.url)), 'worker-run.js');
    const workerArgs = [state.stateDir, worker.name, worker.worktree_path, promptPath, resultPath, sessionId, model || state.config.model || ''];
    const launched = mux.launchWorker({ cwd: worker.worktree_path, command: process.execPath, args: [runner, ...workerArgs], worker, config: state.config });
    paneId = launched.id;
    panePid = launched.pid;
    const updated = updateWorkerState(state.stateDir, worker.name, {
      initial_task_id: task.id,
      pane_id: paneId,
      pane_pid: panePid,
      session_id: sessionId,
      result_path: resultPath,
      prompt_path: promptPath,
    });
    updateTeamTransaction(transaction, {
      phase: 'pane-started',
      resources: { workers: [{ ...worker, pane_id: paneId, pane_pid: updated.pane_pid, session_id: sessionId }] },
    });
    mux.layout();
    finishTeamTransaction(transaction);
    return { worker: updated, task };
  } catch (error) {
    if (paneId) mux.terminate({ name: worker?.name, pane_id: paneId, pane_pid: panePid });
    if (task) updateTaskState(state.stateDir, task.id, {
      status: 'failed', error: error.message, completed_at: new Date().toISOString(),
    });
    if (membershipAdded) updateWorkerState(state.stateDir, worker.name, {
      status: 'failed', error: error.message, completed_at: new Date().toISOString(),
    });
    if (membershipAdded) removeTeamWorker(state.stateDir, worker.name);
    const cleanupDebt = worker ? rollbackWorkerWorktrees(state.config.cwd, [worker]) : [];
    if (cleanupDebt.length > 0) updateTeamConfig(state.stateDir, { cleanup_debt: cleanupDebt });
    finishTeamTransaction(transaction, 'rolled-back', { error: error.message, cleanup_debt: cleanupDebt });
    throw error;
  }
}

export function recoverTeam(cwd, name, run = spawnSync) {
  const stateDir = teamStateDir(cwd, name);
  const deliveries = recoverDeliveryTransactions(stateDir);
  const transactions = listTeamTransactions(stateDir, { activeOnly: true });
  if (transactions.length === 0) return { ok: true, recovered: [], recovered_deliveries: deliveries, cleanup_debt: [] };
  let state = null;
  try { state = readTeamState(cwd, name); } catch {}
  const repoRoot = state?.config.cwd || cwd;
  const recovered = [];
  const cleanupDebt = [];
  let requiresAttention = false;
  for (const record of transactions) {
    const transaction = { stateDir, id: record.id, record };
    const resources = dedupeWorkers(record.resources?.workers || []);
    for (const resource of resources) {
      const persisted = state?.workers.find((worker) => worker.name === resource.name);
      const worker = { ...resource, ...persisted };
      if (state) terminateOwnedRuntime(run, worker, state.config);
      if (persisted && !['completed', 'failed', 'cancelled'].includes(persisted.status)) {
        updateWorkerState(stateDir, worker.name, {
          status: 'failed', error: 'recovered incomplete runtime transaction', completed_at: new Date().toISOString(),
        });
        if (persisted.initial_task_id) updateTaskState(stateDir, persisted.initial_task_id, {
          status: 'failed', claim: null, error: 'recovered incomplete runtime transaction', completed_at: new Date().toISOString(),
        });
      }
    }
    const transactionCleanupDebt = rollbackWorkerWorktrees(repoRoot, resources);
    cleanupDebt.push(...transactionCleanupDebt);
    if (record.operation === 'add-worker' && state) {
      for (const resource of resources) {
        const stillPresent = readTeamState(cwd, name).config.workers.includes(resource.name);
        const preserved = transactionCleanupDebt.some((item) => item.worker === resource.name);
        if (stillPresent && !preserved) removeTeamWorker(stateDir, resource.name);
      }
    }
    if (record.operation === 'start-team' || transactionCleanupDebt.length > 0) requiresAttention = true;
    finishTeamTransaction(transaction, 'recovered', { cleanup_debt: transactionCleanupDebt });
    recovered.push(record.id);
  }
  if (state) updateTeamConfig(stateDir, {
    status: requiresAttention ? 'recovery_required' : state.config.status,
    recovered_at: new Date().toISOString(),
    cleanup_debt: cleanupDebt,
  });
  return { ok: cleanupDebt.length === 0, recovered, recovered_deliveries: deliveries, cleanup_debt: cleanupDebt };
}

function dedupeWorkers(workers) {
  return [...new Map(workers.map((worker) => [worker.name, worker])).values()];
}

export function removeWorker(cwd, name, workerName, run = spawnSync) {
  const state = teamStatus(cwd, name, run);
  const worker = state.workers.find((candidate) => candidate.name === workerName);
  if (!worker) throw new Error(`worker not found: ${workerName}`);
  if (['starting', 'queued', 'working'].includes(worker.status)) throw new Error(`worker is busy: ${workerName}`);
  const producedCommit = Boolean(worker.commit && worker.commit !== worker.base_commit);
  const integrated = ['integrated', 'already_integrated'].includes(worker.integration?.status) || !producedCommit;
  if (!integrated) throw new Error(`worker commit is not integrated: ${workerName}`);
  const worktreeInspection = inspectWorkerWorktree(worker);
  if (!worktreeInspection.ok) throw new Error(`worker cleanup refused: ${worktreeInspection.reason}`);
  const paneInspection = inspectPaneOwnership(run, worker, state.config);
  if (paneInspection === 'mismatch') throw new Error(`worker pane ownership could not be verified: ${workerName}`);
  if (paneInspection === 'owned') terminateOwnedRuntime(run, worker, state.config);
  const cleanup = cleanupWorkerWorktree(state.config.cwd, worker);
  if (cleanup.status !== 'removed') throw new Error(`worker cleanup refused: ${cleanup.reason}`);
  removeTeamWorker(state.stateDir, workerName);
  return { worker: workerName, status: 'removed', cleanup };
}

export function resumeTeam(cwd, name, { model, env = process.env, run = spawnSync } = {}) {
  const state = readTeamState(cwd, name);
  if ((state.config.mux_backend || 'tmux') === 'tmux' && (!env.TMUX || !env.TMUX_PANE)) {
    throw new Error('otx team resume requires running inside tmux for the tmux backend.');
  }
  updateTeamConfig(state.stateDir, {
    leader_pane_id: state.config.mux_backend === 'headless' ? `process:${process.pid}` : env.TMUX_PANE,
    status: 'running',
    resumed_at: new Date().toISOString(),
  });
  const args = ['resume', '--no-alt-screen', '-C', state.config.cwd];
  if (model) args.push('--model', model);
  args.push(state.config.leader_session_id, `Resume leadership of OTX team "${name}". Run team status, inspect worker results, integrate valid commits, verify the objective, then stop the team.`);
  return run('traex', args, { cwd: state.config.cwd, stdio: 'inherit' });
}

function paneOwnedBy(run, workerState, config) {
  return inspectPaneOwnership(run, workerState, config) === 'owned';
}

function inspectPaneOwnership(run, workerState, config) {
  return inspectRuntimeOwnership(run, workerState, config);
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

function materializePlannedWorkers(plannedWorkers) {
  const taskIdBySymbol = new Map(plannedWorkers.map((worker) => [worker.planner_id, String(worker.index)]));
  return plannedWorkers.map((worker) => ({
    ...worker,
    depends_on: worker.depends_on_symbols.map((symbol) => taskIdBySymbol.get(symbol)),
  }));
}
