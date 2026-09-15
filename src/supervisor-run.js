#!/usr/bin/env node

import { startSpawnSupervisor } from './supervisor.js';

const options = parseArgs(process.argv.slice(2));
startSpawnSupervisor(options);

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    values[args[index]?.replace(/^--/, '')] = args[index + 1];
  }
  for (const name of ['remote', 'cwd', 'leader-pane', 'state-dir']) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  return {
    remoteUrl: values.remote,
    cwd: values.cwd,
    leaderPaneId: values['leader-pane'],
    stateDir: values['state-dir'],
  };
}
