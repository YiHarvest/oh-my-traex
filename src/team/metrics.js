import { summarizeUsage } from './usage.js';
import { readMailbox } from './state.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readVersionedRecord } from './codec.js';
import { teamStatus } from './runtime.js';

export function collectTeamMetrics(cwd, name, run, snapshot = {}) {
  const state = snapshot.state || teamStatus(cwd, name, run);
  const messages = snapshot.messages || state.workers.flatMap((worker) => readMailbox(state.stateDir, worker.name).messages);
  const events = countStoredEvents(state.stateDir);
  const taskDurations = state.tasks.map(durationBetween('started_at', 'completed_at')).filter(Number.isFinite);
  const deliveryLatencies = messages.map(durationBetween('created_at', 'delivered_at')).filter(Number.isFinite);
  return {
    team: state.config.name,
    usage: summarizeUsage(state.workers),
    worker_models: Object.fromEntries(state.workers.map((worker) => [worker.name, worker.model || null])),
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

const eventCaches = new Map();
function countStoredEvents(stateDir) {
  const directory = join(stateDir, 'events');
  if (!existsSync(directory)) { eventCaches.delete(stateDir); return new Map(); }
  const stamp = statSync(directory, { bigint: true }).mtimeNs.toString();
  let cache = eventCaches.get(stateDir);
  if (cache?.stamp === stamp) return cache.counts;
  if (!cache) cache = { files: new Map(), counts: new Map() };
  const names = new Set(readdirSync(directory).filter((name) => /^\d{16}-.*\.json$/.test(name)));
  for (const [name, type] of cache.files) {
    if (names.has(name)) continue;
    cache.counts.set(type, cache.counts.get(type) - 1);
    cache.files.delete(name);
  }
  for (const name of names) {
    if (cache.files.has(name)) continue;
    try {
      const { type } = readVersionedRecord(join(directory, name));
      cache.files.set(name, type);
      cache.counts.set(type, (cache.counts.get(type) || 0) + 1);
    } catch { /* A concurrent prune or quarantined record can disappear. */ }
  }
  cache.stamp = stamp;
  eventCaches.delete(stateDir);
  eventCaches.set(stateDir, cache);
  if (eventCaches.size > 64) eventCaches.delete(eventCaches.keys().next().value);
  return cache.counts;
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
  return events.get(type) || 0;
}

function summarize(values) {
  if (values.length === 0) return { count: 0, average: null, max: null };
  return {
    count: values.length,
    average: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    max: Math.max(...values),
  };
}
