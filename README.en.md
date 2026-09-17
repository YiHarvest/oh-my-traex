<div align="center">

# oh-my-traex

**A genuinely observable and recoverable multi-agent runtime for TraeX.**

A TraeX-native orchestration layer inspired by `oh-my-codex`: keep lightweight native children, then add independent processes, panes, sessions, worktrees, and durable task state when the work needs stronger boundaries.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)
[![TraeX](https://img.shields.io/badge/TraeX-multi__agent-3b82f6)](https://www.trae.ai/)
[![Tests](https://img.shields.io/badge/tests-54%20passing-22c55e)](#development-and-verification)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Quick start](#try-the-current-version) · [Architecture](#system-architecture) · [Dashboard](#live-dashboard) · [Command reference](#command-reference) · [简体中文](README.md)

</div>

> **Current status:** `main` ships two execution paths: native child-agent orchestration through `otx run`, and durable independent workers through `otx team`. The Team runtime includes structured planning, task DAGs, claim leases, durable mailboxes, dynamic membership, safe integration, and cleanup. A local REST/SSE Dashboard exposes the same runtime state as a focused control plane.

## System architecture

<a href="assets/oh-my-traex-architecture.html"><img src="assets/oh-my-traex-architecture.png" alt="oh-my-traex architecture: an operator drives the Team runtime through the OTX CLI or Live Dashboard; tasks, claims, leases, and mailboxes persist in Git common state; independent TraeX workers execute in isolated worktrees and may use native TraeX children internally."></a>

> The architecture was generated with [Archify](assets/oh-my-traex-architecture.html). Click the image for the searchable, focusable, theme-aware, exportable artifact. Its source specification is [`docs/oh-my-traex.architecture.json`](docs/oh-my-traex.architecture.json).

## Try the current version

You need Node.js 22+, Git, tmux, and `traex` on `PATH`.

```bash
git clone https://github.com/YiHarvest/oh-my-traex.git
cd oh-my-traex
npm link
otx doctor
```

Start lightweight native-child orchestration:

```bash
otx run -n 3 --mode balanced "Review this repository and implement the approved fixes"
```

Start a durable Team from inside tmux:

```bash
otx team --workers 3 --name release-team "Implement, test, and review the release"
```

Start the repository-scoped live control plane:

```bash
otx dashboard -C /path/to/repository --port 4173
# open http://127.0.0.1:4173
```

## The idea

TraeX already provides native child agents. Complex engineering work still needs a second runtime layer: subtasks should survive beyond one prompt context, workers need independent terminal and Git boundaries, handoffs must be durable, and recovery must preserve who owns what.

oh-my-traex therefore keeps two levels:

1. `otx run` uses native TraeX children for low-overhead, in-session fan-out.
2. `otx team` starts independent TraeX processes; every first-level worker receives its own tmux pane, session, branch, and worktree.
3. A Team worker may still use native TraeX children internally, producing durable first-level workers with lightweight nested agents.
4. The leader owns decomposition, file ownership, verification, and final integration.

## Why not use only native children?

| Capability | `otx run` | `otx team` |
|---|---|---|
| Execution unit | Native TraeX child thread | Independent TraeX process and session |
| Visibility | TraeX session / optional tmux viewer | One tmux pane per worker plus Web Dashboard |
| File isolation | Shared workspace, prompt-enforced ownership | Independent Git branch and worktree |
| Durable state | TraeX session state | `.git/otx/team/<team>/` |
| Follow-up work | New child or leader coordination | Resume the original session through a mailbox |
| Dependencies | Leader prompt | Persistent DAG, claims, and leases |
| Recovery | Native TraeX behavior | Pane, PID, heartbeat, activity, task, mailbox, and Git diagnostics |
| Best fit | Exploration, review, small parallel work | Long-running implementation and recoverable delivery |

The two surfaces complement each other. `otx run` stays light; `otx team` provides the durable orchestration layer associated with `oh-my-codex`.

## Live Dashboard

The Dashboard is a local Team control plane, not a mock-only view or arbitrary command terminal. It binds to `127.0.0.1`, scopes itself to one Git repository, and exposes a constrained action set:

- stream Team, task, worker, heartbeat, activity, mailbox, and terminal state over SSE;
- group tasks by Team and switch terminal output by selecting a worker;
- send same-session follow-ups or create durable tasks with `depends_on`;
- add an independent worker with an explicit role and bounded assignment;
- enable and disable actions according to real runtime state;
- show affected workers and unfinished tasks before confirming Stop;
- report `stalled` when a process still has a heartbeat but TraeX has produced no recent events;
- support `J/K` task navigation, `[/]` worker navigation, `1/2` inspector tabs, `M` message, `A` assignment, and `?` help.

There is no arbitrary shell API. A Dashboard stop removes its tmux session only after resolving the persisted leader pane back to the expected `otx-web-<team>` session.

## What the current source ships

| Shipped surface | Verification evidence |
|---|---|
| Native child orchestration | Bounded fan-out, role, and leader-integration contract tests |
| Independent Team workers | Real tmux pane, TraeX session, branch, and worktree E2E |
| Structured planning | JSON schema plus role, path, cycle, and write-ownership validation |
| Durable task coordination | Atomic task records, cross-process claims, lease renewal/reclaim, dependency unlock tests |
| Long-lived mailbox | Same-session follow-ups, explicit task dispatch, and result-path verification |
| Dynamic membership | Monotonic worker indexes and safe add/remove E2E |
| Safe integration and cleanup | Commit-range checks, cherry-pick, pane ownership, and dirty-worktree guards |
| Live Dashboard | REST/SSE, real pane capture, runtime actions, desktop/mobile verification |
| Health diagnostics | Heartbeat, pane liveness, activity age, and `stalled` state |

## How Team works

Team first requires a clean leader checkout, then follows this lifecycle:

1. A structured planner produces worker roles, assignments, file boundaries, and a DAG. An explicit `N:role` descriptor or `--no-plan` skips planning.
2. The runtime creates one branch, Git worktree, tmux pane, and TraeX session per first-level worker.
3. State is stored under `.git/otx/team/<team>/` in the Git common directory, visible from every worktree without dirtying the checkout.
4. A worker claims a task only after its dependencies complete and renews the lease from its heartbeat loop. Expired leases can be reclaimed safely.
5. The leader sends ordinary follow-ups through the mailbox or creates another durable task.
6. Write workers must produce a clean commit; the leader validates the commit range before integration.
7. Stop and cleanup re-check ownership and recoverability before touching panes, branches, or worktrees.

Example state tree:

```text
.git/otx/team/release-team/
├── config.json
├── tasks/
│   ├── task-1.json
│   └── task-2.json
├── mailbox/
│   └── worker-1/
└── workers/
    ├── worker-1.json
    └── worker-1/
        ├── prompt.md
        ├── result.md
        └── followup-<message-id>.md
```

## Command reference

| Command | Purpose |
|---|---|
| `otx run <task>` | Start a TraeX leader using native children |
| `otx run --ui dashboard <task>` | Start the TraeX app-server/session viewer combination |
| `otx prompt <task>` | Print the leader orchestration prompt |
| `otx team [N:role] <task>` | Start durable independent Team workers |
| `otx team list` | List Teams in the current repository |
| `otx team status <name>` | Inspect worker, pane, worktree, commit, and result state |
| `otx team reconcile <name>` | Explicitly persist dead-worker and terminal Team reconciliation |
| `otx team recover <name>` | Recover panes, worktrees, and state left by interrupted runtime transactions |
| `otx team await <name>` | Wait for every worker to reach a terminal state |
| `otx team send <name> <worker> <message>` | Queue a follow-up for the original worker session |
| `otx team assign <name> <worker> [--depends-on IDs] <task>` | Create and dispatch a durable task |
| `otx team add-worker <name> <role> <assignment>` | Add an independent worker dynamically |
| `otx team remove-worker <name> <worker>` | Safely remove an idle, recoverable worker |
| `otx team diagnose <name>` | Inspect pane, PID, heartbeat, activity, and blockers |
| `otx team integrate <name> [workers...]` | Validate and cherry-pick worker commit ranges |
| `otx team stop <name>` | Stop a Team after verifying pane ownership |
| `otx team cleanup <name>` | Remove stopped, safe branches and worktrees |
| `otx dashboard [-C repo]` | Start the repository-scoped Live Team Dashboard |
| `otx doctor` | Check Node, TraeX, Git, tmux, and multi-agent features |

## Safety boundaries

- The default TraeX sandbox is `workspace-write`; bypass-permissions is never enabled automatically.
- The Dashboard is loopback-only and exposes no arbitrary shell endpoint.
- Worktree trust is injected only into the worker process and does not update the user's global trust list.
- Pane termination validates team, worker, run ID, and original pane PID.
- Dirty or unintegrated worktrees are never silently deleted by cleanup.
- DAG claims use cross-process locks and tokens; expired or incorrect tokens cannot complete a task.

## Development and verification

```bash
npm test
npm run doctor
npm pack --dry-run
node src/cli.js run --dry-run -n 2 "Inspect this repository and propose improvements"
```

The current baseline is **54 passing tests**, including real tmux/TraeX Team, mailbox, DAG, dynamic membership, integration, cleanup, and responsive Dashboard verification.

## License

[MIT](LICENSE) © 2026-present [YiHarvest](https://github.com/YiHarvest)
