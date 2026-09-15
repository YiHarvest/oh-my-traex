import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { buildLeaderPrompt, buildWorkerPrompt } from './prompt.js';
import { addTeamWorker, assertTeamDoesNotExist, createTeamTask, defaultTeamName, enqueueMailboxMessage, enqueueTaskMessage, initTeamState, listTeamTasks, readMailbox, readTeamState, removeTeamWorker, sanitizeTeamName, updateMailboxMessage, updateTaskState, updateTeamConfig, updateWorkerState } from './state.js';
import { assertCleanWorkspace, cleanupWorkerWorktree, createWorkerWorktree, createWorkerWorktrees, inspectWorkerWorktree, rollbackWorkerWorktrees, worktreeStatus } from './worktree.js';

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
      model,
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
    const heartbeatAgeMs = worker.heartbeat_at ? Math.max(0, Date.now() - Date.parse(worker.heartbeat_at)) : null;
    const health = worker.status === 'completed'
      ? 'completed'
      : worker.status === 'failed' || worker.status === 'cancelled'
        ? worker.status
        : !paneAlive
          ? 'dead'
          : heartbeatAgeMs !== null && heartbeatAgeMs > 30_000
            ? 'stale'
            : 'healthy';
    const startupGrace = worker.status === 'starting'
      && Date.now() - Date.parse(worker.updated_at || state.config.created_at) < 10_000;
    if (!paneAlive && !startupGrace && ['starting', 'queued', 'working'].includes(worker.status)) {
      const failed = updateWorkerState(state.stateDir, worker.name, {
        status: 'failed',
        error: 'worker pane exited before recording a terminal result',
        completed_at: new Date().toISOString(),
        pane_alive: false,
        dirty: worktreeStatus(worker.worktree_path) !== '',
      });
      updateTaskState(state.stateDir, worker.initial_task_id || String(worker.index), {
        status: 'failed',
        error: failed.error,
        completed_at: failed.completed_at,
      });
      return { ...failed, health: 'dead', heartbeat_age_ms: heartbeatAgeMs };
    }
    return {
      ...worker,
      pane_alive: paneAlive,
      dirty: worktreeStatus(worker.worktree_path) !== '',
      health,
      heartbeat_age_ms: heartbeatAgeMs,
    };
  });
  if (state.config.status === 'running' && state.workers.every((worker) => ['completed', 'failed'].includes(worker.status))) {
    const producedWorkers = state.workers
      .filter((worker) => worker.requires_commit && worker.commit && worker.commit !== worker.base_commit);
    const integrationCurrent = producedWorkers.length > 0
      && producedWorkers.every((worker) => ['integrated', 'already_integrated'].includes(worker.integration?.status)
        && worker.integration?.commit === worker.commit);
    state.config = updateTeamConfig(state.stateDir, {
      status: state.workers.some((worker) => worker.status === 'failed')
        ? 'failed'
        : integrationCurrent ? 'integrated' : 'ready',
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
  updateWorkerState(state.stateDir, workerName, {
    status: worker.status === 'working' ? 'working' : 'queued',
  });
  updateTeamConfig(state.stateDir, { status: 'running', completed_at: null });
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
  return { task, message };
}

export function integrateTeam(cwd, name, workerNames = [], run = spawnSync) {
  const state = teamStatus(cwd, name, run);
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

export function addWorker(cwd, name, role, assignment, { model, env = process.env, run = spawnSync } = {}) {
  if (!env.TMUX || !env.TMUX_PANE) throw new Error('otx team add-worker requires running inside tmux.');
  const state = teamStatus(cwd, name, run);
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
  const worker = createWorkerWorktree({ repoRoot: state.config.cwd, teamName: name, worker: workerBase });
  let task;
  let paneId = null;
  let membershipAdded = false;
  try {
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
    const command = shellJoin([process.execPath, runner, state.stateDir, worker.name, worker.worktree_path, promptPath, resultPath, sessionId, model || state.config.model || '']);
    const split = run('tmux', ['split-window', '-v', '-d', '-P', '-F', '#{pane_id}', '-t', env.TMUX_PANE, '-c', worker.worktree_path, command], { cwd: state.config.cwd, encoding: 'utf8' });
    if (split.status !== 0) throw new Error(String(split.stderr || 'failed to create worker pane').trim());
    paneId = split.stdout.trim().split('\n')[0];
    if (!paneId.startsWith('%')) throw new Error('tmux did not return a worker pane ID.');
    runTmuxOrThrow(run, ['set-option', '-p', '-t', paneId, '@otx_team', name]);
    runTmuxOrThrow(run, ['set-option', '-p', '-t', paneId, '@otx_worker', worker.name]);
    runTmuxOrThrow(run, ['set-option', '-p', '-t', paneId, '@otx_run_id', state.config.run_id]);
    run('tmux', ['select-pane', '-t', paneId, '-T', `${worker.name} [${worker.role}]`], { encoding: 'utf8' });
    const panePid = readPanePid(run, paneId);
    const updated = updateWorkerState(state.stateDir, worker.name, {
      initial_task_id: task.id,
      pane_id: paneId,
      pane_pid: panePid,
      session_id: sessionId,
      result_path: resultPath,
      prompt_path: promptPath,
    });
    run('tmux', ['select-layout', '-t', env.TMUX_PANE, 'main-vertical'], { encoding: 'utf8' });
    return { worker: updated, task };
  } catch (error) {
    if (paneId?.startsWith('%')) run('tmux', ['kill-pane', '-t', paneId], { encoding: 'utf8' });
    if (task) updateTaskState(state.stateDir, task.id, {
      status: 'failed', error: error.message, completed_at: new Date().toISOString(),
    });
    updateWorkerState(state.stateDir, worker.name, {
      status: 'failed', error: error.message, completed_at: new Date().toISOString(),
    });
    if (membershipAdded) removeTeamWorker(state.stateDir, worker.name);
    const cleanupDebt = rollbackWorkerWorktrees(state.config.cwd, [worker]);
    if (cleanupDebt.length > 0) updateTeamConfig(state.stateDir, { cleanup_debt: cleanupDebt });
    throw error;
  }
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
  if (paneInspection === 'owned') run('tmux', ['kill-pane', '-t', worker.pane_id], { encoding: 'utf8' });
  const cleanup = cleanupWorkerWorktree(state.config.cwd, worker);
  if (cleanup.status !== 'removed') throw new Error(`worker cleanup refused: ${cleanup.reason}`);
  removeTeamWorker(state.stateDir, workerName);
  return { worker: workerName, status: 'removed', cleanup };
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
  return inspectPaneOwnership(run, workerState, config) === 'owned';
}

function inspectPaneOwnership(run, workerState, config) {
  const paneId = workerState.pane_id;
  if (!paneId?.startsWith('%')) return 'missing';
  const result = run('tmux', ['display-message', '-p', '-t', paneId, '#{@otx_team}\t#{@otx_worker}\t#{@otx_run_id}\t#{pane_pid}\t#{pane_dead}'], { encoding: 'utf8' });
  if (result.status !== 0) return 'missing';
  const [team, worker, runId, panePid, dead] = result.stdout.trim().split('\t');
  const owned = team === config.name && worker === workerState.name && runId === config.run_id
    && Number(panePid) === workerState.pane_pid && dead === '0';
  return owned ? 'owned' : 'mismatch';
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
