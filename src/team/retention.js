import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readVersionedRecord } from './codec.js';
import { teamStateDir } from './state.js';

export function pruneTeamState(cwd, name, {
  olderThanMs = 30 * 24 * 60 * 60_000,
  keepEvents = 1000,
  dryRun = false,
  now = Date.now(),
} = {}) {
  if (!Number.isInteger(olderThanMs) || olderThanMs < 0) throw new Error('olderThanMs must be a non-negative integer.');
  if (!Number.isInteger(keepEvents) || keepEvents < 1) throw new Error('keepEvents must be a positive integer.');
  const stateDir = teamStateDir(cwd, name);
  const cutoff = now - olderThanMs;
  const candidates = [
    ...eventCandidates(stateDir, cutoff, keepEvents),
    ...terminalCandidates(stateDir, 'transactions', cutoff),
    ...terminalCandidates(stateDir, 'delivery-transactions', cutoff),
  ];
  const archived = [];
  if (!dryRun) {
    for (const candidate of candidates) {
      const archiveDir = join(stateDir, 'archive', candidate.category);
      mkdirSync(archiveDir, { recursive: true });
      const target = join(archiveDir, basename(candidate.path));
      renameSync(candidate.path, target);
      archived.push({ ...candidate, archive_path: target });
    }
  }
  return { dry_run: dryRun, cutoff: new Date(cutoff).toISOString(), candidates, archived };
}

export function parseRetentionDuration(value) {
  const match = String(value).trim().match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!match) throw new Error('retention duration must look like 30d, 12h, 15m, 10s, or 500ms.');
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()];
  return Number(match[1]) * multiplier;
}

function eventCandidates(stateDir, cutoff, keepEvents) {
  const directory = join(stateDir, 'events');
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory)
    .filter((name) => /^\d{16}-.*\.json$/.test(name))
    .sort();
  const protectedNames = new Set(names.slice(-keepEvents));
  return names.flatMap((name) => {
    if (protectedNames.has(name)) return [];
    const path = join(directory, name);
    const record = safeRead(path);
    return record && recordTime(record) < cutoff ? [{ category: 'events', path, id: record.id }] : [];
  });
}

function terminalCandidates(stateDir, category, cutoff) {
  const directory = join(stateDir, category);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.json')).flatMap((name) => {
    const path = join(directory, name);
    const record = safeRead(path);
    if (!record || record.status === 'active' || recordTime(record) >= cutoff) return [];
    return [{ category, path, id: record.id }];
  });
}

function safeRead(path) {
  try { return readVersionedRecord(path); } catch { return null; }
}

function recordTime(record) {
  const parsed = Date.parse(record.completed_at || record.updated_at || record.created_at || '');
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
