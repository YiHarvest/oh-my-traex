import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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

export function initTeamState({ cwd, name, task, model, plan, planningMode, plannerFallback, leaderPaneId, leaderSessionId, workers }) {
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

export function updateWorkerState(stateDir, workerName, updates) {
  return withRecordLock(stateDir, `worker-${workerName}`, () => {
    const path = workerStatePath(stateDir, workerName);
    const current = readJson(path);
    const next = { ...current, ...updates, updated_at: new Date().toISOString() };
    writeJsonAtomic(path, next);
    return next;
  });
}

export function updateTaskState(stateDir, taskId, updates) {
  return withTaskLock(stateDir, taskId, () => {
    const path = taskStatePath(stateDir, taskId);
    const current = readJson(path);
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
      claim: { owner: workerName, token, leased_until: new Date(Date.now() + 15 * 60_000).toISOString() },
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
      claim: { ...task.claim, leased_until: new Date(Date.now() + 15 * 60_000).toISOString() },
      version: (task.version || 1) + 1,
      updated_at: new Date().toISOString(),
    };
    writeJsonAtomic(taskStatePath(stateDir, taskId), renewed);
    return { ok: true, task: renewed };
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

export function updateMailboxMessage(stateDir, workerName, messageId, updates) {
  const path = mailboxMessagePath(stateDir, workerName, messageId);
  if (!existsSync(path)) throw new Error(`mailbox message not found: ${messageId}`);
  return withRecordLock(stateDir, `mailbox-${messageId}`, () => {
    const updated = { ...readJson(path), ...updates, updated_at: new Date().toISOString() };
    writeJsonAtomic(path, updated);
    return updated;
  });
}

export function updateTeamConfig(stateDir, updates) {
  return withRecordLock(stateDir, 'team-config', () => {
    const path = join(stateDir, 'config.json');
    const current = readJson(path);
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
  return JSON.parse(readFileSync(path, 'utf8'));
}

function withTaskLock(stateDir, taskId, callback) {
  return withRecordLock(stateDir, `task-${taskId}`, callback);
}

export function withStateLock(stateDir, recordName, callback) {
  const lockPath = join(stateDir, '.locks', `${recordName}.lock`);
  mkdirSync(dirname(lockPath), { recursive: true });
  const owner = { token: randomUUID(), pid: process.pid, acquired_at: new Date().toISOString() };
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      writeJsonAtomic(join(lockPath, 'owner.json'), owner);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      recoverAbandonedLock(lockPath);
      if (Date.now() >= deadline) throw new Error(`record lock timeout: ${recordName}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return callback();
  } finally {
    releaseOwnedLock(lockPath, owner.token);
  }
}

const withRecordLock = withStateLock;

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
    rmSync(quarantine, { recursive: true, force: true });
    return true;
  } catch {
    if (expectedToken === 'unowned') {
      rmSync(quarantine, { recursive: true, force: true });
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
    renameSync(lockPath, releasePath);
    if (readJson(join(releasePath, 'owner.json')).token === token) {
      rmSync(releasePath, { recursive: true, force: true });
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
