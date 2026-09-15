const MODES = new Set(['conservative', 'balanced', 'aggressive']);

export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'run';
  const options = { workers: 4, mode: 'balanced', cwd: process.cwd(), ui: 'none', passthrough: [] };
  const taskParts = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
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

  return { command, task: taskParts.join(' ').trim(), options };
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}
