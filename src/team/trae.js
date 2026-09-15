export function projectTrustArgs(worktreePath) {
  const quotedPath = JSON.stringify(worktreePath);
  return ['-c', `projects.${quotedPath}.trust_level=\"trusted\"`];
}
