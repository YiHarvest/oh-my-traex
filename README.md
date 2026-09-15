# oh-my-traex

`oh-my-traex` is a lightweight multi-agent orchestration layer for TraeX. It is inspired by the role routing and lead/worker discipline in `oh-my-codex`, but delegates process management to TraeX's native, stable `multi_agent` runtime.

The first release focuses on a small, auditable contract:

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

Useful options include `--workers 1..6`, `--mode conservative|balanced|aggressive`, `--model`, `--cwd`, `--read-only`, `--json`, and `--dry-run`.

`--ui dashboard` must be launched from inside tmux. It starts the lead through
TraeX's shared dashboard/app-server control plane in the current pane and opens
a second dashboard as a live session monitor. This mode is interactive and does
not support `--json`; without `--ui dashboard`, `otx run` keeps its original
non-interactive `traex exec` behavior.

The dashboard mode also starts an isolated local app-server supervisor. When the
lead spawns a native child agent, the supervisor discovers its thread and opens
a read-only tmux pane named with the child's nickname and role.

## Why this shape

`oh-my-codex` contains its own mature team runtime, durable state, tmux integration, hooks, worktrees, and delivery protocol. TraeX already exposes native child-agent collaboration, so this project starts with the orchestration policy that adds value and avoids duplicating lifecycle machinery. Durable state, resumable team runs, richer role configuration, and a TraeX plugin can be layered on after the native MVP is validated.

## Development

```bash
npm test
node src/cli.js doctor
node src/cli.js run --dry-run -n 2 "Inspect this repository and propose improvements"
```
