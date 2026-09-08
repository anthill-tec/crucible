# CR-CRU-110 — the printed-help test answers the same way whatever ran before it

- **Type**: bug
- **Wave**: 5 (0.2.0)
- **Depends on**: 097
- **Status**: PENDING (0.2.0)
- **Design reference**: none — this is a test-isolation defect, not a design surface. The contract being protected is `CR-CRU-030` §S15 (per-verb `help[]`) as asserted by `CR-CRU-097` §S2/AC2.

## Problem

`tests/project-namespace-tripwire.test.ts`'s CR-CRU-097 §S2/AC2 test drives every client verb's
`--help` for real — 163 verbs across five clients, **168** surfaces (5 root + 163) in batches of
eight — behind a 180 s timeout. Standalone it passes in **3.1 s** (measured 2026-09-08,
`develop`@`8640e4c`; 57x headroom against the cap). Paired IMMEDIATELY BEFORE it, the Chromium
geometry suite makes it hit the cap exactly:

```
bun test tests/roadmap-visual-grammar.test.ts tests/project-namespace-tripwire.test.ts
→ 110 pass / 1 fail, "this test timed out after 180000ms"   (measured 2026-09-07)
```

A gate that answers differently on re-run cannot gate. Three `pre-merge-gate` runs of one tree
reported 2122/1, 2122/1 and 2123/0, with every other slow test's duration identical to the
millisecond; three runs during CR-CRU-107's close-out reported 2171/0 twice and a 180 s hang once.

**ADJACENCY, NOT MERE PRECEDENCE — measured 2026-09-08 and it narrows this CR.** "Same process,
Chromium earlier" is NOT sufficient. In a full-suite run the Chromium suite executes at position
**137/152** and this test at **147/152** — ten files later, same process — and it passes in **3.2 s**
with the suite green (2183 pass / 0 fail, twice, JUnit-instrumented). The hang reproduces 4/4 only
when the two files are the WHOLE invocation, i.e. when Chromium is the immediately preceding file.
So the trigger is adjacency (or something the nine intervening files clear), and the defect reaches
us through TARGETED runs — which is how agents run tests — not through the gate's own full run.

**Bun's file order is not the argument order.** Passing this file FIRST does not make it run first:
four runs (both argument orders, native shell and MCP shell, before and after `touch`) executed the
Chromium suite first every time. mtime-ascending is falsified (this file is the OLDER of the two and
still ran second), and neither alphabetical nor size fits the probes. Whatever bun's rule is, the
reverse order is NOT producible by swapping two paths — which is why AC2 below no longer asks for
that.

**The obvious explanation is wrong, and was measured wrong before this CR was split out.**
CR-CRU-108 originally carried this defect and asserted the cause was subprocess starvation — "a
browser suite earlier in the process leaves subprocess spawning unusable for the rest of the run."
That is false. Measured 2026-09-07 on `develop`@`5c73302`:

| probe | result |
|---|---|
| `Bun.spawn` latency around a real `chromium.launch()` | **10.8 ms** before · **10.7 ms** with the browser open · **10.9 ms** after `close()` |
| open fds while the browser is up | 25, falling to 20 after close — no exhaustion |
| 32 spawns inside `bun test`, immediately after the Chromium suite | **344 ms** (10.8 ms each) — identical to running alone |
| a faithful replica of `collectHelpSurfaces` (5 clients, 163 verbs, batch 8) in that same post-Chromium process | **2.28 s, 0 fail** (per client 404 / 418 / 523 / 406 / 525 ms) |

So spawning is unaffected, and the collection loop itself is fast even after Chromium. The
process is not working, it is **waiting**: the failing pairing runs `real 3m22s` against
`user 14s / sys 4s`. The trigger IS Chromium-specific — the same file paired with a non-Chromium
suite is 63 pass / 0 fail in 3.4 s — but the mechanism is unidentified.

Because the mechanism is unknown, a remedy cannot be specified yet: raising the cap, batching the
spawns, or reducing the spawn count may each miss. §S1 is therefore a diagnosis, and §S2 is
whatever that diagnosis licenses.

## Scope

### §S1 Name the mechanism, by bisection, before changing anything

The difference between the failing test and a fast replica of its own loop is what the rest of its
file does. The bisection follows that:

