import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_DOCTOR_REPLY, parseDoctorArgs, runLiveExecCheck } from '../src/doctor.js';

test('parses explicit live doctor options', () => {
  assert.deepEqual(parseDoctorArgs(['--live', '-C', '/tmp/work', '--model', 'test-model']), {
    live: true, cwd: '/tmp/work', model: 'test-model',
  });
  assert.throws(() => parseDoctorArgs(['--json']), /Unknown doctor option/);
});

test('runs the live probe read-only and ephemeral when supported', () => {
  let invocation;
  const result = runLiveExecCheck({
    cwd: process.cwd(),
    model: 'test-model',
    ephemeral: true,
    run: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: `${LIVE_DOCTOR_REPLY}\n`, stderr: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(invocation.command, 'traex');
  assert.ok(invocation.args.includes('--ephemeral'));
  assert.ok(invocation.args.includes('read-only'));
  assert.deepEqual(invocation.args.slice(-3, -1), ['--model', 'test-model']);
  assert.equal(invocation.options.timeout, 120_000);
});

test('fails the live probe on a non-exact response without leaking multiline output', () => {
  const result = runLiveExecCheck({
    cwd: process.cwd(),
    run: () => ({ status: 0, stdout: 'diagnostic line\nwrong reply\n', stderr: '' }),
  });
  assert.deepEqual({ ok: result.ok, detail: result.detail }, {
    ok: false, detail: 'unexpected reply: wrong reply',
  });
});
