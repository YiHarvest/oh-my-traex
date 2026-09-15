export function nextWrappedIndex(length, currentIndex, delta) {
  if (!Number.isInteger(length) || length < 1) return -1;
  const current = Number.isInteger(currentIndex) && currentIndex >= 0 ? currentIndex : 0;
  return (current + delta + length) % length;
}

export function parseDependencyIds(value) {
  const ids = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (ids.some((item) => !/^\d+$/.test(item))) throw new Error('Dependencies must be comma-separated task IDs.');
  return [...new Set(ids)];
}

export function actionAvailability({ live, hasTeam, focusedWorker, teamStatus }) {
  const hasLiveWorker = Boolean(focusedWorker && focusedWorker.paneAlive !== false);
  return {
    message: live ? hasTeam && hasLiveWorker : true,
    assign: live ? hasTeam && hasLiveWorker : true,
    stop: live ? hasTeam && !['stopped', 'cleaned', 'empty'].includes(teamStatus) : teamStatus === 'working',
  };
}

export function summarizeRuntime(snapshot) {
  const summary = snapshot?.summary || { teams: 0, running: 0, workers: 0, unhealthy: 0 };
  const pending = (snapshot?.teams || []).reduce((count, team) => count + (team.workers || []).reduce((workerCount, worker) => {
    return workerCount + Number(worker.mailbox_pending || 0);
  }, 0), 0);
  return { ...summary, pending, attention: Number(summary.unhealthy || 0) + pending };
}

export function buildWorkerActionPayload({ mode, team, target, message, dependencies = [], model }) {
  if (mode === 'add') return { action: 'add-worker', team, role: target, assignment: message, model };
  if (mode === 'assign') return { action: 'assign-task', team, worker: target, description: message, depends_on: dependencies };
  return { action: 'send-message', team, worker: target, message };
}
