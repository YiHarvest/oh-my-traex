#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { updateTaskState, updateWorkerState } from './state.js';

const [stateDir, workerName, worktreePath, promptPath, resultPath, sessionId, model = ''] = process.argv.slice(2);
const initialState = JSON.parse(readFileSync(join(stateDir, 'workers', `${workerName}.json`), 'utf8'));
updateWorkerState(stateDir, workerName, { status: 'working', started_at: new Date().toISOString(), pid: process.pid });
updateTaskState(stateDir, String(initialState.index), { status: 'in_progress', started_at: new Date().toISOString() });

const args = ['exec', '--skip-git-repo-check', '-C', worktreePath, '--sandbox', 'workspace-write', '--session-id', sessionId, '--output-last-message', resultPath];
if (model) args.push('--model', model);
args.push(readFileSync(promptPath, 'utf8'));
const child = spawn('traex', args, { cwd: worktreePath, stdio: 'inherit' });
updateWorkerState(stateDir, workerName, { child_pid: child.pid, heartbeat_at: new Date().toISOString() });
const heartbeat = setInterval(() => {
  updateWorkerState(stateDir, workerName, { heartbeat_at: new Date().toISOString() });
}, 5000);
const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once('SIGTERM', () => forwardSignal('SIGTERM'));
process.once('SIGINT', () => forwardSignal('SIGINT'));
const exitCode = await new Promise((resolve) => {
  child.once('error', () => resolve(1));
  child.once('close', (code) => resolve(code ?? 1));
});
clearInterval(heartbeat);

// TraeX's sandbox may commit through temporary Git metadata. Rebuild only the
// real worktree index before evaluating cleanliness; this preserves HEAD and
// working-tree files while eliminating stale index entries.
spawnSync('git', ['reset', '--mixed', 'HEAD'], { cwd: worktreePath, stdio: 'ignore' });
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' });
const commitSha = commit.status === 0 ? commit.stdout.trim() : null;
const committed = Boolean(commitSha && commitSha !== initialState.base_commit);
const clean = dirty.status === 0 && dirty.stdout.trim() === '';
const hasResult = existsSync(resultPath) && statSync(resultPath).size > 0;
const commitSatisfied = initialState.requires_commit ? committed : true;
const finalStatus = exitCode === 0 && commitSatisfied && clean && hasResult ? 'completed' : 'failed';
const currentState = JSON.parse(readFileSync(join(stateDir, 'workers', workerName + '.json'), 'utf8'));
if (currentState.status === 'cancelled') {
  process.stdout.write(`\n[otx] ${workerName} cancelled by leader.\n`);
  process.exitCode = 0;
  process.exit();
}
updateWorkerState(stateDir, workerName, {
  status: finalStatus,
  exit_code: exitCode,
  completed_at: new Date().toISOString(),
  commit: commitSha,
  error: finalStatus === 'failed'
    ? exitCode !== 0
      ? `traex exited ${exitCode}`
      : !commitSatisfied
        ? 'worker produced no commit'
        : !clean
          ? 'worker worktree is dirty after completion'
          : 'worker produced no result'
    : null,
});
updateTaskState(stateDir, String(initialState.index), {
  status: finalStatus,
  completed_at: new Date().toISOString(),
  commit: commitSha,
  result_path: resultPath,
});
process.stdout.write(`\n[otx] ${workerName} ${finalStatus}; waiting for leader shutdown.\n`);
process.exitCode = 0;
setInterval(() => {}, 3_600_000);
