export const ROLES = Object.freeze({
  explorer: {
    type: 'explorer',
    access: 'read-only',
    purpose: 'Map files, symbols, dependencies, conventions, and repository facts quickly.',
  },
  architect: {
    type: 'plan',
    access: 'read-only',
    purpose: 'Design boundaries, interfaces, sequencing, and risk controls for complex changes.',
  },
  executor: {
    type: 'worker',
    access: 'write',
    purpose: 'Implement one bounded file or module slice and run focused checks.',
  },
  'test-engineer': {
    type: 'worker',
    access: 'write',
    purpose: 'Add or improve tests in an explicitly owned test scope.',
  },
  reviewer: {
    type: 'default',
    access: 'read-only',
    purpose: 'Review correctness, regressions, security, maintainability, and missing evidence.',
  },
});

export function roleCatalog() {
  return Object.entries(ROLES)
    .map(([name, role]) => `- ${name} (${role.type}, ${role.access}): ${role.purpose}`)
    .join('\n');
}
