# CR-CRU-049 — Audit and harden `mvn-crucible.py` narration against environment-dependent output

**Status:** PENDING
**Type:** patch (client robustness — audit + hardening)
**Priority:** P2 — a latent instance of the CR-CRU-047 defect class; NOT a confirmed break
**Depends on:** CR-CRU-008 (§S2b in-run progress narration), CR-CRU-047 (establishes the defect class and the fix pattern)
**Labels:** patch, client, mvn, narration, gate-correctness, robustness
**Phase:** Wave 4
**Design reference:** CR-CRU-047's root-cause analysis (2026-07-28), which found TWO faults in the
bun narrator — a stale console-format regex, and bun suppressing per-test output entirely when
`CLAUDECODE`/`AGENT`/`REPL_ID` is set. `mvn-crucible.py` narrates the same way, from the same kind
of source, and has never been audited for either fault.

## Context
**This CR is an AUDIT, not a confirmed defect report.** No Maven break has been reproduced —
there is no Java project to hand in this repo to exercise it. What is established is that
`mvn-crucible.py` shares the exact structural weakness that made the bun narrator fail silently.

**Confirmed facts about the mvn client:**
- It has a narrator (16 references) with its own `_run_logged(cmd, cwd, env, log_path, narrator)`
  (`clients/mvn-crucible.py:484`) reading `proc.stdout` line-by-line (`:504`).
- Its completion signal is a console-text regex (`:408`):
  `_MVN_RUNNING_LINE = re.compile(r"(?:^|\s)Running ([A-Za-z_][\w.$]*)\s*$")`
  — matching surefire's `[INFO] Running com.acme.AlphaTest`. Granularity is per CLASS, which is
  inherent to surefire's output, not a defect.
- **It does NOT pass `-B` / `--batch-mode`.** Maven's console output is not pinned; it varies with
  terminal detection and CI heuristics, and Maven/surefire have changed output formatting across
  major versions.

**Why that matters — the CR-047 pattern, restated:** the bun narrator failed in two independent
ways at once. Its regex silently stopped matching (bun moved to `✓`/`✗`), AND an environment
variable set outside the repo suppressed the parsed lines entirely. Neither failure was loud:
narration simply stopped, and the only symptom was a test asserting narration had occurred. The
mvn narrator is exposed to the same shape of failure and nothing would tell us if it already had.

Only `bun` and `mvn` are exposed — `arduino`, `python` and `rust` have no narrator (verified).
CR-CRU-047 fixes bun; this CR covers the remaining one.

## Scope

### §S1 — Establish whether the narrator actually works today
Run the mvn client against a real Maven project and determine whether narration is emitted at
all. This is the deliverable that decides the rest: state plainly whether it works, is broken, or
could not be exercised — do not assume. If no suitable project exists, say so and note what would
be needed, rather than passing the audit by default.

### §S2 — Pin Maven's output format
Pass `-B` / `--batch-mode` on the invocations the narrator reads. Batch mode makes Maven's output
deterministic and independent of terminal/CI detection — the closest Maven analogue to the
documented reporter CR-047 adopts for bun. Confirm it does not alter the surefire/failsafe report
files the ingest path parses.

Note the asymmetry with CR-047, and do not paper over it: Maven has **no `--dots` equivalent**.
There is no per-test streaming machine-readable reporter, so the `Running <Class>` line remains
the signal. `-B` reduces the surface to a stable, documented mode; it does not eliminate the
console-parsing dependency.

### §S3 — Environment parity
Whatever narration path results must behave identically with `CLAUDECODE`, `AGENT`, `REPL_ID` and
`CI` set and unset. That was the half of the bun defect nothing caught, precisely because every
agent-run gate sets it — so it is never the environment anyone tests in.

### §S4 — Verify the regex against the surefire version actually in use
Confirm `_MVN_RUNNING_LINE` matches what the project's surefire version emits. If it does not, fix
it — and record the surefire version the assumption is pinned to, so the next drift is diagnosable
rather than mysterious.

## Acceptance criteria
- [ ] A stated, evidenced verdict on whether mvn narration works today: WORKS / BROKEN /
      NOT-EXERCISABLE with the reason. An unexercised audit is not a pass.
- [ ] `-B` (or `--batch-mode`) is passed on the narrated invocations — asserted.
- [ ] The surefire/failsafe report files the ingest path parses are unchanged by `-B` — asserted,
      so the fix cannot break ingest.
- [ ] Narration behaves identically with `CLAUDECODE=1` set and unset — asserted (§S3).
- [ ] The surefire version `_MVN_RUNNING_LINE` is pinned against is recorded in a comment beside
      the regex.
- [ ] Full Python regression green AND full bun regression green (client change → both gates, per
      CR-CRU-045 §S3).

## Non-goals
- Rewriting mvn narration to per-test granularity. Surefire reports per CLASS; that is its
  contract, not a defect.
- The bun narrator (CR-CRU-047 owns it) or the three clients with no narrator.
- Introducing a Java sample project into this repo solely to exercise the audit, unless §S1 shows
  it is the only way and the orchestrator approves it as separate scope.

## Risk
- **The audit may be unexercisable** without a Maven project. Recording that honestly is an
  acceptable outcome; quietly marking the CR complete without evidence is not — that would
  reproduce the original failure, where nothing told us narration had stopped.
- `-B` changes Maven's console output, which other parsing in the client may depend on. Sweep for
  other console-text assumptions in `mvn-crucible.py` before landing (`:890` reads
  `r.stdout.splitlines()`), rather than assuming the narrator is the only reader.
