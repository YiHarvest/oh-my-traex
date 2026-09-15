import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const ALLOWED_ROLES = new Set(['executor', 'test-engineer', 'reviewer', 'explorer', 'architect']);
const WRITE_ROLES = new Set(['executor', 'test-engineer']);

export async function planTeam({ cwd, task, workerCount, model, timeoutMs = 90_000, launch = spawn }) {
  const temporary = mkdtempSync(join(tmpdir(), 'otx-plan-'));
  const schemaPath = join(temporary, 'schema.json');
  const outputPath = join(temporary, 'plan.json');
  writeFileSync(schemaPath, JSON.stringify(buildPlanSchema(workerCount), null, 2));
  const args = [
    'exec', '--skip-git-repo-check', '-C', cwd, '--sandbox', 'read-only',
    '--output-schema', schemaPath, '--output-last-message', outputPath,
  ];
  if (model) args.push('--model', model);
  args.push(buildPlannerPrompt(task, workerCount));
  try {
    const result = await runPlannerProcess(launch, args, cwd, timeoutMs);
    if (result.code !== 0) throw new Error(String(result.stderr || 'planner failed').trim());
    return validateTeamPlan(JSON.parse(readFileSync(outputPath, 'utf8')), workerCount);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runPlannerProcess(launch, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = launch('traex', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let closed = false;
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2_000).unref?.();
      reject(new Error('planner timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      closed = true;
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

export function validateTeamPlan(plan, workerCount) {
  if (!plan || !Array.isArray(plan.workers) || plan.workers.length !== workerCount) {
    throw new Error('planner must return exactly ' + workerCount + ' workers.');
  }
  const ids = new Set(plan.workers.map((worker) => worker.id));
  if (ids.size !== workerCount) throw new Error('planner worker IDs must be unique.');
  const normalized = plan.workers.map((worker, index) => {
    if (!ALLOWED_ROLES.has(worker.role)) throw new Error('planner returned unsupported role: ' + worker.role);
    if (!worker.assignment?.trim()) throw new Error('planner worker ' + worker.id + ' has no assignment.');
    const dependsOn = [...new Set(worker.depends_on || [])];
    for (const dependency of dependsOn) {
      if (!ids.has(dependency)) throw new Error('planner dependency not found: ' + dependency);
      if (dependency === worker.id) throw new Error('planner worker cannot depend on itself: ' + worker.id);
    }
    if (WRITE_ROLES.has(worker.role) && dependsOn.length > 0) {
      throw new Error('write worker ' + worker.id + ' must be independent; use a read-only review lane for dependencies.');
    }
    const filePaths = [...new Set(worker.file_paths || [])].map(normalizeOwnedPath);
    if (WRITE_ROLES.has(worker.role) && filePaths.length === 0) {
      throw new Error('write worker ' + worker.id + ' must declare at least one file path or directory.');
    }
    return {
      name: 'worker-' + (index + 1),
      index: index + 1,
      planner_id: worker.id,
      role: worker.role,
      assignment: worker.assignment.trim(),
      depends_on_symbols: dependsOn,
      file_paths: filePaths,
      requires_commit: WRITE_ROLES.has(worker.role),
      status: 'starting',
    };
  });
  assertAcyclic(normalized);
  assertNonOverlappingWrites(normalized);
  return { summary: plan.summary?.trim() || '', workers: normalized };
}

function normalizeOwnedPath(value) {
  let normalized = String(value).trim().split('\\').join('/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('planner returned unsafe file path: ' + value);
  }
  return normalized;
}

function assertNonOverlappingWrites(workers) {
  const owners = [];
  for (const worker of workers.filter((candidate) => candidate.requires_commit)) {
    for (const path of worker.file_paths) {
      for (const owner of owners) {
        if (path === owner.path || path.startsWith(owner.path + '/') || owner.path.startsWith(path + '/')) {
          throw new Error('planner write ownership overlaps: ' + owner.worker + ':' + owner.path + ' and ' + worker.planner_id + ':' + path);
        }
      }
      owners.push({ worker: worker.planner_id, path });
    }
  }
}

function buildPlanSchema(workerCount) {
  return {
    type: 'object', additionalProperties: false, required: ['summary', 'workers'],
    properties: {
      summary: { type: 'string' },
      workers: {
        type: 'array', minItems: workerCount, maxItems: workerCount,
        items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'role', 'assignment', 'depends_on', 'file_paths'],
          properties: {
            id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,29}$' },
            role: { type: 'string', enum: [...ALLOWED_ROLES] },
            assignment: { type: 'string', minLength: 1 },
            depends_on: { type: 'array', items: { type: 'string' } },
            file_paths: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
}

function buildPlannerPrompt(task, workerCount) {
  return [
    'Design a ' + workerCount + '-worker execution plan for this repository task:',
    task,
    '',
    'Return only the requested JSON. Assign non-overlapping write ownership.',
    'Executor and test-engineer lanes must have no dependencies.',
    'Dependencies are allowed only for read-only reviewer, explorer, or architect lanes that inspect upstream task records and commits.',
    'Do not invent files; file_paths may be empty when uncertain.',
  ].join('\n');
}

function assertAcyclic(workers) {
  const bySymbol = new Map(workers.map((worker) => [worker.planner_id, worker]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error('planner DAG contains a cycle at ' + id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of bySymbol.get(id).depends_on_symbols) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const worker of workers) visit(worker.planner_id);
}
