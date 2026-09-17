import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
const installRoot = mkdtempSync(join(tmpdir(), 'oh-my-traex-pack-check-'));
try {
  const pack = spawnSync('npm', ['pack', '--pack-destination', installRoot], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(tmpdir(), 'oh-my-traex-npm-cache') },
  });
  if (pack.status !== 0) throw new Error(pack.stderr || 'npm pack failed');
  const tarball = join(installRoot, pack.stdout.trim().split('\n').at(-1));
  const install = spawnSync('npm', ['install', '--prefix', installRoot, tarball], {
    encoding: 'utf8', env: { ...process.env, npm_config_cache: join(tmpdir(), 'oh-my-traex-npm-cache') },
  });
  if (install.status !== 0) throw new Error(install.stderr || 'package install failed');
  const binary = join(installRoot, 'node_modules', '.bin', 'otx');
  const help = spawnSync(binary, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr || 'installed otx --help failed');
  assert.match(help.stdout, /oh-my-traex \(otx\)/, 'installed otx binary produced no help output');
  const dryRun = spawnSync(binary, ['run', '--dry-run', 'verify installed package'], { encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr || 'installed otx dry-run failed');
  assert.match(dryRun.stdout, /traex exec/, 'installed otx binary did not execute main');
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
process.stdout.write(`package verified: ${manifest.entryCount} files, ${manifest.size} bytes packed, ${manifest.unpackedSize} bytes unpacked\n`);
