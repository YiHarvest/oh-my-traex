import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTeamPlan } from '../src/team/planner.js';

test('validates and normalizes a read-after-write team DAG', () => {
  const plan = validateTeamPlan({
    summary: 'implement then review',
    workers: [
      { id: 'impl', role: 'executor', assignment: 'implement API', depends_on: [], file_paths: ['src/api.js'] },
      { id: 'review', role: 'reviewer', assignment: 'review API commit', depends_on: ['impl'], file_paths: ['src/api.js'] },
    ],
  }, 2);
  assert.equal(plan.workers[0].name, 'worker-1');
  assert.deepEqual(plan.workers[1].depends_on_symbols, ['impl']);
  assert.equal(plan.workers[0].requires_commit, true);
  assert.equal(plan.workers[1].requires_commit, false);
});

test('rejects dependent write workers and cycles', () => {
  assert.throws(() => validateTeamPlan({ summary: '', workers: [
    { id: 'one', role: 'executor', assignment: 'one', depends_on: [], file_paths: [] },
    { id: 'two', role: 'test-engineer', assignment: 'two', depends_on: ['one'], file_paths: [] },
  ] }, 2), /write worker/);
  assert.throws(() => validateTeamPlan({ summary: '', workers: [
    { id: 'one', role: 'reviewer', assignment: 'one', depends_on: ['two'], file_paths: [] },
    { id: 'two', role: 'reviewer', assignment: 'two', depends_on: ['one'], file_paths: [] },
  ] }, 2), /cycle/);
});

test('rejects unsafe and overlapping write ownership', () => {
  assert.throws(() => validateTeamPlan({ summary: '', workers: [
    { id: 'one', role: 'executor', assignment: 'one', depends_on: [], file_paths: ['../secret'] },
  ] }, 1), /unsafe file path/);
  assert.throws(() => validateTeamPlan({ summary: '', workers: [
    { id: 'one', role: 'executor', assignment: 'one', depends_on: [], file_paths: ['src'] },
    { id: 'two', role: 'test-engineer', assignment: 'two', depends_on: [], file_paths: ['src/api.test.js'] },
  ] }, 2), /ownership overlaps/);
});
