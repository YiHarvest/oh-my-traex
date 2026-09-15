import test from 'node:test';
import assert from 'node:assert/strict';
import { SpawnSupervisor } from '../src/supervisor.js';

test('creates one pane per newly spawned child thread', () => {
  const calls = [];
  const supervisor = new SpawnSupervisor({
    remoteUrl: 'ws://127.0.0.1:1234',
    cwd: '/repo',
    leaderPaneId: '%1',
    stateDir: '/tmp/unused',
    run(command, args) {
      calls.push({ command, args });
      if (args[0] === 'split-window') return { status: 0, stdout: '%8\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  supervisor.persist = () => {};
  supervisor.log = () => {};

  const event = {
    method: 'item/completed',
    params: {
      item: {
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['child-1'],
        agentNickname: 'worker-1',
        agentRole: 'explorer',
      },
    },
  };
  supervisor.handleMessage(event);
  supervisor.handleMessage(event);

  assert.equal(calls.filter((call) => call.args[0] === 'split-window').length, 1);
  assert.equal(supervisor.childThreads.get('child-1').paneId, '%8');
});

test('discovers spawned child threads from thread list polling', () => {
  const supervisor = new SpawnSupervisor({
    remoteUrl: 'ws://127.0.0.1:1234', cwd: '/repo', leaderPaneId: '%1', stateDir: '/tmp/unused',
    run(command, args) {
      if (args[0] === 'split-window') return { status: 0, stdout: '%11\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  supervisor.startedAtSeconds = 100;
  supervisor.persist = () => {};
  supervisor.log = () => {};
  supervisor.handleThreadList([{ id: 'child-2', createdAt: 101, agentNickname: 'Curie', agentRole: 'explorer', status: { type: 'active' }, source: { subAgent: { thread_spawn: { parent_thread_id: 'leader-1' } } } }]);
  assert.deepEqual(supervisor.childThreads.get('child-2'), {
    threadId: 'child-2', parentThreadId: 'leader-1', nickname: 'Curie', role: 'explorer', status: 'active', paneId: '%11',
  });
});

test('reads newly loaded threads before classifying subagents', () => {
  const sent = [];
  const supervisor = new SpawnSupervisor({
    remoteUrl: 'ws://127.0.0.1:1234', cwd: '/repo', leaderPaneId: '%1', stateDir: '/tmp/unused',
  });
  supervisor.socket = { send(value) { sent.push(JSON.parse(value)); } };
  supervisor.handleLoadedThreadIds(['leader-1', 'child-1']);
  assert.deepEqual(sent.map((message) => message.method), ['thread/read', 'thread/read']);
  assert.deepEqual(sent.map((message) => message.params.threadId), ['leader-1', 'child-1']);
});
