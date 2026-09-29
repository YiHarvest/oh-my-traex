import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamSnapshotReader } from '../src/team/snapshot.js';
test('observer shares snapshots within TTL and invalidates after mutations', () => {
  let now = 0, calls = 0;
  const read = createTeamSnapshotReader({ ttlMs: 100, now: () => now, read: () => ({ revision: ++calls }) });
  assert.equal(read('/repo', 'a').revision, 1);
  assert.equal(read('/repo', 'a').revision, 1);
  now = 101;
  assert.equal(read('/repo', 'a').revision, 2);
  read.clear();
  assert.equal(read('/repo', 'a').revision, 3);
  assert.equal(read('/repo', 'b').revision, 4);
});
test('observer cache evicts old teams and does not retain failed reads', () => {
  let calls = 0;
  const read = createTeamSnapshotReader({ read: (_cwd, name) => { calls++; if (name === 'bad') throw new Error('bad'); return calls; } });
  for (let i = 0; i < 65; i++) read('/repo', String(i));
  assert.equal(read('/repo', '0'), 66);
  assert.throws(() => read('/repo', 'bad'));
  assert.throws(() => read('/repo', 'bad'));
  assert.equal(calls, 68);
});
