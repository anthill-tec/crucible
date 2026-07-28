# CR-CRU-047 — Bun gate integrity: narration tests fail deterministically + an unexplained test-count drop

**Status:** PENDING
**Type:** patch (gate correctness — investigation + fix)
**Priority:** P1 — the bun gate is currently red on `develop`, and its TOTAL is unexplained
**Depends on:** CR-CRU-008 (§S2b in-run progress narration — the actual owner), CR-CRU-039 (the zero-discovery precedent)
**Labels:** patch, gate-correctness, bun, client, narration, test-discovery
**Phase:** Wave 4
**Design reference:** found by the CR-CRU-042 C1 orchestrator gate (2026-07-28). CR-CRU-039
established the precedent that a suite silently running FEWER tests than expected is a gate
defect in its own right, independent of any failing assertion.

## Context
Two symptoms, found together. They may share a cause or may not — **establishing that is part of
this CR's work.**

### Symptom A — narration tests fail deterministically
`tests/clients-narration.test.ts` — 2 of 4 tests fail, both on the same precondition:

```
expect(matches.length).toBeGreaterThan(0)   →   Received: 0
```

- `§S2b … a 24-test bun run (120ms sleeps, spans ~2.9s) narrates 'running N/M' heartbeats polled
  via GET /api/v2/agents BEFORE the final ingest, throttled (≥~2s or ≥10 completions apart)`
- `§S2b … narration heartbeats never leak into the script's own stdout, and never journal MORE
  than the one 'registered' lifecycle event however many heartbeats fired`

So `clients/bun-crucible.py` emits **no** `running N/M` narration at all during a run that does
span ~3s (test duration measured at 3014 ms).

**Already ruled out by the orchestrator — do not re-do this work:**
| Hypothesis | Result |
|---|---|
| Caused by CR-CRU-042 | **No** — reproduces identically on `develop` without it |
| Introduced by a recent merge | **No** — fails at `3ac8d6e` (CR-041), `b7a5b87` (CR-045) and `d1e57a8` (CR-043) alike |
| Flaky/timing | **No** — 2 pass / 2 fail deterministically across repeated runs |
| The dog-food server on `:3849` interfering | **No** — still fails with it stopped |
| Client misrouted to the wrong server | **No** — the test injects `CRUCIBLE_URL` at its own `startServer({port:0, dbPath:":memory:"})` instance |
| Caused by CR-CRU-042 (re-tested SOUNDLY) | **No** — at `d1e57a8` (pre-042) in the MAIN tree with the full environment: 2 pass / 2 fail, identical. The earlier worktree "evidence" was invalid; this run is not |
| bun was upgraded | **No — REFUTED.** `/usr/bin/bun` is 1.3.14, binary mtime **2026-05-17**, unchanged today. The version did NOT move |
| Concurrent Python+bun gates starved it | **No** — fails identically when run alone |

**ROOT CAUSE — fully established (2026-07-28). TWO independent faults:**

**Fault 1 — the regex is stale.** `_COMPLETION_LINE` (`clients/bun-crucible.py:180`) matches
`^\((?:pass|fail|skip|todo)\)`. bun 1.3.14 emits `✓ <name>` / `✗ <name>`. Even with FULL output
the narrator matches **0** lines.

**Fault 2 — `CLAUDECODE=1` makes bun suppress per-test output entirely.** bun detects
agent environments (`CLAUDECODE`, `AGENT`, `REPL_ID`) and switches to "quieter output". Measured
on the same file, same bun binary:

| Environment | per-test lines |
|---|---|
| `CLAUDECODE` unset | `✓ <test name>`, one per test |
| `CLAUDECODE=1` (this session) | **none** |

This is the temporal delta — an ENVIRONMENT VARIABLE, not the commit graph and not a bun upgrade
(binary unchanged since 2026-05-17). It is the more alarming half: a variable outside the repo
silently changes test-runner output, so a gate can flip green→red with no code change at all.

**THE FIX — `--dots`, and it is immune to both faults.** bun's reporter list is only `junit` and
`dots` (confirmed against `bun test --help` AND the official docs — there is no JSON, no TAP, no
streaming reporter, and no custom/programmatic reporter API). `--dots` streams ONE CHARACTER PER
COMPLETED TEST, live, which is exactly the `N` narration needs — it never needed test names.
Verified:

