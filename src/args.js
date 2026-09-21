const MODES = new Set(['conservative', 'balanced', 'aggressive']);
const TRAE_VALUE_OPTIONS = new Map([
  ['--profile', '--profile'], ['-p', '--profile'],
  ['--image', '--image'], ['-i', '--image'],
  ['--add-dir', '--add-dir'],
  ['--output-schema', '--output-schema'],
  ['--output-last-message', '--output-last-message'], ['-o', '--output-last-message'],
  ['--color', '--color'],
  ['--allowed-tool', '--allowed-tool'],
  ['--disallowed-tool', '--disallowed-tool'],
  ['--shell-tool-timeout', '--shell-tool-timeout'],
  ['--enable', '--enable'], ['--disable', '--disable'],
  ['--local-provider', '--local-provider'],
]);
const TRAE_BOOLEAN_OPTIONS = new Set(['--ephemeral', '--oss']);
const TRAE_RESUME_VALUE_OPTIONS = new Map([
  ['--image', '--image'], ['-i', '--image'],
  ['--output-last-message', '--output-last-message'], ['-o', '--output-last-message'],
  ['--allowed-tool', '--allowed-tool'],
  ['--disallowed-tool', '--disallowed-tool'],
  ['--shell-tool-timeout', '--shell-tool-timeout'],
  ['--enable', '--enable'], ['--disable', '--disable'],
]);
const TRAE_RESUME_BOOLEAN_OPTIONS = new Set(['--ephemeral']);
const TRAE_REVIEW_VALUE_OPTIONS = new Map([
  ['--title', '--title'],
  ['--output-last-message', '--output-last-message'], ['-o', '--output-last-message'],
  ['--allowed-tool', '--allowed-tool'],
  ['--disallowed-tool', '--disallowed-tool'],
  ['--shell-tool-timeout', '--shell-tool-timeout'],
  ['--enable', '--enable'], ['--disable', '--disable'],
]);
const TRAE_REVIEW_BOOLEAN_OPTIONS = new Set(['--ephemeral']);
const OTX_MANAGED_OPTIONS = new Set([
  '--permission-mode', '--sandbox', '-s', '--dangerously-bypass-approvals-and-sandbox',
  '-y', '--dangerously-bypass-hook-trust', '--ignore-user-config', '--ignore-rules',
  '--config', '-c', '--session-id', '--cd',
]);

export function parseArgs(argv) {
  const args = [...argv];
  const requestedCommand = args[0] && !args[0].startsWith('-') ? args.shift() : 'exec';
  const command = requestedCommand === 'run' ? 'exec' : requestedCommand;
  if (command === 'exec' && args[0] === 'resume') {
    args.shift();
    return parseResumeArgs(args);
  }
  if (command === 'exec' && args[0] === 'review') {
    args.shift();
    return parseReviewArgs(args);
  }
  const options = { workers: 4, mode: 'balanced', cwd: process.cwd(), ui: 'none', passthrough: [] };
  const taskParts = [];
  let stdinTask = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-') {
      stdinTask = true;
      continue;
    }
    else if (arg === '--') {
      taskParts.push(...args.slice(index + 1));
      break;
    }
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--workers' || arg === '-n') options.workers = Number(requireValue(args, ++index, arg));
    else if (arg.startsWith('--workers=')) options.workers = Number(arg.slice(10));
    else if (arg === '--mode') options.mode = requireValue(args, ++index, arg);
    else if (arg.startsWith('--mode=')) options.mode = arg.slice(7);
    else if (arg === '--model' || arg === '-m') options.model = requireValue(args, ++index, arg);
    else if (arg === '--cwd' || arg === '-C') options.cwd = requireValue(args, ++index, arg);
    else if (arg === '--read-only') options.readOnly = true;
    else if (arg === '--ui') options.ui = requireValue(args, ++index, arg);
    else if (arg.startsWith('--ui=')) options.ui = arg.slice(5);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (TRAE_BOOLEAN_OPTIONS.has(arg)) options.passthrough.push(arg);
    else if (TRAE_VALUE_OPTIONS.has(arg)) {
      options.passthrough.push(TRAE_VALUE_OPTIONS.get(arg), requireValue(args, ++index, arg));
    }
    else if (arg.startsWith('--') && TRAE_VALUE_OPTIONS.has(arg.split('=', 1)[0]) && arg.includes('=')) {
      const [flag, value] = arg.split(/=(.*)/s, 2);
      if (!value) throw new Error(`${flag} requires a value.`);
      options.passthrough.push(TRAE_VALUE_OPTIONS.get(flag), value);
    }
    else if (OTX_MANAGED_OPTIONS.has(arg) || [...OTX_MANAGED_OPTIONS].some((flag) => arg.startsWith(`${flag}=`))) {
      throw new Error(`${arg.split('=', 1)[0]} is managed by OTX and cannot be overridden.`);
    }
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else taskParts.push(arg);
  }

  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 6) {
    throw new Error('--workers must be an integer from 1 to 6.');
  }
  if (!MODES.has(options.mode)) {
    throw new Error('--mode must be conservative, balanced, or aggressive.');
  }
  if (!['none', 'dashboard'].includes(options.ui)) {
    throw new Error('--ui must be none or dashboard.');
  }

  return { command, task: taskParts.join(' ').trim(), stdinTask, options };
}

