import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotRevision, writeSnapshotEvent, waitForStartup } from '../dashboard-prototype/stream-state.js';
test('snapshot revision ignores nested clock changes but observes actual status', () => {
  const a = { generated_at: 'a', teams: [{ metrics: { generated_at: 'a', count: 1 }, health: 'healthy', activity_age_ms: 100 }] };
  const b = { generated_at: 'b', teams: [{ metrics: { generated_at: 'b', count: 1 }, health: 'healthy', activity_age_ms: 200 }] };
  assert.equal(snapshotRevision(a), snapshotRevision(b));
  b.teams[0].health = 'stalled'; assert.notEqual(snapshotRevision(a), snapshotRevision(b));
});
test('slow SSE clients are disconnected before buffers grow unbounded', () => {
  let destroyed = false;
  assert.equal(writeSnapshotEvent({ writableLength: 2e6, destroy() { destroyed = true; } }, 'snapshot', {}), false);
  assert.equal(destroyed, true);
});
test('startup confirms readiness and exposes failed or timed out launches', async () => {
  let polls = 0;
  assert.equal((await waitForStartup(() => ({ status: ++polls === 2 ? 'ready' : 'starting' }), { intervalMs: 1 })).status, 'ready');
  await assert.rejects(waitForStartup(() => ({ status: 'failed', error: 'missing checks' })), /missing checks/);
  await assert.rejects(waitForStartup(() => ({ status: 'starting' }), { timeoutMs: 5, intervalMs: 1 }), /timed out/);
});
