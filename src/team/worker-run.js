#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { readMailbox, updateMailboxMessage, updateTaskState, updateWorkerState } from './state.js';

const [stateDir, workerName, worktreePath, promptPath, resultPath, sessionId, model = ''] = process.argv.slice(2);
const initialState = JSON.parse(readFileSync(join(stateDir, 'workers', `${workerName}.json`), 'utf8'));
updateWorkerState(stateDir, workerName, { status: 'working', started_at: new Date().toISOString(), pid: process.pid });
updateTaskState(stateDir, String(initialState.index), { status: 'in_progress', started_at: new Date().toISOString() });

let activeSessionId = sessionId;
let child = launchTrae(['exec', '--json', '--skip-git-repo-check', '-C', worktreePath, '--sandbox', 'workspace-write', '--session-id', sessionId, '--output-last-message', resultPath], readFileSync(promptPath, 'utf8'));
const heartbeat = setInterval(() => {
  updateWorkerState(stateDir, workerName, { heartbeat_at: new Date().toISOString() });
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
updateWorkerState(stateDir, workerName, {
  status: finalStatus,
  exit_code: exitCode,
  completed_at: new Date().toISOString(),
  commit: commitSha,
  error: finalStatus === 'failed'
    ? exitCode !== 0
      ? `traex exited ${exitCode}`
      : !commitSatisfied
        ? 'worker produced no commit'
        : !clean
          ? 'worker worktree is dirty after completion'
          : 'worker produced no result'
    : null,
});
updateTaskState(stateDir, String(initialState.index), {
  status: finalStatus,
  completed_at: new Date().toISOString(),
  commit: commitSha,
  result_path: resultPath,
});
process.stdout.write(`\n[otx] ${workerName} ${finalStatus}; waiting for leader shutdown.\n`);
process.exitCode = 0;
while (true) {
  const message = readMailbox(stateDir, workerName).messages.find((item) => item.status === 'pending');
  if (!message) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    continue;
  }
  updateMailboxMessage(stateDir, workerName, message.id, { status: 'working', started_at: new Date().toISOString() });
  updateWorkerState(stateDir, workerName, { status: 'working', current_message_id: message.id });
  const followupPath = join(stateDir, 'workers', workerName, `followup-${message.id}.md`);
  const followupArgs = ['exec', 'resume', '--json', '--output-last-message', followupPath];
  if (model) followupArgs.push('--model', model);
  followupArgs.push(activeSessionId, message.body);
  child = spawn('traex', followupArgs, { cwd: worktreePath, stdio: ['inherit', 'pipe', 'inherit'] });
  attachJsonOutput(child);
  updateWorkerState(stateDir, workerName, { child_pid: child.pid, heartbeat_at: new Date().toISOString(), session_id: activeSessionId });
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
  const followupStatus = followupExit === 0 && followupDirty.status === 0 && followupDirty.stdout.trim() === '' ? 'completed' : 'failed';
  updateMailboxMessage(stateDir, workerName, message.id, {
    status: followupStatus,
    completed_at: new Date().toISOString(),
    result_path: followupPath,
    commit: followupCommit.status === 0 ? followupCommit.stdout.trim() : null,
    error: followupStatus === 'failed' ? `follow-up exited ${followupExit}` : null,
  });
  updateWorkerState(stateDir, workerName, {
    status: followupStatus,
    current_message_id: null,
    commit: followupCommit.status === 0 ? followupCommit.stdout.trim() : null,
    completed_at: new Date().toISOString(),
  });
}

function launchTrae(baseArgs, prompt) {
  const args = [...baseArgs];
  if (model) args.push('--model', model);
  args.push(prompt);
  const processHandle = spawn('traex', args, { cwd: worktreePath, stdio: ['inherit', 'pipe', 'inherit'] });
  attachJsonOutput(processHandle);
  updateWorkerState(stateDir, workerName, { child_pid: processHandle.pid, heartbeat_at: new Date().toISOString() });
  return processHandle;
}

function attachJsonOutput(processHandle) {
  const lines = createInterface({ input: processHandle.stdout });
  lines.on('line', (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
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
