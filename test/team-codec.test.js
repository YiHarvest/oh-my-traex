import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CURRENT_STATE_SCHEMA_VERSION, readVersionedRecord } from '../src/team/codec.js';
import { auditTeamRecords } from '../src/team/doctor.js';
import { initTeamState, teamStateDir, writeJsonAtomic } from '../src/team/state.js';

test('migrates v1 records to the current schema in memory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'otx-codec-'));
  try {
    const path = join(directory, 'task-1.json');
    writeFileSync(path, JSON.stringify({ schema_version: 1, id: '1', status: 'pending' }));
    const record = readVersionedRecord(path, { kind: 'task' });
    assert.equal(record.schema_version, CURRENT_STATE_SCHEMA_VERSION);
    assert.equal(record.record_type, 'task');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).schema_version, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('doctor quarantines corrupt auxiliary records and preserves core failures', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-doctor-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'task', requires_commit: false, worktree_path: cwd };
    const initialized = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader', workers: [worker] });
    const brokenEvent = join(initialized.stateDir, 'events', '0000000000000001-broken.json');
    const brokenTask = join(initialized.stateDir, 'tasks', 'task-1.json');
    writeJsonAtomic(brokenEvent, { schema_version: 99 });
    writeFileSync(brokenTask, '{broken', 'utf8');

    const report = auditTeamRecords(cwd, 'demo', { repair: true });
    assert.equal(report.ok, false);
    assert.equal(report.quarantined.length, 1);
    assert.equal(report.quarantined[0].kind, 'event');
    assert.equal(existsSync(brokenEvent), false);
    assert.equal(existsSync(report.quarantined[0].quarantine_path), true);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].kind, 'task');
    assert.equal(existsSync(brokenTask), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor persists valid v1 records as v2 during repair', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-doctor-migrate-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'task', requires_commit: false, worktree_path: cwd };
    initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader', workers: [worker] });
    const report = auditTeamRecords(cwd, 'demo', { repair: true });
    assert.equal(report.ok, true);
    assert.ok(report.migrated.length >= 3);
    const config = JSON.parse(readFileSync(join(teamStateDir(cwd, 'demo'), 'config.json'), 'utf8'));
    assert.equal(config.schema_version, 2);
    assert.equal(config.record_type, 'config');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
