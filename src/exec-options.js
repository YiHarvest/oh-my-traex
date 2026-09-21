const ALL_COMMANDS = ['exec', 'resume', 'review'];

export const EXEC_OPTION_SCHEMA = Object.freeze([
  option('help', ['--help', '-h'], 'boolean', ALL_COMMANDS, 'Show this help'),
  option('dryRun', ['--dry-run'], 'boolean', ALL_COMMANDS, 'Print the TraeX command without running'),
  option('json', ['--json'], 'boolean', ALL_COMMANDS, 'Print TraeX events as JSONL'),
  option('model', ['--model', '-m'], 'value', ALL_COMMANDS, 'Forward a model selection to TraeX', '<model>'),
  option('cwd', ['--cwd', '-C'], 'value', ALL_COMMANDS, 'Workspace or repository for the TraeX run', '<directory>'),
  option('ephemeral', ['--ephemeral'], 'boolean', ALL_COMMANDS, 'Do not persist additional session data', undefined, '--ephemeral'),
  option('outputLastMessage', ['--output-last-message', '-o'], 'value', ALL_COMMANDS, 'Save the final response', '<file>', '--output-last-message'),
  option('allowedTool', ['--allowed-tool'], 'value', ALL_COMMANDS, 'Allow a tool (repeatable)', '<tool>', '--allowed-tool'),
  option('disallowedTool', ['--disallowed-tool'], 'value', ALL_COMMANDS, 'Disallow a tool (repeatable)', '<tool>', '--disallowed-tool'),
  option('shellToolTimeout', ['--shell-tool-timeout'], 'value', ALL_COMMANDS, 'Set the shell command timeout', '<duration>', '--shell-tool-timeout'),
  option('enable', ['--enable'], 'value', ALL_COMMANDS, 'Enable a TraeX feature (repeatable)', '<feature>', '--enable'),
  option('disable', ['--disable'], 'value', ALL_COMMANDS, 'Disable a TraeX feature (repeatable)', '<feature>', '--disable'),

  option('workers', ['--workers', '-n'], 'value', ['exec'], 'Maximum active child agents (default: 4)', '<1-6>', undefined, Number),
  option('mode', ['--mode'], 'value', ['exec'], 'conservative | balanced | aggressive', '<mode>'),
  option('readOnly', ['--read-only'], 'boolean', ['exec'], 'Run the lead with a read-only sandbox'),
  option('ui', ['--ui'], 'value', ['exec'], 'none | dashboard', '<mode>'),
  option('profile', ['--profile', '-p'], 'value', ['exec'], 'Forward a TraeX configuration profile', '<profile>', '--profile'),
  option('image', ['--image', '-i'], 'value', ['exec', 'resume'], 'Attach an image (repeatable)', '<file>', '--image'),
  option('addDir', ['--add-dir'], 'value', ['exec'], 'Add a writable directory (repeatable)', '<directory>', '--add-dir'),
  option('outputSchema', ['--output-schema'], 'value', ['exec'], 'Require a JSON response schema', '<file>', '--output-schema'),
  option('color', ['--color'], 'value', ['exec'], 'always | never | auto', '<mode>', '--color'),
  option('oss', ['--oss'], 'boolean', ['exec'], 'Use an OSS provider', undefined, '--oss'),
  option('localProvider', ['--local-provider'], 'value', ['exec'], 'Select the local OSS provider', '<provider>', '--local-provider'),

  option('last', ['--last'], 'boolean', ['resume'], 'Resume the most recent session'),
  option('all', ['--all'], 'boolean', ['resume'], 'Disable current-directory filtering with --last'),

  target('uncommitted', ['--uncommitted'], 'boolean', 'Review staged, unstaged, and untracked changes'),
  target('base', ['--base'], 'value', 'Review changes against a base branch', '<branch>'),
  target('commit', ['--commit'], 'value', 'Review the changes introduced by one commit', '<sha>'),
  option('title', ['--title'], 'value', ['review'], 'Set the commit title displayed in the summary', '<title>', '--title'),
]);

export const OTX_MANAGED_EXEC_OPTIONS = Object.freeze([
  '--permission-mode', '--sandbox', '-s', '--dangerously-bypass-approvals-and-sandbox',
  '-y', '--dangerously-bypass-hook-trust', '--ignore-user-config', '--ignore-rules',
  '--config', '-c', '--session-id', '--cd',
]);

export function parseExecOption(command, args, index, options, currentTarget) {
  const token = args[index];
  const { flag, inlineValue } = splitOption(token);
  if (isManagedExecOption(flag)) throw new Error(`${flag} is managed by OTX and cannot be overridden.`);
  const definition = EXEC_OPTION_SCHEMA.find((entry) => entry.commands.includes(command) && entry.flags.includes(flag));
  if (!definition) return null;
  if (definition.type === 'boolean' && inlineValue !== undefined) throw new Error(`${flag} does not accept a value.`);
  const value = definition.type === 'value'
    ? inlineValue ?? requireValue(args, index + 1, flag)
    : true;
  const nextIndex = definition.type === 'value' && inlineValue === undefined ? index + 1 : index;
  if (definition.target) {
    if (currentTarget) throw new Error('exec review accepts only one of --uncommitted, --base, or --commit.');
    return { index: nextIndex, target: { kind: definition.target, value } };
  }
  if (definition.forward) options.passthrough.push(definition.forward, ...(definition.type === 'value' ? [value] : []));
  else options[definition.key] = definition.parse ? definition.parse(value) : value;
  return { index: nextIndex, target: currentTarget };
}

export function renderExecOptionHelp(command) {
  return EXEC_OPTION_SCHEMA.filter((entry) => entry.commands.includes(command)).map((entry) => {
    const flags = entry.flags.join(', ');
    const label = `${flags}${entry.placeholder ? ` ${entry.placeholder}` : ''}`;
    return `  ${label.padEnd(34)}${entry.description}`;
  }).join('\n');
}

function option(key, flags, type, commands, description, placeholder, forward, parse) {
  return Object.freeze({ key, flags, type, commands, description, placeholder, forward, parse });
}

function target(kind, flags, type, description, placeholder) {
  return Object.freeze({ key: kind, flags, type, commands: ['review'], description, placeholder, target: kind });
}

function splitOption(token) {
  if (!token.startsWith('-') || !token.includes('=')) return { flag: token, inlineValue: undefined };
  const [flag, inlineValue] = token.split(/=(.*)/s, 2);
  if (!inlineValue) throw new Error(`${flag} requires a value.`);
  return { flag, inlineValue };
}

function isManagedExecOption(flag) {
  return OTX_MANAGED_EXEC_OPTIONS.includes(flag);
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}
