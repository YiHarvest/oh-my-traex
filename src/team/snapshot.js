import { teamStatus } from './runtime.js';

// Bounded, per-observer cache. Mutation paths never use cached state.
export function createTeamSnapshotReader({ ttlMs = 2000, now = Date.now, read = teamStatus } = {}) {
  const cache = new Map();
  const get = (cwd, name, run) => {
    const key = JSON.stringify([cwd, name]);
    const existing = cache.get(key);
    if (existing && now() - existing.at < ttlMs) return existing.state;
    const state = read(cwd, name, run);
    cache.delete(key);
    cache.set(key, { at: now(), state });
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return state;
  };
  get.clear = () => cache.clear();
  return get;
}
