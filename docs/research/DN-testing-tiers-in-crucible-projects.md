# DN — Testing tiers in Crucible-managed projects

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-09-08
**Status:** ACTIVE — the design authority for every testing decision in a Crucible-managed
project. Normative input to CR-CRU-111 (client tier surface) and CR-CRU-112 (gate composition).
Supersedes nothing; the tier vocabulary it governs already exists in `src/types.ts` and this
document states what the words MEAN.

## Why this document exists

Crucible records test runs under a `tier`, and the vocabulary has been in the wire since
CR-CRU-016 §S4 — but nothing ever said what a tier IS. The result, measured on this repo on
2026-09-08, is that the vocabulary is half-used and the gate is half-blind:

| measurement | figure |
|---|---|
| whole `bun test` suite before this date | 2183 tests / 152 files / **525 s**, of which **516 s was spent waiting inside tests**, not computing |
| the fast tail | 81 files ran 993 tests in **5.4 s** |
| the slow head | 13 files consumed **302 s** — 58% of the run |
| python client tests on disk | **65 files, 1445 tests, 82 s** |
| python client tests the gate ran | **zero** — `clients/bun-crucible.py` contains no `pytest`/`unittest` reference |
| tiers the bun client can produce | `unit` (every targeted run, regardless of what it touches), `regression`, `e2e` |
| tiers the server accepts | `unit \| module \| integration \| e2e \| regression \| bdd` (`src/types.ts`) |

Two defects follow directly, and both have already cost this project:

1. **A targeted run of a browser suite is recorded as `unit`.** `cmd_test` hardcodes the tier, so
   the board's own data misdescribes the run. `integration` is a tier the server accepts and the
   bun client cannot emit at all.
2. **A suite the gate cannot see is not gated.** CR-CRU-108 published `tracks` beside `entries`
   and made an omitted list a hard stop; that broke CR-CRU-107's AC8 test in
   `tests/client/test_plan_file_cycle_flag_help.py`. **Two CRs shipped green over it**, because
   `pre-merge-gate` runs `bun test` and the broken test is python. Nothing was wrong with either
   CR's own gate — the gate's SCOPE was wrong.

## What a tier is

**A tier names the DEPENDENCY a test takes, never its subject matter and never its size.** This is
the whole design decision; everything else follows from it. A test of the roadmap's geometry is not
"integration" because geometry is complicated — it is integration because it needs a browser.

| Tier | Takes a dependency on | Consequence the project accepts |
|---|---|---|
| `unit` | the process it runs in, and nothing else | must be CPU-bound; no clock, no port, no process, no disk service |
| `module` | one real component boundary in-process (a store on disk, a parser over fixtures) | fast but not free; may touch the filesystem |
| `integration` | something outside the process: a browser, a spawned process, an HTTP listener, a live service — or **real elapsed time** | slow by construction; may not gate a quick check |
| `e2e` | the assembled product driven as a user drives it | slowest; owns its own harness |
| `regression` | the union of every declared suite | the merge gate; see the gate contract below |
| `bdd` | a specification language over the assembled product | feature files, generated specs |

**Real elapsed time is a dependency.** A test that waits for a 5 s poll tick or a 10 s badge
cadence is observing the app's own clock; its subject IS time. Measured here: the marker-only
classification left `tests/cycle-timers.test.ts` in `unit` because it spawns nothing and serves
nothing — it merely sleeps through five ~11 s production timers, and it alone was 63 s. Waiting is
integration.

**Corollary — `unit` is falsifiable.** If a target claims to be unit and its wall time exceeds its
CPU time by much, the classification is wrong, not merely slow. That is the check that found two
misclassified files here: `test:unit` sat at 76.8 s wall against 20.4 s CPU, and the gap was one
file booting the real server (`startServer`, SSE reads against deadlines, 15.1 s) and one waiting
out two 6 s watchdog sleeps (12.7 s). After correction: **17.8 s wall, 16.3 s CPU — 92% CPU-bound.**

## Who classifies, and who drives — the portability boundary

The rule above is universal. The *evidence* for it is not.

- **The project classifies.** Membership is decided by what a file in THAT repo touches. Here the
  markers are `chromium.launch`, `Bun.spawn`/`spawnSync`, `Bun.serve`, `startServer`, `3849` and
  any declared wait ≥ 1 s. Another bun project has different ones. A client that shipped this list
  would be guessing another project's architecture.
- **The classification is DERIVED, never listed.** A hand-maintained manifest drifts the moment
  someone adds a test, and a file in no target is a test nothing runs. Deriving membership from the
  file's own source means a new browser test is `integration` on the day it is written.
