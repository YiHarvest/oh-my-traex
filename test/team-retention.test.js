import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendTeamEvent, listTeamEvents } from '../src/team/events.js';
import { beginTeamTransaction, finishTeamTransaction } from '../src/team/transaction.js';
import { initTeamState, writeJsonAtomic } from '../src/team/state.js';
import { parseRetentionDuration, pruneTeamState } from '../src/team/retention.js';

test('parses explicit retention durations', () => {
  assert.equal(parseRetentionDuration('30d'), 30 * 86_400_000);
  assert.equal(parseRetentionDuration('12h'), 12 * 3_600_000);
  assert.throws(() => parseRetentionDuration('month'), /retention duration/);
});

test('prune previews then archives old events and terminal transactions', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-retention-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'task', requires_commit: false, worktree_path: cwd };
    const initialized = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader', workers: [worker] });
    const old = '2020-01-01T00:00:00.000Z';
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const id = String(sequence).padStart(16, '0');
      writeJsonAtomic(join(initialized.stateDir, 'events', `${id}-manual.json`), {
        schema_version: 1, id, sequence, type: 'test', actor: 'test', data: {}, created_at: old,
      });
    }
    const transaction = beginTeamTransaction(initialized.stateDir, 'test');
    finishTeamTransaction(transaction);
    writeJsonAtomic(join(initialized.stateDir, 'transactions', `${transaction.id}.json`), {
      ...transaction.record, status: 'committed', created_at: old, updated_at: old, completed_at: old,
    });

    const preview = pruneTeamState(cwd, 'demo', { olderThanMs: 1, keepEvents: 1, dryRun: true });
    assert.equal(preview.candidates.filter((item) => item.category === 'events').length, 2);
    assert.equal(preview.candidates.filter((item) => item.category === 'transactions').length, 1);
    assert.equal(preview.archived.length, 0);

    const result = pruneTeamState(cwd, 'demo', { olderThanMs: 1, keepEvents: 1 });
    assert.equal(result.archived.length, 3);
    assert.equal(listTeamEvents(initialized.stateDir).events.length, 1);
    assert.equal(readdirSync(join(initialized.stateDir, 'archive', 'events')).length, 2);
    assert.equal(existsSync(join(initialized.stateDir, 'transactions', `${transaction.id}.json`)), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('event cursor filters filenames before parsing corrupt older records', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-event-cursor-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
    const worker = { name: 'worker-1', index: 1, status: 'completed', role: 'reviewer', assignment: 'task', requires_commit: false, worktree_path: cwd };
    const initialized = initTeamState({ cwd, name: 'demo', task: 'task', leaderPaneId: '%1', leaderSessionId: 'leader', workers: [worker] });
    const first = appendTeamEvent(initialized.stateDir, 'first');
    const second = appendTeamEvent(initialized.stateDir, 'second');
    const result = listTeamEvents(initialized.stateDir, { after: first.id, limit: 1 });
    assert.deepEqual(result.events.map((event) => event.id), [second.id]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
