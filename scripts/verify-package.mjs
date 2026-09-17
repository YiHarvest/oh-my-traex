import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  env: { ...process.env, npm_config_cache: join(tmpdir(), 'oh-my-traex-npm-cache') },
});
if (result.status !== 0) throw new Error(result.stderr || 'npm pack --dry-run failed');
const parsed = JSON.parse(result.stdout);
const manifest = Array.isArray(parsed) ? parsed[0] : parsed['oh-my-traex'];
assert.ok(manifest, 'npm pack did not return an oh-my-traex manifest');
const paths = manifest.files.map((file) => file.path);
for (const required of ['src/cli.js', 'src/team/runtime.js', 'dashboard-prototype/live-server.js', 'README.md', 'LICENSE']) {
  assert.ok(paths.includes(required), `package is missing ${required}`);
}
for (const excludedPrefix of ['test/', 'assets/', 'docs/', '.github/']) {
  assert.equal(paths.some((path) => path.startsWith(excludedPrefix)), false, `package contains ${excludedPrefix}`);
}
assert.ok(manifest.unpackedSize < 300_000, `unpacked package is too large: ${manifest.unpackedSize} bytes`);
process.stdout.write(`package verified: ${manifest.entryCount} files, ${manifest.size} bytes packed, ${manifest.unpackedSize} bytes unpacked\n`);
