import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inferRecordKind, quarantineRecord, readVersionedRecord } from './codec.js';
import { teamStateDir, writeJsonAtomic } from './state.js';

const CORE_KINDS = new Set(['config', 'worker', 'task']);

export function auditTeamRecords(cwd, name, { repair = false } = {}) {
  const stateDir = teamStateDir(cwd, name);
  const report = { ok: true, checked: 0, migrated: [], quarantined: [], errors: [] };
  for (const path of recordPaths(stateDir)) {
    const kind = inferRecordKind(path);
    report.checked += 1;
    try {
      const record = readVersionedRecord(path, { kind });
      if (repair && record.__migrated_from < record.schema_version) {
        writeJsonAtomic(path, record);
        report.migrated.push(path);
      }
    } catch (error) {
      report.ok = false;
      const issue = { path, kind, error: error.message, repairable: !CORE_KINDS.has(kind) };
      if (repair && issue.repairable) {
        issue.quarantine_path = quarantineRecord(path, stateDir, kind);
        report.quarantined.push(issue);
      } else {
        report.errors.push(issue);
      }
    }
  }
  if (repair && report.errors.length === 0) report.ok = true;
  return report;
}

function recordPaths(stateDir) {
  if (!existsSync(stateDir)) return [];
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.locks' || entry.name === 'quarantine') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(path);
    }
  };
  visit(stateDir);
  return paths.sort();
}
