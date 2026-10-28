# CR-CRU-210 — a scoped re-run after a red gate closes the CR, suite by suite

**Type** fix · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(user rulings 2026-10-28: regression after a gate is scoped; a patch CR into 0.4.0, sequenced next;
re-scored 5 → 8 at gap analysis and 8 → 13 at the spec pre-review)

## Problem

A user ruling of 2026-10-28 makes regression after a gate **scoped**: once a full pre-merge gate has
run on a branch, a fix made after it re-runs only the suites the fix can affect, and the other
suites' results from that gate stand. `cr-close` cannot honour that. Its verdict
(`gate_close_verdict` in `clients/_crucible_axi.py`) reads only the CR's **latest** `pre-merge-gate`
milestone, and that milestone records only totals — outcome, passed, failed, failing tests. A scoped
re-run is an ordinary test run, which the verdict never reads.

It happened on CR-CRU-208: the gate went red on one test-setup defect in the python suite (bun 4111/0,
python 4522/1); the fix was proven by re-running only the python suite (4523/0), and `cr-close` still
refused, so the CR closed with `--accept-failing-gate` — the escape hatch for a deliberately accepted
red gate, recording a green CR as if it were one.

What each suite did is known only to the gate's envelope. `run_gate_suites` builds a `suites[]` row
per declared suite and prints it; `record_gate_outcome` builds the milestone from the runs this
process filed (`_filed_runs`) and the envelope's `run` totals (`note_emitted_run_counts`) and never
sees the rows. The rows carry no outcome (a suite's pass or fail is decided by `_run_outcome` and
surfaces only as a warning), no failing tests and no event id; an own-stack row copies the whole-suite
run's counts (`coveredBy`); an excluded suite is a row too; and a whole-suite run that covers no
declared target has no row at all. Two more gaps sit on the same record:

- **The board keeps only the fields CR-CRU-188 defined.** `gateMilestoneFields` (`src/v2.ts`) and the
  store's milestone write and read carry outcome, passed, failed and failing tests; any other field a
  client posts is dropped.
- **A dispatched suite's failing tests are never named.** `_failing_tests` reads `_filed_runs`, the
  runs this process filed; a suite dispatched to a sibling client is filed by that client's process,
  whose envelope returns counts and no event id. CR-CRU-208's red milestone read `failed: 1` with
  `failingTests: []`, short of CR-CRU-188's "the failing tests (on a failure)".

Only bun's gate dispatches. python cannot enumerate a declaration (`suites=None`), so its gate never
composes; maven, rust and arduino declare only their own suites (`dispatch=None`), all covered by the
one whole-suite run.

## Design (user rulings, 2026-10-28)

**The record.**

- Every `pre-merge-gate` milestone keeps its verdict and counts, and adds `scope` (`full` or
  `scoped`) and `suites`: one entry per gated suite the gate ran — its declared target, its outcome
  (`pass`/`fail`), its passed and failed counts, and its failing tests. A suite that could not run, be
  dispatched or report is `fail` with its counts absent. An excluded suite is not listed.
- **The whole-suite run is always represented when it ran.** Each own-stack target it covered is an
  entry carrying the whole-suite run's outcome, counts and failing tests; when it covered no declared
  target, it is one entry under the stack's whole-suite label.
- A gate that composed no suites — the project declares none, the gate stopped at its step 0, or a
  failure escaped the composition — records no `suites`.
