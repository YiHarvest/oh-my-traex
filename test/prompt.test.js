import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrchestratorPrompt } from '../src/prompt.js';

test('builds a bounded native multi-agent contract', () => {
  const prompt = buildOrchestratorPrompt({ task: 'Build an API', workers: 3, mode: 'balanced' });
  assert.match(prompt, /Build an API/);
  assert.match(prompt, /Maximum simultaneously active child agents: 3/);
  assert.match(prompt, /TraeX native collaboration tools/);
  assert.match(prompt, /Avoid concurrent edits to the same file/);
  assert.match(prompt, /Child agents are leaf workers/);
});
