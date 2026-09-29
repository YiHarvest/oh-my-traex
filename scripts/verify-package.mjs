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
assert.ok(manifest.unpackedSize < 340_000, `unpacked package is too large: ${manifest.unpackedSize} bytes`);
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
  const doctorHelp = spawnSync(binary, ['doctor', '--help'], { encoding: 'utf8' });
  assert.equal(doctorHelp.status, 0, doctorHelp.stderr || 'installed otx doctor --help failed');
  assert.match(doctorHelp.stdout, /otx doctor \[--live\]/, 'installed package does not expose live doctor');
  assert.match(help.stdout, /otx exec/, 'installed otx help does not expose the canonical exec command');
  const dryRun = spawnSync(binary, [
    'exec', '--dry-run', '--ephemeral', '--allowed-tool', 'shell', 'verify installed package',
  ], { encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr || 'installed otx dry-run failed');
  assert.match(dryRun.stdout, /traex exec/, 'installed otx binary did not execute main');
  assert.match(dryRun.stdout, /--ephemeral --allowed-tool shell/, 'installed otx binary did not forward native exec options');
  const piped = spawnSync(binary, ['exec', '--dry-run'], { encoding: 'utf8', input: 'verify piped package input' });
  assert.equal(piped.status, 0, piped.stderr || 'installed otx piped dry-run failed');
  assert.match(piped.stdout, /verify piped package input/, 'installed otx binary did not read stdin task input');
  const resume = spawnSync(binary, [
    'exec', 'resume', '--last', '--dry-run', '--allowed-tool', 'shell', 'verify installed resume',
  ], { encoding: 'utf8' });
  assert.equal(resume.status, 0, resume.stderr || 'installed otx resume dry-run failed');
  assert.match(resume.stdout, /traex exec resume/, 'installed otx binary did not expose exec resume');
  assert.match(resume.stdout, /--permission-mode custom/, 'installed otx resume lost the permission contract');
  assert.match(resume.stdout, /--last/, 'installed otx resume did not select the latest session');
  const review = spawnSync(binary, [
    'exec', 'review', '--base', 'main', '--dry-run', '--output-last-message', 'review.txt',
  ], { encoding: 'utf8' });
  assert.equal(review.status, 0, review.stderr || 'installed otx review dry-run failed');
  assert.match(review.stdout, /traex exec review/, 'installed otx binary did not expose exec review');
  assert.match(review.stdout, /--permission-mode custom/, 'installed otx review lost the permission contract');
  assert.match(review.stdout, /--base main/, 'installed otx review did not preserve the review target');
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
process.stdout.write(`package verified: ${manifest.entryCount} files, ${manifest.size} bytes packed, ${manifest.unpackedSize} bytes unpacked\n`);
