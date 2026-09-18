import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CURRENT_STATE_SCHEMA_VERSION = 2;

export class StateRecordError extends Error {
  constructor(path, reason) {
    super(`invalid state record ${path}: ${reason}`);
    this.name = 'StateRecordError';
    this.path = path;
    this.reason = reason;
  }
}

export function readVersionedRecord(path, { kind = inferRecordKind(path) } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StateRecordError(path, error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StateRecordError(path, 'record must be a JSON object');
  }
  const version = parsed.schema_version ?? 1;
  if (!Number.isInteger(version) || version < 1 || version > CURRENT_STATE_SCHEMA_VERSION) {
    throw new StateRecordError(path, `unsupported schema_version ${version}`);
  }
  const migrated = version === 1
    ? { ...parsed, schema_version: 2, record_type: parsed.record_type || kind }
    : parsed;
  Object.defineProperty(migrated, '__migrated_from', { value: version, enumerable: false });
  validateRecord(migrated, kind, path);
  return migrated;
}

export function quarantineRecord(path, stateDir, reason = 'invalid') {
  const directory = join(stateDir, 'quarantine');
  mkdirSync(directory, { recursive: true });
  const safeReason = String(reason).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'invalid';
  const target = join(directory, `${Date.now()}-${safeReason}-${randomUUID()}-${basename(path)}`);
  renameSync(path, target);
  return target;
}

export function inferRecordKind(path) {
  const normalized = String(path).replaceAll('\\', '/');
  const name = basename(normalized);
  if (name === 'config.json') return 'config';
  if (normalized.includes('/workers/')) return 'worker';
  if (normalized.includes('/tasks/')) return 'task';
  if (normalized.includes('/mailbox/')) return 'mailbox';
  if (normalized.includes('/events/')) return name === 'cursor.json' ? 'event-cursor' : 'event';
  if (normalized.includes('/delivery-transactions/')) return 'delivery-transaction';
  if (normalized.includes('/transactions/')) return 'transaction';
  if (name === 'owner.json') return 'lock-owner';
  return 'record';
}

function validateRecord(record, kind, path) {
  const required = {
    config: ['name', 'status', 'workers', 'cwd'],
    worker: ['name', 'status'],
    task: ['id', 'status'],
    mailbox: ['id', 'status'],
    event: ['id', 'sequence', 'type'],
    'event-cursor': ['sequence'],
    transaction: ['id', 'operation', 'status'],
    'delivery-transaction': ['id', 'status'],
    'lock-owner': ['token', 'pid'],
    record: [],
  }[kind] || [];
  for (const field of required) {
    if (record[field] === undefined || record[field] === null) {
      throw new StateRecordError(path, `missing required field ${field}`);
    }
  }
  if (kind === 'config' && !Array.isArray(record.workers)) {
    throw new StateRecordError(path, 'workers must be an array');
  }
}
