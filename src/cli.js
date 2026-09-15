#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from './args.js';
import { buildOrchestratorPrompt } from './prompt.js';
import { roleCatalog } from './roles.js';
import { scheduleDashboardPrompt, startDashboardRuntime, startDashboardUi, stopDashboardRuntime } from './dashboard.js';
import { runTeamCommand } from './team/cli.js';

const HELP = `oh-my-traex (otx) - TraeX-native multi-agent orchestration

Usage:
  otx run [options] "task"
  otx prompt [options] "task"
  otx team [N:role] [options] "task"
  otx team list
  otx team status|await|resume|stop|cleanup <team-name>
  otx team send <team-name> <worker> "message"
  otx team broadcast <team-name> "message"
  otx team tasks <team-name>
  otx team assign <team-name> <worker> "task"
  otx team diagnose <team-name>
  otx team add-worker <team-name> <role> "assignment"
  otx team remove-worker <team-name> <worker>
  otx team integrate <team-name> [worker ...]
  otx roles
  otx doctor

Options:
  -n, --workers <1-6>       Maximum active child agents (default: 4)
      --mode <mode>         conservative | balanced | aggressive
  -m, --model <model>       Forward a model selection to TraeX
  -C, --cwd <directory>     Workspace for the TraeX run
      --read-only           Run the lead with a read-only sandbox
      --ui <none|dashboard> Open a TraeX dashboard in a sibling tmux pane
      --json                Ask TraeX exec for JSONL events
      --dry-run             Print the TraeX command and prompt without running
  -h, --help                Show this help

Examples:
  otx run "Implement login rate limiting and tests"
  otx run -n 3 --mode conservative "Review this repository for security issues"
  otx prompt "Refactor the parser without changing behavior"`;

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === 'team') return await runTeamCommand(argv.slice(1));
    const { command, task, options } = parseArgs(argv);
    if (options.help || command === 'help') return print(HELP);
    if (command === 'roles') return print(roleCatalog());
    if (command === 'doctor') return doctor();
    if (!['run', 'prompt'].includes(command)) throw new Error(`Unknown command: ${command}`);
    if (!task) throw new Error(`${command} requires a task.`);
    if (options.ui === 'dashboard' && options.json) {
      throw new Error('--json cannot be used with --ui dashboard.');
    }

    const prompt = buildOrchestratorPrompt({ task, workers: options.workers, mode: options.mode });
    if (command === 'prompt') return print(prompt);

    const cwd = resolve(options.cwd);
    accessSync(cwd, constants.R_OK);
    const traeArgs = [
      'exec',
      '--skip-git-repo-check',
      '-C',
      cwd,
      '--sandbox',
      options.readOnly ? 'read-only' : 'workspace-write',
    ];
    if (options.model) traeArgs.push('--model', options.model);
    if (options.json) traeArgs.push('--json');
    traeArgs.push(prompt);

    if (options.dryRun) {
      if (options.ui === 'dashboard') {
        print('ui: start a shared TraeX dashboard leader and sibling monitor pane');
        print('traex dashboard --no-alt-screen <orchestrator-prompt>');
        return 0;
      }
      print(`traex ${traeArgs.slice(0, -1).map(shellQuote).join(' ')} <orchestrator-prompt>`);
      print('\n' + prompt);
      return 0;
    }

    if (options.ui === 'dashboard') {
      const runtime = startDashboardRuntime({ cwd });
      try {
        const panes = startDashboardUi({ cwd, remoteUrl: runtime.remoteUrl });
        runtime.dashboardPaneId = panes.dashboardPaneId;
        scheduleDashboardPrompt({ leaderPaneId: panes.leaderPaneId, prompt });
        print(`otx: dashboard monitor ready in tmux pane ${panes.dashboardPaneId}`);
        const result = spawnSync('traex', ['dashboard', '--no-alt-screen', '--remote', runtime.remoteUrl], { cwd, stdio: 'inherit' });
        if (result.error) throw result.error;
        return result.status ?? 1;
      } finally {
        stopDashboardRuntime(runtime, { cwd });
      }
    }

    const result = spawnSync('traex', traeArgs, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
    process.stderr.write(`otx: ${error.message}\n`);
    return 1;
  }
}

function doctor() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(['Node.js >= 22', nodeMajor >= 22, process.version]);

  const version = spawnSync('traex', ['--version'], { encoding: 'utf8' });
  checks.push(['TraeX on PATH', version.status === 0, (version.stdout || version.stderr).trim() || 'not found']);

  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  checks.push(['Git on PATH', git.status === 0, (git.stdout || git.stderr).trim() || 'not found']);

  const tmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  checks.push(['tmux on PATH', tmux.status === 0, (tmux.stdout || tmux.stderr).trim() || 'not found']);

  const features = spawnSync('traex', ['features', 'list'], { encoding: 'utf8' });
  const featureText = `${features.stdout || ''}\n${features.stderr || ''}`;
  checks.push(['TraeX multi_agent enabled', /multi_agent\s+stable\s+true/.test(featureText), 'required']);
  checks.push(['TraeX multi_agent_v2 enabled', /multi_agent_v2\s+stable\s+true/.test(featureText), 'recommended']);

  for (const [name, ok, detail] of checks) print(`${ok ? 'PASS' : 'FAIL'}  ${name} (${detail})`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

function shellQuote(value) {
  return /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function print(value) {
  process.stdout.write(`${value}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; });
}
