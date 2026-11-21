# CR-CRU-248 — an EDA project's KiCad DRC and ERC run through drc and reach the board

**Status:** PENDING · Pre-review: due — 8 points, user rulings, another project's surface
**Type:** feature
**Priority:** low. There is no current consumer: P1 is a perfboard project with no `.kicad_pcb`.
**Depends on:** CR-CRU-245
**Labels:** clients, eda, codecs
**Phase:** design
**Design reference:** CR-CRU-239 §S1 (adding a compile format); `docs/research/PRD-crucible-v2.md` (compile ingest)

## Context

A KiCad project checks its board with `kicad-cli pcb drc` and its schematic with `kicad-cli sch erc`.
Today an EDA project cannot file either result to the board.

The project's own `.kicad_pro` holds its severity policy. Each rule is set to error, warning or ignore.

**Measured on kicad-cli 10.0.8:**

- **The JSON report.** `pcb drc --format json --severity-all -o f.json <pcb>` writes a JSON report.
  - **Its keys:** `$schema`, `coordinate_units` (`mm`), `date`, `ignored_checks[{key, description}]`,
    `included_severities`, `kicad_version`, `schematic_parity[]`, `source`, `unconnected_items[]` and
    `violations[]`.
  - **Each item:** `{type, severity (error|warning|exclusion), description, items[{description, pos{x,y},
    uuid}]}`.
  - **The schematic report.** `sch erc` has the same shape, with `sheets[{path, uuid_path, violations[]}]`
    in place of `violations`.
- **The policy is applied by kicad-cli.** A rule set to ignore in `.kicad_pro` appears in
  `ignored_checks` and never in `violations`.
- **The exit code.** Under `--severity-error --exit-code-violations`, `pcb drc` and `sch erc` both exit 5,
  and `included_severities` is `["error"]`. Error-severity `unconnected_items` alone trigger exit 5: on
  the Arduino_Mega template, `violations` holds no error and 8 unconnected items fire it.

## Scope

- **A client verb, `drc`, files compile-like.** A DRC or ERC result is a list of defects with no set of
  passing cases, so it is a check, not tests.
