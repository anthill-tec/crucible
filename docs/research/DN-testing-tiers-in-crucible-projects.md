# DN — Test event capture in Crucible-managed projects: the layered structure

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-09-08
**Status:** ACTIVE — the design authority for how a Crucible-managed project CAPTURES and PUBLISHES
test events, whatever its stack, and for every testing decision that follows from it. Normative
input to CR-CRU-111 (complete the client tier map) and CR-CRU-112 (gate composition). Supersedes
nothing: the tier vocabulary exists in `src/types.ts`, the per-subcommand tier map was contracted by
CR-CRU-008 §S2, and this document states the LAYERING those two imply and the drift against it.

## What this document governs

Crucible captures a test event from any project in any language and publishes it on one standard.
That is only possible because the CLASSIFICATION is universal while the MECHANISM is not — and that
single asymmetry is the reason the fleet has per-stack clients at all.

The structure has three layers, and almost every defect found in this area has been a layer reaching
into another's business:

| layer | owns | why it lives there |
|---|---|---|
| **the server** | the CLASSIFICATION and the captured record — `unit \| module \| integration \| e2e \| regression \| bdd` | "unit", "integration" and "e2e/BDD" mean the same thing in every language, so results can be compared across stacks and releases. This is why `Tier` is a server-side type and not a per-client string. |
| **the client, per stack** | the MAPPING from that stack's own testing approaches onto those tiers, and the local RUN that produces the event | maven has surefire and failsafe, cargo has `--lib` and `tests/`, arduino has three build systems, bun and python have nothing. The stack differences ARE why the clients are separate, so each client is the one place its stack's approaches are named in universal terms. |
| **the agent, per stack and per phase** | the CHOICE of which tier this task needs | it is a judgement about the requirement being implemented, not a lookup: RED reads the ACs, GREEN follows the failing contract, VERIFY takes the union. Guidance therefore lives in the per-stack `*-agent.md` definitions. |

**The invariant.** A client that decided which tier to run would be taking the agent's judgement. An
agent that hand-rolled a stack's invocation would be duplicating the client's mapping. A server that
accepted free-text tiers would surrender the comparability that justifies it.

## Layer 1 — the server: what a captured test event IS

A captured event is not just a pass/fail count. The record the server stores (`EventRow`,
`src/store.ts`) carries `tier`, `stack`, `codec`, `kind`, the counts (`total`/`passed`/`failed`/
`pending`), `duration_ms`, the suite `tree`, `coverage`, and — since CR-CRU-094 — the `cycle_id` it
was produced under; a run (`RunRow`) carries `tier`, `stack`, `context` and its lifecycle state.

**`tier` is the axis that makes the rest comparable.** Counts without a tier answer "did tests pass";
counts with a tier answer "what kind of confidence did this run buy". A run whose tier is wrong makes
every downstream reading wrong — the board reports coverage the project does not have — which is why
a mislabelled run is worse than an unlabelled one.

### What a tier means

**A tier names the DEPENDENCY a test takes, never its subject matter and never its size.** This is
the whole design decision; everything else follows. A test of the roadmap's geometry is not
"integration" because geometry is complicated — it is integration because it needs a browser.

| Tier | Takes a dependency on | Consequence the project accepts |
|---|---|---|
| `unit` | the process it runs in, and nothing else | must be CPU-bound; no clock, no port, no process, no disk service |
| `module` | one real component boundary in-process (a store on disk, a parser over fixtures) | fast but not free; may touch the filesystem |
| `integration` | something outside the process: a browser, a spawned process, an HTTP listener, a live service — or **real elapsed time** | slow by construction; may not gate a quick check |
| `e2e` | the assembled product driven as a user drives it | slowest; owns its own harness |
| `regression` | the union of every declared suite | the merge gate; see Layer 2's gate contract |
| `bdd` | a specification language over the assembled product | feature files, generated specs |

**Real elapsed time is a dependency.** A test that waits for a 5 s poll tick or a 10 s badge cadence
is observing the app's own clock; its subject IS time.

