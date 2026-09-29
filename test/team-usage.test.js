import test from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, summarizeUsage } from '../src/team/usage.js';
import { parseRoleModel, selectWorkerModel, loadModelPrices } from '../src/team/models.js';
import { parseTeamArgs } from '../src/team/cli.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('model routing applies explicit role overrides and preserves the team default', () => {
  const parsed = parseTeamArgs(['--model', 'large', '--role-model', 'explorer=small', 'task']);
  assert.equal(selectWorkerModel('explorer', parsed.options.model, parsed.options.roleModels), 'small');
  assert.equal(selectWorkerModel('executor', parsed.options.model, parsed.options.roleModels), 'large');
  assert.equal(selectWorkerModel('reviewer'), null);
  for (const value of ['bad=small', 'explorer=', 'explorer']) assert.throws(() => parseRoleModel(value));
});
test('usage counts observed turns only and subtracts cached tokens from regular input pricing', () => {
  const prices = { small: { input_per_million: 2, cached_input_per_million: 1, output_per_million: 5 } };
  const event = { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 } };
  const first = addUsage(null, event, 'small', prices);
  assert.equal(first.estimated_cost_usd, 0.0026);
  const second = addUsage(first, event, 'small', prices);
  assert.equal(second.input_tokens, 2000); assert.equal(second.observed_turns, 2);
  assert.equal(addUsage(second, { ...event, type: 'item.completed' }, 'small', prices), second);
  assert.equal(addUsage(second, { type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 2 } }, 'small', prices), second);
  assert.equal(addUsage(null, event, 'unknown', prices).estimated_cost_usd, null);
  assert.equal(summarizeUsage([{ usage: first }, {}]).estimated_cost_usd, null);
  assert.equal(summarizeUsage([{ usage: first }]).estimated_cost_usd, first.estimated_cost_usd);
  assert.equal(summarizeUsage([{}]).input_tokens, null);
});
test('price files reject invalid rates and leave missing prices unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'otx-prices-'));
  const path = join(root, 'prices.json');
  try {
    assert.deepEqual(loadModelPrices(), {});
    writeFileSync(path, JSON.stringify({ m: { input_per_million: -1 } }));
    assert.throws(() => loadModelPrices(path));
    const prices = { m: { input_per_million: 1, cached_input_per_million: 0, output_per_million: 2 } };
    writeFileSync(path, JSON.stringify(prices));
    assert.deepEqual(loadModelPrices(path), prices);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
