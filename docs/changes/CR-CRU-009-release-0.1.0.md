# CR-CRU-009 — Release 0.1.0: skill bundle + docs

**Status:** PENDING
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-007, CR-CRU-008, CR-CRU-011, CR-CRU-012, CR-CRU-013, CR-CRU-016
**Labels:** release, packaging, skill-bundle
**Phase:** Wave 4
**Design reference:** PRD §2 (skill-bundle deployment target), §6 (rollout)

## Context
v0.1.0 ships as a self-contained skill bundle: the Crucible server, the client
scripts, and a skill that covers the full agent workflow — installable on any
machine that has Bun, no external services.

## Scope

### §S1 Bundle layout
Repo packages a distributable under `bundle/`: server (source, run via `bun run`),
`clients/` scripts, `skills/crucible/SKILL.md` (the consolidated v2 skill: register →
ingest → status → unregister, TOON examples, shim note), install script
(`install.sh`: copies scripts/skill into `~/.claude/`, creates `data/`, prints the
systemd/user-service or `bun run` start line). No network access needed at install
or runtime (all assets vendored).

### §S2 Docs
`README.md`: what Crucible is, quick start (3 commands to a live dashboard),
API pointers (v2 orientation, shim status), version 0.1.0 + link scheme per house
convention. `docs/RUNBOOK.md`: start/stop, db path, corrupt-db behavior, retention,
health monitoring, port + bind-address config (`CRUCIBLE_PORT`/`CRUCIBLE_HOST` —
loopback-only by default).

### §S3 Version + release ceremony
`package.json` version `0.1.0`; git-flow release per house git-workflow (release
branch → master + tag `0.1.0` → back-merge develop). README version + tag link
updated during the release branch, per house rules.

## Acceptance criteria
- [ ] **Built-artifact AC (packaging rule):** on a scratch dir with only Bun on PATH, `bundle/install.sh --prefix <scratch>` then `bun run <scratch>/crucible/src/server.ts` serves `GET /api/health` → 200 within 5 s; the installed tree contains `skills/crucible/SKILL.md` and 5 `clients/*-crucible.py` files (assert by listing the installed tree, not by reading install.sh).
- [ ] Fresh-install smoke: `crucible-axi project add --name smoke` + `register` + `ingest <bundled fixture>` against the fresh instance all return `ok: true`.
- [ ] CLI-bootstrap smoke (deferred-register fold-in, user-approved 2026-07-15): a test spawns `bun run src/server.ts` as a real subprocess (exercising the `import.meta.main` block + file-db mkdir path), polls `GET /api/health` to 200 within 5 s, then kills it — the two coverage-orphaned line ranges get automated contact.
- [ ] `README.md` quick start contains ≤ 3 shell commands from clone to dashboard, and the stated version matches `package.json` (`0.1.0`).
- [ ] `git tag 0.1.0` exists on master after the release ceremony; develop contains the back-merge.
- [ ] Offline check: install + boot + smoke pass with network disabled (no fetch to any external host — assert no outbound connections attempted, e.g. via `strace`/proxy-less env with a canary resolver).

## Estimated size
M.

## Risk
`install.sh` touching `~/.claude` collides with live skills — install is
prefix-parameterized and never overwrites without `--force`.

## Non-goals
Shim removal, BDD harness, filter bar, coverage-trend deep views — all post-0.1.0.
