import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerExecArgs, buildWorkerResumeArgs, detectTraeCapabilities, projectTrustArgs } from '../src/team/trae.js';

test('builds a process-scoped trust override for a worker worktree', () => {
  assert.deepEqual(projectTrustArgs('/tmp/otx worktree/worker-1'), [
    '-c',
    'projects.\"/tmp/otx worktree/worker-1\".trust_level=\"trusted\"',
  ]);
});

test('detects the required TraeX runtime capabilities', () => {
  const run = (_command, args) => args[0] === 'exec'
    ? { status: 0, stdout: 'Commands: resume\n--json --sandbox --session-id --output-last-message --config', stderr: '' }
    : { status: 0, stdout: 'Commands: app-server\n--remote-auth-token-env', stderr: '' };
  assert.deepEqual(detectTraeCapabilities(run), {
    json: true, resume: true, sandbox: true, sessionId: true, outputLastMessage: true,
    projectConfig: true, appServer: true, remoteAuthToken: true,
  });
});

test('builds version-adapted initial and resume worker commands', () => {
  const input = { worktreePath: '/tmp/work tree', sessionId: 'session', resultPath: '/tmp/result', model: 'model', prompt: 'do work' };
  assert.deepEqual(buildWorkerExecArgs(input).slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '-C', '/tmp/work tree']);
  assert.deepEqual(buildWorkerExecArgs(input).slice(-3), ['--model', 'model', 'do work']);
  assert.deepEqual(buildWorkerResumeArgs(input).slice(0, 3), ['exec', 'resume', '--json']);
  assert.deepEqual(buildWorkerResumeArgs(input).slice(-2), ['session', 'do work']);
});
