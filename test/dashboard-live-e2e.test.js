import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

test('live dashboard enforces token, origin, and browser security headers', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'otx-dashboard-e2e-'));
  const token = 'e2e-dashboard-secret';
  let child;
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
    child = spawn(process.execPath, ['dashboard-prototype/live-server.js', '--repo', repo, '--port', '0', '--poll-ms', '10000'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, OTX_DASHBOARD_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const baseUrl = await readDashboardUrl(child);

    const unauthorized = await fetch(`${baseUrl}/api/health`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${baseUrl}/api/health?token=${token}`);
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).ok, true);
    const forgedOrigin = await fetch(`${baseUrl}/api/actions?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.invalid' },
      body: JSON.stringify({ action: 'stop-team', team: 'demo' }),
    });
    assert.equal(forgedOrigin.status, 403);
    const page = await fetch(baseUrl);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
  } finally {
    if (child && !child.killed) child.kill('SIGTERM');
    rmSync(repo, { recursive: true, force: true });
  }
});

function readDashboardUrl(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`dashboard startup timed out: ${stderr}`)), 5000);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(new RegExp('live dashboard: (http://127\\.0\\.0\\.1:[0-9]+)/#token='));
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      if (!stdout.includes('live dashboard:')) { clearTimeout(timeout); reject(new Error(stderr || `dashboard exited ${code}`)); }
    });
  });
}
