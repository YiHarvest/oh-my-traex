import { spawnSync } from 'node:child_process';
export function normalizeOwnedPath(value) {
  if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) throw new Error('unsafe file path');
  let path = value.trim().replaceAll('\\', '/');
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/+$/, '');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error('unsafe file path: ' + value);
  }
  return path;
}
export function inspectWriteOwnership(cwd, base, commit, paths, run = spawnSync) {
  if (!paths?.length) return { enforced: false, passed: true, changed: [], outside: [] };
  const owned = paths.map(normalizeOwnedPath);
  if (!base || !commit) return { enforced: true, passed: false, changed: [], outside: [], error: 'missing commit for ownership check' };
  const result = run('git', ['diff', '--name-only', '--no-renames', '-z', base, commit, '--'], { cwd, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return { enforced: true, passed: false, changed: [], outside: [], error: 'cannot inspect worker diff' };
  const changed = result.stdout.split('\0').filter(Boolean);
  const outside = changed.filter((path) => !owned.some((root) => path === root || path.startsWith(root + '/')));
  return { enforced: true, passed: outside.length === 0, base, commit, changed, outside,
    error: outside.length ? 'changes outside declared file ownership: ' + outside.join(', ') : null };
}
