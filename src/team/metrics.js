import { readMailbox } from './state.js';
import { listTeamEvents } from './events.js';
import { teamStatus } from './runtime.js';

export function collectTeamMetrics(cwd, name, run) {
  const state = teamStatus(cwd, name, run);
  const messages = state.workers.flatMap((worker) => readMailbox(state.stateDir, worker.name).messages);
  const events = readAllEvents(state.stateDir);
  const taskDurations = state.tasks.map(durationBetween('started_at', 'completed_at')).filter(Number.isFinite);
  const deliveryLatencies = messages.map(durationBetween('created_at', 'delivered_at')).filter(Number.isFinite);
  return {
    team: state.config.name,
    generated_at: new Date().toISOString(),
    task_queue_depth: state.tasks.filter((task) => ['pending', 'blocked', 'in_progress'].includes(task.status)).length,
    message_queue_depth: messages.filter((message) => ['pending', 'working'].includes(message.status)).length,
    workers: countBy(state.workers, (worker) => worker.health || worker.status),
    task_statuses: countBy(state.tasks, (task) => task.status),
    message_statuses: countBy(messages, (message) => message.status),
    task_lease_reclaims: countEvents(events, 'task.lease_reclaimed'),
    message_lease_reclaims: countEvents(events, 'message.lease_reclaimed'),
    reschedules: countEvents(events, 'task.rescheduled'),
    transaction_recoveries: countEvents(events, 'transaction.recovered'),
    delivery_recoveries: countEvents(events, 'delivery.recovered'),
    delivery_latency_ms: summarize(deliveryLatencies),
    task_duration_ms: summarize(taskDurations),
  };
}

function readAllEvents(stateDir) {
  const events = [];
  let cursor = null;
  while (true) {
    const page = listTeamEvents(stateDir, { after: cursor, limit: 1000 });
    events.push(...page.events);
    if (page.events.length < 1000 || page.cursor === cursor) return events;
    cursor = page.cursor;
  }
}

function durationBetween(startField, endField) {
  return (record) => {
    const start = Date.parse(record[startField] || '');
    const end = Date.parse(record[endField] || '');
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : Number.NaN;
  };
}

function countBy(records, select) {
  return records.reduce((counts, record) => {
    const key = select(record) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function countEvents(events, type) {
  return events.filter((event) => event.type === type).length;
}

function summarize(values) {
  if (values.length === 0) return { count: 0, average: null, max: null };
  return {
    count: values.length,
    average: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    max: Math.max(...values),
  };
}
