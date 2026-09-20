import test from 'node:test';
import assert from 'node:assert/strict';
import { createMuxAdapter, inspectRuntimeOwnership, processIdentity } from '../src/team/mux.js';

test('headless adapter launches detached owned processes', () => {
  const calls = [];
  const child = { pid: process.pid, unref: () => calls.push('unref') };
  const adapter = createMuxAdapter({ backend: 'headless', spawnProcess: (...args) => { calls.push(args); return child; } });
  const launched = adapter.launchWorker({ cwd: '/repo', command: 'node', args: ['worker.js'] });
  assert.deepEqual(launched, { id: `process:${process.pid}`, pid: process.pid, processIdentity: processIdentity(process.pid) });
  assert.equal(calls.at(-1), 'unref');
  assert.equal(inspectRuntimeOwnership(undefined, {
    name: 'worker-1', pane_id: launched.id, pane_pid: launched.pid, pid: launched.pid, process_identity: launched.processIdentity,
  }, { mux_backend: 'headless' }), 'owned');
});

test('headless ownership rejects a reused pid with a different birth identity', () => {
  const owner = { name: 'worker-1', pane_id: `process:${process.pid}`, pane_pid: process.pid, process_identity: 'birth-1' };
  assert.equal(inspectRuntimeOwnership(undefined, owner, { mux_backend: 'headless' }, {
    readProcessIdentity: () => 'birth-2',
  }), 'mismatch');
  assert.equal(inspectRuntimeOwnership(undefined, { ...owner, process_identity: null }, { mux_backend: 'headless' }, {
    readProcessIdentity: () => 'birth-1',
  }), 'mismatch');
});

test('rejects unknown mux backends', () => {
  assert.throws(() => createMuxAdapter({ backend: 'unknown' }), /unsupported mux backend/);
});
