import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readVersionedRecord } from './codec.js';

export const TASK_LEASE_MS = 15 * 60_000;
export const MAILBOX_LEASE_MS = 15 * 60_000;
export const STATE_LOCK_TIMEOUT_MS = 30_000;

export function sanitizeTeamName(value) {
  const name = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30).replace(/-$/, '');
  if (!name) throw new Error('team name must contain a letter or number.');
  return name;
}

export function defaultTeamName(task) {
  let base;
  try {
    base = sanitizeTeamName(task.split(/\s+/).slice(0, 4).join('-'));
  } catch {
    base = 'team';
  }
  return `${base}-${Date.now().toString(36).slice(-5)}`;
}

export function resolveRepo(cwd) {
  const rootResult = git(cwd, ['rev-parse', '--show-toplevel']);
  if (rootResult.status !== 0) throw new Error('otx team requires a Git repository.');
  const repoRoot = resolve(rootResult.stdout.trim());
  const commonResult = git(repoRoot, ['rev-parse', '--git-common-dir']);
  if (commonResult.status !== 0) throw new Error('failed to resolve Git common directory.');
  const rawCommon = commonResult.stdout.trim();
  const gitCommonDir = resolve(repoRoot, rawCommon);
  return { repoRoot, gitCommonDir };
}

export function teamStateDir(cwd, teamName) {
  const { gitCommonDir } = resolveRepo(cwd);
  return join(gitCommonDir, 'otx', 'team', sanitizeTeamName(teamName));
}

export function assertTeamDoesNotExist(cwd, name) {
  if (existsSync(join(teamStateDir(cwd, name), 'config.json'))) {
    throw new Error(`team already exists: ${name}`);
  }
}

export function initTeamState({ cwd, name, task, model, plan, planningMode, plannerFallback, leaderPaneId, leaderSessionId, muxBackend = 'tmux', workers }) {
  const stateDir = teamStateDir(cwd, name);
  if (existsSync(join(stateDir, 'config.json'))) throw new Error(`team already exists: ${name}`);
  mkdirSync(join(stateDir, 'workers'), { recursive: true });
  mkdirSync(join(stateDir, 'tasks'), { recursive: true });
  mkdirSync(join(stateDir, 'mailbox'), { recursive: true });
  const config = {
    schema_version: 1,
    name,
    run_id: randomUUID(),
    task,
    model: model || null,
    plan: plan || null,
    planning_mode: planningMode || 'static',
    planner_fallback: plannerFallback || null,
    cwd: resolve(cwd),
    status: 'running',
    created_at: new Date().toISOString(),
    leader_pane_id: leaderPaneId,
    leader_session_id: leaderSessionId,
    mux_backend: muxBackend,
    workers: workers.map(({ name: workerName }) => workerName),
    next_worker_index: workers.length + 1,
  };
  writeJsonAtomic(join(stateDir, 'config.json'), config);
  for (const worker of workers) {
    writeJsonAtomic(workerStatePath(stateDir, worker.name), { ...worker, initial_task_id: String(worker.index) });
    mkdirSync(mailboxDir(stateDir, worker.name), { recursive: true });
    writeJsonAtomic(taskStatePath(stateDir, String(worker.index)), {
      id: String(worker.index),
      subject: worker.assignment,
      description: worker.assignment,
      owner: worker.name,
      role: worker.role,
      planner_id: worker.planner_id || null,
      file_paths: worker.file_paths || [],
      requires_commit: worker.requires_commit,
      depends_on: worker.depends_on || [],
      status: 'pending',
      version: 1,
      created_at: new Date().toISOString(),
    });
  }
  return { stateDir, config };
}

export function readTeamState(cwd, name) {
  const stateDir = teamStateDir(cwd, name);
  const config = readJson(join(stateDir, 'config.json'));
  const workers = config.workers.map((workerName) => readJson(workerStatePath(stateDir, workerName)));
  const tasks = listTeamTasks(stateDir);
  return { stateDir, config, workers, tasks };
}

export function listTeamStates(cwd) {
  const { gitCommonDir } = resolveRepo(cwd);
  const teamsRoot = join(gitCommonDir, 'otx', 'team');
  if (!existsSync(teamsRoot)) return [];
  return readdirSync(teamsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(teamsRoot, entry.name, 'config.json')))
    .map((entry) => readJson(join(teamsRoot, entry.name, 'config.json')))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
}

