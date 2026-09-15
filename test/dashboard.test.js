import test from 'node:test';
import assert from 'node:assert/strict';
import { startDashboardUi } from '../src/dashboard.js';

test('requires a tmux leader pane', () => {
  assert.throws(
    () => startDashboardUi({ cwd: '/repo', env: {}, run: () => assert.fail('must not run') }),
    /requires running otx inside tmux/,
  );
});

test('creates a remote dashboard pane next to the leader', () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'split-window') return { status: 0, stdout: '%9\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = startDashboardUi({
    cwd: '/repo with spaces',
    env: { TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%1' },
    remoteUrl: 'ws://127.0.0.1:12345', run,
  });

  assert.deepEqual(result, { leaderPaneId: '%1', dashboardPaneId: '%9' });
  assert.equal(calls[0].command, 'tmux');
  assert.deepEqual(calls[0].args.slice(0, 12), [
    'split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', '%1', '-c', '/repo with spaces',
    'exec traex dashboard --no-alt-screen --remote ws://127.0.0.1:12345',
  ]);
});
