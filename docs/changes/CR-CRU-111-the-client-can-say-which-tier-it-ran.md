# CR-CRU-111 — the client can say which tier it ran

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 016, 075
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-testing-tiers-in-crucible-projects.md` — "What a tier is",
  "Who classifies, and who drives", and decisions **D1** (per-tier verbs), **D2** (the verb set is
  the six tiers), **D3** (a mislabelled `unit` run warns) and **D4** (the declaration seam is
  per-stack convention, enumerated per client)

## Context

`Tier` is `"unit" | "module" | "integration" | "e2e" | "regression" | "bdd"` (`src/types.ts`) and
the server has accepted the field since CR-CRU-016 §S4. The bun client can produce three of the six
and cannot produce `integration` at all: `cmd_test` stamps `tier="unit"` on every targeted run
whatever that run touches, so a targeted run of a real browser suite is recorded on the board as a
unit run. No client in the fleet accepts a `--tier` flag; `mvn-crucible.py` instead exposes `unit`,
`module` and `e2e` as verbs, so the fleet answers the same question two different ways.

**Surfaces (verified 2026-09-08):** `_ingest_parsed(..., tier=None)` and `_start_run(..., tier=None)`
in `clients/bun-crucible.py`; the two `tier="unit"` call sites in `cmd_test`; `tier="regression"` in
`cmd_regression`; `tier="e2e"` in `cmd_auto_ingest`; `cmd_unit`/`cmd_module`/`cmd_e2e` in
`clients/mvn-crucible.py`; `Tier` in `src/types.ts`; `recordTestEvent`'s `tier: meta?.tier ?? "unit"`
default in `src/store.ts`.

## Scope

### §S1 Per-tier verbs, fleet-wide (DN D1, D2)

Every client that runs tests exposes the tier as a VERB — the six values of `Tier` and no others —
registered from one place in `clients/_crucible_axi.py` beside the other fleet-wide verb surfaces
rather than hand-rolled per client. `mvn-crucible.py`'s existing `unit`/`module`/`e2e` verbs migrate
onto that registration and keep their behaviour; `bun-crucible.py`'s hardcoded tiers stop being
hardcoded.

A tier the vocabulary does not contain is a structured refusal. A tier the vocabulary contains but
the PROJECT has declared no target for is a DIFFERENT refusal, naming the missing declaration: the
tier existing and the project having one are separate facts, and conflating them is what let
`cmd_test` claim `unit` for everything.

### §S2 A run stops claiming a tier it did not earn — in EVERY client, at EVERY such call site

A verb no longer stamps a tier the caller did not state. A targeted run carries the tier the caller
names; absent a stated tier the run carries no tier and the server's own default applies, which is
honest, rather than the client asserting a fact it cannot know from a file path.

**The census that scopes this, measured on `develop`@`df6f9e6` — the defect is FLEET-WIDE, not
bun's.** Every `tier="..."` literal in every client, mapped to its enclosing function:

| client | `cmd_test` | `cmd_auto_ingest` | earned elsewhere |
|---|---|---|---|
| `bun` | `unit` :1065, :1089 | **`e2e` :1252** | `regression` :1175, :1219 |
| `mvn` | `unit` :1270, :1276 | **`unit` :1339**, `regression` :1346 | `e2e` :1097, `regression` :1226 |
| `python` | `unit` :686, **`unit` :696 (a COMPILE ingest)** | **`unit` :854** | `regression` :799, :817 |
| `rust` | `unit` :1085 | **`unit` :793** | — |
| `arduino` | **`unit` :608 (POSITIONAL)** | **`unit` :729 (DICT KEY)** | `unit` :614, `regression` :621, :787 — the verb IS the tier |

**The census above was WRONG for arduino, and the method is why (corrected at cycle 379's RED).**
It scanned `tier=` KEYWORD literals only. `arduino-crucible.py` states its tiers two other ways —
positionally (`_run_native_tests(args, "test", "unit", False)`) and as a dict key
(`"tier": "unit"`) — so a whole client read as "stamps nothing anywhere" when in fact it stamps on
every path, and has since before this CR was cut (`:576`, identical on `develop`). Two consequences,
both corrected here rather than quietly: the two arduino sites above ARE AC3 sites and were invisible
to cycle 378, and AC13's premise was false (see AC13). A census is only as wide as its instrument.

So the unearned stamp lives in `cmd_test` in FIVE clients and `cmd_auto_ingest` in FIVE, and
`auto-ingest` is the worse case: it runs no tests at all, it ingests report files it merely found, so
it cannot know the tier by construction — yet bun asserts `e2e` and mvn/python/rust assert `unit`
over the same discovered reports. A tier a verb states where `regression` or `e2e` IS the verb's own
name is EARNED and stays.

This is a requirement per call site, per client (AC3), because "the client stops claiming `unit`" is
satisfied by editing one line in one client.

### §S3 Each client runs the tier the way ITS OWN toolchain runs it (DN D4)

A tier verb runs the local modality that stack actually has, and reports the run under that tier.
Where the toolchain already splits the tiers, the client uses THAT split — asking such a project to
declare anything would invent a second description of a distinction its build system already makes.
Only where the toolchain has no tier notion does the project declare one. Per client, from the DN's
verified table:

**The question is per (client, TIER), not per client — corrected at gap analysis.** The earlier
five-row table answered "does this stack need a declaration?" once per client, but AC1 requires all
SIX tiers in all FIVE clients: that is 30 cells, and a per-client answer specifies at most twelve of
them. `module` and `bdd` have no toolchain split in ANY stack, and maven's lifecycle splits unit and
integration while saying nothing about `bdd`. Leaving those cells unnamed would hand eighteen
invented behaviours to GREEN.

**The rule that fills the matrix, and it is one sentence:** a tier runs through its stack's own split
WHERE THAT SPLIT EXISTS; where it does not, that tier requires a project declaration, and an absent
declaration is a refusal naming what to declare (AC6a). So "declaration needed?" is a property of
the cell, derived from the toolchain, never a property of the client.

| client | split the toolchain already makes | tiers it covers | every other tier |
|---|---|---|---|
| `mvn-crucible.py` | surefire (`*Test`) · surefire scoped to a reactor module (`-pl <m> -am`) · failsafe / `integration-test` | `unit`, `module`, `integration`, `e2e` | declared |
| `rust-crucible.py` | cargo target selection — `--lib` · `--test <t>` · nextest profiles (`-P ci`, `-P e2e`) | `unit`, `integration`, `e2e` | declared |
| `arduino-crucible.py` | three builds — native host `g++`/`make` · `arduino-cli` · HIL | `unit` ONLY | declared |
| `bun-crucible.py` | none — `bun test` has no tier notion | — | **all six** declared (`package.json` scripts) |
| `python-crucible.py` | none — `unittest` discovery has none | — | **all six** declared (`--start-dir`/`--pattern`) |

**Two corrections to this table, both measured at cycle 379's RED.** (i) rust's `--lib` and its
`--test <t>` tier selection DO NOT EXIST in the shipped client — `--lib` appears **zero** times in
`rust-crucible.py`, and `--test <t>` is shipped only on the untiered `test` verb, so cargo's split is
real in the TOOLCHAIN and unreachable from any tier verb. These selectors are therefore something
this CR BUILDS, not something it wires up. (ii) arduino's `integration` is NOT a split cell: the
client has one `--dir` flag (default `tests/native`, with `tests/native-mock` named in its help for
the ArduinoFake tier), and two directories behind one flag is not a distinction the client can READ.
So arduino has exactly ONE split cell, `unit`, and `integration` is declared like the rest. The
earlier "(+ `integration` where the native build separates it)" was a hedge, and a hedge in a matrix
is an invented cell.

**The rust gate verbs' tiers, STATED HERE because the DN does not contain them.** AC12 cited "the
tier the DN's mapping gives them"; the DN's rust row points at "`smoke-test` / `docker-e2e-gate`
above" and there is no such section above it (checked, and `smoke-test` appears nowhere else in the
DN). The mapping is therefore ruled here: `docker-e2e-gate` and `smoke-test --profile e2e` are
**`e2e`** — the profile name, the verb name and a live compose stack all agree — and the default
`smoke-test` under `-P ci` is **`integration`**, because a workspace-wide nextest run covers cargo's
`tests/` integration targets and is on no reading a unit run.

**What a refusal NAMES, per stack (AC6a).** A declared cell's refusal is only useful if it names the
surface the project must actually declare on: bun → a `package.json` script; python → a
`--start-dir`/`--pattern`; maven → a profile in `pom.xml`; cargo → a profile in
`.config/nextest.toml`. `regression` in bun and python is EXCLUDED from AC6a: that verb already
means the whole suite by design, and what the union comprises is CR-CRU-112's subject, not a
declaration this CR can demand.

mvn's `module` verb is NOT a name collision: its shipped help already reads "MODULE tier: mvn clean
test [-pl <module> -am]", so the module tier is maven's reactor scoping and CR-CRU-008 §S2's
lineage holds (checked, not assumed).

The client never classifies files: which file is which is the project's decision (DN, "the
portability boundary"). This is a requirement per CELL, and levelling the vocabulary must not level
the mechanism.

### §S4 A `unit` run that waits says so (DN D3)

The client measures a run's wall time against its CPU time and, when **wall exceeds CPU by 2x or
more**, carries a structured warning naming both figures and the factor. It does not refuse:
classification is the project's decision, so the client reports the contradiction rather than
vetoing it — but it must report it, or `unit` means nothing as a suite grows. This is the DN's
falsifiability corollary made mechanical; without it the tier definitions are prose.

**The factor and the mechanism are STATED, not left to GREEN** — "the stated factor" was stated
nowhere. Both are measured (gap analysis, 2026-09-08): child CPU comes from
`resource.getrusage(resource.RUSAGE_CHILDREN)` deltas taken around the existing `subprocess.run`
call — stdlib, no dependency, and unused anywhere in `clients/` today. Measured discrimination: a
sleeping child reads **38.4x**, a CPU-bound child reads **1.00x**, and this repo's own `test:unit`
target reads **1.09x** (17.8 s wall, 16.3 s CPU). 2x therefore sits ~1.8x above a real unit suite
and ~19x below a sleeping one. Note the asymmetry deliberately: `RUSAGE_CHILDREN` sums CPU across
cores, so a parallel runner reads BELOW 1x and can never false-positive.

### §S5 The envelope states the tier it ingested

The AXI envelope names the tier of the run it just ingested, so an orchestrator reading the envelope
knows what was covered without inspecting the board. Every exit path states it — success, failure,
zero-discovery and the compile-tier fallback alike.

## Acceptance criteria

- **AC1** — each of the six `Tier` values of `src/types.ts` (`unit`, `module`, `integration`, `e2e`,
  `regression`, `bdd`) is an invocable VERB in **EACH of the five clients**, asserted by driving
  every client's own `--help` and then the verb itself, not by reading source. Five assertions and
  the client count asserted — "the client exposes the verbs" is satisfiable by one client (DN D2:
  the set is the six tiers, *uniformly*). A seventh name is `invalid choice` from argparse's own
  refusal, and the six appear in each root help's choices group.
- **AC2** — the tier a run is stamped with is the tier the caller stated, asserted on the POST body
  the client sends (`payload["tier"]`) for each of the six values.
- **AC3** — a verb with no stated tier sends NO `tier` key: asserted on the POST body (the key is
  absent, not `"unit"`) at EACH of the eight unearned call sites §S2 enumerates — `cmd_test` in bun
  (:1065, :1089), mvn (:1270, :1276), python (:686), rust (:1085), and `cmd_auto_ingest` in bun
  (:1252, today `e2e`), mvn (:1339), python (:854) and rust (:793). The count of corrected sites is
  itself asserted, and a `tier="..."` literal surviving anywhere outside a verb whose own NAME is
  that tier fails this AC. `auto-ingest` is asserted explicitly: it runs no tests, so it may state
  no tier at all.
  **Two clarifications from RED, because each hides a way to pass while failing.** (i) bun's two
  `cmd_test` sites are DIFFERENT endpoints — `:1065` opens the run (`POST /api/v2/runs/start`) and
  `:1089` ingests it (`POST /api/v2/runs/parsed`) — and both must be tier-less: the run ROW is what
  the board's tier column reads first, so fixing the ingest alone leaves the run still stamped
  `unit`. Asserted per endpoint, not per verb. (ii) The `tier=` PARAMETER stays everywhere it is:
  mvn's earned `unit`/`module` verbs reach the same helpers through
  `_run_surefire_tier(..., tier=label)`, so this AC is satisfied by changing unearned CALL SITES,
  never by deleting the parameter. The converse pins are what catch that overshoot.
- **AC4** — the tier surface is registered from ONE place for every client that runs tests by
  `add_tier_verbs(sub, funcs, *, parents=(), add_args=())` in `clients/_crucible_axi.py`. The name is
  FIXED here, not left to GREEN: the fleet's own convention is plural for a multi-verb registrar
  (`add_roadmap_verbs`) and singular for a single-verb one (`add_next_verb`, `add_cr_depends_verb`,
  `add_queue_file_verb`), and an unnamed registrar makes AC4 fail on a naming disagreement rather
  than on a defect. The registrar-parity check counts the call sites: it is invoked by EACH of
  `bun-crucible.py`, `python-crucible.py`, `mvn-crucible.py`, `rust-crucible.py` and
  `arduino-crucible.py`, proven by a derived count over the five files rather than by a frozen list.
- **AC5** — EVERY pre-existing verb whose name is already a tier keeps its behaviour and its own
  flags after migrating onto the shared registration — not mvn's three alone. Enumerated on
  `develop`@`d804286`, because "the migration" was written as if only mvn had such verbs:
  `mvn` `unit` :1885, `module` :1893, `e2e` :1906, `regression` :1918 · `arduino` `unit` :1066,
  `regression` :1072 · `bun` `regression` :2010 · `python` `regression` :1373. Eight verbs across
  four clients; `rust` is the only client with no collision.
  **The ruling, so GREEN does not invent one:** the shared registrar supplies the NAME, the help
  text and the tier binding; everything stack-specific rides the `parents=`/`add_args=` injection
  the existing `add_roadmap_verbs` pattern already provides. So `arduino unit` still runs
  `make junit` under `--dir tests/native` and `arduino regression` still takes `--coverage` and its
  lcov path. Asserted PER colliding verb — eight assertions — and a flag lost in the migration fails
  this AC.
- **AC6** — each TOOLCHAIN-SPLIT cell of §S3's matrix runs through that stack's own split, asserted
  against a fixture project of that stack: maven's surefire / `-pl <m> -am` / failsafe lifecycle,
  cargo's `--lib` / `--test` / profile selection, arduino's native-host build. The invocation the
  client builds is the stack's own, and the ingested run carries the verb's tier. Every split cell is
  asserted and the cell count is itself asserted — "the client runs the tier" is satisfiable by one
  client, and that is the defect this AC exists to prevent.
- **AC6a** — every DECLARED cell refuses when the declaration is absent: `ok:false`, exit 1, and
  `help[]` naming exactly what to declare (the `package.json` script, the start-dir). It may never
  fall back to running the whole suite. Asserted for all six tiers in bun and python (where every
  cell is declared) AND for the declared cells of the split stacks — `bdd` in maven, `module` in
  cargo — so the rule is proven to be per-cell rather than per-client. Asserted NOT to fire on a
  split cell: a refusal demanding a declaration from cargo's `--lib` would be the defect.
- **AC6b** — a `unit` run whose wall time exceeds its CPU time by the stated factor carries a
  structured warning naming both figures and the factor, with `ok` unchanged — the run is reported,
  not refused. Asserted twice: once on a deliberately sleeping fixture (warning present) and once on
  a CPU-bound fixture (warning absent), so the check cannot pass by always warning.
- **AC7** — the AXI envelope carries the ingested tier on every exit path: success, a failing suite,
  zero-discovery, and the compile-tier fallback. Four assertions per client, and both the client
  count and the path count asserted by derivation — "the envelope states the tier" is otherwise
  satisfied once, on one client's happy path.
  **The vocabulary is CLOSED and lives in ONE place (ratified at cycle 381's RED).** A consumer
  matches on these values, so five clients spelling their own sentinel would be exactly the second
  mirror AC10 forbids. `clients/_crucible_axi.py` owns them: a `Tier` value when a tier was
  ingested, `ENVELOPE_TIER_UNSTATED` when the client sent none (honest after AC3 — the client stated
  nothing and the server applied its own default; the envelope must not invent a tier, nor surface a
  bare `None`), and `ENVELOPE_TIER_COMPILE` for a compile ingest, which is not a test tier (AC13a).
  The `tier-run-undeclared` refusal (§S3) ingested nothing and must claim nothing; the no-report
  exits bun and arduino each have are the same case. Neither is one of the four paths.
  **Per-client path reality, derived at RED rather than assumed:** all five clients have success and
  failing-suite paths; only python has a distinct zero-discovery branch (elsewhere an empty report
  flows through the ordinary ingest with total 0); the compile fallback exists on the tier verb in
  python, mvn and rust, on bun's untiered `test` verb, and in arduino as a first-class `compile`
  verb. Where a client lacks a path, the AC is satisfied by the paths it has, stated explicitly.
- **AC8** — caller existence: a grep at VERIFY time returns ≥1 non-test caller of the shared tier
  registration per client, and zero clients still pass a hardcoded tier literal into
  `_ingest_parsed`/`_start_run` except where the verb's own name IS the tier (`regression`, `e2e`).
- **AC9** — no CR-namespace literal reaches printed help (`tests/project-namespace-tripwire.test.ts`
  AC2 stays green) and the fleet verb-surface census (`test_client_fleet_envelope_census.py`) stays
  green over the enlarged surface. The census DERIVES its verb list by driving each client, so there
  is no count to hand-update — the earlier wording asked for a no-op. What DOES need a deliberate,
  ONE-TIME re-record is `PROSE_CITATIONS.clients.head` in the tripwire, today **694** against a
  `develop` floor of 601: this CR adds provenance prose to five clients and the shared module, so
  the head figure moves. It is re-recorded ONCE, as a named close-out step, never as a per-cycle
  approval round-trip. The help surface grows from **168** to **190**: 22 of the 30 (client × tier)
  pairs are missing today (measured — 8 already answer: mvn `unit`/`module`/`e2e`/`regression`,
  arduino `unit`/`regression`, bun `regression`, python `regression`), so the earlier "~195" was
  arithmetic, not measurement. The CR-CRU-110 guard bounds that surface at 60 s against a measured
  ~12 s, so headroom stays above 4x.
- **AC10** — the diff touches NO server file: `git diff --stat` over `src/` is empty. The vocabulary
  lives in ONE place on the client side — a single mirror in `clients/_crucible_axi.py` carrying a
  provenance comment naming `Tier` in `src/types.ts` — and a DRIFT GUARD test parses that union out
  of `src/types.ts` and asserts the mirror equals it, set for set. Reading `src/types.ts` at client
  RUNTIME is not the requirement and cannot be: no client reads `src/` today (verified — every
  `src/` reference in `clients/` is a provenance comment), and an installed wheel has no `src/` to
  read. A mirror plus a guard is the project's established pattern for exactly this (`normalizeTrack`
  is mirrored at `clients/_crucible_axi.py:1434` the same way). What is forbidden is a SECOND mirror:
  no per-client copy of the six values.
- **AC11** — the never-implemented `--tier` flag named in CR-CRU-008's contract is retired
  explicitly: it appears in no client (`add_argument("--tier` returns zero fleet-wide, as today) and
  the retirement is recorded, so a reader of CR-CRU-008 is not left expecting a flag that never
  existed.
- **AC12** — `rust-crucible.py`'s higher tiers stop reporting as `unit`. Asserted on the POST body
  per verb: `smoke-test` and `docker-e2e-gate` carry the tier the DN's mapping gives them, and a run
  driven under a nextest profile (`-P ci`, `-P e2e`, the docker-infra tier) carries that profile's
  tier rather than the `unit` both call sites hardcode today. The drift this closes is measured: two
  `tier="unit"` call sites are the client's only tier statements.
- **AC13** — `arduino-crucible.py` stamps a tier on EVERY test ingest, so no run relies on the
  server's default. Asserted on the POST body: the native-host run carries its own tier, and the
  `arduino-cli` target build continues to post to `/api/v2/runs/compile` as a COMPILE ingest — a
  build is not a test tier, and conflating them would put a compile in the test record. Today this
  client stamps nothing at all, so a native run and a target build are indistinguishable on the
  board.
  **CORRECTION — this AC's premise was false, and the correction is the finding (cycle 379's RED).**
  "Today this client stamps nothing at all" is WRONG, and so was the claim built on it that arduino's
  help lied and its regression runs landed as `unit`. `_run_native_tests_body` has POSTed
  `"tier": tier` at `:576` since before this CR was cut — identical on `develop` — so every arduino
  run it actually RUNS already carries its tier, and the help was telling the truth. The error was
  the census instrument (keyword-only scanning), not the client. What survives as real work is
  narrower and different:
  - **(i) PIN, not RED** — every run arduino actually runs carries its own tier on the POST body.
  - **(ii) the two UNEARNED arduino stamps**, invisible to cycle 378's census: `cmd_test` at `:608`
    passes `"unit"` positionally for a verb whose name is not a tier, and `cmd_auto_ingest` at `:729`
    hardcodes `"tier": "unit"` in its payload dict for a verb that runs no tests at all — AC3's own
    named "worse case". Both are corrected under AC3's rule.
  - **(iii) the help-vs-wire biconditional** — the printed help's tier claim and the POST body agree,
    in both directions, for `unit`, `regression` AND `test`.
  - **(iv)** the `arduino-cli` target build stays a COMPILE ingest carrying no test tier.
  **The AC3 collision is ruled: AC3 WINS.** "Stamps a tier on EVERY test ingest" and "auto-ingest
  runs no tests, so it may state no tier at all" contradict each other at `:729` exactly. A verb that
  ran nothing states nothing; AC13 governs the runs arduino RUNS, never the reports it merely finds.
