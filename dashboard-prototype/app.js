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
  liveSnapshot: null
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
  toast: document.getElementById('toast-region')
};
elements.connectionLabel = document.getElementById('connection-label');
elements.statusButton = document.getElementById('status-button');
elements.orchestratorStatus = document.getElementById('orchestrator-status');
elements.orchestratorModel = document.getElementById('orchestrator-model');

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
  elements.taskList.innerHTML = state.tasks.map(function (task) {
    return '<button class="task-list-item ' + (task.id === state.selectedTaskId ? 'active' : '') + '" type="button" data-task-id="' + task.id + '">'
      + '<span class="task-state-dot ' + task.status + '"></span><span class="task-list-copy"><strong>'
      + escapeHtml(task.title) + '</strong><span>#' + task.id + ' · ' + label(task.status) + '</span></span></button>';
  }).join('');
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
    return '<article class="agent-card child-card ' + (agent.selected ? 'selected' : '') + '" data-agent-id="' + agent.id + '">'
      + '<div class="agent-head"><div><div class="eyebrow">' + escapeHtml(agent.role) + '</div><h2>' + escapeHtml(agent.name) + '</h2></div>'
      + '<span class="status-chip ' + agent.status + '">' + (agent.status === 'working' ? '<span class="spinner"></span>' : '') + label(agent.status) + '</span></div>'
      + '<div class="agent-meta"><span>Model <strong>' + escapeHtml(task.model) + '</strong></span></div><p>' + escapeHtml(agent.detail) + '</p>'
      + '<div class="agent-foot"><span>' + escapeHtml(agent.id) + '</span><span>' + escapeHtml(agent.elapsed) + '</span></div></article>';
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
  elements.terminalWorker.textContent = task.owner || task.agents.find(function (agent) { return agent.selected; })?.id || 'orchestrator';
  renderGraph(task); renderAgents(task); renderInspector(task); renderTerminal(task); renderTaskList();
  if (window.lucide) window.lucide.createIcons();
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
    const workers = team.workers.map(function (worker) {
      const selected = worker.name === task.owner;
      return {
        id: worker.name,
        name: worker.name,
        role: worker.role || 'worker',
        status: worker.health === 'stalled' ? 'stalled' : normalizeLiveStatus(worker.status),
        detail: worker.assignment || worker.error || 'Long-lived TraeX worker',
        elapsed: formatHeartbeat(worker),
        selected: selected,
        health: worker.health,
      };
    });
    const progress = computeLiveProgress(team.tasks);
    const mailbox = owner ? team.mailboxes[owner.name] || [] : [];
    const activity = buildLiveActivity(team, task, mailbox);
    const logs = owner?.terminal_lines?.length
      ? owner.terminal_lines.slice(-14).map(function (line) { return [timeFromIso(team.config.updated_at || team.config.created_at), line, classifyLog(line)]; })
      : [[timeFromIso(team.config.updated_at || team.config.created_at), 'waiting for worker output', 'warning']];
    return {
      id: liveTaskId(team.config.name, task.id),
      liveTeam: team.config.name,
      liveTaskId: String(task.id),
      title: String(task.id) === '1' ? team.config.task : task.subject || team.config.task,
      status: normalizeLiveStatus(task.status || team.config.status),
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
  const response = await fetch('/api/actions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'Dashboard action failed.');
  return result.result;
}

function connectLiveStream() {
  if (!state.connected) updateConnectionBadge('connecting', 'Opening SSE connection');
  const stream = new EventSource('/api/events');
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
    if (!task.liveTeam) { showToast('Launch a Team before adding a worker.'); return; }
    try {
      await callAction({ action: 'add-worker', team: task.liveTeam, role: 'reviewer', assignment: 'Review the current task result and report evidence without changing files.' });
      showToast('Verifier worker requested.');
    } catch (error) { showToast(error.message); }
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
  const count = Number(form.get('agents'));
  if (name.length < 4) { elements.formError.textContent = 'Use at least four characters for the task name.'; return; }
  if (!Number.isInteger(count) || count < 1 || count > 6) { elements.formError.textContent = 'Agent count must be between 1 and 6.'; return; }
  if (state.mode === 'live') {
    try {
      const result = await callAction({ action: 'start-team', title: name, workers: count, model: String(form.get('model')), auto_plan: true });
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
  if (agent) { currentTask().agents.forEach(function (item) { item.selected = item.id === agent.dataset.agentId; }); renderAgents(currentTask()); showToast(agent.dataset.agentId + ' selected.'); return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'new-task') openTaskModal();
  if (action === 'close-modal') closeTaskModal();
  if (action === 'add-node') addAgentNode();
  if (action === 'run-task') setTaskStatus('working', 'orchestrator: execution resumed');
  if (action === 'stop-task') setTaskStatus('failed', 'orchestrator: execution stopped by operator');
  if (action === 'retry-task') { currentTask().progress = Math.max(16, currentTask().progress - 12); setTaskStatus('working', 'orchestrator: retrying failed nodes'); }
  if (action === 'show-settings') elements.settings.hidden = false;
  if (action === 'close-settings') elements.settings.hidden = true;
  if (action === 'toggle-notifications') showToast('Two agent updates are waiting in Activity.');
});

elements.form.addEventListener('submit', createTask);
document.getElementById('status-button').addEventListener('click', function () { showToast('All runtimes, claims, and mailboxes are healthy.'); });
elements.modal.addEventListener('click', function (event) { if (event.target === elements.modal) closeTaskModal(); });
elements.density.addEventListener('change', function () { state.compact = elements.density.checked; saveState(); renderSettings(); });
elements.completed.addEventListener('change', function () { state.showCompleted = elements.completed.checked; saveState(); renderAgents(currentTask()); });
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') { closeTaskModal(); elements.settings.hidden = true; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openTaskModal(); }
});

window.setInterval(function () {
  const task = currentTask(); if (task.status !== 'working') return;
  state.tick += 1; if (state.tick % 2 === 0 && task.progress < 92) task.progress += 1;
  const messages = ['worker-2: tool output verified', 'orchestrator: heartbeat healthy', 'reviewer: checking changed lines'];
  task.logs.push([now(), messages[state.tick % messages.length], state.tick % 3 === 0 ? 'success' : '']);
  if (task.logs.length > 16) task.logs.splice(0, task.logs.length - 16);
  renderTask();
}, 4200);

renderSettings();
if (window.__OTX_LIVE_SNAPSHOT__) applyLiveSnapshot(window.__OTX_LIVE_SNAPSHOT__);
else renderTask();
if (window.lucide) window.lucide.createIcons();
connectLiveStream();
