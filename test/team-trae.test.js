import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTrustArgs } from '../src/team/trae.js';

test('builds a process-scoped trust override for a worker worktree', () => {
  assert.deepEqual(projectTrustArgs('/tmp/otx worktree/worker-1'), [
    '-c',
    'projects.\"/tmp/otx worktree/worker-1\".trust_level=\"trusted\"',
  ]);
});
