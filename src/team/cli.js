import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { addWorker, assignTeamTask, awaitTeam, broadcastTeamMessage, cleanupTeam, diagnoseTeam, integrateTeam, listTasks, readTeamEvents, readTeamMailbox, reconcileTeam, recoverTeam, removeWorker, resumeTeam, sendTeamMessage, startTeam, stopTeam, teamStatus } from './runtime.js';
import { listTeamStates } from './state.js';

const START_TOKEN = /^(\d+)(?::([a-z][a-z0-9-]*))?$/i;
const TEAM_HELP = `oh-my-traex durable team runtime

Usage:
  otx team [N:role] [--name NAME] [--model MODEL] [--no-plan] [--planner-timeout-ms N] [-C DIR] "task"
  otx team list [-C DIR] [--json]
  otx team status|reconcile|recover|await|resume|stop|cleanup <name> [-C DIR]
  otx team tasks|diagnose <name> [-C DIR]
  otx team events <name> [--after CURSOR] [--limit N] [-C DIR]
  otx team add-worker <name> <role> [-C DIR] -- "assignment"
  otx team remove-worker <name> <worker> [-C DIR]
  otx team assign <name> <worker> [--depends-on 1,2] [-C DIR] -- "task"
  otx team send <name> <worker> [-C DIR] -- "message"
  otx team broadcast <name> [-C DIR] -- "message"
  otx team mailbox <name> <worker> [-C DIR]
  otx team integrate <name> [worker ...] [-C DIR]`;

export function parseTeamArgs(args) {
  const tokens = [...args];
  const subcommand = ['list', 'tasks', 'events', 'assign', 'add-worker', 'remove-worker', 'diagnose', 'status', 'reconcile', 'recover', 'await', 'resume', 'stop', 'cleanup', 'send', 'broadcast', 'mailbox', 'integrate'].includes(tokens[0]) ? tokens.shift() : 'start';
  const options = { workers: 3, cwd: process.cwd(), timeoutMs: 3_600_000 };
  if (subcommand === 'list') {
    parseOptions(tokens, options);
    return { subcommand, options };
  }
  if (subcommand === 'send') {
    const name = tokens.shift();
    const worker = tokens.shift();
    const message = parseMessageAndOptions(tokens, options);
    if (!name || !worker || !message) throw new Error('Usage: otx team send <team> <worker> "message"');
    return { subcommand, name, worker, message, options };
  }
  if (subcommand === 'assign') {
    const name = tokens.shift();
    const worker = tokens.shift();
    const description = parseAssignmentAndOptions(tokens, options);
    if (!name || !worker || !description) throw new Error('Usage: otx team assign <team> <worker> "task"');
    return { subcommand, name, worker, description, dependsOn: options.dependsOn || [], options };
  }
  if (subcommand === 'add-worker') {
    const name = tokens.shift();
    const role = tokens.shift();
    const assignment = parseMessageAndOptions(tokens, options);
    if (!name || !role || !assignment) throw new Error('Usage: otx team add-worker <team> <role> "assignment"');
    if (!/^[a-z][a-z0-9-]*$/i.test(role)) throw new Error(`invalid worker role: ${role}`);
    return { subcommand, name, role, assignment, options };
  }
  if (subcommand === 'remove-worker') {
    const name = tokens.shift();
    const worker = tokens.shift();
    parseOptions(tokens, options);
    if (!name || !worker) throw new Error('Usage: otx team remove-worker <team> <worker>');
    return { subcommand, name, worker, options };
  }
  if (subcommand === 'broadcast') {
    const name = tokens.shift();
    const message = parseMessageAndOptions(tokens, options);
    if (!name || !message) throw new Error('Usage: otx team broadcast <team> "message"');
    return { subcommand, name, message, options };
  }
  if (subcommand === 'mailbox') {
    const name = tokens.shift();
    const worker = tokens.shift();
    parseOptions(tokens, options);
    if (!name || !worker) throw new Error('Usage: otx team mailbox <team> <worker>');
    return { subcommand, name, worker, options };
  }
  if (subcommand === 'tasks') {
    const name = tokens.shift();
    parseOptions(tokens, options);
    if (!name) throw new Error('Usage: otx team tasks <team>');
    return { subcommand, name, options };
  }
  if (subcommand === 'events') {
    const name = tokens.shift();
    parseOptions(tokens, options);
    if (!name) throw new Error('Usage: otx team events <team>');
    return { subcommand, name, options };
  }
  if (subcommand === 'diagnose') {
    const name = tokens.shift();
    parseOptions(tokens, options);
    if (!name) throw new Error('Usage: otx team diagnose <team>');
    return { subcommand, name, options };
  }
  if (subcommand === 'integrate') {
    const name = tokens.shift();
    if (!name) throw new Error('Usage: otx team integrate <team> [worker ...]');
    const workers = [];
    while (tokens.length > 0 && !tokens[0].startsWith('-')) workers.push(tokens.shift());
    parseOptions(tokens, options);
    return { subcommand, name, workers, options };
  }
  if (subcommand !== 'start') {
    const name = tokens.shift();
    if (!name) throw new Error(`team ${subcommand} requires a team name.`);
    parseOptions(tokens, options);
    return { subcommand, name, options };
  }

  const descriptor = tokens[0]?.match(START_TOKEN);
  if (descriptor) {
    options.workers = Number(descriptor[1]);
    options.role = descriptor[2];
    tokens.shift();
  }
  else if (/^\d+:/i.test(tokens[0] || '')) {
    throw new Error(`Invalid team descriptor: ${tokens[0]}`);
  }
  const taskParts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--workers' || token === '-n') options.workers = Number(requireValue(tokens, ++index, token));
    else if (token.startsWith('--workers=')) options.workers = Number(token.slice(10));
    else if (token === '--name') options.name = requireValue(tokens, ++index, token);
    else if (token.startsWith('--name=')) options.name = token.slice(7);
    else if (token === '--model' || token === '-m') options.model = requireValue(tokens, ++index, token);
    else if (token === '--cwd' || token === '-C') options.cwd = requireValue(tokens, ++index, token);
    else if (token === '--dry-run') options.dryRun = true;
    else if (token === '--no-plan') options.autoPlan = false;
    else if (token === '--planner-timeout-ms') options.plannerTimeoutMs = Number(requireValue(tokens, ++index, token));
    else if (token.startsWith('--planner-timeout-ms=')) options.plannerTimeoutMs = Number(token.slice(21));
    else if (token.startsWith('-')) throw new Error(`Unknown team option: ${token}`);
    else taskParts.push(token);
  }
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 6) {
    throw new Error('team workers must be an integer from 1 to 6.');
  }
  if (options.plannerTimeoutMs !== undefined
    && (!Number.isInteger(options.plannerTimeoutMs) || options.plannerTimeoutMs < 1000)) {
    throw new Error('--planner-timeout-ms must be an integer of at least 1000.');
  }
  const task = taskParts.join(' ').trim();
  if (!task) throw new Error('Usage: otx team [N:role] [options] "task"');
  return { subcommand, task, options };
}

