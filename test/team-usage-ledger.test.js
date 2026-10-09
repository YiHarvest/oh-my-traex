import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordUsage, readUsageLedger, budgetStatus, assertBudgetAvailable } from '../src/team/usage-ledger.js';
import { parseTeamArgs } from '../src/team/cli.js';
test('usage ledger deduplicates replay and retains history independent of active workers', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'otx-ledger-'));
  const event = { id: 'event-1', type: 'turn.completed', model: 'actual', usage: { input_tokens: 100, output_tokens: 20 } };
  const record = { worker: 'worker-1', execution: 'initial:1', ordinal: 1, event, requestedModel: 'requested',
    prices: { actual: { input_per_million: 2, cached_input_per_million: 1, output_per_million: 5 } } };
  try {
    assert.equal(recordUsage(stateDir, record).duplicate, false);
    assert.equal(recordUsage(stateDir, { ...record, ordinal: 2 }).duplicate, true);
    assert.equal(readUsageLedger(stateDir).summary.input_tokens, 100);
    assert.equal(readUsageLedger(stateDir).summary.estimated_cost_usd, .0003);
    recordUsage(stateDir, { ...record, execution: 'message:2' });
    assert.equal(readUsageLedger(stateDir).summary.input_tokens, 200);
    assert.equal(budgetStatus(stateDir, { max_tokens: 200 }).exceeded, true);
    assert.throws(() => assertBudgetAvailable(stateDir, { max_tokens: 200 }), /exhausted/);
    assert.equal(budgetStatus(stateDir, {}).exceeded, false);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
test('usage without backend IDs uses execution/ordinal and rejects invalid counters', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'otx-ledger-id-'));
  try {
    const record = { worker: 'worker-1', execution: 'initial:1', ordinal: 1, event: { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } } };
    recordUsage(stateDir, record); recordUsage(stateDir, record);
    recordUsage(stateDir, { ...record, ordinal: 2 });
    assert.equal(readUsageLedger(stateDir).summary.input_tokens, 2);
    assert.equal(recordUsage(stateDir, { ...record, event: { ...record.event, usage: { input_tokens: -1 } } }), null);
    assert.equal(parseTeamArgs(['--max-tokens', '500', 'task']).options.maxTokens, 500);
    assert.throws(() => parseTeamArgs(['--max-tokens', '-1', 'task']));
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('supervisor stops a Team when recorded token budget is exhausted', async () => {
  const { spawnSync } = await import('node:child_process');
  const { initTeamState, readTeamState } = await import('../src/team/state.js');
  const { superviseTeamOnce } = await import('../src/team/supervisor.js');
  const cwd = mkdtempSync(join(tmpdir(), 'otx-budget-stop-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd });
    const { stateDir } = initTeamState({ cwd, name: 'budget', task: 'test', leaderPaneId: '%1', leaderSessionId: 's', maxTokens: 100,
      workers: [{ name: 'worker-1', index: 1, status: 'working', role: 'reviewer', worktree_path: cwd }] });
    recordUsage(stateDir, { worker: 'worker-1', execution: 'initial:1', ordinal: 1, event: { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } } });
    const result = superviseTeamOnce(cwd, 'budget', () => ({ status: 1, stdout: '' }));
    assert.equal(result.state.config.status, 'stopped');
    assert.equal(readTeamState(cwd, 'budget').tasks[0].status, 'cancelled');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
