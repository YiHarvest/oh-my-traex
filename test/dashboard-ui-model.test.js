import test from 'node:test';
import assert from 'node:assert/strict';
import { actionAvailability, buildWorkerActionPayload, nextWrappedIndex, parseDependencyIds, summarizeRuntime } from '../dashboard-prototype/ui-model.js';

test('wraps keyboard task and worker navigation', () => {
  assert.equal(nextWrappedIndex(3, 2, 1), 0);
  assert.equal(nextWrappedIndex(3, 0, -1), 2);
  assert.equal(nextWrappedIndex(0, 0, 1), -1);
});

test('parses and deduplicates dependency task IDs', () => {
  assert.deepEqual(parseDependencyIds('1, 2,1'), ['1', '2']);
  assert.throws(() => parseDependencyIds('1, worker-2'), /comma-separated task IDs/);
});

test('disables live actions without a live worker and allows ready-team stop', () => {
  assert.deepEqual(actionAvailability({ live: true, hasTeam: true, focusedWorker: { paneAlive: false }, teamStatus: 'ready' }), {
    message: false, assign: false, stop: true,
  });
  assert.equal(actionAvailability({ live: true, hasTeam: true, focusedWorker: { paneAlive: true }, teamStatus: 'stopped' }).stop, false);
});

test('combines unhealthy workers and pending mailbox work for attention count', () => {
  assert.deepEqual(summarizeRuntime({
    summary: { teams: 1, running: 1, workers: 2, unhealthy: 1 },
    teams: [{ workers: [{ mailbox_pending: 2 }, { mailbox_pending: 0 }] }],
  }), { teams: 1, running: 1, workers: 2, unhealthy: 1, pending: 2, attention: 3 });
});

test('builds explicit message, task, and worker membership actions', () => {
  assert.deepEqual(buildWorkerActionPayload({ mode: 'message', team: 'demo', target: 'worker-1', message: 'check' }), {
    action: 'send-message', team: 'demo', worker: 'worker-1', message: 'check',
  });
  assert.deepEqual(buildWorkerActionPayload({ mode: 'assign', team: 'demo', target: 'worker-2', message: 'verify', dependencies: ['1'] }), {
    action: 'assign-task', team: 'demo', worker: 'worker-2', description: 'verify', depends_on: ['1'],
  });
  assert.deepEqual(buildWorkerActionPayload({ mode: 'add', team: 'demo', target: 'reviewer', message: 'review', model: 'Seed-2.1-Turbo' }), {
    action: 'add-worker', team: 'demo', role: 'reviewer', assignment: 'review', model: 'Seed-2.1-Turbo',
  });
});
