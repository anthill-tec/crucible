# CR-CRU-008 — crucible-axi CLI + client-fleet upgrade

**Status:** PENDING
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-005, CR-CRU-007 (the `context.cycle` RunContext field + labeled markers land there)
**Labels:** cli, clients, migration
**Phase:** Wave 4
**Design reference:** PRD §2 (clients decision), §3.3 (context fields); DN §4 (client inventory)

## Context
With the v2+AXI surface live, the fleet moves off the shim: a gh-axi-style npx CLI
for agents, then the five `*-crucible.py` scripts and the crucible skills upgraded
to v2 endpoints + context fields. The shim retires in a later maintenance CR once
this lands and soaks.

## Scope

### §S1 `crucible-axi` CLI (new package under `cli/`)
`npx -y crucible-axi` — no-arg dashboard (server health, projects, your agent if
registered, next-step hints). Commands: `register`, `heartbeat`, `unregister`,
`ingest <junit-path>`, `ingest-compile <file>`, `ingest-parsed` (stdin JSON),
`events`, `status`, `project add|list`. Flags: `--project-key/--project-dir` (.env
`CRUCIBLE_PROJECT_KEY` discovery), `--agent`, `--tier`, `--branch/--commit/--wave/
--orchestrator` (auto-detect git branch/commit from CWD when omitted, sent only if
detected). Output: TOON to stdout, progress to stderr, per the AXI house idioms.

### §S2 Script fleet upgrade (`~/.claude/scripts/`)
`rust-crucible.py`, `mvn-crucible.py`, `python-crucible.py`, `bun-crucible.py`,
`arduino-crucible.py`: point at `/api/v2/*` (register/unregister verbs, runs
endpoints), send `tier` per subcommand (unit/module/e2e/regression map), send
git context (branch, commit from the SUT repo; wave/orchestrator from env
`CRUCIBLE_WAVE`/`CRUCIBLE_ORCHESTRATOR` when set; **`context.cycle` from env
`CRUCIBLE_CYCLE` when set — the orchestrator todo's description, labeling the
RED→GREEN Cycle marker; round-10 terminology decision, field lands in CR-007**),
read `help[]`/`changed` fields tolerantly. Behavior flags unchanged — call sites
in agent definitions keep working.

### §S3 Skill fleet upgrade (`~/.claude/skills/`)
`crucible-register`, `crucible-report-{rust,java,python,bun,vscode}`,
`agent-protocol` (+ its `heartbeat.sh`): v2 endpoints, context fields, TOON-aware
examples, removal of the dedicated-ping guidance (ingest is the heartbeat).

### §S4 Shim retirement (fold-in, user-approved 2026-07-15)
After the fleet upgrade lands AND the soak gate passes (one full RED→GREEN→regression
dog-food cycle of this repo executed entirely through the UPGRADED clients against
`/api/v2/*`), retire the v1 shim: remove the legacy `/api/*` route handlers (health
stays), mark `tests/v1-contract.test.ts` as the retired-contract archive (moved to
`tests/archive/` and excluded from the suite), and record the retirement in the DN.
If the soak gate fails, retirement DOES NOT happen in this CR — it reverts to a
follow-up, and the shim stays.

## Acceptance criteria
- [ ] `npx crucible-axi` (built from `cli/`, run locally) with the server up prints a TOON dashboard whose first line is `ok: true` and includes a `help[` block; with the server down exits non-zero with a message naming `/api/health`.
- [ ] `crucible-axi ingest <fixture.xml> --project-key <k> --agent a1` inside a git repo → the recorded event's `context.git.branch` equals the repo's current branch (auto-detect); the same command with `GIT_DIR` unset/outside a repo records NO context (graceful).
- [ ] `rust-crucible.py regression …` against the v2 server records an event with `tier: "regression"`; `mvn-crucible.py` unit path records `tier: "unit"` (grep the stored event).
- [ ] With `CRUCIBLE_CYCLE="checkpoint persistence"` set, an upgraded script's ingest records `context.cycle: "checkpoint persistence"` on the event; with the env var unset, the stored context has no `cycle` key.
- [ ] Each upgraded script's register call hits `/api/v2/agents/register` (assert via server access log or store) and still exits 0 with the same CLI arguments used in the agent definitions today (no call-site changes).
- [ ] Skill docs contain no `POST /api/agents/heartbeat` legacy references except in an explicit "legacy/shim" note; `heartbeat.sh` targets `/api/v2/agents/heartbeat`.
- [ ] Soak gate: one full RED→GREEN→regression cycle of THIS repo (Crucible dog-food) executes end-to-end through `bun-crucible.py` upgraded, visible on the dashboard with transition marker + context badges.
- [ ] Caller-existence: `rg "api/v2" ~/.claude/scripts/*-crucible.py` returns ≥ 5 files.
- [ ] Shim retirement (§S4, soak-gated): after the dog-food soak cycle passes through upgraded clients, `GET/POST` on legacy `/api/ingest`, `/api/agents/heartbeat`, `/api/projects/add` → 404 JSON; `/api/health` still 200; `tests/archive/v1-contract.test.ts` exists and is excluded from `bun test`; a dated retirement line exists in DN-crucible-api-reconstruction.md. If the soak gate failed, this AC is N/A and the spec gains a dated deferral note instead.

## Estimated size
L (touches 5 scripts + 7 skills + new CLI package; stage script-by-script).

## Risk
Fleet edits live OUTSIDE this repo (`~/.claude`) — each script upgrade is committed
in this repo under `clients/` as the source of truth and synced to `~/.claude` by an
install step documented in CR-CRU-009; VERIFY tests run against `clients/` copies.

## Non-goals
Shim removal (separate maintenance CR after soak); VS Code script (no v1 script
exists — skill-only update).
