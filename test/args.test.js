import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('parses a run with orchestration options', () => {
  const parsed = parseArgs(['run', '-n', '3', '--mode', 'aggressive', '--model', 'GPT-5.5', 'ship', 'it']);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.task, 'ship it');
  assert.equal(parsed.options.workers, 3);
  assert.equal(parsed.options.mode, 'aggressive');
  assert.equal(parsed.options.model, 'GPT-5.5');
});

test('defaults to run when the first token is an option', () => {
  const parsed = parseArgs(['--workers=2', '--', 'review', '--all']);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.task, 'review --all');
  assert.equal(parsed.options.workers, 2);
});

test('rejects unsafe fanout', () => {
  assert.throws(() => parseArgs(['run', '--workers', '7', 'task']), /1 to 6/);
});

test('parses dashboard UI mode', () => {
  const parsed = parseArgs(['run', '--ui', 'dashboard', 'inspect agents']);
  assert.equal(parsed.options.ui, 'dashboard');
});

test('rejects unknown UI modes', () => {
  assert.throws(() => parseArgs(['run', '--ui', 'windows', 'task']), /none or dashboard/);
});