**Corollary — `unit` is falsifiable.** If a target claims `unit` and its wall time much exceeds its
CPU time, the classification is wrong, not merely slow. That check is the only thing that keeps the
tier honest as a suite grows (D3 makes it mechanical).

## Layer 2 — the client: the per-stack mapping

**The mapping is the client's contract. It was contracted by CR-CRU-008 §S2 — "send `tier` per
subcommand (unit/module/e2e/regression map)" — implemented in ONE client, and drifted everywhere
else.** `mvn-crucible.py:867` states it verbatim: *"CR-CRU-008 §S2 tier map: the subcommand name IS
the tier (unit/module)"*, with `_run_surefire_tier(args, extra, "unit")` passing `tier=label` into
the ingest. CR-CRU-008 is COMPLETED (merged `f0d5b99`); the design is shipped, so what remains is
drift. CR-CRU-111 completes it.

### Does the toolchain split the tiers itself?

Read off each client and its toolchain on 2026-09-08, not assumed:

| Stack | Toolchain splits tiers? | The stack approach → universal tier | Tier verbs TODAY |
|---|---|---|---|
| java / maven | **Yes** — surefire (`*Test`) vs failsafe (`*IT`)/`integration-test`; the client names `failsafe` in 36 places | maven lifecycle + profiles | `unit`, `module`, `e2e`, `regression`, `compile` |
| rust / cargo | **Yes** — in-crate `--lib` units vs `tests/` integration targets; the client passes `--test`/`--tests`/`--all-targets`, and nextest profiles (`-P ci`, `-P e2e`) carve a docker-infra tier | cargo target selection, plus `smoke-test` / `docker-e2e-gate` above | none named as tiers |
| arduino | **Yes** — three separate build systems: native host `g++`/`make`, `arduino-cli` target compile, HIL on hardware | whichever build the tier belongs to | `unit` (native) + `compile` (target); HIL is not a verb |
| bun / TS | **No** — `bun test` has no tier notion | a project-declared target: `package.json` scripts (`test:unit`, `test:integration`) | none (`test`, `regression`) |
| python | **No** — `unittest` discovery has none | a project-declared suite: `--start-dir` / `--pattern` per tier | none (`test`, `regression`) |
| vscode | **Yes, by runner** — Vitest vs Mocha under `@vscode/test-electron` | the runner the tier belongs to | no client yet |

### What each client puts on the wire today — the drift

| client | tier stamped TODAY | verdict against §S2 |
|---|---|---|
| `mvn-crucible.py` | parameterised `tier=label` from the subcommand, plus `e2e`, `regression` | **implements §S2** — the fleet's reference |
| `rust-crucible.py` | `unit` only (two call sites) | drifted — nextest profiles never reach the field, so `smoke-test` and `docker-e2e-gate` report as `unit` |
| `arduino-crucible.py` | **nothing** — posts to `/api/v2/runs/parsed` with no tier | drifted worst — all three build modalities fall to the server default, so a native-host run and a target compile are indistinguishable |
| `bun-crucible.py` | hardcoded `unit` / `regression`, `e2e` on auto-ingest | drifted — `cmd_test` claims `unit` for any file; `integration` unreachable |
| `python-crucible.py` | hardcoded `unit` / `regression` | drifted — same shape as bun |

**Levelling the VOCABULARY is right; levelling the MECHANISM would be wrong.** Forcing a bun-shaped
declaration onto cargo would duplicate a split cargo already makes.

### Who classifies which file — the portability boundary

- **The project classifies.** Membership follows what a file in THAT repo touches. Here: `chromium.launch`,
  `Bun.spawn`/`spawnSync`, `Bun.serve`, `startServer`, `3849`, and any declared wait ≥ 1 s. Another
  project's markers differ; a client shipping this list would be guessing another project's architecture.
- **Classification is DERIVED, never listed.** A manifest drifts the moment someone adds a test, and a
  file in no target is a test nothing runs.