- **The board keeps them, and says so.** The milestone route carries `scope` and `suites` only beside
  a well-formed verdict, and refuses the post (400, nothing recorded) when either is ill-formed — a
  verdict-bearing field half-stated states nothing. Well-formed: `scope` is `full` or `scoped`; each
  entry has a non-empty `target`, an `outcome` of `pass` or `fail`, `passed` and `failed` both
  non-negative integers or both absent (absent only on `fail`), and `failingTests` a list of strings
  (its non-empty members kept, as the top-level list's are); an entry keeps only those keys. Each of
  `scope` and `suites` is optional — `suites` may come without `scope` — but `suites`, when present,
  is a non-empty list, and a `null` for either is ill-formed. Both sit at the top level of the record,
  beside the verdict, and are dropped with a verdict that is not well-formed (as today's gate fields
  are). The store writes and reads them in the milestone's payload — no column, no migration.
  `/api/health` states the capability beside `codecs`: `milestones: { gate: ["scope", "suites"] }`.

**A run names its events.** Every client envelope states `events`: the board's event id of each run
the invocation filed, in filing order, `[]` when it filed none — set once, where the envelope is
emitted, from `_filed_runs`. A gate's envelope lists its local runs' events and each dispatched
suite's, from that suite's envelope, and the gate reads each failing suite's tests through them.

**A scoped gate.** `pre-merge-gate --suites <targets>` runs only the named declared suites.

- **Checked first, refused whole.** One shared check, called as the first act of each of the five
  clients' `pre-merge-gate` (before the unattributed-run refusal and step 0), raises a typed hard stop
  handled in `run_verb`, so a refusal runs nothing, files nothing and posts no milestone. It refuses:
  a board that does not state the capability; a project that declares no suites (python, always); a
  target the project does not declare, or declares excluded; a list with an empty, padded or repeated
  item; `--suites` with `--release`; and a gate with no cycle (no `--cycle` and no binding).
- **Then it runs as a gate.** Step 0 runs as on every gate (`--skip-check`/`--skip-clippy` stay the
  bypass). Naming an own-stack target runs the whole-suite run, which covers every own-stack target,
  so the scoped gate records them all; naming only dispatched targets skips it. On maven, rust and
  arduino `--suites` therefore runs the whole suite. The envelope states `scope`.

**`cr-close` judges suite by suite.** It reads the CR's gate milestones in time order.

- The **base** is the latest full gate. A milestone with no `scope` and no `suites` (posted before
  this CR) is a full gate; one with `suites` and no `scope` is never a base.
- A base with no `suites`, or whose outcome is `fail` while none of its entries is, is judged by its
  own outcome, as today.
- Otherwise, for each suite of the base, the latest result for that suite from any gate at or after
  the base counts; a scoped gate's entry for a target the base never ran is ignored. A gate after the
  base whose outcome is `fail` with no `suites` (stopped at step 0, or escaped) makes the verdict red
  unless a later gate ran past its step 0.
- The CR is green when every counted result passes. A scoped gate with no full gate before it never
  counts.
- A refusal names the suites still red; its help names `pre-merge-gate --suites <those suites>`, or a
  full gate when one of them is no longer declared. `--accept-failing-gate`'s help and its
  unused-reason warning speak of the gate result rather than "the last pre-merge-gate".

**Exit paths.** A gate interrupted by a signal posts no milestone (as today). A milestone post that
fails is reported on stderr and the verdict reads the earlier gates.

**Model B's skills** describe a full re-run after a red gate; per user ruling, the change is
announced in the release notes and the Model B notice.

## Steps

### §S1 — the board keeps a gate's scope and suites, and says it does

The milestone route's validation and refusal, the store's milestone write and read, the milestone
types, and `/api/health`'s capability. PRD §3.5 records the gate's verdict, counts, failing tests,
scope and suites, and lists `pre-merge-gate` among the reserved types (as `RESERVED_MILESTONE_TYPES`
already does); lines below §3.5 keep their numbers, which comments cite.

### §S2 — a run names its events, and the milestone carries its suites

`events` on every envelope; the composition's rows gain `outcome` and failing tests; the envelope
remembers its rows for `record_gate_outcome`, which posts `scope` and `suites` as above.

### §S3 — `--suites` scopes a gate

The shared check and hard stop; the flag declared once and added to each client's `pre-merge-gate`;
the composition runs only the named suites.

### §S4 — `cr-close` composes the verdict per suite

`gate_close_verdict` applies the rule above; its refusal, help and the accept flag's texts follow it.

## Acceptance criteria

GREEN-GUARD marks a criterion that holds today and pins what must not change.

- [ ] **AC1 (§S1)** A `pre-merge-gate` milestone posted with `scope` and `suites` is read back with
  both; one with an ill-formed `scope`, or any ill-formed `suites` entry, is refused with 400 and
  nothing recorded; `/api/health` states `milestones.gate` naming `scope` and `suites` (bun, against
  the board).
- [ ] **AC2 (§S2)** For each of the five clients, every verb that files a run (the verbs
  `test_every_verb_that_files_a_run_is_refused_while_a_cycle_is_active` enumerates) states `events`
  naming the id the board answered, on a passing and a failing run; a verb that filed nothing states
  `events: []`.
- [ ] **AC3 (§S2, bun)** A full gate over a project declaring a bun suite and a dispatched python suite
  that fails posts `scope: full` and both entries, each with its own outcome and counts, the failing
  entry and the milestone's `failingTests` naming the real failing test; the gate's envelope lists the
  events of both.
- [ ] **AC4 (§S2/§S4, bun)** A full gate over a project declaring only a dispatched suite, where that
  suite passes and the whole suite fails, posts a `fail` entry for the whole suite, and `cr-close`
  refuses it with no scoped gate run.
- [ ] **AC5 (§S2, bun)** A declared suite that cannot be dispatched is a `fail` entry with no counts.
- [ ] **AC6 (§S2, GREEN-GUARD)** A gate over a project that declares no suites, and a gate stopped at
  its step 0, each post a milestone with no `suites`.
- [ ] **AC7 (§S3, bun)** `pre-merge-gate --suites <the dispatched target>` runs step 0, then that suite
  only — the whole-suite run does not run — and posts `scope: scoped` naming only that suite; its
  envelope states `scope: scoped`.
- [ ] **AC8 (§S3)** For each of maven, rust and arduino, `pre-merge-gate --suites <one declared
  target>` runs step 0 and the whole suite and posts `scope: scoped` naming every own-stack target.
- [ ] **AC9 (§S3)** For each of the five clients, `--suites` is refused before anything runs — exit
  non-zero, no run, compile or lint result filed, no milestone posted — when: the board does not state
  the capability; the target is undeclared or excluded (the declared targets named); the list has an
  empty, padded or repeated item; `--release` is given; no cycle resolves. python refuses every
  `--suites` as declaring no suites.
- [ ] **AC10 (§S4)** A red full gate whose one failing suite is then re-run green by a scoped gate
  closes, without `--accept-failing-gate`, recording no accepted-failing-gate reason.
- [ ] **AC11 (§S4)** A red full gate followed by a green scoped gate of a *different* suite is refused;
  the error names the suite still red and the help names `pre-merge-gate --suites <that suite>`.
- [ ] **AC12 (§S4)** Refused: a green scoped gate with no full gate before it; a green scoped gate
  older than the latest (red) full gate; two full gates, the older red and re-run green, the newer
  red.
- [ ] **AC13 (§S4)** A green full gate followed by a red scoped gate of one suite is refused.
- [ ] **AC14 (§S4)** A red full gate, a green scoped re-run, then a scoped gate that fails at step 0
  is refused.
- [ ] **AC15 (§S4, GREEN-GUARD)** A red full gate milestone with no `suites` — posted before this CR —
  is refused even when a later scoped gate is green; a green one closes as today.
- [ ] **AC16 (§S3/§S4)** All five clients' `pre-merge-gate --help` lists `--suites`, from the one
  shared declaration; `--accept-failing-gate`'s help and its unused-reason warning speak of the gate
  result.

Standing invariants (not new criteria): no CR citation is added under `src/`, `public/` or
`clients/` (the tripwire's pins unchanged); no test prints an environment value or steers a client by
a retired variable; no gate test opens the live store.

## Non-goals

- Choosing the suites automatically from what a fix touched — the orchestrator names them.
- What the board shows for a gate: no page displays a `pre-merge-gate` milestone today.
- The no-mistakes release gate, and a scoped release gate.

## Release notes

- `pre-merge-gate --suites` re-runs only the named suites after a red gate, and `cr-close` judges a CR
  suite by suite: each suite's latest result counts, so a fixed suite re-run green closes the CR
  without overriding the gate. A change from Model B's close-out, which re-runs the gate in full.
- A gate milestone records each suite's result and names every failing test, including those of a
  suite another stack's client ran; every client envelope names the board events it filed
  (`events`); `/api/health` states that the board records a gate's scope and suites.
