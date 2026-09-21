import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerExecArgs, buildWorkerResumeArgs, detectTraeCapabilities, permissionArgs, projectTrustArgs } from '../src/team/trae.js';

test('builds a process-scoped trust override for a worker worktree', () => {
  assert.deepEqual(projectTrustArgs('/tmp/otx worktree/worker-1'), [
    '-c',
    'projects.\"/tmp/otx worktree/worker-1\".trust_level=\"trusted\"',
  ]);
});

test('detects the required TraeX runtime capabilities', () => {
  const run = (_command, args) => args[0] === 'exec' && args[1] === 'resume'
    ? { status: 0, stdout: '--json --permission-mode --output-last-message --config', stderr: '' }
    : args[0] === 'exec'
      ? { status: 0, stdout: 'Commands: resume\n--json --sandbox --permission-mode --session-id --output-last-message --config --ephemeral', stderr: '' }
    : { status: 0, stdout: 'Commands: app-server\n--remote-auth-token-env', stderr: '' };
  assert.deepEqual(detectTraeCapabilities(run), {
    json: true, resume: true, sandbox: true, permissionMode: true, sessionId: true,
    outputLastMessage: true, projectConfig: true, ephemeral: true, resumeJson: true, resumePermissionMode: true,
    resumeOutputLastMessage: true, resumeProjectConfig: true, appServer: true, remoteAuthToken: true,
  });
});

test('reports the exact missing initial and resume capabilities', () => {
  const run = (_command, args) => args[0] === 'exec' && args[1] === 'resume'
    ? { status: 0, stdout: '--json --output-last-message --config', stderr: '' }
    : args[0] === 'exec'
      ? { status: 0, stdout: 'Commands: resume\n--json --sandbox --session-id --output-last-message --config', stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  assert.throws(() => detectTraeCapabilities(run),
    /permissionMode, resumePermissionMode/);
});

test('builds version-adapted initial and resume worker commands', () => {
  const input = { worktreePath: '/tmp/work tree', sessionId: 'session', resultPath: '/tmp/result', model: 'model', prompt: 'do work' };
  assert.deepEqual(buildWorkerExecArgs(input).slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '-C', '/tmp/work tree']);
  assert.deepEqual(permissionArgs('workspace-write'), [
    '--permission-mode', 'custom', '-c', 'approval_policy="never"', '--sandbox', 'workspace-write',
  ]);
  assert.ok(buildWorkerExecArgs(input).includes('--permission-mode'));
  assert.deepEqual(buildWorkerExecArgs(input).slice(-3), ['--model', 'model', 'do work']);
  assert.deepEqual(buildWorkerResumeArgs(input).slice(0, 3), ['exec', 'resume', '--json']);
  assert.deepEqual(buildWorkerResumeArgs(input).slice(5, 9), [
    '--permission-mode', 'custom', '-c', 'approval_policy="never"',
  ]);
  assert.equal(buildWorkerResumeArgs(input).includes('--sandbox'), false);
  assert.deepEqual(buildWorkerResumeArgs(input).slice(-2), ['session', 'do work']);
});
