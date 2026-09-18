import test from 'node:test';
import assert from 'node:assert/strict';
import { createMuxAdapter, inspectRuntimeOwnership } from '../src/team/mux.js';

test('headless adapter launches detached owned processes', () => {
  const calls = [];
  const child = { pid: process.pid, unref: () => calls.push('unref') };
  const adapter = createMuxAdapter({ backend: 'headless', spawnProcess: (...args) => { calls.push(args); return child; } });
  const launched = adapter.launchWorker({ cwd: '/repo', command: 'node', args: ['worker.js'] });
  assert.deepEqual(launched, { id: `process:${process.pid}`, pid: process.pid });
  assert.equal(calls.at(-1), 'unref');
  assert.equal(inspectRuntimeOwnership(undefined, {
    name: 'worker-1', pane_id: launched.id, pane_pid: launched.pid, pid: launched.pid,
  }, { mux_backend: 'headless' }), 'owned');
});

test('rejects unknown mux backends', () => {
  assert.throws(() => createMuxAdapter({ backend: 'unknown' }), /unsupported mux backend/);
});
