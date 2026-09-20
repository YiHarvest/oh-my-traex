import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { appendTeamEvent, listTeamEvents } from '../src/team/events.js';

test('reads incremental event pages with a stable cursor', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'otx-events-'));
  try {
    appendTeamEvent(stateDir, 'team.started');
    appendTeamEvent(stateDir, 'task.queued');
    appendTeamEvent(stateDir, 'task.completed');
    const first = listTeamEvents(stateDir, { limit: 2 });
    assert.deepEqual(first.events.map((event) => event.type), ['team.started', 'task.queued']);
    const second = listTeamEvents(stateDir, { after: first.cursor });
    assert.deepEqual(second.events.map((event) => event.type), ['task.completed']);
    assert.equal(listTeamEvents(stateDir, { after: second.cursor }).events.length, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('persists a gap-free ordered stream across 64 concurrent event writers', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'otx-events-stress-'));
  try {
    const fixture = new URL('./fixtures/append-event.js', import.meta.url);
    await Promise.all(Array.from({ length: 64 }, (_, index) => runJsonProcess(fixture, [stateDir, String(index)])));
    const stream = listTeamEvents(stateDir, { limit: 100 });
    assert.equal(stream.events.length, 64);
    assert.deepEqual(stream.events.map((event) => event.sequence), Array.from({ length: 64 }, (_, index) => index + 1));
    assert.equal(new Set(stream.events.map((event) => event.id)).size, 64);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function runJsonProcess(scriptUrl, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(scriptUrl), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}
