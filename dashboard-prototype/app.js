import { actionAvailability, buildWorkerActionPayload, nextWrappedIndex, parseDependencyIds, summarizeRuntime } from './ui-model.js';

const dashboardToken = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
if (dashboardToken) history.replaceState(null, '', window.location.pathname + window.location.search);

const initialTasks = [
  {
    id: 1, title: 'Implement user authentication', status: 'working', created: '12m ago', model: 'gpt-5.3-codex',
    progress: 68, duration: '12m', tokens: '12.4k', cost: '$0.42',
    agents: [
      { id: 'planner', name: 'Planner', role: 'Architecture', status: 'complete', detail: 'Authentication flow, boundaries, and acceptance criteria.', elapsed: '4m 18s' },
      { id: 'implementer', name: 'Implementer', role: 'Execution', status: 'working', detail: 'Implementing session middleware and login handlers.', elapsed: '6m 42s', selected: true },
      { id: 'reviewer', name: 'Reviewer', role: 'Verification', status: 'working', detail: 'Reviewing security invariants and regression coverage.', elapsed: '2m 09s' }
    ],
    checklist: [
      { title: 'Define authentication boundaries', note: 'Routes, sessions, failure modes', state: 'complete', owner: 'Planner' },
      { title: 'Implement session middleware', note: 'Cookie rotation and expiry', state: 'working', owner: 'Implementer' },
      { title: 'Verify access-control regressions', note: 'Focused security review', state: 'working', owner: 'Reviewer' }
    ],
    activity: [
      { title: 'Planner completed architecture pass', note: 'Task #2 unlocked', time: '8m ago', tone: 'success' },
      { title: 'Implementer changed auth/session.js', note: '+84 −12', time: '5m ago', tone: 'info' },
      { title: 'Reviewer requested one follow-up', note: 'Cookie flags need explicit test', time: '2m ago', tone: 'warning' }
    ],
    logs: [
      ['12:41:04', '$ npm test -- auth/session.test.js', 'command'],
      ['12:41:08', 'PASS 14 tests · 0 failed', 'success'],
      ['12:41:13', 'reviewer: checking SameSite and rotation policy', ''],
      ['12:41:18', 'implementer: writing regression for expired session', ''],
      ['12:41:24', 'orchestrator: dependency graph remains healthy', 'success']
    ]
  },
  {
    id: 2, title: 'Add test coverage', status: 'complete', created: '34m ago', model: 'gpt-5.3-codex',
    progress: 100, duration: '18m', tokens: '9.8k', cost: '$0.31',
    agents: [
      { id: 'planner', name: 'Planner', role: 'Test map', status: 'complete', detail: 'Mapped weak branches and existing fixtures.', elapsed: '3m 12s' },
      { id: 'test-engineer', name: 'Test Engineer', role: 'Execution', status: 'complete', detail: 'Added task claim and cleanup regression coverage.', elapsed: '10m 06s', selected: true },
      { id: 'verifier', name: 'Verifier', role: 'Quality gate', status: 'complete', detail: 'Confirmed deterministic pass on the full suite.', elapsed: '4m 45s' }
    ],
    checklist: [
      { title: 'Map uncovered state transitions', note: 'Claims, leases, cleanup', state: 'complete', owner: 'Planner' },
      { title: 'Add deterministic fixtures', note: 'Cross-process claim tests', state: 'complete', owner: 'Test Engineer' },
      { title: 'Run full test suite', note: '42 tests passed', state: 'complete', owner: 'Verifier' }
    ],
    activity: [
      { title: 'Coverage task completed', note: 'All checks passed', time: '16m ago', tone: 'success' },
      { title: 'Worker commit integrated', note: 'ff1af7e', time: '19m ago', tone: 'success' }
    ],
    logs: [
      ['12:03:22', '$ npm test', 'command'],
      ['12:03:25', 'PASS 42 tests · 0 failed', 'success'],
      ['12:03:26', 'integration: commit range verified', 'success']
    ]
  },
  {
    id: 3, title: 'Optimize database queries', status: 'failed', created: '1h ago', model: 'gpt-5.3-codex',
    progress: 41, duration: '9m', tokens: '6.1k', cost: '$0.20',
    agents: [
      { id: 'planner', name: 'Planner', role: 'Query map', status: 'complete', detail: 'Identified the slow list and aggregation paths.', elapsed: '2m 41s' },
      { id: 'implementer', name: 'Implementer', role: 'Execution', status: 'failed', detail: 'Migration check failed on a conflicting index.', elapsed: '5m 33s', selected: true },
      { id: 'reviewer', name: 'Reviewer', role: 'Verification', status: 'queued', detail: 'Waiting for a corrected migration.', elapsed: '—' }
    ],
    checklist: [
      { title: 'Profile query paths', note: 'List and aggregation endpoints', state: 'complete', owner: 'Planner' },
      { title: 'Add compound index', note: 'Conflict with existing migration', state: 'failed', owner: 'Implementer' },
      { title: 'Run database verification', note: 'Blocked by task #2', state: 'queued', owner: 'Reviewer' }
    ],
    activity: [
      { title: 'Migration command failed', note: 'Index already exists', time: '47m ago', tone: 'error' },
      { title: 'Reviewer moved to blocked', note: 'Waiting on implementation', time: '46m ago', tone: 'warning' }
    ],
    logs: [
      ['11:28:12', '$ npm run db:migrate', 'command'],
      ['11:28:13', 'ERROR index idx_events_created_at already exists', 'error'],
      ['11:28:15', 'orchestrator: task paused for retry', 'warning']
    ]
  }
];

