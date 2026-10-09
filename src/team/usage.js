export function addUsage(previous, event, model, prices = {}) {
  if (event.type !== 'turn.completed' || !event.usage) return previous;
  const usage = event.usage;
  const input = usage.input_tokens, output = usage.output_tokens, cached = usage.cached_input_tokens ?? 0;
  if (![input, output, cached].every((value) => Number.isSafeInteger(value) && value >= 0) || cached > input) return previous;
  const totals = previous || { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, observed_turns: 0, priced_turns: 0, priced_cost_usd: 0 };
  const rates = prices[model];
  const cost = rates ? ((input - cached) * rates.input_per_million + cached * rates.cached_input_per_million + output * rates.output_per_million) / 1e6 : null;
  const priced = Number.isFinite(cost) && cost >= 0;
  const next = { input_tokens: totals.input_tokens + input, output_tokens: totals.output_tokens + output,
    cached_input_tokens: totals.cached_input_tokens + cached, observed_turns: totals.observed_turns + 1,
    priced_turns: totals.priced_turns + Number(priced), priced_cost_usd: totals.priced_cost_usd + (priced ? cost : 0) };
  return { ...next, estimated_cost_usd: next.priced_turns === next.observed_turns ? next.priced_cost_usd : null };
}
export function summarizeUsage(workers) {
  const observed = workers.filter((worker) => worker.usage?.observed_turns > 0);
  if (!observed.length) return { observed_workers: 0, input_tokens: null, output_tokens: null, cached_input_tokens: null, estimated_cost_usd: null };
  const sum = (key) => observed.reduce((total, worker) => total + worker.usage[key], 0);
  return { observed_workers: observed.length, total_workers: workers.length, input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
    cached_input_tokens: sum('cached_input_tokens'), observed_turns: sum('observed_turns'),
    estimated_cost_usd: observed.length === workers.length && observed.every((worker) => worker.usage.estimated_cost_usd !== null)
      ? sum('estimated_cost_usd') : null };
}
