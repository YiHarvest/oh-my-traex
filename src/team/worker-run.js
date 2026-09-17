#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { acknowledgeMailboxMessage, claimTeamTask, completeClaimedTask, completeMailboxDelivery, readMailbox, renewTaskClaim, updateMailboxMessage, updateWorkerState } from './state.js';
import { projectTrustArgs } from './trae.js';
import { appendTeamEvent } from './events.js';

const [stateDir, workerName, worktreePath, promptPath, resultPath, sessionId, model = ''] = process.argv.slice(2);
const initialState = JSON.parse(readFileSync(join(stateDir, 'workers', `${workerName}.json`), 'utf8'));
const initialTaskId = String(initialState.initial_task_id || initialState.index);
updateWorkerState(stateDir, workerName, { status: 'starting', started_at: new Date().toISOString(), pid: process.pid });
const initialClaim = await waitForInitialClaim();
let activeClaim = { taskId: initialTaskId, token: initialClaim.token };
updateWorkerState(stateDir, workerName, { status: 'working', blocked_task_ids: [] });

let activeSessionId = sessionId;
let child = launchTrae(['exec', '--json', '--skip-git-repo-check', '-C', worktreePath, ...projectTrustArgs(worktreePath), '--sandbox', 'workspace-write', '--session-id', sessionId, '--output-last-message', resultPath], readFileSync(promptPath, 'utf8'));
const heartbeat = setInterval(() => {
  updateWorkerState(stateDir, workerName, { heartbeat_at: new Date().toISOString() });
  if (activeClaim) renewTaskClaim(stateDir, activeClaim.taskId, workerName, activeClaim.token);
}, 5000);
const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once('SIGTERM', () => forwardSignal('SIGTERM'));
process.once('SIGINT', () => forwardSignal('SIGINT'));
const exitCode = await new Promise((resolve) => {
  child.once('error', () => resolve(1));
  child.once('close', (code) => resolve(code ?? 1));
});
activeSessionId = JSON.parse(readFileSync(join(stateDir, 'workers', workerName + '.json'), 'utf8')).session_id || activeSessionId;

