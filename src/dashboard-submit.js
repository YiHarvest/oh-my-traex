#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , paneId, promptPath] = process.argv;
const deadline = Date.now() + 120_000;

try {
  if (!paneId?.startsWith('%') || !promptPath) process.exitCode = 2;
  else await submitWhenReady();
} finally {
  if (promptPath) {
    rmSync(promptPath, { force: true });
    rmSync(dirname(promptPath), { recursive: true, force: true });
  }
}

async function submitWhenReady() {
  while (Date.now() < deadline) {
    const capture = tmux(['capture-pane', '-p', '-t', paneId]);
    if (capture.status !== 0) return;
    if (/Ask TraeCode CLI to do anything/i.test(capture.stdout)) {
      const bufferName = `otx-dashboard-${process.pid}`;
      const load = tmux(['load-buffer', '-b', bufferName, promptPath]);
      if (load.status !== 0) return;
      const paste = tmux(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', paneId]);
      if (paste.status !== 0) return;
      tmux(['send-keys', '-t', paneId, 'C-m']);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function tmux(args) {
  return spawnSync('tmux', args, { encoding: 'utf8' });
}