const savedTasks = localStorage.getItem('otx-dashboard-tasks');
const state = {
  tasks: savedTasks ? JSON.parse(savedTasks) : initialTasks,
  selectedTaskId: Number(localStorage.getItem('otx-dashboard-selected')) || 1,
  inspectorTab: 'tasks',
  compact: localStorage.getItem('otx-dashboard-compact') === 'true',
  showCompleted: localStorage.getItem('otx-dashboard-show-completed') !== 'false',
  tick: 0,
  mode: 'mock',
  connected: false,
  liveSnapshot: null,
  selectedWorkerByTeam: {},
  actionMode: 'message'
};

const elements = {
  shell: document.getElementById('app-shell'), taskList: document.getElementById('task-list'),
  taskId: document.getElementById('current-task-id'), taskTitle: document.getElementById('current-task-title'),
  taskStatus: document.getElementById('current-status'), created: document.getElementById('created-time'),
  owner: document.getElementById('current-owner'), model: document.getElementById('current-model'),
  progress: document.getElementById('progress-value'), progressBar: document.getElementById('progress-bar'),
  graph: document.getElementById('dependency-strip'), agents: document.getElementById('child-agent-grid'),
  inspector: document.getElementById('inspector-content'), terminal: document.getElementById('terminal-lines'),
  terminalWorker: document.getElementById('terminal-worker'),
  summaryAgents: document.getElementById('summary-agents'), summaryTokens: document.getElementById('summary-tokens'),
  summaryDuration: document.getElementById('summary-duration'), summaryCost: document.getElementById('summary-cost'),
  modal: document.getElementById('modal-backdrop'), form: document.getElementById('task-form'),
  formError: document.getElementById('form-error'), settings: document.getElementById('settings-panel'),
  density: document.getElementById('density-toggle'), completed: document.getElementById('completed-toggle'),
  toast: document.getElementById('toast-region'), runtimeHud: document.getElementById('runtime-hud'),
  hudTeam: document.getElementById('hud-team'), hudWorkers: document.getElementById('hud-workers'),
  hudState: document.getElementById('hud-state'), hudUpdated: document.getElementById('hud-updated'),
  runtimeState: document.getElementById('runtime-state'), notificationBadge: document.getElementById('notification-badge'),
  messageButton: document.getElementById('message-button'), assignButton: document.getElementById('assign-button'),
  stopButton: document.getElementById('stop-button'), addNodeButton: document.getElementById('add-node-button'), actionBackdrop: document.getElementById('action-backdrop'),
  actionForm: document.getElementById('action-form'), actionEyebrow: document.getElementById('action-eyebrow'),
  actionTitle: document.getElementById('action-title'), actionContext: document.getElementById('action-context'),
  actionTargetLabel: document.getElementById('action-target-label'), actionWorker: document.getElementById('action-worker'), actionDependenciesRow: document.getElementById('action-dependencies-row'),
  actionDependencies: document.getElementById('action-dependencies'), actionMessage: document.getElementById('action-message'),
  actionError: document.getElementById('action-error'), actionSubmit: document.getElementById('action-submit'),
  confirmBackdrop: document.getElementById('confirm-backdrop'), confirmCopy: document.getElementById('confirm-copy'),
  shortcutsBackdrop: document.getElementById('shortcuts-backdrop')
};
elements.connectionLabel = document.getElementById('connection-label');
elements.statusButton = document.getElementById('status-button');
elements.orchestratorStatus = document.getElementById('orchestrator-status');
elements.orchestratorModel = document.getElementById('orchestrator-model');
elements.taskCount = document.getElementById('task-count');
elements.activityCount = document.getElementById('activity-count');

function currentTask() { return state.tasks.find(function (task) { return task.id === state.selectedTaskId; }) || state.tasks[0]; }
function saveState() {
  localStorage.setItem('otx-dashboard-tasks', JSON.stringify(state.tasks));
  localStorage.setItem('otx-dashboard-selected', String(state.selectedTaskId));
  localStorage.setItem('otx-dashboard-compact', String(state.compact));
  localStorage.setItem('otx-dashboard-show-completed', String(state.showCompleted));
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, function (char) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]; }); }
function label(status) { return status === 'complete' ? 'Completed' : status === 'failed' ? 'Failed' : status === 'stalled' ? 'Stalled' : status === 'queued' ? 'Queued' : 'Working'; }
function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

function renderTaskList() {
  const groups = [];
  state.tasks.forEach(function (task) {
    const key = task.liveTeam || 'Local tasks';
    let group = groups.find(function (item) { return item.key === key; });
    if (!group) { group = { key: key, tasks: [] }; groups.push(group); }
    group.tasks.push(task);
  });
  elements.taskList.innerHTML = groups.map(function (group) {
    const team = state.liveSnapshot?.teams?.find(function (item) { return item.config.name === group.key; });
    const badge = team ? team.config.status + ' · ' + team.workers.length : group.tasks.length + ' tasks';
    return '<section class="task-group"><div class="task-group-head"><strong>' + escapeHtml(group.key) + '</strong><span>' + escapeHtml(badge) + '</span></div>'
      + group.tasks.map(renderTaskListItem).join('') + '</section>';
  }).join('');
}