- **The client provides the vocabulary, the drive and the ingest.** It should run a project-declared
  target, tag the run with the true tier, and refuse to mislabel. It should not decide which files
  are which.
- **The declaration seam is the project's own idiom.** For bun/npm that is `package.json` scripts
  (`test:unit`, `test:integration`); for maven, profiles; for cargo, features or `--test`. The
  client detects and drives the idiom rather than inventing a Crucible-specific config file.
- **Classification errs toward the slower tier.** A marker mentioned in a comment costs one file a
  slower bucket; a browser test hiding in `unit` costs the fast target its meaning.

## The gate contract

**A gate covers every DECLARED suite of the project, not every suite one runner can see.** A suite
the gate cannot see is not gated, and "the gate was green" then means only "the part of the gate
that exists was green".

- Each suite ingests through **its own stack's client** — python tests through
  `clients/python-crucible.py`, TS through `clients/bun-crucible.py`. A client does not learn to run
  another language's tests; that is what the fleet is for.
- **STANDING DECISION 1 (adopted 2026-09-08, user ruling).** This repo's gate includes
  `python3 clients/python-crucible.py regression --start-dir tests/client` alongside the bun
  `pre-merge-gate`. It needs no new code — `--start-dir`/`--pattern` already exist — and it closes
  the hole that let CR-CRU-108 break CR-CRU-107 across two green gates.
- **`regression` means the union.** A `regression` run that silently covers one language of a
  two-language project is a mislabelled run, not a partial one.
- **Additive, never exclusionary.** Targets narrow ONE invocation by naming paths. No project may
  gain a target by hiding files from discovery: `bunfig.toml` carries no `pathIgnorePatterns`
  (CR-CRU-047 §S1) and `tests/suite-integrity.test.ts` asserts the key is absent, because a
  permanently-excluded directory makes suite size unreconcilable.
- **The partition is guarded.** Every test file belongs to exactly one non-regression target, and a
  test asserts that (`tests/test-targets.test.ts`). Without it, targets reintroduce at the script
  level exactly the hazard the bunfig rule prevents at the config level.

## What an agent is expected to run

| situation | target |
|---|---|
| a quick check while editing code | `unit` — sub-20 s here, and it must stay CPU-bound |
| behaviour, geometry, a CLI surface, a real service | `integration` |
| the merge gate | `regression` — every declared suite, both languages |
| the assembled product | `e2e` (`bun run test:e2e`, separate harness) |

A RED/GREEN cycle picks the tier its contract lives in. A cycle that only ever runs `unit` has not
tested a browser contract, and a cycle that runs `regression` for every edit is paying 400 s to
learn what 18 s would have told it.

## Open questions — for refinement

These are deliberately unresolved; this DN is the place to settle them.

1. **`--tier` flag or per-tier verbs?** The fleet is inconsistent today: `mvn-crucible.py` exposes
   `unit` / `module` / `e2e` as verbs; `bun-crucible.py` exposes neither and hardcodes the tier. A
   flag is one surface for six values; verbs are discoverable in `--help` and match the existing
   mvn precedent. Whichever wins should win FLEET-WIDE (CR-CRU-075 set that precedent for
   `queue-file`).
2. **Is `module` worth exposing at all?** Nine files here open a real SQLite store on disk — genuinely
   `module` by the definition above, and currently `unit`. Adding the tier is honest; leaving it
   folded into `integration` is simpler.
3. **Does `unit` get a wall-vs-CPU assertion?** The corollary above is a real, cheap check
   (`resource.getrusage(RUSAGE_CHILDREN)`), and it is the only assertion that keeps `unit` honest as
   the suite grows. Should the client REFUSE a `unit` run whose wall time exceeds CPU by a stated
   factor, or merely warn in the envelope?
4. **Coverage per tier.** Coverage is currently a `regression --coverage` concern. Per-tier coverage
   would let a project see what its fast target actually protects — at the cost of a second
   instrumented run.
5. **Who owns `e2e` ingest?** `auto-ingest` tags `e2e` today. With explicit targets, e2e could be a
   first-class target with the same treatment as the others.
6. **How does a project declare its targets to the client?** Detect `package.json` scripts by
   convention, or read an explicit declaration? Convention is zero-config and idiomatic; explicit is
   unambiguous and stack-neutral.
7. **Does the mount cost deserve attention next?** The 17.8 s remaining in `unit` here is real CPU:
   happy-dom registration plus evaluating ~5000 lines of `public/app.js` per mount. Sharing a mount
   across tests within a file would cut it, at the cost of per-test isolation — a behavioural change
   per file, not a mechanical one.
