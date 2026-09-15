#!/usr/bin/env node

const options = parseArgs(process.argv.slice(2));
const socket = new WebSocket(options.remote);
let initialized = false;
let nextRequestId = 2;
const renderedItemIds = new Set();

process.stdout.write(`TraeX child: ${options.name} [${options.role}]\nthread: ${options.thread}\n\n`);
socket.addEventListener('open', () => socket.send(JSON.stringify({
  id: 1,
  method: 'initialize',
  params: {
    clientInfo: { name: 'oh-my-traex-thread-viewer', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  },
})));
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id === 1 && !initialized) {
    initialized = true;
    socket.send(JSON.stringify({ method: 'initialized' }));
    poll();
    const timer = setInterval(poll, 1000);
    timer.unref?.();
    return;
  }
  if (message.id >= 2 && message.result?.thread) renderHistory(message.result.thread);
  if (message.params?.threadId !== options.thread) return;
  if (message.method === 'item/agentMessage/delta') process.stdout.write(message.params.delta || '');
  else if (message.method === 'turn/started') process.stdout.write('\n[working]\n');
  else if (message.method === 'turn/completed') process.stdout.write('\n[turn completed]\n');
  else if (message.method === 'item/started' && message.params.item?.type === 'commandExecution') {
    process.stdout.write(`\n$ ${message.params.item.command || ''}\n`);
  }
});
socket.addEventListener('error', () => process.stdout.write('\n[viewer disconnected]\n'));

function renderHistory(thread) {
  for (const turn of thread?.turns || []) {
    for (const item of turn.items || []) {
      const itemId = item.id || `${turn.id}:${item.type}:${item.text || item.command || ''}`;
      if (renderedItemIds.has(itemId)) continue;
      renderedItemIds.add(itemId);
      if (item.type === 'agentMessage' && item.text) process.stdout.write(`${item.text}\n`);
      if (item.type === 'commandExecution' && item.command) process.stdout.write(`$ ${item.command}\n`);
    }
  }
}

function poll() {
  socket.send(JSON.stringify({
    id: nextRequestId++,
    method: 'thread/read',
    params: { threadId: options.thread, includeTurns: true },
  }));
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) values[args[index]?.replace(/^--/, '')] = args[index + 1];
  return values;
}
