import { spawn, spawnSync } from 'node:child_process';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { command, cwd, timeoutMs } = JSON.parse(input);
const child = spawn(command, [], { cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', stderr = '', failure = null;
child.stdout?.on('data', (chunk) => { output = (output + chunk).slice(-16000); });
child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });
let cancelled = false;
function terminate(reason) {
  if (cancelled) return;
  cancelled = true;
  failure = reason;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
}
const timer = setTimeout(() => terminate('verification timed out'), timeoutMs);
process.on('message', (message) => { if (message === 'cancel') terminate('verification cancelled'); });
process.on('disconnect', () => terminate('verification parent exited'));
process.on('SIGTERM', () => terminate('verification cancelled'));
child.once('error', (error) => { failure = error.message; });
child.once('close', (exitCode, signal) => {
  clearTimeout(timer);
  process.removeAllListeners('disconnect');
  if (process.connected) process.disconnect();
  process.stdout.write(JSON.stringify({ command, exit_code: exitCode, signal, output, stderr, error: failure }));
});
