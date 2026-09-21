import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTeamHud, openTeamHud, watchTeamHud } from '../src/team/hud.js';

const snapshot = {
  config: { name: 'release', status: 'running', mux_backend: 'tmux', leader_pane_id: '%1', run_id: 'run-1' },
  workers: [
    { name: 'worker-1', role: 'executor', status: 'working', health: 'healthy', current_task_id: '3', activity_age_ms: 5200 },
    { name: 'worker-2', role: 'reviewer', status: 'completed', health: 'completed', initial_task_id: '2', activity_age_ms: 62000 },
    { name: 'worker-3', role: 'tester', status: 'failed', health: 'dead', initial_task_id: '4' },
  ],
};

test('renders a bounded team HUD snapshot', () => {
  const rendered = buildTeamHud(snapshot, { width: 70 });
  assert.match(rendered, /OTX release | running | workers 3 | working 1 | done 1 | attention 1/);
  assert.ok(rendered.includes('· worker-1 [executor] working task=3 activity=5s'));
  assert.ok(rendered.includes('✓ worker-2 [reviewer] completed task=2 activity=1m'));
  assert.ok(rendered.includes('! worker-3 [tester] failed task=4 activity=-'));
  assert.ok(rendered.split('\n').every((line) => line.length <= 70));
});

test('watch mode redraws and restores the cursor when aborted', async () => {
  const fixture = makeState();
  const controller = new AbortController();
  let output = '';
  try {
    await watchTeamHud(fixture.cwd, 'release', {
      intervalMs: 250, signal: controller.signal,
      output: { columns: 80, write(value) { output += value; controller.abort(); } },
      run: fixture.run,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  assert.ok(output.startsWith('\x1b[?25l\x1b[H\x1b[2JOTX release'));
  assert.ok(output.endsWith('\x1b[?25h'));
});

test('tmux HUD reuses an owned pane for the same team run', () => {
  const fixture = makeState((args) => {
    if (args[0] === 'list-panes') return { status: 0, stdout: '%1\t\t\t\n%9\trelease\t%1\trun-1\n' };
    return { status: 0, stdout: '' };
  });
  try {
    const result = openTeamHud(fixture.cwd, 'release', { env: { TMUX: 'tmux', TMUX_PANE: '%1' }, run: fixture.run });
    assert.deepEqual(result, { pane_id: '%9', reused: true });
    assert.equal(fixture.calls.some((args) => args[0] === 'split-window'), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('tmux HUD creates and marks a compact read-only pane', () => {
  const fixture = makeState((args) => {
    if (args[0] === 'list-panes') return { status: 0, stdout: '%1\t\t\t\n' };
    if (args[0] === 'split-window') return { status: 0, stdout: '%8\n' };
    return { status: 0, stdout: '' };
  }, 'repo with space');
  try {
    const result = openTeamHud(fixture.cwd, 'release', {
      env: { TMUX: 'tmux', TMUX_PANE: '%1' }, cliPath: '/pkg/src/cli.js', intervalMs: 750, run: fixture.run,
    });
    assert.deepEqual(result, { pane_id: '%8', reused: false });
    const split = fixture.calls.find((args) => args[0] === 'split-window');
    assert.match(split.at(-1), /team hud release/);
    assert.match(split.at(-1), /repo with space/);
    assert.equal(fixture.calls.filter((args) => args[0] === 'set-option').length, 3);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function makeState(tmuxHandler = () => ({ status: 0, stdout: '' }), suffix = 'repo') {
  const root = mkdtempSync(join(tmpdir(), 'otx-hud-'));
  const cwd = join(root, suffix);
  mkdirSync(cwd, { recursive: true });
  const initialized = spawnSync('git', ['init', '-q'], { cwd, encoding: 'utf8' });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  const stateDir = join(cwd, '.git', 'otx', 'team', 'release');
  mkdirSync(join(stateDir, 'workers'), { recursive: true });
  mkdirSync(join(stateDir, 'tasks'), { recursive: true });
  mkdirSync(join(stateDir, 'mailbox'), { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    ...snapshot.config, cwd, workers: snapshot.workers.map((worker) => worker.name),
  }));
  for (const worker of snapshot.workers) writeFileSync(join(stateDir, 'workers', `${worker.name}.json`), JSON.stringify({
    ...worker, worktree_path: cwd, pane_id: `%${Number(worker.name.at(-1)) + 1}`, pane_pid: 10 + Number(worker.name.at(-1)),
  }));
  const calls = [];
  const run = (command, args) => {
    if (command === 'tmux') {
      if (args[0] === 'display-message') {
        const workerNumber = Number(String(args[3] || '').replace('%', '')) - 1;
        return { status: 0, stdout: `release\tworker-${workerNumber}\trun-1\t${10 + workerNumber}\t0\n` };
      }
      calls.push(args);
      return tmuxHandler(args);
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { status: 0, stdout: `${cwd}\n` };
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--git-common-dir') return { status: 0, stdout: '.git\n' };
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '' };
    if (command === 'git' && args[0] === 'merge-base') return { status: 1, stdout: '' };
    return { status: 0, stdout: '' };
  };
  return { root, cwd, stateDir, run, calls };
}