// TraeX's sandbox may commit through temporary Git metadata. Rebuild only the
// real worktree index before evaluating cleanliness; this preserves HEAD and
// working-tree files while eliminating stale index entries.
spawnSync('git', ['reset', '--mixed', 'HEAD'], { cwd: worktreePath, stdio: 'ignore' });
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' });
const commitSha = commit.status === 0 ? commit.stdout.trim() : null;
const committed = Boolean(commitSha && commitSha !== initialState.base_commit);
const clean = dirty.status === 0 && dirty.stdout.trim() === '';
const hasResult = existsSync(resultPath) && statSync(resultPath).size > 0;
const commitSatisfied = initialState.requires_commit ? committed : true;
const finalStatus = exitCode === 0 && commitSatisfied && clean && hasResult ? 'completed' : 'failed';
const currentState = JSON.parse(readFileSync(join(stateDir, 'workers', workerName + '.json'), 'utf8'));
if (currentState.status === 'cancelled') {
  process.stdout.write(`\n[otx] ${workerName} cancelled by leader.\n`);
  process.exitCode = 0;
  process.exit();
}
const initialCompletion = completeClaimedTask(stateDir, initialTaskId, workerName, initialClaim.token, {
  status: finalStatus,
  completed_at: new Date().toISOString(),
  commit: commitSha,
  result_path: resultPath,
});
const persistedInitialStatus = initialCompletion.ok ? finalStatus : 'failed';
appendTeamEvent(stateDir, `task.${persistedInitialStatus}`, {
  actor: workerName,
  data: { task_id: initialTaskId, commit: commitSha, error: initialCompletion.ok ? null : initialCompletion.error },
});
updateWorkerState(stateDir, workerName, {
  status: persistedInitialStatus,
  exit_code: exitCode,
  completed_at: new Date().toISOString(),
  commit: commitSha,
  error: !initialCompletion.ok
    ? initialCompletion.error
    : finalStatus === 'failed'
    ? exitCode !== 0
      ? `traex exited ${exitCode}`
      : !commitSatisfied
        ? 'worker produced no commit'
        : !clean
          ? 'worker worktree is dirty after completion'
          : 'worker produced no result'
      : null,
});
activeClaim = null;
process.stdout.write(`\n[otx] ${workerName} ${persistedInitialStatus}; waiting for leader shutdown.\n`);
process.exitCode = 0;
while (true) {
  const selected = selectPendingMessage();
  if (!selected) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    continue;
  }
  const { message, taskClaim, receiptToken } = selected;
  activeClaim = taskClaim ? { taskId: message.task_id, token: taskClaim.token } : null;
  appendTeamEvent(stateDir, 'message.delivered', { actor: workerName, data: { message_id: message.id, task_id: message.task_id } });
  updateWorkerState(stateDir, workerName, {
    status: 'working',
    current_message_id: message.id,
    current_task_id: message.task_id,
    blocked_task_ids: [],
  });
  const followupBaseCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).stdout.trim();
  const followupStartState = JSON.parse(readFileSync(join(stateDir, 'workers', workerName + '.json'), 'utf8'));
  const followupPath = join(stateDir, 'workers', workerName, `followup-${message.id}.md`);
  const followupArgs = ['exec', 'resume', '--json', ...projectTrustArgs(worktreePath), '--output-last-message', followupPath];
  if (model) followupArgs.push('--model', model);
  followupArgs.push(activeSessionId, message.body);
  child = spawn('traex', followupArgs, { cwd: worktreePath, stdio: ['inherit', 'pipe', 'inherit'] });
  attachJsonOutput(child);
  const followupStartedAt = new Date().toISOString();
  updateWorkerState(stateDir, workerName, {
    child_pid: child.pid,
    child_started_at: followupStartedAt,
    last_activity_at: followupStartedAt,
    heartbeat_at: followupStartedAt,
    session_id: activeSessionId,
  });
  const followupExit = await waitForChild(child);
  const latestMessage = readMailbox(stateDir, workerName).messages.find((item) => item.id === message.id);
  if (latestMessage?.status === 'cancelled') {
    process.stdout.write(`\n[otx] follow-up ${message.id} cancelled by leader.\n`);
    process.exitCode = 0;
    process.exit();
  }
  spawnSync('git', ['reset', '--mixed', 'HEAD'], { cwd: worktreePath, stdio: 'ignore' });
  const followupCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' });
  const followupDirty = spawnSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' });
  const followupCommitSha = followupCommit.status === 0 ? followupCommit.stdout.trim() : null;
  const followupTask = message.task_id
    ? JSON.parse(readFileSync(join(stateDir, 'tasks', 'task-' + message.task_id + '.json'), 'utf8'))
    : null;
  const followupCommitSatisfied = followupTask?.requires_commit ? followupCommitSha !== followupBaseCommit : true;
  const followupHasResult = existsSync(followupPath) && statSync(followupPath).size > 0;
  const followupStatus = followupExit === 0
    && followupDirty.status === 0
    && followupDirty.stdout.trim() === ''
    && followupCommitSatisfied
    && followupHasResult
    ? 'completed'
    : 'failed';
  const followupError = followupStatus === 'failed'
    ? followupExit !== 0 ? `follow-up exited ${followupExit}`
      : !followupCommitSatisfied ? 'follow-up task produced no commit'
        : !followupHasResult ? 'follow-up produced no result'
          : 'follow-up worktree is dirty'
    : null;
  let persistedFollowupStatus = followupStatus;
  let persistedFollowupError = followupError;
  if (message.task_id) {
    const completion = completeClaimedTask(stateDir, message.task_id, workerName, taskClaim.token, {
      status: followupStatus,
      completed_at: new Date().toISOString(),
      commit: followupCommitSha,
      result_path: followupPath,
      error: followupError,
    });
    if (!completion.ok) {
      persistedFollowupStatus = 'failed';
      persistedFollowupError = completion.error;
    }
    appendTeamEvent(stateDir, `task.${persistedFollowupStatus}`, {
      actor: workerName,
      data: { task_id: message.task_id, message_id: message.id, commit: followupCommitSha, error: persistedFollowupError },
    });
  }
  completeMailboxDelivery(stateDir, workerName, message.id, receiptToken, {
    status: persistedFollowupStatus,
    completed_at: new Date().toISOString(),
    result_path: followupPath,
    commit: followupCommitSha,
    error: persistedFollowupError,
  });
  appendTeamEvent(stateDir, `message.${persistedFollowupStatus}`, {
    actor: workerName, data: { message_id: message.id, task_id: message.task_id, commit: followupCommitSha },
  });
  activeClaim = null;
  updateWorkerState(stateDir, workerName, {
    status: persistedFollowupStatus,
    current_message_id: null,
    current_task_id: null,
    blocked_task_ids: [],
    commit: followupCommitSha,
    integration: followupCommitSha !== followupBaseCommit ? null : followupStartState.integration,
    completed_at: new Date().toISOString(),
    error: persistedFollowupError,
  });
}

