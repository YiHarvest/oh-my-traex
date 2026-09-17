import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './state.js';

export function beginTeamTransaction(stateDir, operation, details = {}) {
  const id = randomUUID();
  const record = {
    schema_version: 1,
    id,
    operation,
    status: 'active',
    phase: 'started',
    resources: {},
    details,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  mkdirSync(transactionDir(stateDir), { recursive: true });
  writeJsonAtomic(transactionPath(stateDir, id), record);
  return { stateDir, id, record };
}

export function updateTeamTransaction(transaction, updates) {
  const path = transactionPath(transaction.stateDir, transaction.id);
  const current = readTransaction(path);
  const next = { ...current, ...updates, updated_at: new Date().toISOString() };
  writeJsonAtomic(path, next);
  transaction.record = next;
  return next;
}

export function finishTeamTransaction(transaction, status = 'committed', details = {}) {
  return updateTeamTransaction(transaction, {
    status,
    details: { ...transaction.record.details, ...details },
    completed_at: new Date().toISOString(),
  });
}

export function listTeamTransactions(stateDir, { activeOnly = false } = {}) {
  const directory = transactionDir(stateDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readTransaction(join(directory, name)))
    .filter((record) => !activeOnly || record.status === 'active')
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
}

function transactionDir(stateDir) {
  return join(stateDir, 'transactions');
}

function transactionPath(stateDir, id) {
  return join(transactionDir(stateDir), `${id}.json`);
}

function readTransaction(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.schema_version !== 1 || !parsed.id || !parsed.operation || !parsed.status) {
    throw new Error(`invalid team transaction: ${path}`);
  }
  return parsed;
}
