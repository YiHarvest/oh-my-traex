import { spawnSync } from 'node:child_process';
import { listTeamTasks, readMailbox, readTeamState, reclaimExpiredMailboxDelivery, reclaimExpiredTask } from './state.js';
import { reconcileTeam, recoverTeam } from './runtime.js';
import { appendTeamEvent } from './events.js';

export const DEFAULT_SUPERVISOR_INTERVAL_MS = 1000;

export function superviseTeamOnce(cwd, name, run = spawnSync) {
  const recovery = recoverTeam(cwd, name, run);
  const before = readTeamState(cwd, name);
  const reclaimedTasks = [];
  const reclaimedMessages = [];

  for (const task of listTeamTasks(before.stateDir)) {
    if (task.status !== 'in_progress' || !task.claim) continue;
    const result = reclaimExpiredTask(before.stateDir, task.id);
    if (result.reclaimed) reclaimedTasks.push(task.id);
  }

  for (const worker of before.workers) {
    for (const message of readMailbox(before.stateDir, worker.name).messages) {
      if (message.status !== 'working' || !message.receipt) continue;
      const result = reclaimExpiredMailboxDelivery(before.stateDir, worker.name, message.id);
      if (result.reclaimed) reclaimedMessages.push({
        worker: worker.name,
        message_id: message.id,
        exhausted: result.exhausted,
      });
    }
  }

  const state = reconcileTeam(cwd, name, run);
  for (const taskId of reclaimedTasks) {
    appendTeamEvent(before.stateDir, 'task.lease_reclaimed', { data: { task_id: taskId } });
  }
  for (const message of reclaimedMessages) {
    appendTeamEvent(before.stateDir, 'message.lease_reclaimed', { data: message });
  }
  for (const transactionId of recovery.recovered) {
    appendTeamEvent(before.stateDir, 'transaction.recovered', { data: { transaction_id: transactionId } });
  }
  for (const transactionId of recovery.recovered_deliveries) {
    appendTeamEvent(before.stateDir, 'delivery.recovered', { data: { transaction_id: transactionId } });
  }
  return {
    state,
    recovered_transactions: recovery.recovered,
    recovered_deliveries: recovery.recovered_deliveries,
    cleanup_debt: recovery.cleanup_debt,
    reclaimed_tasks: reclaimedTasks,
    reclaimed_messages: reclaimedMessages,
  };
}

export async function runTeamSupervisor(cwd, name, {
  intervalMs = DEFAULT_SUPERVISOR_INTERVAL_MS,
  once = false,
  run = spawnSync,
  signal,
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 100) {
    throw new Error('supervisor interval must be an integer of at least 100ms.');
  }
  let last;
  while (!signal?.aborted) {
    last = superviseTeamOnce(cwd, name, run);
    if (once || isTerminal(last.state.config.status)) return last;
    await delay(intervalMs, signal);
  }
  return last;
}

function isTerminal(status) {
  return ['ready', 'failed', 'integrated', 'stopped', 'cleaned', 'cleanup_pending'].includes(status);
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
