import { spawnSync } from 'node:child_process';

export function projectTrustArgs(worktreePath) {
  const quotedPath = JSON.stringify(worktreePath);
  return ['-c', `projects.${quotedPath}.trust_level=\"trusted\"`];
}

export function detectTraeCapabilities(run = spawnSync) {
  const exec = run('traex', ['exec', '--help'], { encoding: 'utf8' });
  const root = run('traex', ['--help'], { encoding: 'utf8' });
  if (exec.error || exec.status !== 0) throw new Error('TraeX exec capability probe failed.');
  const execHelp = `${exec.stdout || ''}\n${exec.stderr || ''}`;
  const rootHelp = `${root.stdout || ''}\n${root.stderr || ''}`;
  const capabilities = {
    json: execHelp.includes('--json'),
    resume: /Commands:[\s\S]*\bresume\b/.test(execHelp),
    sandbox: execHelp.includes('--sandbox'),
    sessionId: execHelp.includes('--session-id'),
    outputLastMessage: execHelp.includes('--output-last-message'),
    projectConfig: execHelp.includes('--config'),
    appServer: /\bapp-server\b/.test(rootHelp),
    remoteAuthToken: rootHelp.includes('--remote-auth-token-env'),
  };
  const missing = ['json', 'resume', 'sandbox', 'sessionId', 'outputLastMessage', 'projectConfig']
    .filter((name) => !capabilities[name]);
  if (missing.length > 0) throw new Error(`TraeX is missing required capabilities: ${missing.join(', ')}`);
  return capabilities;
}

export function buildWorkerExecArgs({ worktreePath, sessionId, resultPath, model, prompt }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', worktreePath,
    ...projectTrustArgs(worktreePath), '--sandbox', 'workspace-write',
    '--session-id', sessionId, '--output-last-message', resultPath];
  if (model) args.push('--model', model);
  args.push(prompt);
  return args;
}

export function buildWorkerResumeArgs({ worktreePath, sessionId, resultPath, model, prompt }) {
  const args = ['exec', 'resume', '--json', ...projectTrustArgs(worktreePath), '--output-last-message', resultPath];
  if (model) args.push('--model', model);
  args.push(sessionId, prompt);
  return args;
}
