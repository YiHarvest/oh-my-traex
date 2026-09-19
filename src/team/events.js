import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withStateLock, writeJsonAtomic } from './state.js';
import { readVersionedRecord } from './codec.js';

export function appendTeamEvent(stateDir, type, { actor = 'runtime', data = {} } = {}) {
  if (!type || typeof type !== 'string') throw new Error('team event type is required.');
  return withStateLock(stateDir, 'event-sequence', () => {
    const directory = eventsDir(stateDir);
    const cursorPath = join(directory, 'cursor.json');
    mkdirSync(directory, { recursive: true });
    const sequence = existsSync(cursorPath)
      ? readVersionedRecord(cursorPath).sequence + 1
      : 1;
    const event = {
      schema_version: 1,
      id: String(sequence).padStart(16, '0'),
      sequence,
      type,
      actor,
      data,
      created_at: new Date().toISOString(),
    };
    writeJsonAtomic(join(directory, `${event.id}-${randomUUID()}.json`), event);
    writeJsonAtomic(cursorPath, { schema_version: 1, sequence, updated_at: event.created_at });
    return event;
  });
}

export function listTeamEvents(stateDir, { after = null, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('event limit must be an integer from 1 to 1000.');
  }
  const directory = eventsDir(stateDir);
  if (!existsSync(directory)) return { events: [], cursor: after };
  const names = readdirSync(directory)
    .filter((name) => /^\d{16}-.*\.json$/.test(name))
    .filter((name) => !after || name.slice(0, 16) > after)
    .sort()
    .slice(0, limit);
  const events = names
    .map((name) => {
      try { return readVersionedRecord(join(directory, name)); } catch { return null; }
    })
    .filter((event) => event && (!after || event.id > after))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { events, cursor: events.at(-1)?.id || after };
}

function eventsDir(stateDir) {
  return join(stateDir, 'events');
}