function renderTaskListItem(task) {
  return '<button class="task-list-item ' + (task.id === state.selectedTaskId ? 'active' : '') + '" type="button" data-task-id="' + task.id + '">'
    + '<span class="task-state-dot ' + task.status + '"></span><span class="task-list-copy"><strong>'
    + escapeHtml(task.title) + '</strong><span>#' + escapeHtml(task.liveTaskId || task.id) + ' · ' + label(task.status) + '</span></span></button>';
}

function renderGraph(task) {
  elements.graph.innerHTML = task.agents.map(function (agent) {
    return '<div class="flow-node ' + (agent.status === 'working' ? 'active' : '') + '"><span>'
      + escapeHtml(agent.name) + ' · ' + label(agent.status) + '</span></div>';
  }).join('');
}

function renderAgents(task) {
  const agents = state.showCompleted ? task.agents : task.agents.filter(function (agent) { return agent.status !== 'complete'; });
  elements.agents.innerHTML = agents.map(function (agent) {
    return '<button class="agent-card child-card ' + (agent.selected ? 'selected' : '') + '" type="button" data-agent-id="' + agent.id + '" aria-pressed="' + String(Boolean(agent.selected)) + '">'
      + '<div class="agent-head"><div><div class="eyebrow">' + escapeHtml(agent.role) + '</div><h2>' + escapeHtml(agent.name) + '</h2></div>'
      + '<span class="status-chip ' + agent.status + '">' + (agent.status === 'working' ? '<span class="spinner"></span>' : '') + label(agent.status) + '</span></div>'
      + '<div class="agent-meta"><span>Model <strong>' + escapeHtml(task.model) + '</strong></span></div><p>' + escapeHtml(agent.detail) + '</p>'
      + '<div class="agent-foot"><span>' + escapeHtml((agent.paneId || agent.id) + (agent.taskId ? ' · task:' + agent.taskId : '')) + '</span><span>' + escapeHtml(agent.elapsed) + '</span></div></button>';
  }).join('');
}

function renderInspector(task) {
  const rows = state.inspectorTab === 'tasks' ? task.checklist : task.activity;
  elements.inspector.innerHTML = rows.map(function (row, index) {
    return '<div class="inspector-row"><span class="row-icon">' + (state.inspectorTab === 'tasks' ? index + 1 : 'L') + '</span><div class="row-copy"><strong>'
      + escapeHtml(row.title) + '</strong><p>' + escapeHtml(row.note) + '</p><div class="row-meta"><span>'
      + escapeHtml(row.owner || row.time || '') + '</span><span>' + escapeHtml(row.state || row.tone || '') + '</span></div></div></div>';
  }).join('');
}

function renderTerminal(task) {
  elements.terminal.innerHTML = task.logs.map(function (line) {
    return '<div class="terminal-line"><span class="time">' + line[0] + '</span><span class="' + line[2] + '">' + escapeHtml(line[1]) + '</span></div>';
  }).join('');
  elements.terminal.scrollTop = elements.terminal.scrollHeight;
}

function renderTask() {
  const task = currentTask();
  elements.taskId.textContent = 'Task #' + task.id;
  elements.taskTitle.textContent = task.title;
  elements.taskStatus.className = 'status-chip ' + task.status;
  elements.taskStatus.innerHTML = (task.status === 'working' ? '<span class="spinner"></span>' : '') + label(task.status);
  elements.created.textContent = 'Created ' + task.created;
  elements.owner.textContent = task.owner || (state.mode === 'live' ? task.liveTeam : 'Samuel');
  elements.model.textContent = task.model;
  elements.orchestratorModel.textContent = task.model;
  elements.orchestratorStatus.className = 'status-chip ' + task.status;
  elements.orchestratorStatus.innerHTML = (task.status === 'working' ? '<span class="spinner"></span>' : '') + label(task.status);
  elements.progress.textContent = task.progress + '%';
  elements.progressBar.style.width = task.progress + '%';
  elements.summaryAgents.textContent = String(task.agents.length);
  elements.summaryTokens.textContent = task.tokens;
  elements.summaryDuration.textContent = task.duration;
  elements.summaryCost.textContent = task.cost;
  elements.taskCount.textContent = String(task.checklist.length);
  elements.activityCount.textContent = String(task.activity.length);
  const focused = task.agents.find(function (agent) { return agent.selected; });
  elements.terminalWorker.textContent = focused?.id || task.owner || 'orchestrator';
  if (focused?.logs) task.logs = focused.logs;
  elements.runtimeState.textContent = state.mode === 'live' ? task.teamStatus || label(task.status) : 'Preview';
  renderActionState(task, focused);
  renderHud(task);
  renderGraph(task); renderAgents(task); renderInspector(task); renderTerminal(task); renderTaskList();
  if (window.lucide) window.lucide.createIcons();
}

