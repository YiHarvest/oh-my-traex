import { parseExecOption } from './exec-options.js';

const MODES = new Set(['conservative', 'balanced', 'aggressive']);

export function parseArgs(argv) {
  const args = [...argv];
  const requestedCommand = args[0] && !args[0].startsWith('-') ? args.shift() : 'exec';
  const command = requestedCommand === 'run' ? 'exec' : requestedCommand;
  if (command === 'exec' && args[0] === 'resume') {
    args.shift();
    return parseExecCommand('resume', args);
  }
  if (command === 'exec' && args[0] === 'review') {
    args.shift();
    return parseExecCommand('review', args);
  }
  return parseExecCommand(command, args, command === 'prompt' ? 'exec' : command);
}

export function parseResumeArgs(argv) {
  return parseExecCommand('resume', argv);
}

export function parseReviewArgs(argv) {
  return parseExecCommand('review', argv);
}

function parseExecCommand(command, argv, schemaCommand = command) {
  const options = schemaCommand === 'exec'
    ? { workers: 4, mode: 'balanced', cwd: process.cwd(), ui: 'none', passthrough: [] }
    : { cwd: process.cwd(), passthrough: [] };
  const positionals = [];
  let stdinTask = false;
  let target;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-') {
      stdinTask = true;
      continue;
    }
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('-')) {
      const parsed = parseExecOption(schemaCommand, argv, index, options, target);
      if (!parsed) throw new Error(`Unknown ${command === 'exec' ? '' : `${command} `}option: ${arg}`);
      index = parsed.index;
      target = parsed.target;
      continue;
    }
    positionals.push(arg);
  }

  if (schemaCommand === 'exec') {
    validateExecOptions(options);
    return { command, task: positionals.join(' ').trim(), stdinTask, options };
  }
  if (command === 'resume') {
    const sessionId = options.last ? undefined : positionals.shift();
    if (!options.help && !options.last && !sessionId) throw new Error('exec resume requires a session ID or --last.');
    return { command, sessionId, task: positionals.join(' ').trim(), stdinTask, options };
  }
  return { command, target, task: positionals.join(' ').trim(), stdinTask, options };
}

function validateExecOptions(options) {
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 6) {
    throw new Error('--workers must be an integer from 1 to 6.');
  }
  if (!MODES.has(options.mode)) throw new Error('--mode must be conservative, balanced, or aggressive.');
  if (!['none', 'dashboard'].includes(options.ui)) throw new Error('--ui must be none or dashboard.');
}
