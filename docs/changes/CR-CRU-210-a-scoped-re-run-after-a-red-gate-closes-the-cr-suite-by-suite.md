# CR-CRU-210 — a scoped re-run after a red gate closes the CR, suite by suite

**Type** fix · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(user rulings 2026-10-28: regression after a gate is scoped; a patch CR into 0.4.0, sequenced next;
re-scored 5 → 8 at gap analysis)

## Problem

A user ruling of 2026-10-28 makes regression after a gate **scoped**: once a full pre-merge gate has
run on a branch, a fix made after it re-runs only the suites the fix can affect, and the other
suites' results from that gate stand. `cr-close` cannot honour that. Its verdict
(`gate_close_verdict` in `clients/_crucible_axi.py`) reads only the CR's **latest** `pre-merge-gate`
milestone, and that milestone records only totals — outcome, passed, failed — not which suites ran or
how each one did. A scoped re-run is an ordinary test run, which the verdict never reads.

It happened on CR-CRU-208: the gate went red on one test-setup defect in the python suite (bun 4111/0,
python 4522/1); the fix was proven by re-running only the python suite (4523/0), and `cr-close` still
refused, so the CR closed with `--accept-failing-gate` — the escape hatch for a deliberately accepted
red gate, recording a green CR as if it were one.

The gate already knows each suite's result: `run_gate_suites` composes one `suites[]` row per declared
suite and prints it in the envelope, and `record_gate_outcome` drops it before posting the milestone.
Two more gaps sit on the same record:

- **The board keeps only the fields CR-CRU-188 defined.** `gateMilestoneFields` (`src/v2.ts`) and the
  store's milestone write and read carry outcome, passed, failed and failing tests, so any other field
  a client posts is dropped.
- **A dispatched suite's failing tests are never named.** `_failing_tests` reads the runs this process
  filed; a suite dispatched to a sibling client is filed by that client's process, whose envelope
  returns counts and no event id. CR-CRU-208's red milestone read `failed: 1` with `failingTests: []`,
  short of CR-CRU-188's "the failing tests (on a failure)".

## Design (user rulings, 2026-10-28)

- **A gate milestone records each suite's result, and its scope.** Every `pre-merge-gate` milestone
  carries `scope` (`full`, or `scoped`) and `suites`: one entry per gated suite the gate ran — its
  declared target, its outcome (`pass`/`fail`), its passed and failed counts, and its failing tests.
  A suite that could not run, be dispatched, or report is `fail` with its counts absent. An excluded
  suite is not listed. A gate that composed no suites — the project declares none, or the gate stopped
  at its step 0 — records no `suites`.
- **The board keeps them.** The milestone route validates `scope` and `suites` on its never-coerce
  terms (an ill-formed entry is dropped, never coerced) and the store writes and reads them in the
  milestone's payload — no column, no migration.
- **`pre-merge-gate --suites <targets>` runs only the named declared suites.** A comma list of the
  project's declared targets. The gate's step 0 (tsc, clippy, compile, docker-up) runs as on every
  gate; `--skip-check`/`--skip-clippy` stay the bypass. An own-stack target is run by the stack's
  whole-suite run, which covers every own-stack target, so the scoped gate records them all; naming
  only other stacks' targets skips that run. On maven and rust every declared suite is the client's
  own, so `--suites` runs the whole suite. A target the project does not declare, or declares
  excluded, and `--suites` on a project that declares no suites, are refused before anything runs.
  Declared once in the shared module, so all five clients take it.
- **A run names the event it filed, and the gate names every failing test.** A run verb's envelope
  states the board's event id of each run it filed (`events`); the gate reads a dispatched suite's
  failing tests through it, so the suite's entry and the milestone's `failingTests` name them.
- **`cr-close` judges suite by suite.** It takes the CR's latest **full** gate, and for each suite
  that gate ran, the latest result for that suite from any gate of the CR at or after it (full or
  scoped). The CR is green when every one of those passes. A full gate with no `suites` is judged by
  its own outcome, as today. A scoped gate with no full gate before it, or older than the latest full
  gate, does not count. A refusal names the suites still red, and its help names
  `pre-merge-gate --suites <those suites>`.
