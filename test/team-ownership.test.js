import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectWriteOwnership, normalizeOwnedPath } from '../src/team/ownership.js';
import { buildWorkerPrompt } from '../src/team/prompt.js';
test('ownership rejects unsafe paths and distinguishes sibling directory names', () => {
  for (const path of ['/root', '../x', 'C:\\secret', 'a/../b', '.git/../x', 'a\0b']) assert.throws(() => normalizeOwnedPath(path));
  assert.equal(normalizeOwnedPath('./src/'), 'src');
  const report = inspectWriteOwnership('.', 'base', 'head', ['src'], () => ({ status: 0, stdout: 'src/a\0src2/b\0' }));
  assert.deepEqual(report.outside, ['src2/b']);
  assert.equal(report.passed, false);
  assert.equal(inspectWriteOwnership('.', 'base', 'head', []).enforced, false);
  assert.match(buildWorkerPrompt({ teamName: 't', worker: { file_paths: ['src/a'], role: 'executor' }, task: 't' }), /Allowed write paths: src\/a/);
});
test('real Git diff catches both sides of a rename outside the boundary', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otx-ownership-'));
  const git = (...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    mkdirSync(join(cwd, 'src')); writeFileSync(join(cwd, 'src', 'a'), 'same');
    git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    renameSync(join(cwd, 'src', 'a'), join(cwd, 'outside'));
    git('add', '-A'); git('commit', '-qm', 'rename'); const head = git('rev-parse', 'HEAD');
    const report = inspectWriteOwnership(cwd, base, head, ['src']);
    assert.equal(report.passed, false); assert.deepEqual(report.outside, ['outside']);
    assert.ok(report.changed.includes('src/a'));
    assert.equal(inspectWriteOwnership(cwd, base, head, ['src', 'outside']).passed, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
