import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamArgs, runTeamCommand } from '../src/team/cli.js';

test('parses team worker descriptor and options', () => {
  const parsed = parseTeamArgs(['2:executor', '--name', 'auth-team', '--model', 'GPT-5.6-Sol', 'ship', 'auth']);
  assert.equal(parsed.subcommand, 'start');
  assert.equal(parsed.options.workers, 2);
  assert.equal(parsed.options.role, 'executor');
  assert.equal(parsed.options.name, 'auth-team');
  assert.equal(parsed.task, 'ship auth');
});

test('parses static no-plan team mode', () => {
  const parsed = parseTeamArgs(['--no-plan', '--workers', '2', 'task']);
  assert.equal(parsed.options.autoPlan, false);
  assert.equal(parsed.options.workers, 2);
});

test('parses team lifecycle subcommands', () => {
  const parsed = parseTeamArgs(['await', 'auth-team', '--timeout-ms', '5000']);
  assert.equal(parsed.subcommand, 'await');
  assert.equal(parsed.name, 'auth-team');
  assert.equal(parsed.options.timeoutMs, 5000);
});

test('parses explicit team reconciliation', () => {
  const parsed = parseTeamArgs(['reconcile', 'auth-team', '--json']);
  assert.equal(parsed.subcommand, 'reconcile');
  assert.equal(parsed.name, 'auth-team');
  assert.equal(parsed.options.json, true);
});

test('parses team supervisor options', () => {
  const parsed = parseTeamArgs(['supervise', 'auth-team', '--interval-ms', '250', '--once']);
  assert.equal(parsed.subcommand, 'supervise');
  assert.equal(parsed.name, 'auth-team');
  assert.equal(parsed.options.intervalMs, 250);
  assert.equal(parsed.options.once, true);
});

test('parses team transaction recovery', () => {
  const parsed = parseTeamArgs(['recover', 'auth-team', '-C', '/repo']);
  assert.equal(parsed.subcommand, 'recover');
  assert.equal(parsed.name, 'auth-team');
  assert.equal(parsed.options.cwd, '/repo');
});

test('parses incremental team event queries', () => {
  const parsed = parseTeamArgs(['events', 'auth-team', '--after', '0000000000000001', '--limit', '25']);
  assert.equal(parsed.subcommand, 'events');
  assert.equal(parsed.options.after, '0000000000000001');
  assert.equal(parsed.options.limit, 25);
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

test('parses team send and broadcast messages', () => {
  const sent = parseTeamArgs(['send', 'auth-team', 'worker-1', '-C', '/repo', 'run', 'tests']);
  assert.equal(sent.message, 'run tests');
  assert.equal(sent.worker, 'worker-1');
  assert.equal(sent.options.cwd, '/repo');
  const broadcast = parseTeamArgs(['broadcast', 'auth-team', 'report', 'status']);
  assert.equal(broadcast.message, 'report status');
});

test('parses mailbox cwd option', () => {
  const parsed = parseTeamArgs(['mailbox', 'auth-team', 'worker-1', '-C', '/repo']);
  assert.equal(parsed.options.cwd, '/repo');
});

test('parses explicit workers for integration', () => {
  const parsed = parseTeamArgs(['integrate', 'auth-team', 'worker-1', 'worker-2', '-C', '/repo']);
  assert.deepEqual(parsed.workers, ['worker-1', 'worker-2']);
  assert.equal(parsed.options.cwd, '/repo');
});

test('parses task listing and assignment', () => {
  const listed = parseTeamArgs(['tasks', 'auth-team', '--json']);
  assert.equal(listed.name, 'auth-team');
  assert.equal(listed.options.json, true);
  const assigned = parseTeamArgs(['assign', 'auth-team', 'worker-1', '-C', '/repo', '--depends-on', '1,2', 'add', 'tests']);
  assert.equal(assigned.description, 'add tests');
  assert.deepEqual(assigned.dependsOn, ['1', '2']);
  assert.equal(assigned.options.cwd, '/repo');
});

test('parses team diagnose command', () => {
  const parsed = parseTeamArgs(['diagnose', 'auth-team', '-C', '/repo']);
  assert.equal(parsed.name, 'auth-team');
  assert.equal(parsed.options.cwd, '/repo');
});

test('parses team cleanup command', () => {
  const parsed = parseTeamArgs(['cleanup', 'auth-team', '-C', '/repo']);
  assert.equal(parsed.name, 'auth-team');
  assert.equal(parsed.options.cwd, '/repo');
});

test('parses dynamic worker membership commands', () => {
  const added = parseTeamArgs(['add-worker', 'auth-team', 'verifier', '-C', '/repo', '--', 'verify', 'release']);
  assert.equal(added.role, 'verifier');
  assert.equal(added.assignment, 'verify release');
  assert.equal(added.options.cwd, '/repo');
  const removed = parseTeamArgs(['remove-worker', 'auth-team', 'worker-4', '-C', '/repo']);
  assert.equal(removed.worker, 'worker-4');
});

test('team help does not require a task or repository', async () => {
  assert.equal(await runTeamCommand(['--help']), 0);
});

test('rejects unsafe team worker counts', () => {
  assert.throws(() => parseTeamArgs(['7:executor', 'task']), /1 to 6/);
});

test('rejects malformed team descriptors', () => {
  assert.throws(() => parseTeamArgs(['2:bad_role', 'task']), /Invalid team descriptor/);
});
