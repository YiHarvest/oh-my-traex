import { readFileSync } from 'node:fs';
const ROLES = ['executor', 'test-engineer', 'reviewer', 'explorer', 'architect'];
export function parseRoleModel(value) {
  const separator = value.indexOf('=');
  const role = value.slice(0, separator), model = value.slice(separator + 1).trim();
  if (separator < 1 || !ROLES.includes(role) || !model) throw new Error('--role-model requires role=model');
  return [role, model];
}
export function loadModelPrices(path) {
  if (!path) return {};
  const prices = JSON.parse(readFileSync(path, 'utf8'));
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) throw new Error('model prices must be an object');
  for (const [model, rates] of Object.entries(prices)) {
    if (!model || !rates || ['input_per_million', 'cached_input_per_million', 'output_per_million'].some((key) => !Number.isFinite(rates[key]) || rates[key] < 0)) {
      throw new Error('invalid USD model prices: ' + model);
    }
  }
  return prices;
}
export function selectWorkerModel(role, model, roleModels = {}) { return roleModels[role] || model || null; }