- **Model B's skills** describe the full re-run; per user ruling, the change is announced in the
  release notes and the Model B notice.

## Steps

### §S1 — the board keeps a gate's scope and suites

The milestone route, the store's milestone write and read, and the milestone types carry `scope` and
`suites`. PRD §3.5 records the gate's verdict, counts, failing tests, scope and suites (its line count
unchanged: tests cite its lines).

### §S2 — a run names its events, and the milestone carries its suites

Every run verb's envelope states `events`. `record_gate_outcome` posts `scope` and `suites` from the
composition's rows, each with its failing tests — read through the events this process filed and,
for a dispatched suite, the events its envelope stated.

### §S3 — `--suites` scopes a gate

The shared declaration adds `--suites` to every client's `pre-merge-gate`; the composition runs only
the named suites as above and refuses what it cannot run.

### §S4 — `cr-close` composes the verdict per suite

`gate_close_verdict` reads the CR's gate milestones and applies the rule above; its refusal and help,
and `--accept-failing-gate`'s help, speak of the gate result.

## Acceptance criteria

- [ ] **AC1 (§S1)** A `pre-merge-gate` milestone posted with `scope` and `suites` is read back with
  both; an ill-formed `scope` is dropped, and an ill-formed `suites` entry is dropped while the
  well-formed ones are kept (bun, against the route).
- [ ] **AC2 (§S2)** A run verb's envelope states the event id of each run it filed, in each of the
  five clients' `test` verb.
- [ ] **AC3 (§S2)** A full gate over a project declaring two suites, one of them a dispatched suite
  that fails, posts a milestone with `scope: full` and both suites, each with its own outcome and
  counts, and the failing suite's entry and the milestone's `failingTests` naming the real failing
  test.
- [ ] **AC4 (§S2)** A gate over a project that declares no suites, and a gate stopped at its step 0,
  each post a milestone with no `suites`.
- [ ] **AC5 (§S3)** `pre-merge-gate --suites <another stack's target>` runs step 0, then dispatches
  that suite only — the whole-suite run does not run — and posts `scope: scoped` naming only that
  suite.
- [ ] **AC6 (§S3)** `--suites` naming a target the project does not declare, or declares excluded, or
  given on a project that declares no suites, is refused before any run: non-zero exit, the declared
  targets named, no run filed, no milestone posted.
- [ ] **AC7 (§S4)** A red full gate whose one failing suite is then re-run green by a later scoped
  gate closes with `cr-close`, without `--accept-failing-gate`, and records no accepted-failing-gate
  reason.
- [ ] **AC8 (§S4)** A red full gate followed by a green scoped gate of a *different* suite is refused;
  the refusal names the suite still red, and its help names `pre-merge-gate --suites <that suite>`.
- [ ] **AC9 (§S4)** A green scoped gate with no full gate before it is refused as having no full gate
  result; a green scoped gate older than the latest (red) full gate does not turn it green.
- [ ] **AC10 (§S4)** A red full gate milestone with no `suites` — posted before this CR, or stopped at
  step 0 — is refused as today even when a later scoped gate is green.
- [ ] **AC11 (§S3)** All five clients' `pre-merge-gate --help` lists `--suites`, from the one shared
  declaration.

Standing invariants (not new criteria): no CR citation is added under `src/`, `public/` or
`clients/` (the tripwire's pins unchanged); no test prints an environment value or steers a client by
a retired variable; no gate test opens the live store.

## Non-goals

- Choosing the suites automatically from what a fix touched — the orchestrator names them.
- What the board shows for a gate: no page displays a `pre-merge-gate` milestone today.
- The no-mistakes release gate.

## Release notes

- `pre-merge-gate --suites` re-runs only the named suites after a red gate, and `cr-close` judges a CR
  suite by suite: each suite's latest result counts, so a fixed suite re-run green closes the CR
  without overriding the gate. A change from Model B's close-out, which re-runs the gate in full.
- A gate milestone records each suite's result and names every failing test, including those of a
  suite another stack's client ran; a run's envelope names the board events it filed.