| Check | Result |
|---|---|
| `--dots` + `--reporter=junit --reporter-outfile` together | **both work** — dots stream AND the junit file is written (ingest unaffected) |
| dot granularity across 3 files | **35 tests → 35 dots** — per test, not per file |
| failure detail preserved under `--dots` | **yes** — source excerpt, error, and `✗ <name>` all still emitted, so §S2c's console-stream marrying survives |
| `--dots` under `CLAUDECODE=1` | **11 dots — unaffected**; an explicitly requested reporter is not subject to agent-quieting |

**Note the user's correction that shaped this:** JUnit XML cannot drive live narration — it is
written only when the run ENDS. Narration and ingest are different needs; `--dots` serves the
live one, `junit` the post-run one, and they compose.

### Symptom A2 — a third failure, in a different file
`tests/clients-bun-crucible.test.ts` — 1 of 15 fails:

> `§S2c: matched failing leaves carry failure.message married from the console stream`

Established: that file is **byte-identical to `develop`** (`git diff develop..HEAD` empty), and in
the MAIN tree it runs **14 pass / 1 fail** — so it is not caused by CR-CRU-042. It shares the
`clients/bun-crucible.py` console-stream parsing surface with Symptom A, so a common cause is
plausible but NOT established. This CR owns it outright; do not leave it unattributed.

### 🚨 Methodology warning — do NOT bisect with `git worktree`
Fresh worktrees do not contain `node_modules`, `.venv`, `.env` or `data` (all gitignored), and the
client tests spawn the Python client, which needs `.venv` + `.env`. A worktree run of
`tests/clients-bun-crucible.test.ts` reports **43 failures** that are pure environment artifacts.
Any bisect must run in a tree with the full environment present, or its results are noise. The
Symptom-A conclusions in the table above were corroborated by a MAIN-tree run (2 pass / 2 fail)
and stand; anything else derived from worktree runs must be re-established.

### Symptom B — RESOLVED during gap-analysis: not a collection failure
The bun total is fully accounted for. `bun test` reports **1045 tests across 87 files**; there are
**91** `.test.ts` files on disk. The four absent ones are all under `tests/archive/`, excluded
DELIBERATELY by `bunfig.toml` (`[test] pathIgnorePatterns = ["tests/archive/**"]`). Nothing fails
to collect.

My earlier "~11 unaccounted" figure came from comparing a **static `test(` grep against a runtime
total** — an unsound comparison (the grep counts occurrences in comments and strings). No defect
here. §S1 below therefore changes from "reconcile the count" to "delete the dead weight that made
it unreconcilable".

### Symptom C — 2,235 lines of unrunnable dead test code
`tests/archive/` holds four suites pinning the **v1 shim**, which is RETIRED:
- `src/server.ts:222` — *"CR-CRU-008 §S4 — the v1 shim is RETIRED: no legacy /api/\* routes"*; there is no `src/shim*` module at all.
- The archived files test an API that no longer exists, and can never run (excluded from discovery).
- Their own header still declares itself *"the PERMANENT regression gate for the shim's wire contract… forever"* — false since the shim was removed.
- The contract that still matters is already covered by a LIVE test: `tests/shim-retirement.test.ts` asserts legacy `/api/*` returns 404.

"Kept for historical reference" is what git history is for. This is accumulation, and it is what
made the test count unexplainable and cost an investigation.

## Scope

### §S1 — DELETE `tests/archive/` and its exclusion
Remove the four retired-shim suites (2,235 lines) and the now-pointless
`pathIgnorePatterns = ["tests/archive/**"]` from `bunfig.toml`. Git history preserves them; the
working tree should not. After this, on-disk `.test.ts` files and files bun runs must be EQUAL —
no permanently-excluded directory.

### §S2 — Make a shrinking suite impossible to miss
Surface the collected file/test count in the client's regression envelope so a drop is visible in
the gate output itself — the CR-CRU-039 treatment applied to the bun side. With §S1 landed, a
divergence between on-disk test files and files run has no legitimate cause, so it can be
asserted rather than merely reported.

### §S3 — Fix the completion regex (ANSI-tolerant); extend the existing env strip
**REVISED TWICE. Read the correction — it changes what the defect actually is.**

**CORRECTION (2026-07-28): "Fault 2" does NOT apply to the client.**
`clients/bun-crucible.py:712` and `:784` ALREADY do `env.pop("CLAUDECODE", None)` before
`_run_logged`, with a comment stating it is there so the narrator's line family streams. The
agent-quieting measurements in the Context section were taken against **raw `bun` invocations**,
not against the client — the two were conflated. The client already defends itself. What remains
is a real but smaller gap: only `CLAUDECODE` is popped, not `AGENT` or `REPL_ID`.

