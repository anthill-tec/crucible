# CR-CRU-049 — Harden `mvn-crucible.py` narration: real-format fixtures + pinned output mode

**Status:** PENDING
**Type:** patch (client robustness + test fidelity)
**Priority:** P2 — the CR-047 defect class survives in the mvn narration TEST, not in the client
**Depends on:** CR-CRU-008 (§S2b in-run progress narration), CR-CRU-047 (establishes the defect class)
**Labels:** patch, client, mvn, narration, test-fidelity, gate-correctness
**Phase:** Wave 4
**Design reference:** CR-CRU-047's root-cause analysis (2026-07-28) — the bun narrator failed two ways
at once (a stale console-format regex, and bun suppressing per-test output when `CLAUDECODE`/`AGENT`/
`REPL_ID` is set), and neither failure was loud.

## Context

**This CR was re-baselined on 2026-08-03 after the audit it originally asked for was actually
performed.** The original spec was written as a four-section audit whose blocking premise was
*"there is no Java project to hand in this repo to exercise it"* and which accepted NOT-EXERCISABLE
as a passing outcome. That premise was false, and three of its four sections are now falsified by
measurement. The audit is DONE; what remains is a small, precise fix.

**How it was measured.** Nine reachable Maven projects carry `mvnw` wrappers and the local
`~/.m2` (2.1 GB) caches eight surefire versions, so the audit ran fully offline. A real
multi-module project (139 tests, 2 test classes) was copied to scratch — never building in the
source repo — and driven with `./mvnw -o`.

**Measured results, replacing the original §S1–§S4 assumptions:**

| Original premise | Measured outcome |
|---|---|
| §S1 — may be unexercisable, no Java project to hand | **FALSE.** Exercised end-to-end against real surefire |
| §S4 — `_MVN_RUNNING_LINE` may not match | **MATCHES.** 2/2 classes extracted, on surefire **3.2.5 and 3.5.4** |
| §S3 — agent env may suppress narration | **DOES NOT REPRODUCE.** Identical output with `CLAUDECODE`/`AGENT`/`REPL_ID`/`CI` set and unset |
| §S2 — `-B` pins the format | **Safe but inert today.** Identical `Running` lines and an identical surefire report file set |

Real surefire emits, on both versions tested:

```
[INFO] Running org.fourpm.mdx.topogen.generator.TopologyGenerationServiceTest
```

`_MVN_RUNNING_LINE` (`clients/mvn-crucible.py:362`) matches it because `(?:^|\s)` accepts the space
after `[INFO]`. Granularity is per CLASS, inherent to surefire, not a defect.

**§S3 does not transfer, and that is a finding, not an omission.** The quieting half of the bun
defect was a *bun* behaviour — bun detects an agent session and suppresses per-test output. Maven
has no agent detection. Verified directly: the narrated `Running` lines are byte-identical with all
four variables set and unset. `bun-crucible.py` drops those variables (`:767`, `:844`); mvn never
has and does not need to.

**`-B` is inert because of HOW the client invokes Maven.** `_run_logged` (`:449`) reads
`proc.stdout` through a pipe, so Maven's own TTY detection already degrades it to plain,
non-ANSI output. `-B` still belongs in the command as defence-in-depth — it makes the mode
explicit rather than a consequence of pipe detection — but it is not a fix for a live break.

**The live defect is in the TEST.** `STREAMING_MVNW_SCRIPT` (`tests/clients-narration.test.ts:356`)
is a fake `mvnw` that emits:

```
Running com.acme.AlphaTest
```

— **without the `[INFO] ` prefix real Maven always emits.** It was hand-written to satisfy the
regex, so the test confirms the narrator against itself rather than against Maven. It passes either
way, and would keep passing if the regex and Maven's real format diverged in either direction. That
is exactly the CR-047 defect class — *"the only symptom was a test asserting narration had
occurred"* — living one layer up, in the fixture.

## Scope

### §S1 — Make the mvn narration fixture emit REAL surefire console format
`STREAMING_MVNW_SCRIPT` must reproduce what surefire actually prints, `[INFO] ` prefix included, so
the test exercises the regex against Maven's format rather than against a format written to fit it.
Keep the existing streaming/timing shape — the throttle assertions depend on it. The
`Tests run: …` completion lines must likewise carry their real prefix and the `-- in` separator
that surefire 3.x emits.

### §S2 — Pass `-B` on the narrated invocations
Add `--batch-mode` to the Maven commands the narrator reads, so the output mode is pinned
explicitly instead of inherited from pipe detection. Assert the surefire/failsafe report files the
ingest path parses are unchanged by it — measured identical, and the assertion keeps it that way.

### §S3 — Record the surefire versions the regex is pinned against
A comment beside `_MVN_RUNNING_LINE` naming the versions verified (3.2.5, 3.5.4) and the exact line
form matched, so the next drift is diagnosable rather than mysterious. This is the durable output of
the audit — without it the measurement is lost the moment this CR closes.

## Acceptance criteria
- [ ] `STREAMING_MVNW_SCRIPT` emits real surefire console format (`[INFO] Running <FQCN>` and
      `[INFO] Tests run: … -- in <FQCN>`); the existing narration test still passes against it.
- [ ] A test asserts the fixture's `Running` line carries the `[INFO] ` prefix — so the fixture
      cannot silently drift back to a hand-fitted format.
- [ ] `-B` / `--batch-mode` is passed on the narrated Maven invocations — asserted.
- [ ] The surefire/failsafe report file set the ingest path parses is unchanged by `-B` — asserted.
- [ ] The verified surefire versions (3.2.5, 3.5.4) and the matched line form are recorded in a
      comment beside `_MVN_RUNNING_LINE`.
- [ ] Full Python regression green AND full bun regression green (client change → both gates, per
      CR-CRU-045 §S3).

## Non-goals
- **Environment parity (the original §S3).** Falsified by measurement — Maven does not suppress
  narration under `CLAUDECODE`/`AGENT`/`REPL_ID`/`CI`. Recorded in Context; no code changes.
- Rewriting mvn narration to per-test granularity. Surefire reports per CLASS; that is its
  contract, not a defect.
- The bun narrator (CR-CRU-047 owns it) or the three clients with no narrator — inventory
  re-confirmed: only `bun-crucible.py:234` and `mvn-crucible.py:394` define a `_Narrator`.
- Unifying the duplicated `_Narrator` into `_crucible_axi.py`. It is a genuine duplicate that
  CR-CRU-054 did not lift, but it belongs to the ~25 uninventoried duplicates tracked in the queue
  Notes (§S3b), not here.
- Introducing a Java sample project into this repo. The audit reached real Maven projects already
  present on the machine; the repo stays Java-free.

## Risk
- **`-B` changes Maven's console output, which other parsing in the client may depend on.** Sweep
  for other console-text readers in `mvn-crucible.py` before landing (`:890` reads
  `r.stdout.splitlines()`) rather than assuming the narrator is the only one. Measured safe on the
  report-file side; the console-reader sweep is the open half.
- **Making the fixture realistic could expose a regex that only ever matched the fake.** That is the
  point of the change, not a reason to avoid it — but if the narration test goes red on the real
  format, the regex is the thing to fix, never the fixture.
- **Only surefire 3.2.5 and 3.5.4 were exercisable offline.** 3.0.0-M7 could not run — its
  `surefire-junit-platform` provider jar is absent from the local repo and the probe was offline.
  One reachable project pins 2.22.1, which is likewise unverified. The comment must state the
  versions actually tested rather than implying a range that was not.
