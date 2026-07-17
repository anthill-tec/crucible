# CR-CRU-008 — crucible-axi CLI + client-fleet upgrade

**Status:** PENDING
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-005, CR-CRU-007 (the `context.cycle` RunContext field + labeled markers land there), CR-CRU-011 (the cycle-plan API the plan verbs call — reordered round 15: 011 now runs BEFORE 008)
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
`WORKFLOW_WAVE`/`WORKFLOW_ROLE` when set; **`context.cycle` from env
`WORKFLOW_CYCLE` when set — the orchestrator todo's description, labeling the
RED→GREEN Cycle marker; round-10 terminology decision, field lands in CR-007**),
read `help[]`/`changed` fields tolerantly. Behavior flags unchanged — call sites
in agent definitions keep working.
**Plan verbs (user-locked round 15 — "encoded in the python client as calls for
the agentic backend"):** orchestrator-facing subcommands on every `*-crucible.py`:
`plan-file` (files the cycle plan from the orchestrator's todo list →
CR-011 §S0 `POST /plans` — including `--title "<CR title>"` for the
Workflow CR-root display (CR-021 §S6.11 additive field), prints the assigned cycle ids — **auto-attaching
`track` from `WORKFLOW_ROLE` when set**: Model-B track operators
register their track with the CR for free, solo orchestrators send nothing,
round 17), `cycle-activate <id>`,
`cycle-done <id>` (the orchestrator's GREEN confirmation — closes the span),
`cr-close --commit <sha>` (on feature merge — closes the plan). Agents receive
`WORKFLOW_CYCLE_ID` from the orchestrator and every run/compile ingest attaches
`context.cycleId` when it is set (alongside `WORKFLOW_CYCLE` for the label
fallback).

### §S2b In-run progress narration (user-approved option (a) — message field)
While a runner executes, the wrapping script TAILS its output and posts
throttled heartbeats (`message: "running 214/385 · <current file>"`) so the
Project pane's agent row narrates live progress — no new API (the `message`
field was built for narration). Per-stack granularity (all stacks work; detail
varies with what the runner streams):
- bun test → per-test/file lines → fine-grained counter
- cargo nextest → per-test status stream → fine-grained counter
- pytest → per-test `[ 45%]` lines → fine-grained counter/percent
- maven surefire → per-CLASS "Running …/Tests run:" lines → class-level counter
- arduino/native g++ runners → per-suite prints → suite-level counter
- playwright (BDD/e2e) → `--reporter=line` `[k/N]` → fine-grained counter
Throttle: update at most every 2 s (or every 10 completions) to keep heartbeat
traffic negligible. On completion the final ingest replaces the narration.

### §S2c Failure-detail enrichment for bun runs (user defect 2026-07-15)
Bun's JUnit reporter emits bare `<failure type="AssertionError"/>` — no
message attribute, no element text (probe-verified: even a thrown
`new Error("boom with detail")` carries zero detail in the XML). The bun
ingest path must therefore MARRY the JUnit tree with the captured console
output: the wrapper already tails the run (§S2b); it additionally parses
bun's per-test failure blocks (the `error:`/assertion block preceding each
`(fail) <name>` line in the stream) and attaches `{message, trace}` to the
matching failing leaf before ingest. The UI's degradation fallback
(`no failure detail captured by the reporter`, CR-007 re-baseline 82ad70d)
then appears only for genuinely detail-less reporters.

### §S3 Skill fleet upgrade (`~/.claude/skills/`)
`crucible-register`, `crucible-report-{rust,java,python,bun,vscode}`,
`agent-protocol` (+ its `heartbeat.sh`): v2 endpoints, context fields, TOON-aware
examples, removal of the dedicated-ping guidance (ingest is the heartbeat).