- **The verdict is kicad-cli's own exit code.** The client runs kicad-cli with `--severity-error
  --exit-code-violations`:
  - 0 passes;
  - 5 fails;
  - any other code is a kicad-cli failure.

  The client reads no report. The fleet's rule that a client parses no report holds.
- **The board decodes the report** through a new `kicad` compile format. Every error-severity item is a
  diagnostic, including `unconnected_items` and `schematic_parity`, so that a run which exited 5 is never
  filed with 0 errors.
- **The project's policy decides what can fail.** kicad-cli applies `.kicad_pro`. Warnings are not
  requested, and they are not filed.
- **`drc` is a fail-fast gate step after `check`.** It runs when the project declares KiCad files.

### §S1 — the declaration

- `[eda] kicad_pcb` is a list of `.kicad_pcb` paths, and `[eda] kicad_sch` a list of `.kicad_sch` paths.
  Both are relative to the project dir, and each path must exist.
- The schema's `eda` stack table gains both fields, and its `version` goes up by one.

### §S2 — the `drc` verb

- **What it runs:**
  - for each `kicad_pcb`: `kicad-cli pcb drc --format json --severity-error --exit-code-violations -o
    <reports>/<stem>.drc.json <pcb>`;
  - for each `kicad_sch`: `kicad-cli sch erc --format json --severity-error --exit-code-violations -o
    <reports>/<stem>.erc.json <sch>`.
- **The `kicad-cli` binary** is the one on PATH. A missing binary is refused before anything is posted,
  naming `kicad-cli`.
- **Every declared file runs,** even after an earlier one fails.
- **Each file's outcome:**
  - exit 0 passes;
  - exit 5 fails, and with `--agent` the report's text is filed as one compile run of format `kicad`;
  - any other exit fails, and with `--agent` kicad-cli's captured output is filed as one compile run of
    format `kicad`, which the codec stores as a message-only error.
- **The envelope** carries `drc: [{file, command: "pcb drc"|"sch erc", exit}]`, and is `ok: false` when
  any file failed.
- **A clean `drc`** files nothing.
- **With neither field declared,** `drc` passes, files nothing, and carries `check-compiled-nothing`,
  naming `[eda] kicad_pcb` and `[eda] kicad_sch`.
- **It takes** `--agent`, `--cycle` and `--project-dir`.

### §S3 — the `kicad` compile format

In `src/codecs/compile.ts`, the `kicad` format reads the report as JSON.

- **What becomes a diagnostic:** every item of `violations[]`, `unconnected_items[]`, `schematic_parity[]`
  and each `sheets[].violations[]`.
- **Each diagnostic's fields:**
  - `level`: `error` for an `error` item, `warning` for a `warning` item. An `exclusion` item is not a
    diagnostic.
  - `code`: the item's `type`.
  - `file`: the report's `source` for a PCB, or the sheet's `path` for a schematic.
  - `message`: the item's `description`, then a semicolon and a space, then each `items[].description` with
    `@ (<x>, <y>) <coordinate_units>`.
- **A text that is not JSON,** or that holds none of these arrays, is one message-only error whose
  message is the text's first non-blank line (at most `MESSAGE_LIMIT`).
- **The hint `kicad`** joins `HINT_ALIASES`. `detectFormat` is unchanged.

### §S4 — the gate

`pre-merge-gate` runs `drc` after `check` and before the tier suites, and stops there on a failure:

- `stage: drc`;
- the shared step-abort help and warning;
- `--skip-drc` bypasses it.

With no KiCad file declared, the step passes and says so.

## Acceptance criteria

Two sets of fixtures:

- the kicad-cli 10.0.8 reports and exit codes, captured on a copy of the KiCad template
  `Arduino_Mega` (`/usr/share/kicad/template/`), committed as text;
- a stub `kicad-cli` placed on PATH for the client's tests, which replays them.

- [ ] **AC1 — unconnected items alone fail and are filed.**
  - The captured PCB report has 0 error `violations` and 8 error `unconnected_items`, with exit 5.
  - `drc --agent <id>` fails, and files one compile run of format `kicad` whose `errorCount` is 8.
- [ ] **AC2 — a clean board.** Exit 0 passes and files nothing.
- [ ] **AC3 — the schematic.** The captured `sch erc` report exits 5. It is filed with one error
  diagnostic per error item across `sheets[].violations[]`, each with its sheet path as `file`.
- [ ] **AC4 — the codec.** On the captured reports:
  - each diagnostic's `code`, `level`, `file` and `message` follow §S3, and the message carries `@ (x, y)
    mm`;
  - an `exclusion` item is no diagnostic;
  - a non-JSON text is one message-only error.
- [ ] **AC5 — kicad-cli's failures.**
  - With no `kicad-cli` on PATH, `drc` is refused before any POST, naming it.
  - A stub that exits 1 with an `Error:` line fails, and is filed as one message-only error carrying that
    line.
- [ ] **AC6 — every file runs.** With two PCBs, where the first fails, both run, the first is filed, and
  the envelope lists both.
- [ ] **AC7 — the policy is the project's.** The stub's argv holds `--severity-error` and
  `--exit-code-violations`. RUNBOOK states that `.kicad_pro`'s ignore rules never fail `drc`.
- [ ] **AC8 — the gate.**
  - With a failing `drc`, `pre-merge-gate` stops at `stage: drc`, after a passing `check`, and no tier
    run opens.
  - `--skip-drc` runs the tiers.
  - With nothing declared, the step passes and says so.
- [ ] **AC9 — the declaration.**
  - The schema's `version` is one more than at the branch's base, with `kicad_pcb` and `kicad_sch`.
  - The agreement test drives them.
  - A missing path is refused, naming the field.
- [ ] **AC10 — docs and invariants.**
  - README, RUNBOOK and CHANGELOG name `drc`, the two fields, the `kicad` format and exit 5.
  - The shared modules keep their pinned sizes.
  - The code and tests this CR adds carry no CR id literal.

## Estimated size

8 points: the server format with its tests (3), the verb with its runs and filing (3), and the gate step,
the schema fields and the docs (2).

## Risk

- **A future kicad-cli may change the JSON shape** (there is no published DRC schema). The codec then
  falls to its message-only error, so the run is never clean.
- **A board older than this format** stores a `kicad` report as `raw`. Its `"severity": "error"` strings
  still count as errors.

## Non-goals

- Filing warnings.
- One test case per rule from `.kicad_pro` (reading the report in the client).
- A kicad-cli version floor.
- Exporting Gerbers or a BOM.
- Storing counts on the board.
