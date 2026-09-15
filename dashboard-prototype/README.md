# Orchestration Dashboard Prototype

High-fidelity interactive control plane for `oh-my-traex`. The static server
uses mock state; the live server binds to one Git repository and streams its
real Team state over Server-Sent Events.

Run it locally:

```bash
node dashboard-prototype/server.js
```

Then open `http://127.0.0.1:4173`.

Live runtime mode:

```bash
node dashboard-prototype/live-server.js --repo /path/to/git/repository --port 4173
```

The live server reads `.git/otx/team`, captures owned tmux worker panes, and
streams config, tasks, workers, heartbeat health, mailbox state, integration
state, and terminal output. It binds only to `127.0.0.1`.

Interactions:

- switch between task histories from the left navigation;
- open **Tasks** and **Activity** inspector tabs;
- create a task with the plus button or `Ctrl/Cmd + K`;
- add an agent node and select any agent card;
- run, stop, or retry the active task;
- toggle compact density and completed-agent visibility in Settings;
- task and display preferences persist in `localStorage`.

In live mode, **Launch Task**, **Stop**, **Run/Retry**, and **Add Node** call the
restricted local runtime API. The API exposes only start, stop, send, assign,
integrate, and add-worker operations scoped to the repository supplied at
server startup; it does not expose an arbitrary command endpoint.
