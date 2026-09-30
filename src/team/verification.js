import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function verificationPolicy(cwd, commands = [], preparation = []) {
  if (!Array.isArray(commands) || commands.some((command) => typeof command !== 'string' || !command.trim())) {
    throw new Error('verification commands must be non-empty strings');
  }
  if (!Array.isArray(preparation) || preparation.some((command) => typeof command !== 'string' || !command.trim())) throw new Error('invalid preparation commands');
  if (commands.length) return { commands, preparation, timeout_ms: 120000 };
  const path = join(cwd, 'package.json');
  if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).scripts?.test) return { commands: ['npm test'], preparation, timeout_ms: 120000 };
  return { commands: [], preparation, timeout_ms: 120000 };
}

export async function runVerification(cwd, policy, run = spawnSync, { signal } = {}) {
  const head = () => run('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const before = head();
  const evidence = { commit: before.stdout?.trim(), commands: [], passed: false, checked_at: new Date().toISOString() };
  if (before.status !== 0 || !policy?.commands?.length) return { ...evidence, error: 'verification commands are not configured' };
  const preparation = policy.preparation?.length ? policy.preparation
    : existsSync(join(cwd, 'package-lock.json')) && !existsSync(join(cwd, 'node_modules')) ? ['npm ci --no-audit --no-fund'] : [];
  evidence.preparation = [];
  for (const command of preparation) {
    const record = await runCheck(command, cwd, policy.timeout_ms || 120000, signal);
    evidence.preparation.push(record);
    if (record.exit_code !== 0 || record.error) return { ...evidence, error: 'environment preparation failed: ' + (record.error || command) };
  }
  for (const command of policy.commands) {
    const record = await runCheck(command, cwd, policy.timeout_ms || 120000, signal);
    evidence.commands.push(record);
    if (record.exit_code !== 0 || record.error) return { ...evidence, error: record.error || 'verification command failed' };
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

function runCheck(command, cwd, timeoutMs, signal) {
  if (signal?.aborted) return Promise.resolve({ command, exit_code: null, error: 'verification cancelled' });
  return new Promise((resolve) => {
    const runner = spawn(process.execPath, [fileURLToPath(new URL('./verification-runner.js', import.meta.url))],
      { cwd, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let output = '', stderr = '';
    const cancel = () => { if (runner.connected) runner.send('cancel', () => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    runner.stdout.on('data', (chunk) => { output = (output + chunk).slice(-128000); });
    runner.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });
    runner.once('error', (error) => { signal?.removeEventListener('abort', cancel); resolve({ command, exit_code: null, error: error.message }); });
    runner.once('close', () => {
      signal?.removeEventListener('abort', cancel);
      try { resolve(JSON.parse(output)); }
      catch { resolve({ command, exit_code: null, error: stderr || 'verification runner failed' }); }
    });
    runner.stdin.on('error', () => {});
    runner.stdin.end(JSON.stringify({ command, cwd, timeoutMs }));
    if (signal?.aborted) cancel();
  });
}