function renderHud(task) {
  if (state.mode !== 'live' || !state.liveSnapshot) {
    elements.hudTeam.textContent = 'preview';
    elements.hudWorkers.textContent = task.agents.length + ' agents';
    elements.hudState.textContent = label(task.status).toLowerCase();
    elements.hudUpdated.textContent = 'local';
    return;
  }
  const summary = summarizeRuntime(state.liveSnapshot);
  elements.hudTeam.textContent = task.liveTeam ? 'team:' + task.liveTeam : 'team:—';
  elements.hudWorkers.textContent = summary.workers + ' workers';
  elements.hudState.textContent = summary.attention ? summary.attention + ' attention' : summary.running ? summary.running + ' running' : 'idle';
  elements.hudState.className = summary.attention ? 'warning' : '';
  elements.hudUpdated.textContent = 'updated:' + relativeTime(state.liveSnapshot.generated_at);
  elements.notificationBadge.textContent = String(summary.attention);
  elements.notificationBadge.hidden = summary.attention === 0;
}

function renderActionState(task, focused) {
  const live = state.mode === 'live';
  const availability = actionAvailability({ live: live, hasTeam: Boolean(task.liveTeam), focusedWorker: focused, teamStatus: live ? task.teamStatus : task.status });
  elements.messageButton.disabled = !availability.message;
  elements.assignButton.disabled = !availability.assign;
  elements.stopButton.disabled = !availability.stop;
  elements.addNodeButton.disabled = live ? !task.liveTeam || task.agents.length >= 6 || ['stopped', 'cleaned', 'empty'].includes(task.teamStatus) : task.agents.length >= 6;
  elements.messageButton.title = focused ? 'Send a same-session follow-up to ' + focused.id + ' (M)' : 'Select a worker first';
  elements.assignButton.title = focused ? 'Create a durable task for ' + focused.id + ' (A)' : 'Select a worker first';
}

function applyLiveSnapshot(snapshot) {
  state.mode = 'live';
  state.connected = true;
  state.liveSnapshot = snapshot;
  const mapped = snapshot.teams.flatMap(mapLiveTeam);
  if (mapped.length > 0) {
    const selectedExists = mapped.some(function (task) { return task.id === state.selectedTaskId; });
    state.tasks = mapped;
    if (!selectedExists) state.selectedTaskId = mapped[0].id;
  } else state.tasks = [emptyLiveTask(snapshot)];
  updateConnectionBadge('live', snapshot.repo);
  renderTask();
}

function emptyLiveTask(snapshot) {
  return {
    id: 999999,
    liveTeam: null,
    liveTaskId: null,
    title: 'No OTX teams in this repository',
    status: 'complete',
    created: 'now',
    model: '—',
    progress: 0,
    duration: '—',
    tokens: 'live',
    cost: '—',
    agents: [],
    checklist: [{ title: 'Launch a Team', note: 'Use the plus button or Ctrl/Cmd + K', state: 'queued', owner: 'Dashboard' }],
    activity: [{ title: 'Live monitor connected', note: snapshot.repo, time: 'now', tone: 'success' }],
    logs: [[now(), 'monitor: connected; waiting for team state', 'success']],
    owner: 'Dashboard',
  };
}

function mapLiveTeam(team) {
  const tasks = team.tasks.length ? team.tasks : [{ id: '0', subject: team.config.task, status: team.config.status }];
  return tasks.map(function (task) {
    const owner = team.workers.find(function (worker) { return worker.name === task.owner; });
    const preferredWorker = state.selectedWorkerByTeam[team.config.name];
    const selectedWorker = team.workers.some(function (worker) { return worker.name === preferredWorker; })
      ? preferredWorker
      : owner?.name || team.workers[0]?.name;
    state.selectedWorkerByTeam[team.config.name] = selectedWorker;
    const workers = team.workers.map(function (worker) {
      const selected = worker.name === selectedWorker;
      return {
        id: worker.name,
        name: worker.name,
        role: worker.role || 'worker',
        status: worker.health === 'stalled' ? 'stalled' : normalizeLiveStatus(worker.status),
        detail: worker.assignment || worker.error || 'Long-lived TraeX worker',
        elapsed: formatHeartbeat(worker),
        selected: selected,
        health: worker.health,
        paneAlive: worker.pane_alive,
        paneId: worker.pane_id,
        taskId: worker.current_task_id || worker.initial_task_id,
        updatedAt: worker.updated_at,
        logs: worker.terminal_lines?.length
          ? worker.terminal_lines.slice(-40).map(function (line) { return [timeFromIso(worker.updated_at || team.config.created_at), line, classifyLog(line)]; })
          : [[timeFromIso(worker.updated_at || team.config.created_at), 'waiting for worker output', 'warning']],
      };
    });
    const progress = computeLiveProgress(team.tasks);
    const mailbox = owner ? team.mailboxes[owner.name] || [] : [];
    const activity = buildLiveActivity(team, task, mailbox);
    const terminalWorker = team.workers.find(function (worker) { return worker.name === selectedWorker; }) || owner;
    const logs = terminalWorker?.terminal_lines?.length
      ? terminalWorker.terminal_lines.slice(-40).map(function (line) { return [timeFromIso(terminalWorker.updated_at || team.config.created_at), line, classifyLog(line)]; })
      : [[timeFromIso(team.config.updated_at || team.config.created_at), 'waiting for worker output', 'warning']];
    return {
      id: liveTaskId(team.config.name, task.id),
      liveTeam: team.config.name,
      liveTaskId: String(task.id),
      title: String(task.id) === '1' ? team.config.task : task.subject || team.config.task,
      status: owner?.health === 'stalled' && task.status === 'in_progress' ? 'stalled' : normalizeLiveStatus(task.status || team.config.status),
      created: relativeTime(task.created_at || team.config.created_at),
      model: team.config.model || 'TraeX default',
      progress: progress,
      duration: relativeDuration(team.config.created_at),
      tokens: 'live',
      cost: '—',
      agents: workers,
      checklist: team.tasks.map(function (item) {
        return { title: item.subject, note: taskNote(item), state: normalizeLiveStatus(item.status), owner: item.owner || 'unassigned' };
      }),
      activity: activity,
      logs: logs,
      teamStatus: team.config.status,
      owner: owner?.name || null,
      dependsOn: task.depends_on || [],
    };
  });
}