- **It errs toward the slower tier.** A marker named in a comment costs one file a slower bucket; a
  browser test hiding in `unit` costs the fast target its meaning.

### The gate contract

**A gate covers every DECLARED suite of the project, not every suite one runner can see.** A suite the
gate cannot see is not gated, and "the gate was green" then means only "the part that exists was green".

- Each suite ingests through **its own stack's client** — python tests through `python-crucible.py`, TS
  through `bun-crucible.py`. A client never learns to run another language's tests; that is what the
  fleet is for.
- **STANDING DECISION 1 (adopted 2026-09-08, user ruling).** This repo's gate includes
  `python3 clients/python-crucible.py regression --start-dir tests/client` alongside the bun
  `pre-merge-gate`. No new code — `--start-dir`/`--pattern` already exist.
- **`regression` means the union.** A `regression` run covering one language of a two-language project
  is a mislabelled run, not a partial one.
- **Additive, never exclusionary.** No project may gain a target by hiding files from discovery:
  `bunfig.toml` carries no `pathIgnorePatterns` (CR-CRU-047 §S1) and `tests/suite-integrity.test.ts`
  asserts the key is absent.
- **The partition is guarded** (`tests/test-targets.test.ts`) — every file belongs to exactly one
  non-regression target, or targets reintroduce at script level the hazard bunfig prevents at config level.

## Layer 3 — the agent: choosing the tier is a judgement

**The client offers the verbs; the agent chooses.** The choice follows from the requirement being
implemented, so it cannot be a lookup table in a tool — and it differs by PHASE:

| phase | how it chooses |
|---|---|
| **RED** | from the **ACs**. The dependency the AC names fixes the tier: a pure transform → `unit`; a rendered geometry, a spawned CLI, an HTTP surface, anything that waits → `integration`; a user journey → `e2e`/`bdd`. An AC that does not say what it depends on is a spec gap — escalate it, do not guess. Prefer the cheapest tier that can actually falsify the AC. |
| **GREEN** | from its **context** — the failing contract. Run that tier, targeted, while iterating; do not pay the union per edit (measured: 433 s vs 17.8 s here). Before yielding, run the tiers the change can affect. |
| **FIX** | the tier of the finding, plus the tier that would catch its regression. |
| **VERIFY** | the **union** (`regression`), never the fast target alone, and check which tiers a cycle's runs actually covered — a browser contract is not verified by unit runs. |

**Never report a run under a tier it did not earn.** If the agent cannot tell, it says so and asks.

The carriers, therefore — this section is NOT a CR (an earlier draft made it one, CR-CRU-113, VOID
2026-09-08, which conflated a verb being AVAILABLE with a decision being MADE):

| carrier | states |
|---|---|
| each stack's RED / GREEN / FIX `*-agent.md` | the phase rule above in THAT stack's mechanism |
| each stack's VERIFY `*-agent.md` | the union, and the per-tier coverage check |
| the `crucible` skill | the vocabulary, what each tier means, and that the choice is the agent's |
| the orchestrator's dispatch brief | the target for the phase being dispatched, explicitly |

A generic paragraph across stacks would be wrong in four of six: a rust RED agent needs cargo's
`tests/` convention, an arduino agent needs to know a hardware contract is unreachable from the
native-host build, and a vscode agent needs the runner split.

## Evidence base — measured on this repo, 2026-09-08

| measurement | figure |
|---|---|
| whole `bun test` suite, before this date | 2183 tests / 152 files / **525 s**, of which **516 s waiting inside tests**, not computing |
| the fast tail | 81 files ran 993 tests in **5.4 s** |
| the slow head | 13 files consumed **302 s** — 58% of the run |
| python client tests on disk / gated | **1445 tests in 82 s** / **zero** — `bun-crucible.py` has no `unittest` reference |
| `unit` target after correction | 871 tests / **17.8 s**, 16.3 s CPU — **92% CPU-bound** |
| `--tier` flag implementations across the fleet | **zero** (`add_argument("--tier` in all seven client files) |

