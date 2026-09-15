import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamArgs } from '../src/team/cli.js';

test('parses team worker descriptor and options', () => {
  const parsed = parseTeamArgs(['2:executor', '--name', 'auth-team', '--model', 'GPT-5.6-Sol', 'ship', 'auth']);
  assert.equal(parsed.subcommand, 'start');
  assert.equal(parsed.options.workers, 2);
  assert.equal(parsed.options.role, 'executor');
  assert.equal(parsed.options.name, 'auth-team');
  assert.equal(parsed.task, 'ship auth');
});

test('parses team lifecycle subcommands', () => {
  const parsed = parseTeamArgs(['await', 'auth-team', '--timeout-ms', '5000']);
  assert.equal(parsed.subcommand, 'await');
  assert.equal(parsed.name, 'auth-team');
  assert.equal(parsed.options.timeoutMs, 5000);
});

test('parses team resume model override', () => {
  const parsed = parseTeamArgs(['resume', 'auth-team', '--model', 'GPT-5.6-Sol']);
  assert.equal(parsed.subcommand, 'resume');
  assert.equal(parsed.options.model, 'GPT-5.6-Sol');
});

test('parses team list JSON output', () => {
  const parsed = parseTeamArgs(['list', '--json']);
  assert.equal(parsed.subcommand, 'list');
  assert.equal(parsed.options.json, true);
});

test('rejects unsafe team worker counts', () => {
  assert.throws(() => parseTeamArgs(['7:executor', 'task']), /1 to 6/);
});

test('rejects malformed team descriptors', () => {
  assert.throws(() => parseTeamArgs(['2:bad_role', 'task']), /Invalid team descriptor/);
});