const TERMINAL_STATUSES = {
  worker: new Set(['completed', 'failed', 'cancelled']),
  task: new Set(['completed', 'failed', 'cancelled']),
  mailbox: new Set(['completed', 'failed', 'cancelled']),
  config: new Set([
    'ready', 'failed', 'integrated', 'integration_failed', 'stopped', 'cleaned',
    'cleanup_pending', 'empty', 'resume_failed', 'recovery_required',
  ]),
};
const VALID_STATUSES = {
  worker: new Set(['starting', 'queued', 'working', 'blocked', 'completed', 'failed', 'cancelled']),
  task: new Set(['pending', 'blocked', 'in_progress', 'completed', 'failed', 'cancelled']),
  mailbox: new Set(['pending', 'working', 'completed', 'failed', 'cancelled']),
  config: new Set([
    'running', 'resuming', 'ready', 'failed', 'integrated', 'integration_failed', 'stopped',
    'cleaned', 'cleanup_pending', 'empty', 'resume_failed', 'recovery_required',
  ]),
};

function assertStatusTransition(kind, currentStatus, nextStatus, options = {}) {
  if (!nextStatus || nextStatus === currentStatus) return;
  if (!VALID_STATUSES[kind].has(nextStatus)) throw new Error(`invalid ${kind} status: ${nextStatus}`);
  if (!TERMINAL_STATUSES[kind].has(currentStatus) || TERMINAL_STATUSES[kind].has(nextStatus)) return;
  if (!options.allowTerminalReset) {
    throw new Error(`invalid ${kind} status transition: ${currentStatus} -> ${nextStatus}; terminal reset requires an explicit reason`);
  }
  if (typeof options.reason !== 'string' || options.reason.trim() === '') {
    throw new Error(`invalid ${kind} status transition: ${currentStatus} -> ${nextStatus}; terminal reset reason is required`);
  }
}

export function updateWorkerState(stateDir, workerName, updates, options = {}) {
  return withRecordLock(stateDir, `worker-${workerName}`, () => {
    const path = workerStatePath(stateDir, workerName);
    const current = readJson(path);
    assertStatusTransition('worker', current.status, updates.status, options);
    const next = { ...current, ...updates, updated_at: new Date().toISOString() };
    writeJsonAtomic(path, next);
    return next;
  });
}

