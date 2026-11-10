# CR-CRU-249 — an EDA project's ngspice decks run through sim against declared bounds

**Status:** PENDING · Pre-review: due — 8 points, user rulings, another project's surface
**Type:** feature
**Priority:** low. There is no current consumer: P1 has no sims yet.
**Depends on:** CR-CRU-243
**Labels:** clients, eda
**Phase:** design
**Design reference:** `docs/research/DN-crucible-live-test-progress.md` (the `crucible-events` shape); CR-CRU-200 §S1

## Context

An EDA project's L2 tier checks its circuits in ngspice batch decks, using `.meas` statements.

**Measured on ngspice-47:**

- `ngspice -b <deck>` exits 0, and prints each `.meas` result as `<name> = <value> at= <t>`. For example:
  `vmax = 3.64624e+00 at= 5.00000e-03`.
- A broken deck exits 1, with `Error: incomplete or empty netlist`.

A deck states what it measures, but not what is acceptable. The bounds are the project's to declare.

## Scope

- **A client verb, `sim`, runs a project's declared decks.** Each deck is a tier entry
  (`framework = "eda-sim"`), so the tier verbs, `regression` and the gate run it as well.
- **Each deck entry is one run of cases:**
  - one `runs` case, which passes when ngspice exits 0;
  - one case per declared measurement, which passes when the printed value lies within its declared
    bounds.
- **The client composes the run's stream.** The verdict compares ngspice's console lines with the
  project's bounds, and that comparison is the client's. The client writes the result as `crucible-events`
  to the run's stream file, and the shared relay carries it.
  - There is no new codec.
  - A value appears only in a failure's message. No board field is added.

### §S1 — the declaration

An entry `[targets."<tier>"]` or `[targets."<tier>/<label>"]` with `framework = "eda-sim"` holds:

- `deck`: a path relative to the project dir. It is required, and must exist.
- `meas`: a table from measurement name to `{min = <number>, max = <number>}`.
  - At least one of `min` and `max` is given per name.
  - `min` must not exceed `max`.
  - The table may be empty, in which case only `runs` is checked.

**The schema** gains `eda-sim` under `stacks.eda` and in `reserved_frameworks.eda`, and its `version`
goes up by one. **`eda-sim` joins the other-stack skip sets** of rust, arduino and maven.

### §S2 — running a deck

- **The command** is `ngspice -b <deck>`, run in the deck's directory, using the `ngspice` on PATH. A
  missing `ngspice` is refused before the run opens, naming it.
- **The start total** is `1 + len(meas)`, stated in the stream's `run-start`.
- **Reading the console.** A measurement's value comes from the last stdout line matching
  `^\s*<name>\s*=\s*<float>`, with the name compared case-insensitively. Whatever follows the value is
  ignored (for example, `at= …`).
- **The cases** are written to the run's stream file, each with `suite` = the deck's path:
  - **`runs`** passes on exit 0. On a non-zero exit it fails, and its message is the `Error:` lines, or
    else the last 20 output lines.
  - **Each measurement** passes when its value lies within `[min, max]`.
    - Out of bounds, it fails with the message `<name> = <value> outside [<min>, <max>]`. An open side is
      written as `-inf` or `inf`.
    - Never printed, it fails with `<name> was not measured`.
    - A value that is not a float fails with `<name> = <text> is not a number`.
- **Then `run-end`.** The stream is relayed through the shared `StreamRelay` and closed through
  `close_streamed_run`, with framework `eda-sim` under the entry's tier.

### §S3 — the verb, the tiers and the gate

- **`sim --agent <id>`** runs every `eda-sim` entry, each as its own run under its own tier.
  - `--entry <key>` runs one entry.
  - An undeclared deck, or a `--entry` that is not an `eda-sim` key, is refused.
  - `sim` takes `--agent`, `--cycle`, `--release`, `--reports`, `--log` and `--project-dir`.
- **The tier verbs and the gate's per-entry suites** run `eda-sim` entries as they run CR-CRU-242's entries.
- **`regression`** adds one run per `eda-sim` entry under `regression`, and its envelope sums them.
- **The envelope** carries `verdict` and the `tier-skipped` warning as CR-CRU-242 §S5 defines them, and
  `sim: [{entry, deck, exit}]`.

## Acceptance criteria

Two sets of fixtures:

- committed decks;
- a stub `ngspice` on PATH, which replays ngspice-47 captures (the measured `vmax` line, and the broken
  deck's exit 1 with its `Error:` line).

- [ ] **AC1 — in bounds.**
  - **Setup:** `[targets."integration/rc"]` with `deck = "sim/rc.cir"` and `meas.vmax = {min = 3.5, max =
    3.8}`.
  - `sim --agent <id>` opens one streamed run (`codec: crucible-events`, tier `integration`, framework
    `eda-sim`) with start total 2.
  - It is filed with passed 2 and failed 0.
- [ ] **AC2 — out of bounds.** With `max = 3.6`, the `vmax` case fails, and its message is
  `vmax = 3.64624 outside [3.5, 3.6]`. The `runs` case passes, and the envelope's `verdict` is `fail`.
- [ ] **AC3 — not measured, and a broken deck.**
  - A declared `vmin` that is never printed fails with `vmin was not measured`.
  - The broken-deck capture fails `runs`, with message `Error: incomplete or empty netlist`, and every
    measurement fails with `… was not measured`.
- [ ] **AC4 — refusals.**
  - With no `ngspice` on PATH, `sim` is refused before any run opens, naming it.
  - `meas.x = {}` is refused, naming the field.
  - A `min` greater than its `max` is refused.
  - A missing deck is refused.
  - `--entry unit` (not an `eda-sim` key) is refused.
- [ ] **AC5 — tiers, `regression` and the gate.**
  - `integration` runs the deck entry beside the tier's `eda-pytest` entry, as two runs.
  - `regression` files the deck's run under `regression`.
  - `pre-merge-gate` has an `integration/rc` row, with its own run.
- [ ] **AC6 — a SIGTERM** leaves the run aborted, keeping the cases already streamed.
- [ ] **AC7 — the declaration.**
  - The schema's `version` is one more than at the branch's base, with `eda-sim`.
  - The agreement test drives the check.
  - A complete valid `eda-sim` entry is skipped by each of rust, arduino and maven (three call sites).
- [ ] **AC8 — docs and invariants.**
  - README, RUNBOOK and CHANGELOG name:
    - `sim` and the `eda-sim` declaration;
    - the `runs` case;
    - the bounds rule;
    - that values appear only in failure messages.
  - The shared modules keep their pinned sizes.
  - The code and tests this CR adds carry no CR id literal.

## Estimated size

8 points: the declaration with the schema and the skip sets (2), the deck run with its `.meas` reading and
stream writing (4), and the verb, tier and gate wiring with the docs (2).

## Risk

- **Only one `.meas` print form is measured.** Other forms (a `trig`/`targ` measurement, a failed
  measurement) are not. A form that the reader cannot match fails as "not measured", which is loud.
- **No deck timeout is declared.** A deck that never ends holds the run until it is signalled.

## Non-goals

- PySpice: a pytest gate under CR-CRU-242 covers it.
- Waveform files.
- A run timeout.
- Storing measured values on the board.
- An ngspice version floor.
