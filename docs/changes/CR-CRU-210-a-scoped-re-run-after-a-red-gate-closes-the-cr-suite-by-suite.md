# CR-CRU-210 — a scoped re-run after a red gate closes the CR, suite by suite

**Type** fix · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(user rulings 2026-10-28: regression after a gate is scoped; a patch CR into 0.4.0, sequenced next)

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
suite (counts, `coveredBy` for an own-stack target the whole-suite run covered), prints it in the
envelope, and drops it before the milestone is posted (`record_gate_outcome`).

## Design (user ruling, 2026-10-28)

- **A gate milestone records each suite's result, and its scope.** Every `pre-merge-gate` milestone
  carries `scope` (`full`, or `scoped`) and `suites`: one entry per gated suite it ran — the suite's
  declared target, its outcome (`pass`/`fail`), passed and failed. An excluded suite is not listed.
- **`pre-merge-gate --suites <targets>` runs only the named declared suites.** A comma list of the
  project's declared targets. An own-stack target is run by the stack's whole-suite run (as today,
  rule 3 of the composition), so naming one runs that run; naming only other stacks' targets skips it.
  A target the project does not declare, or declares as excluded, is refused before anything runs.
  Declared once in the shared module, so all five clients take it.
- **`cr-close` judges suite by suite.** It takes the CR's latest **full** gate, and for each suite that
  gate ran, the latest result for that suite from any gate of the CR at or after it (full or scoped).
  The CR is green when every one of those passes. A scoped gate with no full gate before it, or older
  than the latest full gate, does not count. A refusal names the suites still red.
- A full gate milestone posted before this CR (no `suites`) is judged as today: by its own outcome.

## Steps

### §S1 — the gate milestone carries its suites and scope

`record_gate_outcome` posts `scope` and `suites` from the composition's rows; the counts and outcome of
a row come from the run that produced them (for an own-stack target, the whole-suite run it was
covered by).

### §S2 — `--suites` scopes a gate

The shared declaration adds `--suites` to every client's `pre-merge-gate`; the composition runs only
the named suites and refuses an undeclared or excluded one, naming the declared targets.

### §S3 — `cr-close` composes the verdict per suite

`gate_close_verdict` reads the CR's gate milestones and applies the rule above. Its refusal and the
`--accept-failing-gate` path are otherwise unchanged.

## Acceptance criteria

- [ ] **AC1 (§S1)** A full gate over a project declaring two suites, one of which fails, posts a
  milestone with `scope: full` and both suites, the failing one `fail` and the other `pass`, each with
  its own counts.
- [ ] **AC2 (§S2)** `pre-merge-gate --suites <another stack's target>` dispatches that suite only —
  the whole-suite run does not run — and posts a milestone with `scope: scoped` naming only that suite.
- [ ] **AC3 (§S2)** `--suites` naming a target the project does not declare, or declares excluded, is
  refused before any run: non-zero exit, the declared targets named, no run filed, no milestone posted.
- [ ] **AC4 (§S3)** A red full gate whose one failing suite is then re-run green by a later scoped gate
  closes with `cr-close`, without `--accept-failing-gate`, and records no accepted-failing-gate reason.
- [ ] **AC5 (§S3)** A red full gate followed by a green scoped gate of a *different* suite is refused,
  and the refusal names the suite still red.
- [ ] **AC6 (§S3)** A green scoped gate with no full gate before it is refused as having no full gate
  result; a green scoped gate older than the latest (red) full gate does not turn it green.
- [ ] **AC7 (§S3)** A red full gate milestone with no `suites` (posted before this CR) is refused as
  today even when a later scoped gate is green.
- [ ] **AC8 (§S2)** All five clients' `pre-merge-gate --help` lists `--suites`, from the one shared
  declaration.

## Open for the gap analysis

- CR-CRU-208's red milestone named no failing test (`failingTests: []` with `failed: 1`):
  `_failing_tests` reads only the runs this process filed, and the failing python suite was filed by
  the dispatched client. Whether the per-suite entries close that, or it stays a separate defect.
- What the board shows for a scoped gate (History, the Now pane's gate view).

## Non-goals

- Choosing the suites automatically from what a fix touched — the orchestrator names them.
- The no-mistakes release gate.

## Release notes

- `pre-merge-gate --suites` re-runs only the named suites after a red gate, and `cr-close` judges a CR
  suite by suite: each suite's latest result counts, so a fixed suite re-run green closes the CR
  without overriding the gate.