function selectPendingMessage() {
  const pending = readMailbox(stateDir, workerName).messages.filter((item) => item.status === 'pending');
  const blockedTaskIds = [];
  for (const message of pending) {
    if (!message.task_id) {
      const delivery = acknowledgeMailboxMessage(stateDir, workerName, message.id);
      if (delivery.ok) return { message: delivery.message, taskClaim: null, receiptToken: delivery.token };
      continue;
    }
    const taskClaim = claimTeamTask(stateDir, message.task_id, workerName);
    if (taskClaim.ok) {
      const delivery = acknowledgeMailboxMessage(stateDir, workerName, message.id);
      if (delivery.ok) return { message: delivery.message, taskClaim, receiptToken: delivery.token };
      updateTaskStateAfterDeliveryRace(message, taskClaim);
      continue;
    }
    if (taskClaim.error === 'blocked_dependency') {
      blockedTaskIds.push(message.task_id);
      continue;
    }
    updateMailboxMessage(stateDir, workerName, message.id, {
      status: 'failed', error: taskClaim.error, completed_at: new Date().toISOString(),
    });
  }
  if (blockedTaskIds.length > 0) {
    updateWorkerState(stateDir, workerName, {
      status: 'blocked',
      blocked_task_ids: blockedTaskIds,
      current_message_id: null,
      current_task_id: null,
    });
  }
  return null;
}

function updateTaskStateAfterDeliveryRace(message, taskClaim) {
  completeClaimedTask(stateDir, message.task_id, workerName, taskClaim.token, {
    status: 'pending', claim: null, error: null, completed_at: null,
  });
}

function launchTrae(baseArgs, prompt) {
  const args = [...baseArgs];
  if (model) args.push('--model', model);
  args.push(prompt);
  const processHandle = spawn('traex', args, { cwd: worktreePath, stdio: ['inherit', 'pipe', 'inherit'] });
  attachJsonOutput(processHandle);
  const startedAt = new Date().toISOString();
  updateWorkerState(stateDir, workerName, {
    child_pid: processHandle.pid,
    child_started_at: startedAt,
    last_activity_at: startedAt,
    heartbeat_at: startedAt,
  });
  return processHandle;
}

function attachJsonOutput(processHandle) {
  const lines = createInterface({ input: processHandle.stdout });
  lines.on('line', (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      updateWorkerState(stateDir, workerName, { last_activity_at: new Date().toISOString(), last_event_type: 'output' });
      process.stdout.write(`${line}\n`);
      return;
    }
    updateWorkerState(stateDir, workerName, {
      last_activity_at: new Date().toISOString(),
      last_event_type: event.type || 'event',
    });
    if (event.type === 'thread.started' && event.thread_id) {
      activeSessionId = event.thread_id;
      updateWorkerState(stateDir, workerName, { session_id: activeSessionId });
      process.stdout.write(`[otx] session ${activeSessionId}\n`);
      return;
    }
    const item = event.item;
    if (item?.type === 'agent_message' && item.text) process.stdout.write(`${item.text}\n`);
    else if (item?.type === 'command_execution') {
      if (event.type === 'item.started') process.stdout.write(`$ ${item.command || ''}\n`);
      else if (item.aggregated_output) process.stdout.write(item.aggregated_output);
    }
    else if (item?.type === 'error' && item.message) process.stderr.write(`${item.message}\n`);
  });
}

function waitForChild(processHandle) {
  return new Promise((resolve) => {
    processHandle.once('error', () => resolve(1));
    processHandle.once('close', (code) => resolve(code ?? 1));
  });
}

async function waitForInitialClaim() {
  while (true) {
    const claimed = claimTeamTask(stateDir, initialTaskId, workerName);
    if (claimed.ok) return claimed;
    if (claimed.error !== 'blocked_dependency') {
      throw new Error(`failed to claim initial task: ${claimed.error}`);
    }
    updateWorkerState(stateDir, workerName, {
      status: 'blocked',
      blocked_task_ids: claimed.dependencies,
      heartbeat_at: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