**So the defect is Fault 1 alone: the completion regex is stale.**
`_COMPLETION_LINE` matches `^\((?:pass|fail|skip|todo)\)`; bun 1.3.14 emits `✓`/`✗` lines.

**🚨 The trap that would silently reproduce the bug.** bun's per-test lines are **ANSI-colourised
even through a pipe**. Measured raw bytes of a passing line:

```
\x1b[0m\x1b[32m\xe2\x9c\x93\x1b[0m \x1b[0mapp-logic — phaseRole(...)
```

An anchored `^✓` matches **zero** lines. The new pattern MUST either allow a leading
`(?:\x1b\[[0-9;]*m)*` run or strip ANSI before matching. A naive `^✓` "fix" fails exactly as
silently as the original — same defect, new spelling. `_FILE_HEADER_LINE` is unaffected
(`narration.test.ts:` arrives with no escapes).

Scope: make `_COMPLETION_LINE` match bun's current per-test lines ANSI-tolerantly; add `AGENT`
and `REPL_ID` to the existing `env.pop` at both call sites. `_prescan_test_total`, the throttle,
and `_run_logged` are all UNCHANGED — the tick lines are newline-terminated, so line-based
reading already delivers them live and the byte-identity risk never arises.

**Why NOT `--dots` (withdrawn, with a new disqualifying fact).** It is documented and
quieting-immune, but: dots carry no newlines, forcing `_run_logged` to character-level reading of
a stream whose capture must stay byte-identical for the `§S2c` parser. Worse — measured — **bun
emits NO dot for a failing test**, printing the failure block and a `✗` line instead, so a dot
count silently under-reports on exactly the runs that matter most. Dots are not a viable
completion signal.

### §S4 — Cross-stack gate note
`clients/bun-crucible.py` is Python whose observable contract is asserted by bun tests — the
CR-CRU-045 §S3 rule applies: any change here needs BOTH gates before close-out.

## Acceptance criteria
- [ ] `tests/clients-narration.test.ts` is 4/4 green, with the `matches.length > 0` precondition
      INTACT — narration must actually occur, not be asserted away.
- [ ] `tests/clients-bun-crucible.test.ts` is 15/15 green — the `§S2c` failure-marrying test
      passes with its console-stream assertion intact (Symptom A2).
- [ ] `tests/archive/` no longer exists and `bunfig.toml` carries no `pathIgnorePatterns`
      exclusion; the count of on-disk `.test.ts` files EQUALS the file count bun reports —
      asserted, so a future permanently-excluded directory fails the gate.
- [ ] A test asserts the collected-test count is surfaced in the regression envelope, so a future
      silent drop fails the gate rather than passing it (§S2).
- [ ] `AGENT` and `REPL_ID` join `CLAUDECODE` in the `env.pop` at BOTH call sites (`:712`, `:784`)
      — asserted on the env handed to the child.
- [ ] The completion regex matches a REAL ANSI-colourised bun tick line (use captured raw bytes as
      the fixture, not a hand-typed `✓`) — asserted. This is the anti-trap test.
- [ ] The narration tests pass BOTH with `CLAUDECODE=1` set and unset — asserted explicitly,
      since agent-quieting is Fault 2 and a fix that only works in one environment is not a fix.
- [ ] The junit file is still written — ingest must be unaffected.
- [ ] `tests/clients-bun-crucible.test.ts` stays green — the `§S2c` parser consumes
      `result.stdout`, and stripping the vars makes bun MORE verbose, so the capture changes
      shape even though the reader does not.
- [ ] Full bun regression green AND full Python regression green.

## Non-goals
- Weakening or deleting the narration assertions to reach green. The `matches.length > 0`
  precondition exists specifically so the purity/journal invariants below it are non-vacuous;
  removing it would make the remaining assertions trivially true.
- Re-testing the hypotheses already eliminated in the Context table.
- Nothing outside the three failures and the count reconciliation named above.

## Risk
- **The tempting wrong fix is to relax `toBeGreaterThan(0)`.** That converts a real signal into a
  permanently green vacuous test. The AC forbids it.
- Symptoms A and B may be unrelated; forcing a single explanation could leave one unfixed. Treat
  the reconciliation (§S1) as independently completable.
- The environmental trigger may not reproduce after a machine state change, which would make the
  fix unverifiable. If that happens, §S2's count-surfacing is the durable safeguard and should
  land regardless.