function buildLiveActivity(team, task, mailbox) {
  const entries = [];
  if (task.started_at) entries.push({ title: 'Task claimed by ' + (task.owner || 'worker'), note: 'Version ' + (task.version || 1), time: relativeTime(task.started_at), tone: 'info' });
  if (task.completed_at) entries.push({ title: 'Task ' + task.status, note: task.commit ? task.commit.slice(0, 12) : 'No commit', time: relativeTime(task.completed_at), tone: task.status === 'completed' ? 'success' : 'error' });
  mailbox.slice(-5).forEach(function (message) {
    entries.push({ title: 'Mailbox ' + message.status, note: message.body, time: relativeTime(message.updated_at || message.created_at), tone: message.status === 'failed' ? 'error' : 'info' });
  });
  if (team.config.planner_fallback) entries.push({ title: 'Planner fallback', note: team.config.planner_fallback, time: relativeTime(team.config.created_at), tone: 'warning' });
  return entries.length ? entries : [{ title: 'Team created', note: team.config.planning_mode || 'static plan', time: relativeTime(team.config.created_at), tone: 'success' }];
}

function taskNote(task) {
  const dependency = task.depends_on?.length ? 'depends on ' + task.depends_on.join(', ') : 'no dependencies';
  return dependency + ' · v' + (task.version || 1);
}

function computeLiveProgress(tasks) {
  if (!tasks.length) return 0;
  const score = tasks.reduce(function (sum, task) {
    if (task.status === 'completed') return sum + 1;
    if (task.status === 'in_progress') return sum + 0.62;
    if (task.status === 'blocked') return sum + 0.22;
    return sum;
  }, 0);
  return Math.round(score / tasks.length * 100);
}

function normalizeLiveStatus(status) {
  if (['completed', 'ready', 'integrated', 'cleaned', 'stopped'].includes(status)) return 'complete';
  if (['failed', 'cancelled', 'dead', 'integration_failed'].includes(status)) return 'failed';
  if (status === 'stalled') return 'stalled';
  if (['pending', 'blocked', 'queued', 'starting'].includes(status)) return 'queued';
  return 'working';
}

function liveTaskId(teamName, taskId) {
  let hash = 0;
  const value = teamName + ':' + taskId;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash) + 1000;
}

function formatHeartbeat(worker) {
  if (!worker.heartbeat_age_ms && worker.heartbeat_age_ms !== 0) return worker.pane_alive ? 'connected' : 'offline';
  return Math.round(worker.heartbeat_age_ms / 1000) + 's heartbeat';
}

function relativeTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'recently';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  return Math.round(minutes / 60) + 'h ago';
}

function relativeDuration(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  return minutes < 1 ? '<1m' : minutes + 'm';
}

function timeFromIso(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.valueOf()) ? now() : date.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function classifyLog(line) {
  const text = String(line).toLowerCase();
  if (text.includes('error') || text.includes('failed')) return 'error';
  if (text.includes('pass') || text.includes('completed') || text.includes('success')) return 'success';
  if (text.trim().startsWith('$')) return 'command';
  return '';
}

function updateConnectionBadge(mode, detail) {
  elements.statusButton.classList.remove('connecting', 'disconnected');
  if (mode === 'disconnected') elements.statusButton.classList.add('disconnected');
  if (mode === 'connecting') elements.statusButton.classList.add('connecting');
  elements.connectionLabel.textContent = mode === 'live' ? 'Live Runtime' : mode === 'connecting' ? 'Connecting Live' : 'Mock Fallback';
  elements.statusButton.title = detail || '';
}

