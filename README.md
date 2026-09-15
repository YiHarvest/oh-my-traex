# oh-my-traex

`oh-my-traex` provides two multi-agent execution surfaces for TraeX: a lightweight
native-child mode and a durable independent-process team runtime inspired by
`oh-my-codex`.

The native `otx run` surface follows a small, auditable contract:

- a lead agent owns decomposition, integration, verification, and the final answer;
- at most 1-6 child agents run concurrently;
- built-in role mappings cover exploration, architecture, implementation, testing, and review;
- workers receive bounded scopes and may not recursively delegate;
- concurrent writers must own different files or modules;
- TraeX keeps control of sessions, permissions, tools, and child-agent lifecycle.

## Requirements

- Node.js 22 or newer (the supervisor uses Node's built-in WebSocket client)
- `traex` available on `PATH`
- TraeX features `multi_agent` and `multi_agent_v2` enabled
- permission for TraeX to write its own user/session state directory (normally `~/.trae`)

Check the environment:

```bash
npm run doctor
```

## Use from the repository

```bash
node src/cli.js run "Implement login rate limiting and tests"
node src/cli.js run --ui dashboard "Implement login rate limiting and tests"
node src/cli.js run -n 3 --mode conservative "Audit the authorization layer"
node src/cli.js prompt "Refactor the parser without changing behavior"
node src/cli.js team 3:executor --name auth-team "Implement authentication and tests"
node src/cli.js team list
node src/cli.js team status auth-team
node src/cli.js team await auth-team
node src/cli.js team resume auth-team
node src/cli.js team send auth-team worker-1 "Add an edge-case test and commit it"
node src/cli.js team broadcast auth-team "Re-run verification and report blockers"
node src/cli.js team tasks auth-team
node src/cli.js team assign auth-team worker-1 "Implement another bounded change"
node src/cli.js team diagnose auth-team
node src/cli.js team add-worker auth-team verifier "Verify the integrated behavior"
node src/cli.js team remove-worker auth-team worker-4
node src/cli.js team integrate auth-team worker-1 worker-2
node src/cli.js team stop auth-team
node src/cli.js team cleanup auth-team
```

To make `otx` available locally while developing:

```bash
npm link
otx doctor
otx run "Your task"
```

`otx run` uses TraeX's `workspace-write` sandbox by default. Use `--read-only` for analysis and review tasks. It never enables bypass-permissions mode. The sandbox governs project access; TraeX still needs access to its own user state directory to initialize a session.

## Commands

| Command | Purpose |
| --- | --- |
| `otx run <task>` | Start a non-interactive TraeX lead with the orchestration contract |
| `otx prompt <task>` | Print the generated lead prompt for inspection or reuse |
| `otx roles` | List the built-in role mappings |
| `otx doctor` | Verify Node, TraeX, and native multi-agent features |
| `otx team [N:role] <task>` | Start independent TraeX workers in tmux and dedicated Git worktrees |
| `otx team list` | List persisted teams in the current Git repository |
| `otx team status <name>` | Show durable worker, pane, worktree, commit, and result state |
| `otx team await <name>` | Wait until every worker reaches a terminal state |
| `otx team resume <name>` | Resume the persisted TraeX leader session |
| `otx team send <name> <worker> <message>` | Queue a durable follow-up for one worker session |
| `otx team broadcast <name> <message>` | Queue the same follow-up for all workers |
| `otx team mailbox <name> <worker>` | Inspect persisted follow-up delivery/results |
| `otx team tasks <name>` | List the durable task ledger |
| `otx team assign <name> <worker> <task>` | Persist and dispatch a new task to a long-lived worker |
| `otx team diagnose <name>` | Report pane, heartbeat, child PID, task, mailbox, and worktree health |
| `otx team add-worker <name> <role> <assignment>` | Add an independent worker, worktree, task, session, and pane |
| `otx team remove-worker <name> <worker>` | Remove an idle worker only when its work is clean and integrated |
| `otx team integrate <name> [worker ...]` | Validate and cherry-pick completed worker commits |
| `otx team stop <name>` | Safely stop panes after validating ownership |
| `otx team cleanup <name>` | Remove only stopped, clean, integrated worker worktrees and branches |

Useful options include `--workers 1..6`, `--mode conservative|balanced|aggressive`, `--model`, `--cwd`, `--read-only`, `--json`, and `--dry-run`.

`--ui dashboard` must be launched from inside tmux. It starts the lead through
TraeX's shared dashboard/app-server control plane in the current pane and opens
a second dashboard as a live session monitor. This mode is interactive and does
not support `--json`; without `--ui dashboard`, `otx run` keeps its original
non-interactive `traex exec` behavior.

The dashboard mode also starts an isolated local app-server supervisor. When the
lead spawns a native child agent, the supervisor discovers its thread and opens
a read-only tmux pane named with the child's nickname and role.

## Durable team runtime

`otx team` is the heavier execution surface for changes that need independent
workers. Each first-level worker receives its own TraeX process, tmux pane,
session ID, branch, and Git worktree under `../<repo>.otx-worktrees/<team>/`.
Team metadata and worker results are stored under the repository's Git common
directory at `.git/otx/team/<team>/`, so they remain available from every
worktree without dirtying the project checkout.

The first release uses static role lanes and requires a clean leader checkout.
Workers must finish with a new commit and clean worktree. The leader reviews and
cherry-picks accepted commits; `team stop` closes only panes whose team, worker,
run ID, and original pane PID still match the persisted ownership record.

Long-lived workers can receive durable messages or explicit follow-up tasks on
their original TraeX session. Team membership can grow or shrink at runtime;
worker indices are monotonic and never reused within a team. Cleanup and removal
preserve dirty or unintegrated worktrees instead of deleting recoverable work.

## Why this shape

`otx run` uses TraeX native children for inexpensive in-session fanout. `otx team`
uses independent TraeX processes and worktrees for durable, coarse-grained
parallel execution. A team worker may still use native TraeX children internally,
giving OTX the same two-level execution model that makes OMX useful: durable
first-level workers plus lightweight nested subagents.

## Development

```bash
npm test
node src/cli.js doctor
node src/cli.js run --dry-run -n 2 "Inspect this repository and propose improvements"
```