export async function runTeamCommand(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${TEAM_HELP}\n`);
    return 0;
  }
  const parsed = parseTeamArgs(args);
  const cwd = resolve(parsed.options.cwd);
  if (parsed.subcommand === 'list') return printTeams(listTeamStates(cwd), parsed.options.json);
  if (parsed.subcommand === 'send') {
    process.stdout.write(`${JSON.stringify(sendTeamMessage(cwd, parsed.name, parsed.worker, parsed.message), null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === 'assign') {
    process.stdout.write(`${JSON.stringify(assignTeamTask(cwd, parsed.name, parsed.worker, parsed.description, parsed.dependsOn), null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === 'add-worker') {
    process.stdout.write(`${JSON.stringify(addWorker(cwd, parsed.name, parsed.role, parsed.assignment, { model: parsed.options.model }), null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === 'remove-worker') {
    process.stdout.write(`${JSON.stringify(removeWorker(cwd, parsed.name, parsed.worker), null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === 'broadcast') {
    process.stdout.write(`${JSON.stringify(broadcastTeamMessage(cwd, parsed.name, parsed.message), null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === 'mailbox') {
    process.stdout.write(`${JSON.stringify(readTeamMailbox(cwd, parsed.name, parsed.worker), null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === 'tasks') {
    process.stdout.write(`${JSON.stringify(listTasks(cwd, parsed.name), null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === 'events') {
    process.stdout.write(`${JSON.stringify(readTeamEvents(cwd, parsed.name, { after: parsed.options.after, limit: parsed.options.limit }), null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === 'diagnose') {
    process.stdout.write(`${JSON.stringify(diagnoseTeam(cwd, parsed.name), null, 2)}\n`);
    return 0;
  }
  if (parsed.subcommand === 'integrate') {
    const result = integrateTeam(cwd, parsed.name, parsed.workers);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (parsed.subcommand === 'cleanup') {
    const result = cleanupTeam(cwd, parsed.name);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (parsed.subcommand === 'status') return printStatus(teamStatus(cwd, parsed.name), parsed.options.json);
  if (parsed.subcommand === 'reconcile') return printStatus(reconcileTeam(cwd, parsed.name), parsed.options.json);
  if (parsed.subcommand === 'recover') {
    const result = recoverTeam(cwd, parsed.name);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (parsed.subcommand === 'stop') {
    printStatus(stopTeam(cwd, parsed.name), parsed.options.json);
    return 0;
  }
  if (parsed.subcommand === 'resume') {
    const result = resumeTeam(cwd, parsed.name, { model: parsed.options.model });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  if (parsed.subcommand === 'await') {
    return awaitTeam(cwd, parsed.name, parsed.options.timeoutMs)
      .then((state) => printStatus(state, parsed.options.json));
  }
  if (parsed.options.dryRun) {
    process.stdout.write(`otx team: would start ${parsed.options.workers} independent workers for: ${parsed.task}\n`);
    return 0;
  }

  const runtime = await startTeam({
    cwd,
    task: parsed.task,
    workerCount: parsed.options.workers,
    model: parsed.options.model,
    teamName: parsed.options.name,
    baseRole: parsed.options.role,
    autoPlan: parsed.options.autoPlan !== false,
    plannerTimeoutMs: parsed.options.plannerTimeoutMs,
  });
  process.stdout.write(`otx team started: ${runtime.name}\nstate: ${runtime.stateDir}\n`);
  if (runtime.config.planning_mode === 'fallback') {
    process.stdout.write(`otx team planner fallback: ${runtime.config.planner_fallback}\n`);
  } else {
    process.stdout.write(`planning: ${runtime.config.planning_mode}\n`);
  }
  const leaderArgs = [
    '--no-alt-screen', '--session-id', runtime.config.leader_session_id,
    '-C', runtime.config.cwd, '--sandbox', 'workspace-write', runtime.leaderPrompt,
  ];
  if (parsed.options.model) leaderArgs.unshift('--model', parsed.options.model);
  const result = spawnSync('traex', leaderArgs, { cwd: runtime.config.cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function parseOptions(tokens, options) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--cwd' || token === '-C') options.cwd = requireValue(tokens, ++index, token);
    else if (token === '--model' || token === '-m') options.model = requireValue(tokens, ++index, token);
    else if (token === '--timeout-ms') options.timeoutMs = Number(requireValue(tokens, ++index, token));
    else if (token.startsWith('--timeout-ms=')) options.timeoutMs = Number(token.slice(13));
    else if (token === '--json') options.json = true;
    else if (token === '--after') options.after = requireValue(tokens, ++index, token);
    else if (token.startsWith('--after=')) options.after = token.slice(8);
    else if (token === '--limit') options.limit = Number(requireValue(tokens, ++index, token));
    else if (token.startsWith('--limit=')) options.limit = Number(token.slice(8));
    else throw new Error(`Unknown team option: ${token}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('--timeout-ms must be a positive integer.');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)) {
    throw new Error('--limit must be an integer from 1 to 1000.');
  }
}

function parseMessageAndOptions(tokens, options) {
  const messageParts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      messageParts.push(...tokens.slice(index + 1));
      break;
    }
    if (token === '--cwd' || token === '-C') options.cwd = requireValue(tokens, ++index, token);
    else if (token === '--json') options.json = true;
    else messageParts.push(token);
  }
  return messageParts.join(' ').trim();
}

function parseAssignmentAndOptions(tokens, options) {
  const messageParts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      messageParts.push(...tokens.slice(index + 1));
      break;
    }
    if (token === '--cwd' || token === '-C') options.cwd = requireValue(tokens, ++index, token);
    else if (token === '--depends-on') options.dependsOn = parseDependencyList(requireValue(tokens, ++index, token));
    else if (token.startsWith('--depends-on=')) options.dependsOn = parseDependencyList(token.slice(13));
    else messageParts.push(token);
  }
  return messageParts.join(' ').trim();
}

function parseDependencyList(value) {
  const dependencies = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (dependencies.some((entry) => !/^\d+$/.test(entry))) throw new Error('--depends-on must contain comma-separated task IDs.');
  return [...new Set(dependencies)];
}

function printStatus(state, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return state.workers.some((worker) => ['failed', 'cancelled'].includes(worker.status)) ? 1 : 0;
  }
  process.stdout.write(`Team ${state.config.name}: ${state.config.status}\n`);
  for (const worker of state.workers) {
    const commit = worker.commit && worker.commit !== worker.base_commit ? worker.commit.slice(0, 12) : '-';
    process.stdout.write(`- ${worker.name} [${worker.role}] ${worker.status} pane=${worker.pane_alive ? 'alive' : 'closed'} commit=${commit} dirty=${worker.dirty}\n`);
    if (worker.result_path) process.stdout.write(`  result: ${worker.result_path}\n`);
  }
  return state.workers.some((worker) => ['failed', 'cancelled'].includes(worker.status)) ? 1 : 0;
}

function printTeams(teams, json = false) {
  if (json) process.stdout.write(`${JSON.stringify(teams, null, 2)}\n`);
  else if (teams.length === 0) process.stdout.write('No OTX teams found.\n');
  else for (const team of teams) process.stdout.write(`${team.name}\t${team.status}\t${team.created_at}\t${team.task}\n`);
  return 0;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}