export function updateTaskState(stateDir, taskId, updates, options = {}) {
  return withTaskLock(stateDir, taskId, () => {
    const path = taskStatePath(stateDir, taskId);
    const current = readJson(path);
    assertStatusTransition('task', current.status, updates.status, options);
    const next = {
      ...current,
      ...updates,
      version: updates.version ?? (current.version || 1) + 1,
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(path, next);
    return next;
  });
}

export function createTeamTask(stateDir, input) {
  return withRecordLock(stateDir, 'task-create', () => {
    const tasksDir = join(stateDir, 'tasks');
    const ids = readdirSync(tasksDir)
      .map((name) => name.match(/^task-(\d+)\.json$/)?.[1])
      .filter(Boolean)
      .map(Number);
    const id = String(ids.length === 0 ? 1 : Math.max(...ids) + 1);
    const dependsOn = [...new Set(input.depends_on || [])];
    for (const dependencyId of dependsOn) {
      if (!existsSync(taskStatePath(stateDir, dependencyId))) {
        throw new Error(`task dependency not found: ${dependencyId}`);
      }
    }
    const task = {
      id,
      subject: input.subject,
      description: input.description,
      owner: input.owner,
      role: input.role,
      requires_commit: input.requires_commit,
      depends_on: dependsOn,
      status: 'pending',
      version: 1,
      created_at: new Date().toISOString(),
    };
    writeJsonAtomic(taskStatePath(stateDir, id), task);
    return task;
  });
}

export function listTeamTasks(stateDir) {
  const tasksDir = join(stateDir, 'tasks');
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((name) => /^task-\d+\.json$/.test(name))
    .map((name) => readJson(join(tasksDir, name)))
    .sort((left, right) => Number(left.id) - Number(right.id));
}

export function readTeamTask(stateDir, taskId) {
  return readJson(taskStatePath(stateDir, taskId));
}

export function claimTeamTask(stateDir, taskId, workerName) {
  return withTaskLock(stateDir, taskId, () => {
    let task = readTeamTask(stateDir, taskId);
    if (task.status === 'in_progress' && task.claim) {
      if (Date.parse(task.claim.leased_until) > Date.now()) {
        return { ok: false, error: 'claim_conflict', task };
      }
      task = {
        ...task,
        status: 'pending',
        claim: null,
        version: (task.version || 1) + 1,
        updated_at: new Date().toISOString(),
      };
    }
    if (task.status !== 'pending' && task.status !== 'blocked') {
      return { ok: false, error: 'task_not_pending', task };
    }
    if (task.owner && task.owner !== workerName) return { ok: false, error: 'owner_mismatch', task };
    const incomplete = (task.depends_on || []).filter((dependencyId) =>
      readTeamTask(stateDir, dependencyId).status !== 'completed',
    );
    if (incomplete.length > 0) {
      if (task.status === 'blocked'
        && JSON.stringify(task.blocked_by || []) === JSON.stringify(incomplete)) {
        return { ok: false, error: 'blocked_dependency', dependencies: incomplete, task };
      }
      const blocked = {
        ...task,
        status: 'blocked',
        blocked_by: incomplete,
        version: (task.version || 1) + 1,
        updated_at: new Date().toISOString(),
      };
      writeJsonAtomic(taskStatePath(stateDir, taskId), blocked);
      return { ok: false, error: 'blocked_dependency', dependencies: incomplete, task: blocked };
    }
    const token = randomUUID();
    const claimed = {
      ...task,
      status: 'in_progress',
      owner: workerName,
      blocked_by: [],
      claim: { owner: workerName, token, leased_until: new Date(Date.now() + TASK_LEASE_MS).toISOString() },
      version: (task.version || 1) + 1,
      started_at: task.started_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(taskStatePath(stateDir, taskId), claimed);
    return { ok: true, token, task: claimed };
  });
}

export function reclaimExpiredTask(stateDir, taskId) {
  return withTaskLock(stateDir, taskId, () => {
    const task = readTeamTask(stateDir, taskId);
    if (task.status !== 'in_progress' || !task.claim) return { ok: true, reclaimed: false, task };
    if (Date.parse(task.claim.leased_until) > Date.now()) return { ok: false, error: 'lease_active', task };
    const reclaimed = {
      ...task,
      status: 'pending',
      claim: null,
      version: (task.version || 1) + 1,
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(taskStatePath(stateDir, taskId), reclaimed);
    return { ok: true, reclaimed: true, task: reclaimed };
  });
}

export function reassignTeamTask(stateDir, taskId, fromWorker, toWorker) {
  return withTaskLock(stateDir, taskId, () => {
    const task = readTeamTask(stateDir, taskId);
    if (task.owner !== fromWorker) return { ok: false, error: 'owner_changed', task };
    if (!['failed', 'pending', 'blocked', 'in_progress'].includes(task.status)) {
      return { ok: false, error: 'task_not_reschedulable', task };
    }
    if (task.status === 'in_progress' && task.claim && Date.parse(task.claim.leased_until) > Date.now()) {
      return { ok: false, error: 'lease_active', task };
    }
    const reassigned = {
      ...task,
      owner: toWorker,
      status: 'pending',
      claim: null,
      blocked_by: [],
      reschedule_count: (task.reschedule_count || 0) + 1,
      rescheduled_from: fromWorker,
      rescheduled_at: new Date().toISOString(),
      error: null,
      completed_at: null,
      version: (task.version || 1) + 1,
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(taskStatePath(stateDir, taskId), reassigned);
    return { ok: true, task: reassigned };
  });
}

export function completeClaimedTask(stateDir, taskId, workerName, token, updates) {
  return withTaskLock(stateDir, taskId, () => {
    const task = readTeamTask(stateDir, taskId);
    if (task.claim?.owner !== workerName || task.claim?.token !== token) {
      return { ok: false, error: 'claim_mismatch', task };
    }
    if (Date.parse(task.claim.leased_until) <= Date.now()) {
      return { ok: false, error: 'lease_expired', task };
    }
    const completed = {
      ...task,
      ...updates,
      claim: null,
      version: (task.version || 1) + 1,
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(taskStatePath(stateDir, taskId), completed);
    return { ok: true, task: completed };
  });
}

export function renewTaskClaim(stateDir, taskId, workerName, token) {
  return withTaskLock(stateDir, taskId, () => {
    const task = readTeamTask(stateDir, taskId);
    if (task.status !== 'in_progress' || task.claim?.owner !== workerName || task.claim?.token !== token) {
      return { ok: false, error: 'claim_mismatch', task };
    }
    const renewed = {
      ...task,
      claim: { ...task.claim, leased_until: new Date(Date.now() + TASK_LEASE_MS).toISOString() },
      version: (task.version || 1) + 1,
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(taskStatePath(stateDir, taskId), renewed);
    return { ok: true, task: renewed };
  });
}

export function abandonTaskClaim(stateDir, taskId, workerName, token) {
  return withTaskLock(stateDir, taskId, () => {
    const task = readTeamTask(stateDir, taskId);
    if (task.claim?.owner !== workerName || task.claim?.token !== token) {
      return { ok: false, error: 'claim_mismatch', task };
    }
    const abandoned = {
      ...task,
      status: 'pending',
      claim: null,
      error: null,
      completed_at: null,
      version: (task.version || 1) + 1,
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(taskStatePath(stateDir, taskId), abandoned);
    return { ok: true, task: abandoned };
  });
}

export function enqueueMailboxMessage(stateDir, workerName, message) {
  const created = {
    id: randomUUID(),
    body: message,
    task_id: null,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  writeJsonAtomic(mailboxMessagePath(stateDir, workerName, created.id), created);
  return created;
}

export function enqueueTaskMessage(stateDir, workerName, taskId, message) {
  const created = enqueueMailboxMessage(stateDir, workerName, message);
  return updateMailboxMessage(stateDir, workerName, created.id, { task_id: taskId });
}

export function readMailbox(stateDir, workerName) {
  const directory = mailboxDir(stateDir, workerName);
  if (!existsSync(directory)) return { worker: workerName, messages: [] };
  const messages = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(join(directory, name)))
    .sort((left, right) =>
      String(left.created_at).localeCompare(String(right.created_at))
      || String(left.id).localeCompare(String(right.id)),
    );
  return { worker: workerName, messages };
}

export function updateMailboxMessage(stateDir, workerName, messageId, updates, options = {}) {
  const path = mailboxMessagePath(stateDir, workerName, messageId);
  if (!existsSync(path)) throw new Error(`mailbox message not found: ${messageId}`);
  return withRecordLock(stateDir, `mailbox-${messageId}`, () => {
    const current = readJson(path);
    assertStatusTransition('mailbox', current.status, updates.status, options);
    const updated = { ...current, ...updates, updated_at: new Date().toISOString() };
    writeJsonAtomic(path, updated);
    return updated;
  });
}

export function acknowledgeMailboxMessage(stateDir, workerName, messageId) {
  const path = mailboxMessagePath(stateDir, workerName, messageId);
  if (!existsSync(path)) throw new Error(`mailbox message not found: ${messageId}`);
  return withRecordLock(stateDir, `mailbox-${messageId}`, () => {
    const current = readJson(path);
    if (current.status !== 'pending') return { ok: false, error: 'message_not_pending', message: current };
    const acknowledgedAt = new Date().toISOString();
    const receipt = {
      token: randomUUID(),
      worker: workerName,
      acknowledged_at: acknowledgedAt,
      leased_until: new Date(Date.now() + MAILBOX_LEASE_MS).toISOString(),
    };
    const updated = {
      ...current,
      status: 'working',
      delivery_attempts: (current.delivery_attempts || 0) + 1,
      delivered_at: acknowledgedAt,
      receipt,
      updated_at: acknowledgedAt,
    };
    writeJsonAtomic(path, updated);
    return { ok: true, token: receipt.token, message: updated };
  });
}

export function completeMailboxDelivery(stateDir, workerName, messageId, receiptToken, updates) {
  const path = mailboxMessagePath(stateDir, workerName, messageId);
  if (!existsSync(path)) throw new Error(`mailbox message not found: ${messageId}`);
  return withRecordLock(stateDir, `mailbox-${messageId}`, () => {
    const current = readJson(path);
    if (current.receipt?.worker !== workerName || current.receipt?.token !== receiptToken) {
      return { ok: false, error: 'receipt_mismatch', message: current };
    }
    if (current.status !== 'working') return { ok: false, error: 'delivery_not_active', message: current };
    if (Date.parse(current.receipt.leased_until) <= Date.now()) {
      return { ok: false, error: 'lease_expired', message: current };
    }
    const updated = { ...current, ...updates, receipt: current.receipt, updated_at: new Date().toISOString() };
    writeJsonAtomic(path, updated);
    return { ok: true, message: updated };
  });
}

export function completeWorkerTurn(stateDir, {
  workerName, messageId = null, taskId = null, taskToken = null, receiptToken = null,
  taskUpdates = {}, messageUpdates = {}, workerUpdates = {},
}) {
  if (!messageId && !taskId) throw new Error('worker turn completion requires a task or mailbox message');
  const messagePath = messageId ? mailboxMessagePath(stateDir, workerName, messageId) : null;
  if (messagePath && !existsSync(messagePath)) throw new Error(`mailbox message not found: ${messageId}`);
  const lockNames = [`worker-${workerName}`];
  if (messageId) lockNames.push(`mailbox-${messageId}`);
  if (taskId) lockNames.push(`task-${taskId}`);
  return withOrderedRecordLocks(stateDir, lockNames.sort(), () => {
    const message = messagePath ? readJson(messagePath) : null;
    if (message) {
      if (message.status !== 'working' || message.receipt?.worker !== workerName
        || message.receipt?.token !== receiptToken) {
        return { ok: false, error: 'receipt_mismatch', message };
      }
      if (Date.parse(message.receipt.leased_until) <= Date.now()) {
        return { ok: false, error: 'lease_expired', message };
      }
    }
    let task = null;
    if (taskId) {
      task = readTeamTask(stateDir, taskId);
      if (task.status !== 'in_progress' || task.claim?.owner !== workerName
        || task.claim?.token !== taskToken) {
        return { ok: false, error: 'claim_mismatch', task, message };
      }
      if (Date.parse(task.claim.leased_until) <= Date.now()) {
        return { ok: false, error: 'lease_expired', task, message };
      }
    }
    const now = new Date().toISOString();
    const completedTask = task ? {
      ...task, ...taskUpdates, claim: null, version: (task.version || 1) + 1, updated_at: now,
    } : null;
    const completedMessage = message ? {
      ...message, ...messageUpdates, receipt: message.receipt, updated_at: now,
    } : null;
    const workerPath = workerStatePath(stateDir, workerName);
    const completedWorker = { ...readJson(workerPath), ...workerUpdates, updated_at: now };
    const transaction = beginDeliveryTransaction(stateDir, {
      operation: 'complete', workerName, messageId, taskId,
      task: completedTask, message: completedMessage, worker: completedWorker,
    });
    if (completedTask) writeJsonAtomic(taskStatePath(stateDir, taskId), completedTask);
    if (completedMessage) writeJsonAtomic(messagePath, completedMessage);
    writeJsonAtomic(workerPath, completedWorker);
    finishDeliveryTransaction(transaction);
    return { ok: true, task: completedTask, message: completedMessage, worker: completedWorker };
  });
}

export function renewMailboxDelivery(stateDir, workerName, messageId, receiptToken) {
  const path = mailboxMessagePath(stateDir, workerName, messageId);
  if (!existsSync(path)) throw new Error(`mailbox message not found: ${messageId}`);
  return withRecordLock(stateDir, `mailbox-${messageId}`, () => {
    const current = readJson(path);
    if (current.status !== 'working' || current.receipt?.worker !== workerName
      || current.receipt?.token !== receiptToken) {
      return { ok: false, error: 'receipt_mismatch', message: current };
    }
    const updated = {
      ...current,
      receipt: { ...current.receipt, leased_until: new Date(Date.now() + MAILBOX_LEASE_MS).toISOString() },
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(path, updated);
    return { ok: true, message: updated };
  });
}

export function reclaimExpiredMailboxDelivery(stateDir, workerName, messageId) {
  const path = mailboxMessagePath(stateDir, workerName, messageId);
  if (!existsSync(path)) throw new Error(`mailbox message not found: ${messageId}`);
  return withRecordLock(stateDir, `mailbox-${messageId}`, () => {
    const current = readJson(path);
    if (current.status !== 'working' || !current.receipt) {
      return { ok: true, reclaimed: false, message: current };
    }
    if (Date.parse(current.receipt.leased_until) > Date.now()) {
      return { ok: false, error: 'lease_active', message: current };
    }
    const exhausted = (current.delivery_attempts || 0) >= 3;
    const now = new Date().toISOString();
    const updated = {
      ...current,
      status: exhausted ? 'failed' : 'pending',
      receipt: null,
      error: exhausted ? 'mailbox delivery attempts exhausted' : null,
      completed_at: exhausted ? now : null,
      reclaimed_at: now,
      updated_at: now,
    };
    writeJsonAtomic(path, updated);
    return { ok: true, reclaimed: true, exhausted, message: updated };
  });
}

export function abandonMailboxDelivery(stateDir, workerName, messageId, receiptToken) {
  const path = mailboxMessagePath(stateDir, workerName, messageId);
  if (!existsSync(path)) return { ok: true, abandoned: false };
  return withRecordLock(stateDir, `mailbox-${messageId}`, () => {
    const current = readJson(path);
    if (current.status !== 'working' || current.receipt?.worker !== workerName
      || current.receipt?.token !== receiptToken) {
      return { ok: false, error: 'receipt_mismatch', message: current };
    }
    const updated = {
      ...current,
      status: 'pending',
      receipt: null,
      error: null,
      completed_at: null,
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(path, updated);
    return { ok: true, abandoned: true, message: updated };
  });
}

export function claimTaskMessage(stateDir, workerName, messageId) {
  const path = mailboxMessagePath(stateDir, workerName, messageId);
  if (!existsSync(path)) throw new Error(`mailbox message not found: ${messageId}`);
  const current = readJson(path);
  if (!current.task_id) return { ok: false, error: 'message_has_no_task', message: current };
  const lockNames = [`mailbox-${messageId}`, `task-${current.task_id}`].sort();
  return withOrderedRecordLocks(stateDir, lockNames, () => {
    const message = readJson(path);
    if (message.status !== 'pending') return { ok: false, error: 'message_not_pending', message };
    let task = readTeamTask(stateDir, message.task_id);
    if (task.status === 'in_progress' && task.claim && Date.parse(task.claim.leased_until) <= Date.now()) {
      task = { ...task, status: 'pending', claim: null };
    }
    if (task.status !== 'pending' && task.status !== 'blocked') {
      return { ok: false, error: 'task_not_pending', task, message };
    }
    if (task.owner && task.owner !== workerName) return { ok: false, error: 'owner_mismatch', task, message };
    const incomplete = (task.depends_on || []).filter((dependencyId) =>
      readTeamTask(stateDir, dependencyId).status !== 'completed',
    );
    if (incomplete.length > 0) {
      if (task.status !== 'blocked' || JSON.stringify(task.blocked_by || []) !== JSON.stringify(incomplete)) {
        task = {
          ...task, status: 'blocked', blocked_by: incomplete,
          version: (task.version || 1) + 1, updated_at: new Date().toISOString(),
        };
        writeJsonAtomic(taskStatePath(stateDir, task.id), task);
      }
      return { ok: false, error: 'blocked_dependency', dependencies: incomplete, task, message };
    }
    const now = new Date().toISOString();
    const token = randomUUID();
    const leasedUntil = new Date(Date.now() + TASK_LEASE_MS).toISOString();
    const claimedTask = {
      ...task, status: 'in_progress', owner: workerName, blocked_by: [],
      claim: { owner: workerName, token, leased_until: leasedUntil },
      version: (task.version || 1) + 1, started_at: task.started_at || now, updated_at: now,
    };
    const receiptToken = randomUUID();
    const claimedMessage = {
      ...message, status: 'working', delivery_attempts: (message.delivery_attempts || 0) + 1,
      delivered_at: now,
      receipt: { token: receiptToken, worker: workerName, acknowledged_at: now, leased_until: leasedUntil },
      updated_at: now,
    };
    const transaction = beginDeliveryTransaction(stateDir, {
      operation: 'claim', workerName, messageId, taskId: task.id, task: claimedTask, message: claimedMessage,
    });
    try {
      writeJsonAtomic(taskStatePath(stateDir, task.id), claimedTask);
      writeJsonAtomic(path, claimedMessage);
      finishDeliveryTransaction(transaction);
    } catch (error) {
      writeJsonAtomic(taskStatePath(stateDir, task.id), task);
      writeJsonAtomic(path, message);
      throw error;
    }
    return { ok: true, task: claimedTask, message: claimedMessage, token, receiptToken };
  });
}

export function recoverDeliveryTransactions(stateDir) {
  const directory = join(stateDir, 'delivery-transactions');
  if (!existsSync(directory)) return [];
  const recovered = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json'))) {
    const path = join(directory, name);
    const transaction = readJson(path);
    if (transaction.status !== 'active') continue;
    const lockNames = [];
    if (transaction.message_id) lockNames.push(`mailbox-${transaction.message_id}`);
    if (transaction.task_id) lockNames.push(`task-${transaction.task_id}`);
    if (transaction.worker_state) lockNames.push(`worker-${transaction.worker}`);
    lockNames.sort();
    withOrderedRecordLocks(stateDir, lockNames, () => {
      if (transaction.task) writeJsonAtomic(taskStatePath(stateDir, transaction.task_id), transaction.task);
      if (transaction.message) {
        writeJsonAtomic(mailboxMessagePath(stateDir, transaction.worker, transaction.message_id), transaction.message);
      }
      if (transaction.worker_state) {
        writeJsonAtomic(workerStatePath(stateDir, transaction.worker), transaction.worker_state);
      }
      writeJsonAtomic(path, { ...transaction, status: 'recovered', recovered_at: new Date().toISOString() });
    });
    recovered.push(transaction.id);
  }
  return recovered;
}

function beginDeliveryTransaction(stateDir, { operation = 'claim', workerName, messageId, taskId, task, message, worker }) {
  const transaction = {
    schema_version: 1, id: randomUUID(), operation, status: 'active', worker: workerName,
    message_id: messageId, task_id: taskId, task, message, created_at: new Date().toISOString(),
  };
  if (worker) transaction.worker_state = worker;
  const path = join(stateDir, 'delivery-transactions', `${transaction.id}.json`);
  writeJsonAtomic(path, transaction);
  return { path, transaction };
}

function finishDeliveryTransaction({ path, transaction }) {
  writeJsonAtomic(path, { ...transaction, status: 'committed', completed_at: new Date().toISOString() });
}

export function updateTeamConfig(stateDir, updates, options = {}) {
  return withRecordLock(stateDir, 'team-config', () => {
    const path = join(stateDir, 'config.json');
    const current = readJson(path);
    assertStatusTransition('config', current.status, updates.status, options);
    const next = { ...current, ...updates, updated_at: new Date().toISOString() };
    writeJsonAtomic(path, next);
    return next;
  });
}

export function addTeamWorker(stateDir, worker) {
  return withRecordLock(stateDir, 'team-config', () => {
    const configPath = join(stateDir, 'config.json');
    const config = readJson(configPath);
    if (config.workers.includes(worker.name)) throw new Error(`worker already exists: ${worker.name}`);
    writeJsonAtomic(workerStatePath(stateDir, worker.name), worker);
    mkdirSync(mailboxDir(stateDir, worker.name), { recursive: true });
    const task = createTeamTask(stateDir, {
      subject: worker.assignment,
      description: worker.assignment,
      owner: worker.name,
      role: worker.role,
      requires_commit: worker.requires_commit,
    });
    writeJsonAtomic(workerStatePath(stateDir, worker.name), { ...worker, initial_task_id: task.id });
    writeJsonAtomic(configPath, {
      ...config,
      workers: [...config.workers, worker.name],
      next_worker_index: Math.max(config.next_worker_index || 1, worker.index + 1),
      status: 'running',
      updated_at: new Date().toISOString(),
    });
    return task;
  });
}

export function removeTeamWorker(stateDir, workerName) {
  return withRecordLock(stateDir, 'team-config', () => {
    const configPath = join(stateDir, 'config.json');
    const config = readJson(configPath);
    if (!config.workers.includes(workerName)) throw new Error(`worker not found: ${workerName}`);
    writeJsonAtomic(configPath, {
      ...config,
      workers: config.workers.filter((name) => name !== workerName),
      status: config.workers.length === 1 ? 'empty' : config.status,
      updated_at: new Date().toISOString(),
    });
  });
}

export function workerStatePath(stateDir, workerName) {
  return join(stateDir, 'workers', `${workerName}.json`);
}

export function taskStatePath(stateDir, taskId) {
  return join(stateDir, 'tasks', `task-${taskId}.json`);
}

export function mailboxDir(stateDir, workerName) {
  return join(stateDir, 'mailbox', workerName);
}

export function mailboxMessagePath(stateDir, workerName, messageId) {
  return join(mailboxDir(stateDir, workerName), `${messageId}.json`);
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    syncDescriptor(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJson(path) {
  return readVersionedRecord(path);
}

function withTaskLock(stateDir, taskId, callback) {
  return withRecordLock(stateDir, `task-${taskId}`, callback);
}

function withOrderedRecordLocks(stateDir, names, callback, index = 0) {
  if (index >= names.length) return callback();
  return withStateLock(stateDir, names[index], () => withOrderedRecordLocks(stateDir, names, callback, index + 1));
}

export function withStateLock(stateDir, recordName, callback, { beforePublish } = {}) {
  const lockPath = join(stateDir, '.locks', `${recordName}.lock`);
  mkdirSync(dirname(lockPath), { recursive: true });
  removeAbandonedLockCandidates(lockPath);
  const owner = { token: randomUUID(), pid: process.pid, acquired_at: new Date().toISOString() };
  const candidatePath = `${lockPath}.candidate.${process.pid}.${owner.token}`;
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  mkdirSync(candidatePath);
  try {
    writeJsonAtomic(join(candidatePath, 'owner.json'), owner);
    beforePublish?.(candidatePath);
    while (true) {
      if (existsSync(lockPath)) {
        recoverAbandonedLock(lockPath);
        if (Date.now() >= deadline) throw new Error(`record lock timeout: ${recordName}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        continue;
      }
      try {
        renameSync(candidatePath, lockPath);
        syncDirectory(dirname(lockPath));
        break;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
        recoverAbandonedLock(lockPath);
        if (Date.now() >= deadline) throw new Error(`record lock timeout: ${recordName}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } finally {
    if (existsSync(candidatePath)) removeTree(candidatePath);
  }
  try {
    return callback();
  } finally {
    releaseOwnedLock(lockPath, owner.token);
  }
}

const withRecordLock = withStateLock;

function removeAbandonedLockCandidates(lockPath) {
  const directory = dirname(lockPath);
  const prefix = `${lockPath.slice(directory.length + 1)}.candidate.`;
  for (const name of readdirSync(directory).filter((entry) => entry.startsWith(prefix))) {
    const candidatePath = join(directory, name);
    let owner;
    try {
      owner = readJson(join(candidatePath, 'owner.json'));
    } catch {
      const candidatePid = Number(name.slice(prefix.length).split('.')[0]);
      if (!processIsLive(candidatePid)) removeTree(candidatePath);
      continue;
    }
    if (!processIsLive(owner.pid)) removeTree(candidatePath);
  }
}

function recoverAbandonedLock(lockPath) {
  let owner;
  let ageMs;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
    owner = readJson(join(lockPath, 'owner.json'));
  } catch {
    if (ageMs > 30_000) quarantineLock(lockPath, 'unowned');
    return;
  }
  if (ageMs <= 30_000 || processIsLive(owner.pid)) return;
  quarantineLock(lockPath, owner.token);
}

function quarantineLock(lockPath, expectedToken) {
  const quarantine = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockPath, quarantine);
  } catch {
    return false;
  }
  try {
    const moved = readJson(join(quarantine, 'owner.json'));
    if (expectedToken !== 'unowned' && moved.token !== expectedToken) {
      try { renameSync(quarantine, lockPath); } catch {}
      return false;
    }
    removeTree(quarantine);
    return true;
  } catch {
    if (expectedToken === 'unowned') {
      removeTree(quarantine);
      return true;
    }
    try { renameSync(quarantine, lockPath); } catch {}
    return false;
  }
}

function releaseOwnedLock(lockPath, token) {
  try {
    if (readJson(join(lockPath, 'owner.json')).token !== token) return;
  } catch {
    return;
  }
  const releasePath = `${lockPath}.release.${process.pid}.${token}`;
  try {
    renameWithRetry(lockPath, releasePath);
    if (readJson(join(releasePath, 'owner.json')).token === token) {
      removeTree(releasePath);
    } else {
      try { renameSync(releasePath, lockPath); } catch {}
    }
  } catch {}
}

function processIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function renameWithRetry(source, target, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function removeTree(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

function syncDescriptor(descriptor) {
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!(process.platform === 'win32' && error?.code === 'EPERM')) throw error;
  }
}

function syncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    syncDescriptor(descriptor);
  } catch (error) {
    if (!(process.platform === 'win32' && error?.code === 'EPERM')) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}