### §S4 Shim retirement (fold-in, user-approved 2026-07-15) + guarded run deletion (user-ruled 2026-07-17)
**Retirement precondition — capability parity (user ruling 2026-07-17:
"Cant we support both A and B? A is used only rarely. B can be by default
and the configuration set in the project manager."):** before the v1 routes
go, v2 gains DOUBLE-GATED single-run deletion so retiring
`/api/events/delete`/`clear` leaves no capability gap:
1. Per-project setting `allowRunDeletion` (default **false** — immutable
   audit log is the default posture), additive PATCHable field on
   `PATCH /api/v2/projects/<key>` and a toggle in the manager's
   edit-in-place form (`manager-edit-allow-deletion`, danger-styled).
2. `DELETE /api/v2/events/<id>` — single event only, NO bulk clear.
   Refused unless BOTH gates pass: the project's `allowRunDeletion` is
   true (else 403 + AXI help naming the manager setting) AND the body
   carries `userApproved: true` (else 409 with the CR-024 §S6-style
   discouraging help). A deleted event vanishes from events/timeline and
   never folds into rollups at later prunes; existing rollups are not
   retro-adjusted.
3. The legacy `/api/events/delete` + `/api/events/clear` retire WITH the
   shim (bulk clear is deliberately dropped — audit-log posture).
4. **v2 silent unregister (C2 GREEN finding, orchestrator-ruled):** gated
   runs are v2-native (ingest = implicit heartbeat, no lifecycle ceremony),
   but the anti-ghost cleanup still needs a ceremony-free removal and v2
   journals a lifecycle event on every unregister — so the clients' silent
   cleanup currently rides the shim's `/api/agents/remove`, which would 404
   after retirement. Precondition: `POST /api/v2/agents/unregister` accepts
   `{silent: true}` — removes the agent WITHOUT journaling a lifecycle
   event; the clients/ silent-cleanup path swaps to it in this cycle.
   AC: silent unregister removes the agent (GET agents omits it) and the
   events journal gains NO entry; non-silent behavior byte-unchanged.
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
- [ ] With `WORKFLOW_CYCLE="checkpoint persistence"` set, an upgraded script's ingest records `context.cycle: "checkpoint persistence"` on the event; with the env var unset, the stored context has no `cycle` key.
- [ ] §S2b: during a wrapped `bun-crucible.py test` run of ≥20 tests, the agent's `message` (polled via GET agents) changes at least once to a `running N/M` narration before the final ingest, and updates are throttled (≤1 per 2 s asserted from the poll log); `mvn-crucible.py` narrates at class granularity (fixture with ≥3 classes).
- [ ] §S2c: a bun run with 2 failing tests (one `expect(1+1).toBe(3)` mismatch, one `throw new Error("boom with detail")`) ingests failing leaves whose `failure.message` contains `expect(` / `boom with detail` respectively — married from the captured console output, since bun's JUnit XML carries only the failure `type`; an unmatched failing leaf degrades to type-only (the UI renders its fallback note).
- [ ] Plan verbs: `bun-crucible.py plan-file --cr CR-X-1 --cycles "a,b"` creates an open plan and prints two numeric ids; with `WORKFLOW_ROLE=track-2` set the plan records `track:"track-2"` and with it unset the plan has no `track` key; `cycle-activate 1` → cycle 1 `active`; with `WORKFLOW_CYCLE_ID=1` an ingest records `context.cycleId: 1`; `cycle-done 1` → `done`; `cr-close --commit abc1234` → plan `closed` with the commit (each asserted via `GET /plans`).
- [ ] Each upgraded script's register call hits `/api/v2/agents/register` (assert via server access log or store) and still exits 0 with the same CLI arguments used in the agent definitions today (no call-site changes).
- [ ] Skill docs contain no `POST /api/agents/heartbeat` legacy references except in an explicit "legacy/shim" note; `heartbeat.sh` targets `/api/v2/agents/heartbeat`.
- [ ] Soak gate: one full RED→GREEN→regression cycle of THIS repo (Crucible dog-food) executes end-to-end through `bun-crucible.py` upgraded, visible on the dashboard with transition marker + context badges.
- [ ] Caller-existence: `rg "api/v2" ~/.claude/scripts/*-crucible.py` returns ≥ 5 files.
- [ ] §S4 guarded deletion — config gate: fresh project has `allowRunDeletion` absent/false; `DELETE /api/v2/events/<id>` with `{userApproved:true}` → 403 whose help[] names the manager setting; after `PATCH {allowRunDeletion:true}` the same call → 200 and the event is gone (GET events count drops; a later retention prune folds rollups WITHOUT the deleted event's contribution).
- [ ] §S4 guarded deletion — approval gate: with the config ON, `DELETE` without `userApproved:true` → 409 whose error demands user approval and help[] instructs presenting to the user first (CR-024 §S6 wording family); no state change.
- [ ] §S4 guarded deletion — manager UI: the edit form renders `manager-edit-allow-deletion` (off by default, danger-styled); toggling + save PATCHes exactly `{allowRunDeletion:<bool>}`; the row view surfaces the enabled state.
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

## Implementation Notes (gap-analysis accumulator — items ruled/found before execution)
- **e2e ingest verb (from CR-012 VERIFY finding 1, 2026-07-17):** add an e2e
  path to `bun-crucible.py` (and the fleet map) that runs/wraps playwright
  with `PLAYWRIGHT_JUNIT_OUTPUT_NAME` and ingests the JUnit with
  `tier:"e2e"` + workflow context — replacing the manual curl step
  documented in CR-CRU-012's close-out. The `unit/module/e2e/regression`
  tier map in §S2 already contracts this; the finding makes it concrete.
- **`register` verb ergonomics (2026-07-17):** `bun-crucible.py register
  --agent X` hard-requires `--phase`; orchestrator-side brackets (e.g. the
  CR-012-E2E ingest) had to rely on implicit heartbeat registration. Make
  `--phase` optional (default `report`) or document the implicit path.
- **`plan-file --title` / `--orchestrator`:** CR-021 §S6.11 additive fields —
  already reflected in §S2's plan-verbs text; keep the assigned-cycle-ids
  printout prominent (the plan-7 mis-activation root cause was a guessed id).
- **`checkpoint` / `stop` verbs + `/shutdown` emergency wiring:** CR-024 §S5.4
  assigns the fleet side here — orchestrator emergency flow calls
  `POST …/plans/<id>/checkpoint` and `POST …/projects/<key>/stop`.
- **python-crucible.py no-XML fallback 400 bug:** carried from the 2026-07-16
  python-side cycle — fix during §S2.
- **Guards adoption:** CR-024 lands after this CR — the plan verbs here must
  read AXI `help[]` tolerantly so the later guard 4xxs (out-of-order,
  single-active, §S7 ingest cycle-reference validation) degrade gracefully.
