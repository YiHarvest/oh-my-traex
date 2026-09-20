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

test('reads process birth identity through each supported platform adapter', () => {
  assert.equal(processIdentity(42, undefined, 'linux', () => '42 (worker name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 9876'),
    'linux-start-ticks:9876');
  const windowsRun = (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.match(args.at(-1), /Get-Process -Id 42/);
    return { status: 0, stdout: '638000000000000000\r\n' };
  };
  assert.equal(processIdentity(42, windowsRun, 'win32'), 'windows-start-ticks:638000000000000000');
  const posixRun = (command, args) => {
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-o', 'lstart=', '-p', '42']);
    return { status: 0, stdout: 'Sat Sep 20 10:00:00 2026\n' };
  };
  assert.equal(processIdentity(42, posixRun, 'darwin'), 'posix-lstart:Sat Sep 20 10:00:00 2026');
});

test('rejects unknown mux backends', () => {
  assert.throws(() => createMuxAdapter({ backend: 'unknown' }), /unsupported mux backend/);
});
