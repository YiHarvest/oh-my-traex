import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function verificationPolicy(cwd, commands = []) {
  if (!Array.isArray(commands) || commands.some((command) => typeof command !== 'string' || !command.trim())) {
    throw new Error('verification commands must be non-empty strings');
  }
  if (commands.length) return { commands, timeout_ms: 120000 };
  const path = join(cwd, 'package.json');
  if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).scripts?.test) return { commands: ['npm test'], timeout_ms: 120000 };
  return { commands: [], timeout_ms: 120000 };
}

export function runVerification(cwd, policy, run = spawnSync) {
  const head = () => run('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const before = head();
  const evidence = { commit: before.stdout?.trim(), commands: [], passed: false, checked_at: new Date().toISOString() };
  if (before.status !== 0 || !policy?.commands?.length) return { ...evidence, error: 'verification commands are not configured' };
  for (const command of policy.commands) {
    const result = run(command, [], { cwd, shell: true, encoding: 'utf8', timeout: policy.timeout_ms || 120000, maxBuffer: 1024 * 1024 });
    evidence.commands.push({ command, exit_code: result.status, signal: result.signal || null,
      output: String(result.stdout || '').slice(-16000), stderr: String(result.stderr || '').slice(-16000), error: result.error?.message || null });
    if (result.status !== 0 || result.error) return { ...evidence, error: 'verification command failed' };
  }
  const after = head();
  const dirty = run('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (after.status !== 0 || after.stdout.trim() !== evidence.commit || dirty.status !== 0 || dirty.stdout.trim()) {
    return { ...evidence, error: 'verification changed the commit or left the worktree dirty' };
  }
  return { ...evidence, passed: true };
}

export function verificationCurrent(evidence, commit, policy) {
  return Boolean(evidence?.passed && evidence.commit === commit && policy?.commands?.length
    && evidence.commands?.length === policy.commands.length
    && evidence.commands.every((entry, index) => entry.command === policy.commands[index] && entry.exit_code === 0 && !entry.error));
}