- **AC13a** — no COMPILE ingest carries a test tier, asserted fleet-wide on the POST body to
  `/api/v2/runs/compile`. There are **two** offenders in `python-crucible.py`, not the one this AC
  first named: `:696` stamps `tier="unit"` on a collection/syntax failure under `test`, and `:799`
  stamps `tier="regression"` on the same kind of failure under `regression` (found at RED). Both do
  exactly what AC13 forbids for arduino — a build failure recorded as a test tier — and `:799` shows
  why the rule must be fleet-wide rather than one example: an earned verb name does not make a
  COMPILE event a test run. Asserted for every client that has a compile path; arduino's is already
  clean and is pinned to stay clean.

## Estimated size

M — one shared registrar, five thin call sites, and the `mvn` migration. §S3's script detection is
the only new mechanism; §S2 and §S4 are corrections to existing call sites.

## Risk

The fleet-wide spelling is a one-way door: five clients teaching six values is expensive to respell
later, which is why DN **D1** settles the spelling before this CR is cut rather than during it.

Removing the `tier="unit"` default from `cmd_test` changes what the board records for targeted runs.
Historical rows are untouched and stay `unit`; the change is forward-only.

**That confirmation, now made rather than deferred (RED escalation, cycle 378).** `src/store.ts`
defaults `tier: meta?.tier ?? "unit"` at `:1911` and `:1950`, so a tier-less run still LANDS as
`unit` and the board column looks identical before and after this CR. The default is accepted, for
a reason worth stating plainly: what changes is WHO asserts. Today the client asserts a fact it
cannot know from a file path; after this CR the client asserts nothing and the server applies its
own documented default — and the caller who DOES know now has six verbs (§S1) to say so. Two
consequences follow and both are deliberate: the improvement is not visible in the board's tier
column, and no test in this CR can assert the stored value without a server change, which AC10
forbids. **So AC3 is judged on the POST body alone; a green tier column is not evidence either
way.** Changing the server's default is a separate question for a separate CR, on evidence this CR
does not have.

## Non-goals

- **Any server-side change.** The interface is already declared and authoritative: `Tier`
  (`src/types.ts`), the `TIERS` validation and the verbatim `{tier, stack, context}` trio
  (`src/v2.ts`), the ingest endpoints, and `EventRow`/`RunRow` (`src/store.ts`). This CR is
  client-side only; `src/` is READ as the source of the vocabulary and touched not at all. A new
  field, endpoint or enum value would be out of scope by construction.
- **The vscode stack.** The DN records its split (Vitest for unit, Mocha under
  `@vscode/test-electron` for integration), but there is no vscode client to carry a verb surface;
  it inherits this mapping when that client is built, and until then its interim inline ingest
  states the tier explicitly. Five clients are in scope here, not six.
- Classifying files into tiers. That is the project's decision, per the DN.
- Per-tier coverage (DN open question 4) and e2e ownership (open question 5) — both still open.
  The wall-vs-CPU check is NOT deferred: DN **D3** settled it as a warning and it is §S4/AC6b of
  this CR.
- Changing what any existing test asserts.
