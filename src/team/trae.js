import { spawnSync } from 'node:child_process';

export const TRAE_PERMISSION_MODE = 'custom';
export const TRAE_APPROVAL_POLICY = 'never';
export const TRAE_WORKER_SANDBOX = 'workspace-write';
export const TRAE_PLANNER_SANDBOX = 'read-only';
export const REQUIRED_TRAE_CAPABILITIES = Object.freeze([
  'json', 'resume', 'sandbox', 'permissionMode', 'sessionId', 'outputLastMessage', 'projectConfig',
  'resumeJson', 'resumePermissionMode', 'resumeOutputLastMessage', 'resumeProjectConfig',
]);

export function projectTrustArgs(worktreePath) {
  const quotedPath = JSON.stringify(worktreePath);
  return ['-c', `projects.${quotedPath}.trust_level=\"trusted\"`];
}

export function detectTraeCapabilities(run = spawnSync) {
  const exec = run('traex', ['exec', '--help'], { encoding: 'utf8' });
  const resume = run('traex', ['exec', 'resume', '--help'], { encoding: 'utf8' });
  const root = run('traex', ['--help'], { encoding: 'utf8' });
  if (exec.error || exec.status !== 0) throw new Error('TraeX exec capability probe failed.');
  if (resume.error || resume.status !== 0) throw new Error('TraeX exec resume capability probe failed.');
  const execHelp = `${exec.stdout || ''}\n${exec.stderr || ''}`;
  const resumeHelp = `${resume.stdout || ''}\n${resume.stderr || ''}`;
  const rootHelp = `${root.stdout || ''}\n${root.stderr || ''}`;
  const capabilities = {
    json: execHelp.includes('--json'),
    resume: /Commands:[\s\S]*\bresume\b/.test(execHelp),
    sandbox: execHelp.includes('--sandbox'),
    permissionMode: execHelp.includes('--permission-mode'),
    sessionId: execHelp.includes('--session-id'),
    outputLastMessage: execHelp.includes('--output-last-message'),
    projectConfig: execHelp.includes('--config'),
    ephemeral: execHelp.includes('--ephemeral'),
    resumeJson: resumeHelp.includes('--json'),
    resumePermissionMode: resumeHelp.includes('--permission-mode'),
    resumeOutputLastMessage: resumeHelp.includes('--output-last-message'),
    resumeProjectConfig: resumeHelp.includes('--config'),
    appServer: /\bapp-server\b/.test(rootHelp),
    remoteAuthToken: rootHelp.includes('--remote-auth-token-env'),
  };
  const missing = REQUIRED_TRAE_CAPABILITIES.filter((name) => !capabilities[name]);
  if (missing.length > 0) throw new Error(`TraeX is missing required capabilities: ${missing.join(', ')}`);
  return capabilities;
}

export function permissionArgs(sandbox) {
  const args = [
    '--permission-mode', TRAE_PERMISSION_MODE,
    '-c', `approval_policy="${TRAE_APPROVAL_POLICY}"`,
  ];
  if (sandbox) args.push('--sandbox', sandbox);
  return args;
}

export function buildWorkerExecArgs({ worktreePath, sessionId, resultPath, model, prompt }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', worktreePath,
    ...projectTrustArgs(worktreePath), ...permissionArgs(TRAE_WORKER_SANDBOX),
    '--session-id', sessionId, '--output-last-message', resultPath];
  if (model) args.push('--model', model);
  args.push(prompt);
  return args;
}

export function buildWorkerResumeArgs({ worktreePath, sessionId, resultPath, model, prompt }) {
  const args = [
    'exec', 'resume', '--json', ...projectTrustArgs(worktreePath),
    ...permissionArgs(), '--output-last-message', resultPath,
  ];
  if (model) args.push('--model', model);
  args.push(sessionId, prompt);
  return args;
}
