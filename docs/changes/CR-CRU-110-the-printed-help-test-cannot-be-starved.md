# CR-CRU-110 — the printed-help test answers the same way whatever ran before it

- **Type**: bug
- **Wave**: 5 (0.2.0)
- **Depends on**: 097
- **Status**: PENDING (0.2.0)
- **Design reference**: none — this is a test-isolation defect, not a design surface. The contract being protected is `CR-CRU-030` §S15 (per-verb `help[]`) as asserted by `CR-CRU-097` §S2/AC2.

## Problem

`tests/project-namespace-tripwire.test.ts`'s CR-CRU-097 §S2/AC2 test drives every client verb's
`--help` for real — 163 verbs across five clients, ~168 `python3` spawns in batches of eight —
behind a 180 s timeout. Standalone it passes in **2.5 s**. Run in the same `bun test` invocation as
the Chromium geometry suite it hits the cap exactly:

```
bun test tests/roadmap-visual-grammar.test.ts tests/project-namespace-tripwire.test.ts
→ 110 pass / 1 fail, "this test timed out after 180000ms"   (measured 2026-09-07)
```

A gate that answers differently on re-run cannot gate. Three `pre-merge-gate` runs of one tree
reported 2122/1, 2122/1 and 2123/0, with every other slow test's duration identical to the
millisecond; three runs during CR-CRU-107's close-out reported 2171/0 twice and a 180 s hang once.

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

### §S2 The test answers the same way whatever ran before it

Whatever §S1 names, the fix makes the CR-CRU-097 §S2/AC2 test order-independent. Two constraints
bound the remedy:

- **It may not weaken what the test asserts** (§S3).
- **It may not move the test out of the gate.** If the remedy is a separate invocation, then
  `pre-merge-gate` runs that invocation. A test the gate no longer runs is worse than a test that
  sometimes times out.

### §S3 The assertions are unchanged

Every client verb's printed `--help` plus every client's root help is still driven for real and
inspected for a CR-namespace literal, and the non-vacuity floors stay exactly as they are: ≥150
surfaces, ≥25 verbs per client, all five root helps present, and no non-zero exit among them.

## Acceptance criteria

- **AC1** — the mechanism is NAMED in this CR before any remedy lands: one sentence that predicts
  the failure, plus the bisection evidence that isolated it. A remedy committed before AC1 fails
  this CR.
- **AC2** — `bun test tests/roadmap-visual-grammar.test.ts tests/project-namespace-tripwire.test.ts`
  is green, and so is the reverse order.
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

## Estimated size

S for §S2 once §S1 lands. §S1 is a bisection, not a build — bounded by the two experiments above.

## Risk

The remedy could make the gate quieter rather than more honest. Two shapes to refuse: skipping the
test when a browser ran (a gate that opts out of its own assertion), and raising the 180 s cap
alone (the answer would still depend on file order, which is the actual defect).

`bun test`'s per-file process model is what makes this order-dependent at all, so a remedy that
depends on bun's current scheduling should say so — a runner upgrade could re-trigger it.

## Non-goals

- Fixing the Chromium suite's own resource handling beyond what AC2 requires.
- Changing what `CR-CRU-097` §S2/AC2 asserts, or which verbs it covers.
- The multi-track publication half of the original CR-CRU-108 — that CR keeps §S1–§S3 and its
  AC1–AC7/AC11, which are unaffected by this defect.
