import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('parses exec with orchestration options', () => {
  const parsed = parseArgs(['exec', '-n', '3', '--mode', 'aggressive', '--model', 'GPT-5.5', 'ship', 'it']);
  assert.equal(parsed.command, 'exec');
  assert.equal(parsed.task, 'ship it');
  assert.equal(parsed.options.workers, 3);
  assert.equal(parsed.options.mode, 'aggressive');
  assert.equal(parsed.options.model, 'GPT-5.5');
});

test('defaults to exec when the first token is an option', () => {
  const parsed = parseArgs(['--workers=2', '--', 'review', '--all']);
  assert.equal(parsed.command, 'exec');
  assert.equal(parsed.task, 'review --all');
  assert.equal(parsed.options.workers, 2);
});

test('keeps run as a compatibility alias for exec', () => {
  const parsed = parseArgs(['run', 'ship', 'it']);
  assert.equal(parsed.command, 'exec');
  assert.equal(parsed.task, 'ship it');
});

test('rejects unsafe fanout', () => {
  assert.throws(() => parseArgs(['exec', '--workers', '7', 'task']), /1 to 6/);
});

test('parses dashboard UI mode', () => {
  const parsed = parseArgs(['exec', '--ui', 'dashboard', 'inspect agents']);
  assert.equal(parsed.options.ui, 'dashboard');
});

test('rejects unknown UI modes', () => {
  assert.throws(() => parseArgs(['exec', '--ui', 'windows', 'task']), /none or dashboard/);
});

test('forwards a controlled subset of native TraeX exec options', () => {
  const parsed = parseArgs([
    'exec', '--profile', 'work', '-i', 'one.png', '--image=two.png',
    '--add-dir', '../shared', '--ephemeral', '--output-schema=schema.json',
    '-o', 'result.txt', '--color', 'never', '--allowed-tool', 'shell',
    '--disallowed-tool=browser', '--shell-tool-timeout', '2m',
    '--enable', 'feature-a', '--disable=feature-b', '--oss',
    '--local-provider', 'ollama', 'inspect', 'this',
  ]);
  assert.equal(parsed.task, 'inspect this');
  assert.deepEqual(parsed.options.passthrough, [
    '--profile', 'work', '--image', 'one.png', '--image', 'two.png',
    '--add-dir', '../shared', '--ephemeral', '--output-schema', 'schema.json',
    '--output-last-message', 'result.txt', '--color', 'never', '--allowed-tool', 'shell',
    '--disallowed-tool', 'browser', '--shell-tool-timeout', '2m',
    '--enable', 'feature-a', '--disable', 'feature-b', '--oss',
    '--local-provider', 'ollama',
  ]);
});

test('rejects native options that would override the OTX execution boundary', () => {
  for (const args of [
    ['--permission-mode', 'bypass_permissions'], ['--sandbox=danger-full-access'],
    ['-c', 'approval_policy=never'], ['--ignore-rules'], ['-y'],
  ]) {
    assert.throws(() => parseArgs(['exec', ...args, 'task']), /managed by OTX/);
  }
});

test('recognizes explicit stdin task input', () => {
  const parsed = parseArgs(['exec', '-']);
  assert.equal(parsed.stdinTask, true);
  assert.equal(parsed.task, '');
});

test('parses exec resume by session ID and with --last', () => {
  const byId = parseArgs(['exec', 'resume', 'session-123', 'finish', 'the', 'tests']);
  assert.equal(byId.command, 'resume');
  assert.equal(byId.sessionId, 'session-123');
  assert.equal(byId.task, 'finish the tests');

  const latest = parseArgs(['exec', 'resume', '--last', '--all', '-m', 'GPT-5.5', 'continue']);
  assert.equal(latest.command, 'resume');
  assert.equal(latest.sessionId, undefined);
  assert.equal(latest.task, 'continue');
  assert.equal(latest.options.last, true);
  assert.equal(latest.options.all, true);
  assert.equal(latest.options.model, 'GPT-5.5');
});

test('parses resume stdin and safe native options', () => {
  const parsed = parseArgs([
    'exec', 'resume', '--last', '--json', '--ephemeral', '-i', 'context.png',
    '-o', 'result.txt', '--allowed-tool=shell', '--disable', 'feature-a', '-',
  ]);
  assert.equal(parsed.stdinTask, true);
  assert.equal(parsed.options.json, true);
  assert.deepEqual(parsed.options.passthrough, [
    '--ephemeral', '--image', 'context.png', '--output-last-message', 'result.txt',
    '--allowed-tool', 'shell', '--disable', 'feature-a',
  ]);
});

test('exec resume requires a session selector and keeps OTX permission controls', () => {
  assert.throws(() => parseArgs(['exec', 'resume', '--json']), /session ID or --last/);
  assert.throws(
    () => parseArgs(['exec', 'resume', '--last', '--permission-mode', 'bypass_permissions']),
    /managed by OTX/,
  );
  assert.throws(() => parseArgs(['exec', 'resume', '--last', '--sandbox=read-only']), /managed by OTX/);
});
