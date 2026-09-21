import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function processIdentity(pid, run = spawnSync, platform = process.platform, readFile = readFileSync) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') {
    try {
      const stat = readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
      return fields[19] ? `linux-start-ticks:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  if (platform === 'win32') {
    const result = run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ], { encoding: 'utf8' });
    const started = result.status === 0 ? result.stdout.trim() : '';
    return /^\d+$/.test(started) ? `windows-start-ticks:${started}` : null;
  }
  const result = run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const started = result.status === 0 ? result.stdout.trim() : '';
  return started ? `posix-lstart:${started}` : null;
}

export function processOwnerIsLive(owner, readIdentity = processIdentity) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code !== 'EPERM') return false;
  }
  if (!owner.process_identity) return true;
  const currentIdentity = readIdentity(owner.pid);
  return Boolean(currentIdentity && currentIdentity === owner.process_identity);
}
