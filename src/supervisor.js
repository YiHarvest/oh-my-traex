import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class SpawnSupervisor {
  constructor({ remoteUrl, cwd, leaderPaneId, stateDir, WebSocketImpl = globalThis.WebSocket, run = spawnSync }) {
    this.remoteUrl = remoteUrl;
    this.cwd = cwd;
    this.leaderPaneId = leaderPaneId;
    this.stateDir = stateDir;
    this.WebSocketImpl = WebSocketImpl;
    this.run = run;
    this.childThreads = new Map();
    this.seenThreadIds = new Set();
    this.pendingReads = new Map();
    this.startedAtSeconds = Math.floor(Date.now() / 1000) - 2;
    this.nextRequestId = 100;
  }

  start() {
    mkdirSync(this.stateDir, { recursive: true });
    this.socket = new this.WebSocketImpl(this.remoteUrl);
    this.socket.addEventListener('open', () => this.initialize());
    this.socket.addEventListener('message', (event) => this.handleMessage(JSON.parse(String(event.data))));
    this.socket.addEventListener('error', (event) => this.log({ type: 'supervisor_error', message: String(event.message || 'websocket error') }));
    return this;
  }

  initialize() {
    this.send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'oh-my-traex-supervisor', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
  }

  handleMessage(message) {
    if (message.id === 1) {
      this.send({ method: 'initialized' });
      this.log({ type: 'supervisor_ready' });
      this.pollThreads();
      this.pollTimer = setInterval(() => this.pollThreads(), 1000);
      this.pollTimer.unref?.();
      return;
    }

    if (message.id >= 100 && message.result?.data) {
      this.handleLoadedThreadIds(message.result.data);
      return;
    }
    if (this.pendingReads.has(message.id)) {
      const threadId = this.pendingReads.get(message.id);
      this.pendingReads.delete(message.id);
      if (message.result?.thread) this.handleThreadList([message.result.thread]);
      else this.seenThreadIds.add(threadId);
      return;
    }

    if (!['item/started', 'item/completed'].includes(message.method)) return;
    const item = message.params?.item;
    if (item?.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') return;

    for (const threadId of item.receiverThreadIds || []) {
      if (!threadId || this.childThreads.has(threadId)) continue;
      const child = {
        threadId,
        nickname: item.agentNickname || threadId.slice(0, 8),
        role: item.agentRole || 'subagent',
        status: item.status || 'running',
      };
      child.paneId = this.createChildPane(child);
      this.childThreads.set(threadId, child);
      this.persist();
      this.log({ type: 'child_spawned', ...child });
    }
  }

  pollThreads() {
    this.send({
      id: this.nextRequestId++,
      method: 'thread/loaded/list',
      params: { limit: 100 },
    });
  }

  handleLoadedThreadIds(threadIds) {
    for (const threadId of threadIds) {
      if (!threadId || this.seenThreadIds.has(threadId) || this.pendingReadsHasThread(threadId)) continue;
      const requestId = this.nextRequestId++;
      this.pendingReads.set(requestId, threadId);
      this.send({ id: requestId, method: 'thread/read', params: { threadId, includeTurns: false } });
    }
  }

  pendingReadsHasThread(threadId) {
    return [...this.pendingReads.values()].includes(threadId);
  }

  handleThreadList(threads) {
    for (const thread of threads) {
      if (!thread?.id) continue;
      this.seenThreadIds.add(thread.id);
      if (thread.createdAt < this.startedAtSeconds || this.childThreads.has(thread.id)) continue;
      const spawn = thread.source?.subAgent?.thread_spawn ?? thread.source?.subagent?.thread_spawn;
      if (!spawn) continue;
      const child = {
        threadId: thread.id,
        parentThreadId: spawn.parent_thread_id,
        nickname: thread.agentNickname || spawn.agent_nickname || thread.id.slice(0, 8),
        role: thread.agentRole || spawn.agent_role || 'subagent',
        status: thread.status?.type || 'running',
      };
      child.paneId = this.createChildPane(child);
      this.childThreads.set(thread.id, child);
      this.persist();
      this.log({ type: 'child_discovered', ...child });
    }
  }

  createChildPane(child) {
    const title = sanitizeTitle(`${child.nickname} [${child.role}]`);
    const command = shellJoin([
      process.execPath,
      join(import.meta.dirname, 'thread-viewer.js'),
      '--remote',
      this.remoteUrl,
      '--thread',
      child.threadId,
      '--name',
      child.nickname,
      '--role',
      child.role,
    ]);
    const result = this.run('tmux', [
      'split-window', '-v', '-d', '-P', '-F', '#{pane_id}',
      '-t', this.leaderPaneId, '-c', this.cwd, command,
    ], { cwd: this.cwd, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      this.log({ type: 'pane_error', threadId: child.threadId, message: String(result.error?.message || result.stderr || result.status) });
      return null;
    }
    const paneId = result.stdout.trim().split('\n')[0];
    this.run('tmux', ['select-pane', '-t', paneId, '-T', title], { cwd: this.cwd, encoding: 'utf8' });
    this.run('tmux', ['select-layout', '-t', this.leaderPaneId, 'tiled'], { cwd: this.cwd, encoding: 'utf8' });
    return paneId;
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  persist() {
    writeFileSync(join(this.stateDir, 'children.json'), JSON.stringify([...this.childThreads.values()], null, 2));
  }

  log(record) {
    appendFileSync(join(this.stateDir, 'supervisor.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  }
}

export function startSpawnSupervisor(options) {
  return new SpawnSupervisor(options).start();
}

function sanitizeTitle(value) {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 80);
}

function shellJoin(parts) {
  return parts.map((value) => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ');
}
