import { createHash } from 'node:crypto';
const volatile = new Set(['generated_at', 'heartbeat_age_ms', 'activity_age_ms']);
export function snapshotRevision(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot, (key, value) => volatile.has(key) ? undefined : value)).digest('hex');
}
export function writeSnapshotEvent(response, event, data) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.writableLength > 1024 * 1024) { response.destroy(); return false; }
  return response.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
export async function waitForStartup(read, { timeoutMs = 100000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = read();
    if (state?.status === 'failed') throw new Error(state.error || 'Team startup failed');
    if (state?.status === 'ready') return state;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Team startup confirmation timed out; inspect the Team before retrying');
}
