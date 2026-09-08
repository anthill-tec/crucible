# CR-CRU-112 — the gate covers every declared suite

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 047, 111
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-testing-tiers-in-crucible-projects.md` — "The gate
  contract" (every clause: declared suites, per-stack ingest, `regression` means the union, additive
  never exclusionary, the guarded partition), STANDING DECISION 1, and decision **D4** for the
  declaration seam this CR reads

## Context

`pre-merge-gate` runs `check` (tsc) then `regression` (`bun test`), so it gates exactly what one
runner collects. In this repo that silently excluded **65 files / 1445 tests** of python client
coverage: `clients/bun-crucible.py` contains no `pytest`/`unittest` reference at all.

The cost is measured, not hypothetical. CR-CRU-108 published `tracks` beside `entries` and made an
omitted list a hard stop (`queue-track-fact-unpublished`); that broke CR-CRU-107's AC8 test in
`tests/client/test_plan_file_cycle_flag_help.py`, whose stub published no `tracks`. **Both CRs
shipped green.** Neither gate was faulty — each ran everything it could see, and a suite the gate
cannot see is not gated. Running the python suite by hand on 2026-09-08 found the failure in 82 s.

**Surfaces (verified 2026-09-08):** `cmd_pre_merge_gate` and `cmd_regression` in
`clients/bun-crucible.py`; `_bun_test_cmd`, which builds the invocation from targets or the whole
suite; `_xmlrunner_cmd(python, targets, start_dir, pattern, reports_dir)` in
`clients/python-crucible.py`, which already accepts `--start-dir` and `--pattern`;
`tests/suite-integrity.test.ts`'s `discoveryExclusions` and the `pathIgnorePatterns` assertions.

## Scope

### §S1 A project declares its suites, and the gate runs all of them

The gate's scope becomes the project's declared suites rather than one runner's discovery. A project
declares each suite with the stack that owns it, and each suite ingests through THAT stack's client —
python tests through `python-crucible.py`, TS through `bun-crucible.py`. No client learns to run
another language's tests.

A gate that ran a subset reports as a gate that ran a subset: the envelope names the suites it ran
and, if any declared suite was skipped or unavailable, the gate does not report a pass.

**THE DECLARATION IS CR-CRU-111'S, EXTENDED BY ONE FIELD — ruled at gap analysis, and it is what the
Risk section demanded.** That section warned this CR could grow "a second, competing description of
the project's tests beside the tier targets of CR-CRU-111" and required that "one declaration serves
both". CR-111 shipped `DeclaredTierSurface(target, names, read, run, add_args)` with a per-stack
`read` — the seam this CR needs already exists, so this CR adds a **stack** to a declared target and
defines the rest in terms of it:

- a declared target names the STACK that owns it (absent → the reading client's own stack, so every
  existing declaration keeps its meaning);
- a **suite** is simply a declared target owned by a stack, and one owned by a stack OTHER than the
  invoked client is dispatched to that stack's client rather than run locally — which is §S1's "no
  client learns another language's tests", enforced by construction instead of by discipline;
- **`regression` is the union of the declared targets** (§S2), computed from the declaration rather
  than from a second list.

No new artifact, no second format, and nothing for the two descriptions to drift apart on.

**The composition lives in `clients/_crucible_axi.py`, once.** All five clients have their own
`cmd_pre_merge_gate` (`check` → `regression`), so a gate that dispatches per-suite must be shared or
it will be written five times and diverge — the same argument that made `add_tier_verbs` shared in
CR-CRU-111. Each client supplies only how to invoke a sibling client for a stack.

**What already exists, and why it does NOT satisfy this CR (measured on `develop`@`e7dad2d`).**
`package.json` declares `test:unit`, `test:integration`, `test:client`, `test:regression` and
`test:e2e`, and `scripts/run-test-target.ts` ALREADY runs the union: `test:regression` runs
`bun test` and then `python3 -m unittest discover -s tests/client`, returning the worse exit code. So
§S2's union is not new — but that path invokes python DIRECTLY, so **nothing is ingested for the
python suite, no run carries the python stack, and the gate never consults it**. The union exists in
a place the gate does not look, which is why CR-CRU-107/108 still shipped green. §S2 is therefore a
re-reading of an existing verb only in its OUTCOME; the mechanism is the declaration the gate reads.

**`test:e2e` is DECLARED and deliberately OUTSIDE the gate.** The repo declares a fifth script
(`bunx bddgen && bunx playwright test`). Read literally, "the gate covers every declared suite" would
drag it in, while this CR's own non-goals defer e2e ownership to DN open question 5. Both cannot
hold, so the answer is stated explicitly rather than omitted — an omission by silence leaves the next
reader unable to tell a decision from an oversight.

**Gate coverage is a property of the TIER, not a per-project flag — ruled after cycle 388's RED
showed a `package.json` script table cannot carry one.** `TIER_MEANINGS` already lives in
`clients/_crucible_axi.py` as the fleet's one mirror, so the tier that is not gate-covered is named
there, beside the vocabulary it belongs to. `e2e` is excluded fleet-wide with DN open question 5
cited; every other tier is covered. This invents no format, adds no per-project field, and keeps the
client owning the mapping exactly as the DN's layering requires. A project that wants its e2e suite
gated is a decision for the CR that answers open question 5.

**The envelope shape is NAMED here, so "named" and "attributed" are checkable.** The gate's envelope
carries `suites[]`, one entry per declared target: `{suite, stack, gated, passed, failed, total}`,
the counts FLAT on the row that names the suite. A not-gate-covered target appears with
`gated: false` and no counts. One flat total for two suites does not satisfy AC1.

*(The counts were first ruled as a nested `run: {…}` sub-object; that layout was withdrawn at cycle
388's GREEN. The requirement is that the counts hang off the entry NAMING the suite, and a nested
sub-object does not contain the suite name — so the flatter row satisfies the requirement and the
instrument both. A RED instrument is not edited to accommodate a layout invented after it.)*

**How a suite's STACK is known, and why nothing new is declared.** `DeclaredTierSurface` gains
exactly one field — `suites`, returning `(target, command)` pairs — and the stack is DERIVED from the
declared command by one shared rule: a sibling client named in it, else the stack's interpreter as
the command's first token; absent, the reading client's own stack. So a project states its suites in
the words it already writes, and `test:client` reading `python3 -m unittest discover -s tests/client`
is a python-owned suite by inspection. This repo's own line is changed to exactly that, dropping the
bun indirection: the script still runs locally with no agent and no ingest, while the GATE does the
client dispatch itself and supplies its own `--agent`. Making the script BE the client invocation
would have made every local `bun run test:client` demand an agent and ingest to the live board.

**All five gates route through the one composition** (rule 15 — "the gate composes the suites" is
otherwise satisfied by one client). Enumeration turned out cheaper than feared, and it was measured
rather than assumed: because mvn/rust/arduino declare targets by the template `<tier>` /
`junit-<tier>`, the complete set of declarable names IS the tier vocabulary, so enumeration is
CR-CRU-111's own `read` asked six times — **no new parsing code in any client**. python alone cannot
enumerate (its declaration IS the invocation, CR-CRU-111 ruling 1), so its composition answers with
the fallback: this client's own regression, which is AC4's single-suite case rather than a hole.

**`regression` is never a member of the union** — a union is not an element of itself, so a declared
`test:regression` is skipped by the composition rather than run twice.

### §S2 `regression` means the union

A `regression` run of a multi-suite project covers every declared suite. Where a project declares
one suite, behaviour is unchanged — this repo's own bun `regression` keeps its current shape and
gains the python suite beside it, not inside it.

### §S3 No suite is gained by hiding files

Suites and targets narrow an invocation by naming paths. Nothing in this CR may introduce a
discovery exclusion: `bunfig.toml` carries no `pathIgnorePatterns` (CR-CRU-047 §S1) and
`tests/suite-integrity.test.ts` asserts the key is absent, because a permanently-excluded directory
makes suite size unreconcilable.

## Acceptance criteria

- **AC1** — with two GATE-COVERED suites declared (this repo: the bun suite and `tests/client` under
  python), a single gate invocation runs BOTH and its envelope names both, with the per-suite
  pass/fail counts attributed to the suite that produced them. Asserted alongside the negative: the
  declared-but-not-gate-covered target (`test:e2e`) is NOT run by the gate and is named as excluded
  rather than absent, so "the gate covers every declared suite" cannot be satisfied by a declaration
  that quietly omits one.
- **AC2** — a declared suite that fails fails the gate: exit non-zero, `ok:false`, and the failing
  suite named in `warnings[]`. Asserted by planting one failing python test and one failing bun test
  in a fixture project, separately — two assertions, because a gate that only notices the first
  runner's failure is the defect this CR closes.
- **AC3** — a declared suite that cannot be run (missing interpreter, missing start-dir) fails the
  gate with the suite and the reason named. It may NOT be silently skipped, and it may NOT report a
  pass.
- **AC4** — a single-suite project's gate output is unchanged: same steps, same envelope shape, same
  exit codes, asserted against a one-suite fixture.
- **AC5** — each suite's runs are ingested by its own stack's client, asserted on the POST BODY each
  ingest sends (the rows are made of those bodies, and the wire is what every sibling tier suite
  asserts on — no live-board dependency): the python suite's run carries the python stack and the bun
  suite's carries the bun stack, from ONE gate invocation. The DISPATCH is asserted too, not just the
  field: the python suite must be run by invoking `python-crucible.py`, because a test that checked
  only the `stack` value would pass if the bun client ran the tests and mislabelled them.
  **Measured at RED: `python-crucible.py` sends no `stack` key at all**, so nothing this repo has ever
  ingested from the python suite was attributable to it. Closing that is part of this AC.
- **AC6** — `bunfig.toml` still carries no `pathIgnorePatterns` and `tests/suite-integrity.test.ts`
  passes unchanged; the count of discovery exclusions the repo declares is still zero, asserted by
  that file's own `discoveryExclusions` over the real config.
- **AC7** — this repo's own gate, driven end to end, reports the python suite beside the bun suite's,
  and the CR-CRU-107/108 regression is demonstrably caught: with the CR-CRU-108 `tracks` fix reverted
  in a scratch copy, the gate fails and names the python suite. **The figure is measured at
  implementation time, not quoted from this AC:** the suite was 1445 tests / 65 files when this CR
  was filed and is **1615 / 72** on `develop`@`e7dad2d` (CR-CRU-111 added seven files), so a frozen
  number here would be wrong before the branch was cut. Assert the suite is present and its counts
  attributed, never a literal total. `scripts/run-test-target.ts:7` still says "the 65-file python
  client suite (1445 tests)" and is corrected in the same commit.
- **AC8** — caller existence: a grep at VERIFY time returns ≥1 non-test caller of the multi-suite
  gate path, and the standing python gate step is invoked from the gate itself rather than only from
  documentation.

## Estimated size

M — the declaration seam and the gate's composition. §S2 is a re-reading of an existing verb rather
than new machinery; AC7's reverted-fix reproduction is the expensive assertion.

## Risk

A gate that runs more can fail more, and the first honest run of this repo's gate will surface
whatever else the python suite has been hiding. That is the point, but it means the CR's own gate run
is the first place a pre-existing python failure can appear — which is a finding to record, not a
reason to narrow the gate.

The declaration seam risks becoming a second, competing description of the project's tests beside
the tier targets of CR-CRU-111. One declaration serves both or they will drift; that coupling is why
this CR depends on 111.

## Non-goals

- **Any server-side change.** The gate composes CLIENT-side; each suite ingests through its own
  stack's client using the endpoints and the `{tier, stack, context}` contract the server already
  declares (`src/v2.ts`, `src/store.ts`). No new field, endpoint or enum value.
- **Guarding a project's own target partition.** The DN's gate contract names it as a clause, and it
  is PROJECT-side: here `tests/test-targets.test.ts` asserts that every test file belongs to exactly
  one non-regression target. This gate asserts SUITE coverage — that every declared suite ran and
  none was skipped — not that a project's targets partition its files correctly. Building a
  cross-project partition checker into the gate would be machinery for a guarantee each project can
  make locally in one test.
- Teaching any client to run another language's tests.
- Changing what `e2e` covers or who ingests it (DN open question 5).
- Fixing whatever the python suite reveals beyond the CR-CRU-107/108 case named in AC7 — with ONE
  exception, ruled at cycle 388's RED because it is this CR's own prerequisite: the branch baseline is
  **1615 / 2**, not 1615 / 0. Two tests in `tests/client/test_client_tier_verb_contract.py` compare
  against `develop` as a BASE REF (CR-CRU-111's AC16 flag-retention proof), and that comparison went
  degenerate the moment CR-CRU-111 merged into `develop` — the base and the tree became the same
  thing. A self-invalidating test is repaired here, not deferred: the comparison is re-pinned to a
  NAMED, DATED snapshot of the eight migrated verbs' option sets, which is the durable form of the
  same guarantee and cannot rot when a branch merges. It is also a live instance of this CR's own
  thesis — the bun gate cannot see it, which is why it reached `develop` at all.