1. Copy the tripwire file, delete every test except the help test, and pair the copy with the
   Chromium suite. **Passes** ⇒ a file-mate's residue is the trigger; **hangs** ⇒ the file's own
   module-level state is. (Note: `-t` name filtering CANNOT be used for this — it filters every
   file in the invocation, so the Chromium suite's own tests are skipped and Chromium never
   launches. That confound produced a false "it passes" reading during the split's analysis.)
2. From whichever half answers, bisect to the single statement, and state the mechanism in one
   sentence that predicts the failure.
3. Only then choose the remedy.

The output of §S1 is a named cause recorded in this CR, not a code change.

#### §S1 ANSWERED — the mechanism, named 2026-09-08 on `develop`@`a87af0a`

**One sentence.** After a file that has driven Chromium through playwright in the same bun process,
one child among a concurrently spawned batch has its stderr pipe torn down WITHOUT its reader
promise being settled and without the child being reaped — the child becomes a zombie, bun holds no
fd for it at all, so `new Response(proc.stderr).text()` can never resolve and the test waits until
its cap.

**What that predicts, and each prediction held:**

| prediction | measured |
|---|---|
| ONE child is lost while its siblings all succeed | wave of 8: seven finished within 6 ms of each other, `#1` never returned |
| it never completes — it is not slow | 20 s, 90 s, 150 s and 180 s caps all reached; no natural completion ever observed |
| the lost child EXITED, so the loss is bookkeeping, not the child | `/proc/<pid>/status` → `State: Z (zombie)`, `ps` → `[python3] <defunct>`, ppid = the bun test process |
| bun no longer holds the pipe it is waiting on | at stall: 536 open fds, of which **0 pipes**; `Max open files` 1 048 576, so no limit is in play |
| it is the STDERR read specifically | the watchdog names the await: `STALLED on w2#1 stderrRead`; the stdout read for that same child had already returned |
| any earlier spawn clears it | the same six variants that hang when run first ALL pass when the order is reversed (96 pass / 0 fail) |
| `spawnSync` is immune | full 168-surface loop via `spawnSync`, FIRST after the browser file: 168 surfaces, 0 non-zero exits, **12.00 s** |

**The bisection that isolated it**, in the order the steps were taken:

1. The reproducer still reproduces on `a87af0a`: 110 pass / 1 fail, **202.72 s**; the same file alone
   is 21 pass / 0 fail in **3.22 s**.
2. Step 1 of the bisection above — the tripwire copy with every test but the help test deleted —
   **hangs** (201 s). File-mates are exonerated; the trigger is not their residue.
3. Six variants of the spawn shape, each capped at 20 s: only the exact real shape hung. Reversing
   their declaration order made ALL SIX pass, which killed the shape hypothesis and revealed the
   condition is one-shot and cleared by any earlier spawn.
4. Narrowing what is required: one spawn after the browser file is **12.4 ms**; eight CONCURRENT
   trivial spawns are **15.3 ms**; eight concurrent REAL client help spawns are **85 ms**; the eight
   verbs of the batch that stalls, run alone, are **83 ms**. So neither concurrency, nor the client,
   nor any particular verb is the trigger.
5. The instrumented full loop names the stall point exactly: `arduino-crucible.py` batch 0 (nine
   spawns) completes in 80 ms, and batch 1 never completes.
6. Successive identical waves reproduce it without any verb variation — wave 0 completes, wave 1
   loses exactly one child — which is how the per-await watchdog and `/proc` snapshot above became
   possible.

**Why the earlier subprocess-starvation reading was wrong, restated with this evidence.** The
replica probe that ran in 2.28 s did not fail because it was a replica; it did not fail because
something before it had already spawned. Spawning is not degraded — 10.8 ms per spawn, `0` pipes
leaked, no fd or process limit approached. Exactly one child per triggering batch is dropped.

**Ownership.** This is a defect in `Bun.spawn`'s pipe/exit bookkeeping under state the playwright
file leaves in the process (bun still holds four `playwright-core/lib` fds and reports
`killed 1 dangling process` when that file ends), not in this repo's test. Pinned to
`bun 1.3.14 (0d9b296a)` per AC8. This project cannot fix bun; §S2 is therefore a remedy that does
not depend on the broken path.

**The position is not fixed, which is why the exposure is stated as a risk and not as a count.**
Across runs the lost child moved: once it was in the second wave of eight (spawns 9-16), once in
the third (spawns 17-24). So this is a race that becomes reachable once a file spawns enough
children, not a threshold at a known spawn number. Twelve test files use async `Bun.spawn` with a
piped stderr and five launch a browser, so this test is not structurally unique — it is simply the
one that spawns **168** times, which makes a rare loss near-certain. Three low-spawn files paired
immediately after the browser file stayed green (`toon-conformance` 1 spawn, `shim-retirement` 1,
`clients-narration` 2 — one repetition each, 109/121/106 pass, 0 fail), which bounds the practical
exposure without claiming those files are immune.

### §S2 The test answers the same way whatever ran before it

**The remedy §S1 licenses: collect the help surfaces with `Bun.spawnSync`.** It is the one shape
measured immune as the FIRST work after the browser file, it needs no cap change, no exclusion, no
skip and no second invocation, and it keeps all 168 surfaces and every assertion. Its cost is
measured, not assumed: **12.00 s paired / 11.70 s standalone**, against the existing 180 s cap —
15x headroom, where the async batched loop's 3.1 s had 57x. The trade is stated plainly: ~9 s of
wall time bought in exchange for a result that does not depend on what ran before it, in a file
that is INTEGRATION and already carries a browser suite's worth of cost.

Concurrency was the only thing the async shape bought, and the loop is I/O-bound on 168 python
startups; it was never the assertion. `spawnSync` also removes the `Promise.all` fan-out that made
the defect reachable at all.

Whatever §S1 names, the fix makes the CR-CRU-097 §S2/AC2 test order-independent. Three constraints
bound the remedy:

- **It may not weaken what the test asserts** (§S3).
- **It may not move the test out of the gate.** If the remedy is a separate invocation, then
  `pre-merge-gate` runs that invocation. A test the gate no longer runs is worse than a test that
  sometimes times out.
- **It may not be an exclusion.** The file stays discoverable by a bare `bun test`; see AC9.

**Standing infrastructure this CR inherits (maintenance, 2026-09-08, not a CR).** The suite now
carries `test:unit` / `test:integration` / `test:client` / `test:regression` targets, membership
DERIVED per file (browser, subprocess, HTTP server, live board, or any wait of a second or more) and
guarded by `tests/test-targets.test.ts` so no file falls outside every target. This test is
INTEGRATION and the Chromium suite is INTEGRATION, so both still share one invocation and the defect
is NOT dissolved by the split - which is why this CR stands rather than being absorbed by it.

### §S3 The assertions are unchanged

Every client verb's printed `--help` plus every client's root help is still driven for real and
inspected for a CR-namespace literal, and the non-vacuity floors stay exactly as they are: ≥150
surfaces, ≥25 verbs per client, all five root helps present, and no non-zero exit among them.

## Acceptance criteria

- **AC1** — the mechanism is NAMED in this CR before any remedy lands: one sentence that predicts
  the failure, plus the bisection evidence that isolated it. A remedy committed before AC1 fails
  this CR.
- **AC2** — `bun test tests/roadmap-visual-grammar.test.ts tests/project-namespace-tripwire.test.ts`
  is green. The order is stated as the one bun ACTUALLY produces (Chromium first, verified in the run
  output, not assumed from the argument order), and tripwire-first is proven by a SEPARATE
  invocation of each file rather than by swapping the two paths — a swap does not change bun's order
  and would evidence nothing.
- **AC3** — the help test's own count is unchanged and its floors are intact: ≥150 surfaces, ≥25
  verbs per client, five root helps, zero non-zero exits, and the same leak assertion. A test
  asserting fewer surfaces than before does not satisfy this CR — quote the surface count before
  and after.
- **AC4** — the test is still collected by `pre-merge-gate`. If the remedy introduces a second
  invocation, the gate runs it, proven by driving `pre-merge-gate` and showing the test's result in
  its output.
- **AC5** — three consecutive `pre-merge-gate` runs on one unchanged tree report the SAME
  pass/fail counts. Recorded in the close-out as three figures, not one.
- **AC6** — the Chromium suite that triggers it is unchanged, or its change is justified against
  what it exists to assert. `tests/roadmap-visual-grammar.test.ts` is CR-CRU-096/103's live-board
  corroboration; making it cheaper by asserting less fails this AC.
- **AC7** — the remedy is NEITHER of the two non-fixes this CR was filed to refuse: it does not skip
  or conditionally disable the test when a browser ran, and it does not consist solely of raising the
  180 s cap. Stated as an AC because AC1-AC6 are ALL satisfiable by "raise the cap to 600 s", which
  is the outcome the Risk section forbids in prose and prose is measured against nothing.
- **AC8** — if the remedy depends on the runner's scheduling, it says so and pins the version it was
  measured against (`bun 1.3.14`), so a runner upgrade re-opens the question deliberately.
- **AC9** — no test-discovery exclusion is introduced. `bunfig.toml` carries no `pathIgnorePatterns`
  (CR-CRU-047 §S1) and `tests/suite-integrity.test.ts` asserts the key is ABSENT, so any separation
  is additive - naming paths in one invocation - never a carve-out. A remedy that adds an exclusion
  fails that guard and this AC.

## Estimated size

S for §S2 once §S1 lands. §S1 is a bisection, not a build — bounded by the two experiments above.

## Risk

The remedy could make the gate quieter rather than more honest. Two shapes to refuse: skipping the
test when a browser ran (a gate that opts out of its own assertion), and raising the 180 s cap
alone (the answer would still depend on file order, which is the actual defect).

`bun test`'s per-file process model is what makes this order-dependent at all, so a remedy that
depends on bun's current scheduling should say so — a runner upgrade could re-trigger it.

## Non-goals

- **Hardening the other eleven async-spawn test files.** The exposure above is recorded as a
  finding, not fixed here: those files spawn one to three children each and none has been observed
  to lose one. Converting the fleet on the strength of a race none of them has hit would be a
  change with no failing test behind it. If one ever does hang, this CR's §S1 names the mechanism
  and the remedy is already proven.
- Reporting the defect upstream to bun, or waiting on a runner fix. AC8 pins the version so an
  upgrade re-opens the question deliberately.
- Fixing the Chromium suite's own resource handling beyond what AC2 requires.
- Changing what `CR-CRU-097` §S2/AC2 asserts, or which verbs it covers.
- The multi-track publication half of the original CR-CRU-108 — that CR keeps §S1–§S3 and its
  AC1–AC7/AC11, which are unaffected by this defect.
