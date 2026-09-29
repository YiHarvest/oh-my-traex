import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    const result = run(process.execPath, [fileURLToPath(new URL('./verification-runner.js', import.meta.url))], {
      cwd, encoding: 'utf8', input: JSON.stringify({ command, cwd, timeoutMs: policy.timeout_ms || 120000 }), maxBuffer: 1024 * 1024,
    });
    let record;
    try { record = JSON.parse(result.stdout); }
    catch { record = { command, exit_code: result.status, error: result.error?.message || result.stderr || 'verification runner failed' }; }
    evidence.commands.push(record);
    if (result.status !== 0 || result.error || record.exit_code !== 0 || record.error) return { ...evidence, error: record.error || 'verification command failed' };
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