Two defects this already cost the project:

1. **A targeted browser suite is recorded as `unit`** — the board misdescribes its own data.
2. **A suite the gate cannot see is not gated.** CR-CRU-108 made an omitted `tracks` list a hard stop
   and broke CR-CRU-107's AC8 test; **both CRs shipped green**, because the gate runs `bun test` and
   the broken test is python. Neither gate was faulty — the gate's SCOPE was.

## Decisions

Recorded 2026-09-08 by the co-author, with reasoning, for the user to override.

- **D1 — the subcommand IS the tier, REAFFIRMING CR-CRU-008 §S2** rather than settling a new fork
  (closes Q1). The map is shipped design (see Layer 2); the drift is what remains. CR-CRU-008's flag
  list also named a `--tier` flag that was implemented in **zero** clients, and the subcommand map
  makes it redundant — so CR-CRU-111 RETIRES it from the contract explicitly rather than leaving a
  contracted flag that never existed. Cost accepted: the fleet verb-surface census (CR-CRU-075 §S2)
  moves, asserted rather than absorbed.
- **D2 — the verb set is the six tiers, uniformly** (closes Q2). `module` is exposed because the
  server accepts it and this repo already has its subject (nine files open a real store on disk). A
  stack that has declared no target for a tier answers a structured refusal naming the missing
  declaration: the tier existing and the project having one are separate facts, and conflating them
  is what let `cmd_test` claim `unit` for everything.
- **D3 — a mislabelled `unit` run WARNS, it is not refused** (closes Q3). The client compares wall to
  CPU time and carries a structured warning naming both figures. Warning, not refusal: classification
  is the project's decision, so the client reports the contradiction rather than vetoing it — but it
  MUST report it, or `unit` means nothing.
- **D4 — the modality is the TOOLCHAIN's where the toolchain has one; a project declaration only
  where it does not** (closes Q6). Three of five stacks already split the tiers natively, so asking
  those projects to declare anything invents a second description of a split their build system
  already makes. Only bun and python need a declaration. Five modalities, five assertions.

## How this DN decomposes

The decomposition is the co-author's recommendation and lives here plus the queue and board; the
layers above are the contract each CR implements.

| DN layer / section | CR | Carries |
|---|---|---|
| Layer 1 (what a tier means) · Layer 2 (the per-stack mapping) · D1–D4 | **CR-CRU-111** | the six verbs, the true tier on every run, each stack's own modality, the wall-vs-CPU warning, `--tier` retired |
| Layer 2's gate contract · STANDING DECISION 1 | **CR-CRU-112** | a gate over every declared suite, each ingesting through its own stack's client |
| Layer 3 (the agent's choice) | **not a CR** | the per-stack `*-agent.md` definitions, the `crucible` skill, the dispatch brief |
| Q4 (per-tier coverage) · Q5 (e2e ownership) | not yet filed | candidates; Q4 costs a second instrumented run, Q5 waits on 111 landing |
| Q7 (mount cost) | not a CR | maintenance task — per-file behavioural change, no design surface |

## Open questions — for refinement

Q1, Q2, Q3 and Q6 are settled as D1–D4. The numbering is kept so the CRs' references stay valid.

4. **Coverage per tier.** Coverage is a `regression --coverage` concern today. Per-tier coverage would
   show what the fast target actually protects — at the cost of a second instrumented run.
5. **Who owns `e2e` ingest?** `auto-ingest` tags `e2e` today. With explicit tier verbs, e2e could be a
   first-class target with the same treatment as the others.
7. **Does the mount cost deserve attention next?** The 17.8 s remaining in `unit` here is real CPU:
   happy-dom registration plus evaluating ~5000 lines of `public/app.js` per mount. Sharing a mount
   across tests within a file would cut it, at the cost of per-test isolation — a behavioural change
   per file, not a mechanical one.
