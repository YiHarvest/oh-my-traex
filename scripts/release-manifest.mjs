import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const requestedTag = process.argv[2] || process.env.GITHUB_REF_NAME || '';

assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'package version must be valid semver');
assert.equal(pkg.publishConfig?.access, 'public', 'release package must be public');
assert.equal(pkg.publishConfig?.provenance, true, 'release package must publish provenance');
assert.equal(pkg.bin?.otx, 'src/cli.js', 'release package must expose the otx binary');
assert.ok(pkg.files?.includes('src/'), 'release package must include runtime sources');
assert.ok(pkg.files?.includes('README.md') && pkg.files?.includes('LICENSE'), 'release package must include docs and license');

if (requestedTag) assert.equal(requestedTag, `v${pkg.version}`, `tag ${requestedTag} does not match package version ${pkg.version}`);

const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
if (pack.status !== 0) throw new Error(pack.stderr || 'npm pack --dry-run failed');
const parsed = JSON.parse(pack.stdout);
const manifest = Array.isArray(parsed) ? parsed[0] : parsed[pkg.name];
assert.ok(manifest, 'npm pack did not produce a manifest');
assert.equal(manifest.name, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.ok(manifest.files.some((file) => file.path === pkg.bin.otx), 'packed tarball is missing the otx binary');

process.stdout.write(`${JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  tag: `v${manifest.version}`,
  files: manifest.entryCount,
  packed_bytes: manifest.size,
  unpacked_bytes: manifest.unpackedSize,
}, null, 2)}\n`);
