import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withStateLock, writeJsonAtomic } from './state.js';
import { addUsage, summarizeUsage } from './usage.js';
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function recordUsage(stateDir, { worker, execution, ordinal, event, requestedModel, prices = {} }) {
  const observedModel = event.model || event.response?.model || null;
  const model = observedModel || requestedModel;
  if (!addUsage(null, event, model, prices)) return null;
  const sourceId = event.event_id || event.id || event.turn_id;
  const identity = sourceId ? [worker, execution, sourceId] : [worker, execution, ordinal];
  const id = hash(JSON.stringify(identity));
  return withStateLock(stateDir, 'usage-ledger', () => {
    const path = join(stateDir, 'usage', id + '.json');
    const duplicate = existsSync(path);
    if (!duplicate) writeJsonAtomic(path, { id, worker, execution, ordinal, event, requested_model: requestedModel || null,
      observed_model: observedModel, pricing_model: model || null, prices, observed_at: new Date().toISOString() });
    if (!duplicate && ledgerCaches.has(stateDir)) ledgerCaches.get(stateDir).stamp = null;
    return { duplicate, usage: readUsageLedger(stateDir).workers.find((entry) => entry.name === worker)?.usage };
  });
}

const ledgerCaches = new Map();
export function readUsageLedger(stateDir) {
  const directory = join(stateDir, 'usage');
  if (!existsSync(directory)) { ledgerCaches.delete(stateDir); return { workers: [], summary: summarizeUsage([]) }; }
  const stamp = statSync(directory, { bigint: true }).mtimeNs.toString();
  let cache = ledgerCaches.get(stateDir);
  if (cache?.stamp === stamp) return cache.result;
  cache ||= { seen: new Set(), byWorker: new Map() };
  const byWorker = cache.byWorker;
  for (const file of readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    if (cache.seen.has(file)) continue;
    const record = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    const previous = byWorker.get(record.worker);
    byWorker.set(record.worker, addUsage(previous, record.event, record.pricing_model, record.prices));
    cache.seen.add(file);
  }
  const workers = [...byWorker].map(([name, usage]) => ({ name, usage }));
  const result = { workers, summary: summarizeUsage(workers) };
  ledgerCaches.delete(stateDir);
  ledgerCaches.set(stateDir, { ...cache, stamp, result });
  if (ledgerCaches.size > 64) ledgerCaches.delete(ledgerCaches.keys().next().value);
  return result;
}

export function budgetStatus(stateDir, config) {
  const maximum = config.max_tokens;
  const summary = readUsageLedger(stateDir).summary;
  const used = (summary.input_tokens || 0) + (summary.output_tokens || 0);
  return { max_tokens: maximum ?? null, observed_tokens: used, exceeded: Number.isSafeInteger(maximum) && used >= maximum };
}
export function assertBudgetAvailable(stateDir, config) {
  if (budgetStatus(stateDir, config).exceeded) throw new Error('observed Team token budget exhausted');
}
