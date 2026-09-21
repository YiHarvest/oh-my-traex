import test from 'node:test';
import assert from 'node:assert/strict';
import { readTaskInput } from '../src/stdin.js';

test('uses piped stdin as the task when no argument was provided', () => {
  assert.equal(readTaskInput('', { isTTY: false, read: () => 'piped task\n' }), 'piped task');
});

test('appends piped stdin to an argument task once', () => {
  assert.equal(readTaskInput('base task', { isTTY: false, read: () => 'details\n' }),
    'base task\n\n<stdin>\ndetails\n</stdin>');
});

test('reads explicit dash input and rejects mixed task tokens', () => {
  assert.equal(readTaskInput('', { stdinTask: true, isTTY: true, read: () => 'file task' }), 'file task');
  assert.throws(() => readTaskInput('base', { stdinTask: true, read: () => { throw new Error('must not read'); } }),
    /must be the only task input token/);
});

test('does not read interactive stdin without an explicit dash', () => {
  let called = false;
  assert.equal(readTaskInput('task', { isTTY: true, read: () => { called = true; return 'extra'; } }), 'task');
  assert.equal(called, false);
});
