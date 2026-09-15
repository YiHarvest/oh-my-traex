import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
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

export function initTeamState({ cwd, name, task, leaderPaneId, leaderSessionId, workers }) {
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
    cwd: resolve(cwd),
    status: 'running',
    created_at: new Date().toISOString(),
    leader_pane_id: leaderPaneId,
    leader_session_id: leaderSessionId,
    workers: workers.map(({ name: workerName }) => workerName),
  };
  writeJsonAtomic(join(stateDir, 'config.json'), config);
  for (const worker of workers) {
    writeJsonAtomic(workerStatePath(stateDir, worker.name), worker);
    mkdirSync(mailboxDir(stateDir, worker.name), { recursive: true });
    writeJsonAtomic(taskStatePath(stateDir, String(worker.index)), {
      id: String(worker.index),
      subject: worker.assignment,
      description: worker.assignment,
      owner: worker.name,
      role: worker.role,
      requires_commit: worker.requires_commit,
      status: 'pending',
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
  const path = workerStatePath(stateDir, workerName);
  const current = readJson(path);
  const next = { ...current, ...updates, updated_at: new Date().toISOString() };
  writeJsonAtomic(path, next);
  return next;
}

export function updateTaskState(stateDir, taskId, updates) {
  const path = taskStatePath(stateDir, taskId);
  const current = readJson(path);
  const next = { ...current, ...updates, updated_at: new Date().toISOString() };
  writeJsonAtomic(path, next);
  return next;
}

export function createTeamTask(stateDir, input) {
  const tasksDir = join(stateDir, 'tasks');
  const ids = readdirSync(tasksDir)
    .map((name) => name.match(/^task-(\d+)\.json$/)?.[1])
    .filter(Boolean)
    .map(Number);
  const id = String(ids.length === 0 ? 1 : Math.max(...ids) + 1);
  const task = {
    id,
    subject: input.subject,
    description: input.description,
    owner: input.owner,
    role: input.role,
    requires_commit: input.requires_commit,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  writeJsonAtomic(taskStatePath(stateDir, id), task);
  return task;
}

export function listTeamTasks(stateDir) {
  const tasksDir = join(stateDir, 'tasks');
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((name) => /^task-\d+\.json$/.test(name))
    .map((name) => readJson(join(tasksDir, name)))
    .sort((left, right) => Number(left.id) - Number(right.id));
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
  const updated = { ...readJson(path), ...updates, updated_at: new Date().toISOString() };
  writeJsonAtomic(path, updated);
  return updated;
}

export function updateTeamConfig(stateDir, updates) {
  const path = join(stateDir, 'config.json');
  const current = readJson(path);
  const next = { ...current, ...updates, updated_at: new Date().toISOString() };
  writeJsonAtomic(path, next);
  return next;
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
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}
