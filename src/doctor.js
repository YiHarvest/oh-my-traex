import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { permissionArgs, TRAE_PLANNER_SANDBOX } from './team/trae.js';

export const LIVE_DOCTOR_REPLY = 'OTX-LIVE-OK';

export function parseDoctorArgs(argv) {
  const options = { cwd: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--live') options.live = true;
    else if (token === '--cwd' || token === '-C') options.cwd = requireValue(argv, ++index, token);
    else if (token === '--model' || token === '-m') options.model = requireValue(argv, ++index, token);
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`Unknown doctor option: ${token}`);
  }
  return options;
}

export function runLiveExecCheck({ cwd, model, ephemeral = false, run = spawnSync }) {
  const workspace = resolve(cwd);
  accessSync(workspace, constants.R_OK);
  const tempRoot = mkdtempSync(join(tmpdir(), 'otx-live-doctor-'));
  const outputPath = join(tempRoot, 'last-message.txt');
  try {
    const args = [
      'exec', '--skip-git-repo-check', '-C', workspace,
      ...permissionArgs(TRAE_PLANNER_SANDBOX),
    ];
    if (ephemeral) args.push('--ephemeral');
    args.push('--output-last-message', outputPath);
    if (model) args.push('--model', model);
    args.push(`Reply with exactly ${LIVE_DOCTOR_REPLY}. Do not use tools.`);

    const result = run('traex', args, {
      cwd: workspace, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      return { ok: false, detail: commandFailure(result), args };
    }
    const reply = (existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : result.stdout || '').trim();
    if (reply !== LIVE_DOCTOR_REPLY) {
      return { ok: false, detail: `unexpected reply: ${summarize(reply || 'empty output')}`, args };
    }
    return { ok: true, detail: `${LIVE_DOCTOR_REPLY}${ephemeral ? ', ephemeral' : ''}`, args };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function commandFailure(result) {
  if (result.error?.code === 'ETIMEDOUT') return 'timed out after 120s';
  return summarize(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`);
}

function summarize(value) {
  return String(value).trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 240) || 'unknown error';
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}
