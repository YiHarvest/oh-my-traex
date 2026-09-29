# Changelog

All notable changes to this project are documented here. This project follows Semantic Versioning.

## 0.5.0 - 2026-09-21

### Added

- Native `otx exec`, session resume, and code review entry points with controlled TraeX option forwarding.
- Durable headless Team execution for CI and container environments.
- Team state validation, repair, retention, metrics, event cursors, task dependencies, and dynamic workers.
- Self-healing supervision, mailbox delivery receipts, transaction recovery, and packed runtime E2E coverage.
- Optional local dashboard support with loopback-only security controls.
- Cross-platform packed headless lifecycle checks and a lightweight read-only Team HUD.

### Changed

- `otx exec` is now the canonical command; `otx run` remains a compatibility alias.
- `exec`, `resume`, and `review` share one declarative option and help schema.
- Non-interactive execution consistently enforces `permission-mode=custom` with managed sandbox and approval settings.
- Multi-worker integration stages and validates the complete batch before publishing it to the leader branch.
- npm releases use Trusted Publishing provenance and verify that tags point to `main`.

### Fixed

- npm-installed CLI execution, worker state races, PID-reused locks, task/message claim fencing, and safe worktree cleanup.

## 0.4.1 - 2026-09-17

- Fixed the npm-installed `otx` binary entry point.
