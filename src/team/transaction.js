import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { processIdentity } from './process.js';
import { writeJsonAtomic, withStateLock } from './state.js';
import { readVersionedRecord } from './codec.js';

export function beginTeamTransaction(stateDir, operation, details = {}) {
  return withStateLock(stateDir, 'transaction-registry', () => {
  if (operation === 'start-team' && listTeamTransactions(stateDir, { activeOnly: true }).some((record) => record.operation === operation)) {
    throw new Error('team startup transaction already exists; recover it before retrying');
  }
  const id = randomUUID();
  const record = {
    schema_version: 1,
    id,
    operation,
    status: 'active',
    phase: 'started',
    owner: { pid: process.pid, identity: processIdentity(process.pid), token: randomUUID() },
    resources: {},
    details,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  mkdirSync(transactionDir(stateDir), { recursive: true });
  writeJsonAtomic(transactionPath(stateDir, id), record);
  return { stateDir, id, record };
  });
}

export function updateTeamTransaction(transaction, updates) {
  return withStateLock(transaction.stateDir, 'transaction-' + transaction.id, () => {
  const path = transactionPath(transaction.stateDir, transaction.id);
  const current = readTransaction(path);
  if (current.status !== 'active' || current.owner?.token !== transaction.record.owner?.token) {
    throw new Error('transaction owner or status changed');
  }
  const next = { ...current, ...updates, updated_at: new Date().toISOString() };
  writeJsonAtomic(path, next);
  transaction.record = next;
  return next;
  });
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
    .map((name) => {
      try { return readTransaction(join(directory, name)); } catch { return null; }
    })
    .filter(Boolean)
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
  return readVersionedRecord(path, { kind: 'transaction' });
}

// Unknown identity is not proof of death. A live owner is never reaped merely
// because an operation takes longer than expected.
export function transactionOwnerExited(record, { kill = process.kill, identity = processIdentity } = {}) {
  const owner = record.owner;
  if (!Number.isInteger(owner?.pid) || !owner.identity) return false;
  try { kill(owner.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  const current = identity(owner.pid);
  return Boolean(current && current !== owner.identity);
}

export function recoverOwnedTransaction(stateDir, id, callback) {
  return withStateLock(stateDir, 'transaction-' + id, () => {
    const path = transactionPath(stateDir, id);
    const record = readTransaction(path);
    if (record.status !== 'active' || !transactionOwnerExited(record)) return false;
    const details = callback(record);
    writeJsonAtomic(path, { ...record, status: 'recovered', details: { ...record.details, ...details },
      updated_at: new Date().toISOString(), completed_at: new Date().toISOString() });
    return true;
  });
}