export function parseResumeArgs(argv) {
  const args = [...argv];
  const options = { cwd: process.cwd(), passthrough: [] };
  const positionals = [];
  let stdinTask = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-') {
      stdinTask = true;
      continue;
    }
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg === '--last') options.last = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--model' || arg === '-m') options.model = requireValue(args, ++index, arg);
    else if (arg === '--cwd' || arg === '-C') options.cwd = requireValue(args, ++index, arg);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (TRAE_RESUME_BOOLEAN_OPTIONS.has(arg)) options.passthrough.push(arg);
    else if (TRAE_RESUME_VALUE_OPTIONS.has(arg)) {
      options.passthrough.push(TRAE_RESUME_VALUE_OPTIONS.get(arg), requireValue(args, ++index, arg));
    }
    else if (arg.startsWith('--') && TRAE_RESUME_VALUE_OPTIONS.has(arg.split('=', 1)[0]) && arg.includes('=')) {
      const [flag, value] = arg.split(/=(.*)/s, 2);
      if (!value) throw new Error(`${flag} requires a value.`);
      options.passthrough.push(TRAE_RESUME_VALUE_OPTIONS.get(flag), value);
    }
    else if (OTX_MANAGED_OPTIONS.has(arg) || [...OTX_MANAGED_OPTIONS].some((flag) => arg.startsWith(`${flag}=`))) {
      throw new Error(`${arg.split('=', 1)[0]} is managed by OTX and cannot be overridden.`);
    }
    else if (arg.startsWith('-')) throw new Error(`Unknown resume option: ${arg}`);
    else positionals.push(arg);
  }

  const sessionId = options.last ? undefined : positionals.shift();
  if (!options.help && !options.last && !sessionId) {
    throw new Error('exec resume requires a session ID or --last.');
  }
  return { command: 'resume', sessionId, task: positionals.join(' ').trim(), stdinTask, options };
}

export function parseReviewArgs(argv) {
  const args = [...argv];
  const options = { cwd: process.cwd(), passthrough: [] };
  const taskParts = [];
  let stdinTask = false;
  let target;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-') {
      stdinTask = true;
      continue;
    }
    if (arg === '--') {
      taskParts.push(...args.slice(index + 1));
      break;
    }
    if (arg === '--uncommitted') target = setReviewTarget(target, 'uncommitted', true);
    else if (arg === '--base' || arg === '--commit') {
      target = setReviewTarget(target, arg.slice(2), requireValue(args, ++index, arg));
    }
    else if (arg.startsWith('--base=') || arg.startsWith('--commit=')) {
      const [flag, value] = arg.split(/=(.*)/s, 2);
      if (!value) throw new Error(`${flag} requires a value.`);
      target = setReviewTarget(target, flag.slice(2), value);
    }
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--model' || arg === '-m') options.model = requireValue(args, ++index, arg);
    else if (arg === '--cwd' || arg === '-C') options.cwd = requireValue(args, ++index, arg);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (TRAE_REVIEW_BOOLEAN_OPTIONS.has(arg)) options.passthrough.push(arg);
    else if (TRAE_REVIEW_VALUE_OPTIONS.has(arg)) {
      options.passthrough.push(TRAE_REVIEW_VALUE_OPTIONS.get(arg), requireValue(args, ++index, arg));
    }
    else if (arg.startsWith('--') && TRAE_REVIEW_VALUE_OPTIONS.has(arg.split('=', 1)[0]) && arg.includes('=')) {
      const [flag, value] = arg.split(/=(.*)/s, 2);
      if (!value) throw new Error(`${flag} requires a value.`);
      options.passthrough.push(TRAE_REVIEW_VALUE_OPTIONS.get(flag), value);
    }
    else if (OTX_MANAGED_OPTIONS.has(arg) || [...OTX_MANAGED_OPTIONS].some((flag) => arg.startsWith(`${flag}=`))) {
      throw new Error(`${arg.split('=', 1)[0]} is managed by OTX and cannot be overridden.`);
    }
    else if (arg.startsWith('-')) throw new Error(`Unknown review option: ${arg}`);
    else taskParts.push(arg);
  }

  return { command: 'review', target, task: taskParts.join(' ').trim(), stdinTask, options };
}

function setReviewTarget(current, kind, value) {
  if (current) throw new Error('exec review accepts only one of --uncommitted, --base, or --commit.');
  return { kind, value };
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}
