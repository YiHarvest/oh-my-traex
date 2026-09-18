import { spawn, spawnSync } from 'node:child_process';

export function createMuxAdapter({ backend = 'tmux', run = spawnSync, spawnProcess = spawn, leaderPaneId } = {}) {
  if (backend === 'tmux') return new TmuxAdapter(run, leaderPaneId);
  if (backend === 'headless') return new HeadlessAdapter(spawnProcess);
  throw new Error(`unsupported mux backend: ${backend}`);
}

export function inspectRuntimeOwnership(run, owner, config) {
  return createMuxAdapter({ backend: config.mux_backend || 'tmux', run }).inspect(owner, config);
}

export function terminateOwnedRuntime(run, owner, config) {
  const adapter = createMuxAdapter({ backend: config.mux_backend || 'tmux', run });
  if (adapter.inspect(owner, config) !== 'owned') return false;
  adapter.terminate(owner);
  return true;
}

class TmuxAdapter {
  constructor(run, leaderPaneId) {
    this.backend = 'tmux';
    this.run = run;
    this.leaderPaneId = leaderPaneId;
  }

  prepareLeader(config) {
    this.#tmux(['set-option', '-p', '-t', this.leaderPaneId, '@otx_team', config.name]);
    this.#tmux(['set-option', '-p', '-t', this.leaderPaneId, '@otx_worker', 'leader']);
    this.#tmux(['set-option', '-p', '-t', this.leaderPaneId, '@otx_run_id', config.run_id]);
  }

  launchWorker({ cwd, command, args, worker, config }) {
    const split = this.run('tmux', [
      'split-window', worker.index === 1 ? '-h' : '-v', '-d', '-P', '-F', '#{pane_id}',
      '-t', this.leaderPaneId, '-c', cwd, shellJoin([command, ...args]),
    ], { cwd, encoding: 'utf8' });
    const paneId = this.#paneId(split, 'worker');
    this.#own(paneId, worker.name, config);
    this.run('tmux', ['select-pane', '-t', paneId, '-T', `${worker.name} [${worker.role}]`], { encoding: 'utf8' });
    return { id: paneId, pid: this.#panePid(paneId) };
  }

  launchSupervisor({ cwd, command, args, config }) {
    const created = this.run('tmux', [
      'new-window', '-d', '-P', '-F', '#{pane_id}', '-n', `otx-${config.name}-supervisor`,
      '-c', cwd, shellJoin([command, ...args]),
    ], { cwd, encoding: 'utf8' });
    const paneId = this.#paneId(created, 'supervisor');
    this.#own(paneId, 'supervisor', config);
    return { id: paneId, pid: this.#panePid(paneId) };
  }

  inspect(owner, config) {
    if (!owner.pane_id?.startsWith('%')) return 'missing';
    const result = this.run('tmux', ['display-message', '-p', '-t', owner.pane_id, '#{@otx_team}\t#{@otx_worker}\t#{@otx_run_id}\t#{pane_pid}\t#{pane_dead}'], { encoding: 'utf8' });
    if (result.status !== 0) return 'missing';
    const [team, worker, runId, panePid, dead] = result.stdout.trim().split('\t');
    return team === config.name && worker === owner.name && runId === config.run_id
      && Number(panePid) === owner.pane_pid && dead === '0' ? 'owned' : 'mismatch';
  }

  terminate(owner) {
    this.run('tmux', ['kill-pane', '-t', owner.pane_id], { encoding: 'utf8' });
  }

  layout() {
    this.run('tmux', ['select-layout', '-t', this.leaderPaneId, 'main-vertical'], { encoding: 'utf8' });
  }

  #own(paneId, owner, config) {
    this.#tmux(['set-option', '-p', '-t', paneId, '@otx_team', config.name]);
    this.#tmux(['set-option', '-p', '-t', paneId, '@otx_worker', owner]);
    this.#tmux(['set-option', '-p', '-t', paneId, '@otx_run_id', config.run_id]);
  }

  #paneId(result, kind) {
    if (result.status !== 0) throw new Error(String(result.stderr || `failed to create ${kind} pane`).trim());
    const paneId = result.stdout.trim().split('\n')[0];
    if (!paneId.startsWith('%')) throw new Error(`tmux did not return a ${kind} pane ID.`);
    return paneId;
  }

  #panePid(paneId) {
    const result = this.run('tmux', ['display-message', '-p', '-t', paneId, '#{pane_pid}'], { encoding: 'utf8' });
    const pid = Number(result.stdout?.trim());
    if (result.status !== 0 || !Number.isInteger(pid)) throw new Error(`failed to read pane PID for ${paneId}`);
    return pid;
  }

  #tmux(args) {
    const result = this.run('tmux', args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(String(result.error?.message || result.stderr || 'tmux failed').trim());
  }
}

class HeadlessAdapter {
  constructor(spawnProcess) {
    this.backend = 'headless';
    this.spawnProcess = spawnProcess;
  }

  prepareLeader() {}

  launchWorker({ cwd, command, args }) {
    return this.#launch(cwd, command, args);
  }

  launchSupervisor({ cwd, command, args }) {
    return this.#launch(cwd, command, args);
  }

  inspect(owner) {
    const pid = Number(String(owner.pane_id || '').replace('process:', ''));
    if (!Number.isInteger(pid) || pid !== owner.pane_pid) return 'missing';
    if (owner.pid && owner.pid !== pid) return 'mismatch';
    try { process.kill(pid, 0); return 'owned'; } catch { return 'missing'; }
  }

  terminate(owner) {
    try { process.kill(owner.pane_pid, 'SIGTERM'); } catch {}
  }

  layout() {}

  #launch(cwd, command, args) {
    const child = this.spawnProcess(command, args, { cwd, detached: true, stdio: 'ignore' });
    if (!child.pid) throw new Error('failed to start headless runtime process');
    child.unref();
    return { id: `process:${child.pid}`, pid: child.pid };
  }
}

function shellJoin(parts) {
  return parts.map((value) => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ');
}