async function callAction(payload) {
  const response = await fetch('/api/actions?token=' + encodeURIComponent(dashboardToken), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-otx-token': dashboardToken }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'Dashboard action failed.');
  return result.result;
}

function connectLiveStream() {
  if (!state.connected) updateConnectionBadge('connecting', 'Opening SSE connection');
  const stream = new EventSource('/api/events?token=' + encodeURIComponent(dashboardToken));
  stream.addEventListener('snapshot', function (event) {
    try { applyLiveSnapshot(JSON.parse(event.data)); }
    catch (error) { showToast('Invalid live snapshot: ' + error.message); }
  });
  stream.addEventListener('monitor-error', function (event) {
    const data = JSON.parse(event.data);
    updateConnectionBadge('disconnected', data.error);
    showToast('Monitor error: ' + data.error);
  });
  stream.onerror = function () {
    state.connected = false;
    updateConnectionBadge('disconnected', 'SSE reconnecting; mock state remains available.');
  };
}

function renderSettings() {
  elements.shell.classList.toggle('compact', state.compact);
  elements.density.checked = state.compact;
  elements.completed.checked = state.showCompleted;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.textContent = message; elements.toast.appendChild(toast);
  window.setTimeout(function () { toast.remove(); }, 2800);
}

function openWorkerAction(mode) {
  const task = currentTask();
  const workers = task.agents.filter(function (agent) { return agent.paneAlive !== false; });
  if (state.mode === 'live' && (!task.liveTeam || (mode !== 'add' && workers.length === 0))) {
    showToast('No live worker is available for this action.');
    return;
  }
  state.actionMode = mode;
  elements.actionEyebrow.textContent = mode === 'add' ? 'Team membership' : mode === 'assign' ? 'Durable task' : 'Worker message';
  elements.actionTitle.textContent = mode === 'add' ? 'Add independent worker' : mode === 'assign' ? 'Assign task' : 'Send follow-up';
  elements.actionSubmit.textContent = mode === 'add' ? 'Add worker' : mode === 'assign' ? 'Assign' : 'Send';
  elements.actionTargetLabel.textContent = mode === 'add' ? 'Role' : 'Worker';
  elements.actionDependenciesRow.hidden = mode !== 'assign';
  elements.actionContext.textContent = task.liveTeam
    ? mode === 'add' ? 'Team ' + task.liveTeam + ' · creates a new pane, session, branch, worktree, and initial task.' : 'Team ' + task.liveTeam + ' · messages resume the existing worker session.'
    : 'Preview mode updates local mock state only.';
  elements.actionWorker.innerHTML = mode === 'add'
    ? ['reviewer', 'explorer', 'architect', 'executor', 'test-engineer'].map(function (role) { return '<option value="' + role + '">' + role + '</option>'; }).join('')
    : workers.map(function (worker) {
      return '<option value="' + escapeHtml(worker.id) + '"' + (worker.selected ? ' selected' : '') + '>'
        + escapeHtml(worker.id + ' · ' + worker.role + ' · ' + label(worker.status)) + '</option>';
    }).join('');
  elements.actionMessage.value = mode === 'assign' ? '' : '';
  elements.actionDependencies.value = mode === 'assign' && task.liveTaskId ? task.liveTaskId : '';
  elements.actionError.textContent = '';
  elements.actionBackdrop.hidden = false;
  requestAnimationFrame(function () { elements.actionMessage.focus(); });
}

function closeWorkerAction() {
  elements.actionBackdrop.hidden = true;
  elements.actionError.textContent = '';
}

async function submitWorkerAction(event) {
  event.preventDefault();
  const task = currentTask();
  const worker = elements.actionWorker.value;
  const message = elements.actionMessage.value.trim();
  if (message.length < 3) { elements.actionError.textContent = 'Enter a bounded instruction of at least three characters.'; return; }
  elements.actionSubmit.disabled = true;
  try {
    if (state.mode === 'live') {
      if (state.actionMode === 'add') {
        await callAction(buildWorkerActionPayload({ mode: 'add', team: task.liveTeam, target: worker, message: message, model: task.model }));
      } else if (state.actionMode === 'assign') {
        const dependencies = parseDependencyIds(elements.actionDependencies.value);
        await callAction(buildWorkerActionPayload({ mode: 'assign', team: task.liveTeam, target: worker, message: message, dependencies: dependencies }));
      } else {
        await callAction(buildWorkerActionPayload({ mode: 'message', team: task.liveTeam, target: worker, message: message }));
      }
    } else {
      task.logs.push([now(), worker + ': ' + message, 'command']);
      task.status = 'working';
      saveState(); renderTask();
    }
    closeWorkerAction();
    const outcome = state.actionMode === 'add' ? 'Worker added with role ' : state.actionMode === 'assign' ? 'Task assigned to ' : 'Message queued for ';
    showToast(outcome + worker + '.');
  } catch (error) {
    elements.actionError.textContent = error.message;
  } finally {
    elements.actionSubmit.disabled = false;
  }
}

function openStopConfirmation() {
  const task = currentTask();
  const team = state.liveSnapshot?.teams?.find(function (item) { return item.config.name === task.liveTeam; });
  const activeWorkers = team?.workers.filter(function (worker) { return worker.pane_alive && !['completed', 'failed', 'cancelled'].includes(worker.status); }).length || 0;
  const pendingTasks = team?.tasks.filter(function (item) { return !['completed', 'failed', 'cancelled'].includes(item.status); }).length || 0;
  elements.confirmCopy.textContent = task.liveTeam
    ? 'This stops ' + task.liveTeam + ', closes its Dashboard-owned tmux session, and cancels ' + activeWorkers + ' active workers across ' + pendingTasks + ' unfinished tasks.'
    : 'This stops the current preview task.';
  elements.confirmBackdrop.hidden = false;
  requestAnimationFrame(function () { document.getElementById('confirm-stop-button').focus(); });
}

function closeStopConfirmation() { elements.confirmBackdrop.hidden = true; }

function selectWorker(workerId) {
  const task = currentTask();
  task.agents.forEach(function (item) { item.selected = item.id === workerId; });
  if (task.liveTeam) state.selectedWorkerByTeam[task.liveTeam] = workerId;
  renderTask();
}

function moveSelection(collection, currentIndex, delta, callback) {
  if (!collection.length) return;
  callback(nextWrappedIndex(collection.length, currentIndex, delta));
}

async function setTaskStatus(status, logText) {
  const task = currentTask();
  if (state.mode === 'live') {
    if (!task.liveTeam) { showToast('Launch a Team before sending runtime actions.'); return; }
    try {
      if (status === 'failed') await callAction({ action: 'stop-team', team: task.liveTeam });
      else if (task.owner) await callAction({ action: 'send-message', team: task.liveTeam, worker: task.owner, message: logText });
      else throw new Error('This task has no assigned worker.');
      showToast(status === 'failed' ? 'Team stop requested.' : 'Follow-up queued for ' + task.owner + '.');
    } catch (error) { showToast(error.message); }
    return;
  }
  task.status = status;
  if (status === 'working') task.progress = Math.max(12, Math.min(task.progress, 92));
  if (status === 'complete') task.progress = 100;
  task.logs.push([now(), logText, status === 'failed' ? 'error' : status === 'complete' ? 'success' : 'command']);
  saveState(); renderTask();
}

async function addAgentNode() {
  const task = currentTask();
  if (state.mode === 'live') {
    openWorkerAction('add');
    return;
  }
  if (task.agents.length >= 6) { showToast('Agent limit reached for this task.'); return; }
  const next = task.agents.length + 1;
  task.agents.push({ id: 'worker-' + next, name: 'Verifier ' + (next - 2), role: 'Verification', status: 'queued', detail: 'Waiting for an explicit verification assignment.', elapsed: '—' });
  task.checklist.push({ title: 'Verify output lane ' + next, note: 'New node waiting for task', state: 'queued', owner: 'Verifier ' + (next - 2) });
  task.logs.push([now(), 'orchestrator: added worker-' + next, 'success']);
  saveState(); renderTask(); showToast('worker-' + next + ' added to the graph.');
}

function openTaskModal() { elements.modal.hidden = false; requestAnimationFrame(function () { document.getElementById('task-name').focus(); }); }
function closeTaskModal() { elements.modal.hidden = true; elements.formError.textContent = ''; }

async function createTask(event) {
  event.preventDefault();
  const form = new FormData(elements.form);
  const name = String(form.get('taskName') || '').trim();
  const teamName = String(form.get('teamName') || '').trim();
  const count = Number(form.get('agents'));
  if (name.length < 4) { elements.formError.textContent = 'Use at least four characters for the task name.'; return; }
  if (teamName && !/^[a-z0-9][a-z0-9-]{0,59}$/i.test(teamName)) { elements.formError.textContent = 'Team name may contain letters, numbers, and hyphens.'; return; }
  if (!Number.isInteger(count) || count < 1 || count > 6) { elements.formError.textContent = 'Agent count must be between 1 and 6.'; return; }
  if (state.mode === 'live') {
    try {
      const result = await callAction({ action: 'start-team', team: teamName || undefined, title: name, workers: count, model: String(form.get('model')), auto_plan: form.get('planning') !== 'static' });
      elements.form.reset(); closeTaskModal(); showToast('Team ' + result.team + ' is starting.');
    } catch (error) { elements.formError.textContent = error.message; }
    return;
  }
  const id = Math.max.apply(null, state.tasks.map(function (task) { return task.id; })) + 1;
  const names = ['Planner', 'Implementer', 'Reviewer', 'Verifier', 'Researcher', 'Auditor'];
  const model = String(form.get('model'));
  state.tasks.unshift({
    id: id, title: name, status: 'working', created: 'just now', model: model, progress: 8, duration: '<1m', tokens: '0.4k', cost: '$0.02',
    agents: Array.from({ length: count }, function (_, index) { return { id: index === 0 ? 'planner' : 'worker-' + index, name: names[index], role: index === 0 ? 'Architecture' : index === 1 ? 'Execution' : 'Verification', status: index === 0 ? 'working' : 'queued', detail: index === 0 ? 'Decomposing scope and assigning independent lanes.' : 'Waiting for upstream task assignment.', elapsed: index === 0 ? '4s' : '—', selected: index === 0 }; }),
    checklist: [{ title: 'Plan execution graph', note: 'Define roles and dependencies', state: 'working', owner: 'Planner' }],
    activity: [{ title: 'Task created', note: count + ' agents requested', time: 'just now', tone: 'success' }],
    logs: [[now(), 'orchestrator: launching ' + count + ' agents', 'command']]
  });
  state.selectedTaskId = id; saveState(); elements.form.reset(); closeTaskModal(); renderTask(); showToast('Task #' + id + ' launched.');
}

document.addEventListener('click', function (event) {
  const navItem = event.target.closest('[data-nav]');
  if (navItem) {
    document.querySelectorAll('[data-nav]').forEach(function (item) { item.classList.toggle('active', item === navItem); });
    showToast(navItem.dataset.nav === 'sessions' ? 'Session history is represented by the task timeline.' : 'Task workspace selected.');
    return;
  }
  const taskButton = event.target.closest('[data-task-id]');
  if (taskButton) { state.selectedTaskId = Number(taskButton.dataset.taskId); saveState(); renderTask(); return; }
  const tab = event.target.closest('[data-tab]');
  if (tab) { state.inspectorTab = tab.dataset.tab; document.querySelectorAll('.inspector-tab').forEach(function (button) { button.classList.toggle('active', button === tab); }); renderInspector(currentTask()); return; }
  const agent = event.target.closest('[data-agent-id]');
  if (agent) { selectWorker(agent.dataset.agentId); return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'new-task') openTaskModal();
  if (action === 'close-modal') closeTaskModal();
  if (action === 'add-node') addAgentNode();
  if (action === 'message-worker') openWorkerAction('message');
  if (action === 'assign-worker') openWorkerAction('assign');
  if (action === 'confirm-stop') openStopConfirmation();
  if (action === 'stop-task') { closeStopConfirmation(); setTaskStatus('failed', 'orchestrator: execution stopped by operator'); }
  if (action === 'close-action') closeWorkerAction();
  if (action === 'close-confirm') closeStopConfirmation();
  if (action === 'show-shortcuts') { elements.settings.hidden = true; elements.shortcutsBackdrop.hidden = false; }
  if (action === 'close-shortcuts') elements.shortcutsBackdrop.hidden = true;
  if (action === 'show-settings') elements.settings.hidden = false;
  if (action === 'close-settings') elements.settings.hidden = true;
  if (action === 'toggle-notifications') {
    const summary = summarizeRuntime(state.liveSnapshot);
    const activityTab = document.querySelector('[data-tab="activity"]');
    if (activityTab) activityTab.click();
    showToast(summary.attention ? summary.attention + ' runtime items need attention.' : 'No runtime items need attention.');
  }
});

elements.form.addEventListener('submit', createTask);
elements.actionForm.addEventListener('submit', submitWorkerAction);
document.getElementById('status-button').addEventListener('click', function () {
  if (!state.liveSnapshot) { showToast('Live runtime is not connected.'); return; }
  const summary = summarizeRuntime(state.liveSnapshot);
  showToast(summary.teams + ' teams · ' + summary.running + ' running · ' + summary.workers + ' workers · ' + summary.attention + ' need attention');
});
elements.modal.addEventListener('click', function (event) { if (event.target === elements.modal) closeTaskModal(); });
elements.actionBackdrop.addEventListener('click', function (event) { if (event.target === elements.actionBackdrop) closeWorkerAction(); });
elements.confirmBackdrop.addEventListener('click', function (event) { if (event.target === elements.confirmBackdrop) closeStopConfirmation(); });
elements.shortcutsBackdrop.addEventListener('click', function (event) { if (event.target === elements.shortcutsBackdrop) elements.shortcutsBackdrop.hidden = true; });
elements.density.addEventListener('change', function () { state.compact = elements.density.checked; saveState(); renderSettings(); });
elements.completed.addEventListener('change', function () { state.showCompleted = elements.completed.checked; saveState(); renderAgents(currentTask()); });
document.addEventListener('keydown', function (event) {
  const editing = event.target.matches('input, textarea, select');
  if (event.key === 'Escape') { closeTaskModal(); closeWorkerAction(); closeStopConfirmation(); elements.shortcutsBackdrop.hidden = true; elements.settings.hidden = true; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openTaskModal(); }
  if (editing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === '?') { elements.shortcutsBackdrop.hidden = !elements.shortcutsBackdrop.hidden; return; }
  if (event.key === '1' || event.key === '2') {
    const tab = document.querySelector('[data-tab="' + (event.key === '1' ? 'tasks' : 'activity') + '"]');
    if (tab) tab.click();
    return;
  }
  if (event.key.toLowerCase() === 'm') { openWorkerAction('message'); return; }
  if (event.key.toLowerCase() === 'a') { openWorkerAction('assign'); return; }
  if (event.key.toLowerCase() === 'j' || event.key.toLowerCase() === 'k') {
    const index = state.tasks.findIndex(function (task) { return task.id === state.selectedTaskId; });
    moveSelection(state.tasks, Math.max(0, index), event.key.toLowerCase() === 'j' ? 1 : -1, function (next) {
      state.selectedTaskId = state.tasks[next].id; saveState(); renderTask();
    });
    return;
  }
  if (event.key === '[' || event.key === ']') {
    const workers = currentTask().agents;
    const index = workers.findIndex(function (worker) { return worker.selected; });
    moveSelection(workers, Math.max(0, index), event.key === ']' ? 1 : -1, function (next) { selectWorker(workers[next].id); });
  }
});

window.setInterval(function () {
  const task = currentTask(); if (task.status !== 'working') return;
  state.tick += 1; if (state.tick % 2 === 0 && task.progress < 92) task.progress += 1;
  const messages = ['worker-2: tool output verified', 'orchestrator: heartbeat healthy', 'reviewer: checking changed lines'];
  task.logs.push([now(), messages[state.tick % messages.length], state.tick % 3 === 0 ? 'success' : '']);
  if (task.logs.length > 16) task.logs.splice(0, task.logs.length - 16);
  renderTask();
}, 4200);

window.setInterval(function () {
  if (state.mode === 'live') renderHud(currentTask());
}, 1000);

renderSettings();
if (window.__OTX_LIVE_SNAPSHOT__) applyLiveSnapshot(window.__OTX_LIVE_SNAPSHOT__);
else renderTask();
if (window.lucide) window.lucide.createIcons();
connectLiveStream();
