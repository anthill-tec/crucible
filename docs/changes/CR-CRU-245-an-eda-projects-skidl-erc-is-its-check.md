# CR-CRU-245 — an EDA project's SKiDL ERC is its check, and a failing ERC reaches the board

**Status:** PENDING · Pre-review: due — 8 points, user rulings, another project's surface
**Type:** feature
**Priority:** high. P1's CR-PFC-010 gates its netlist's ERC through it.
**Depends on:** CR-CRU-243
**Labels:** clients, eda, codecs
**Phase:** design
**Design reference:** CR-CRU-239 §S1 (adding a compile format; a failure is never clean); `docs/research/PRD-crucible-v2.md` (compile ingest)

## Context

An EDA project's L0 is SKiDL netlist generation with its ERC. The fleet's `check` is each stack's compile
analogue: it runs before the tests, a failing one files a compile run, and a clean one files nothing.

**Measured on SKiDL 3.0.0, Python 3.13:**

- **`ERC()` exits 0 even with ERC errors.** Only a Python exception (a bad pin name) exits 1, with a
  traceback.
- **ERC writes its findings line by line** to stderr and to `<script>.erc`:
  - `ERC ERROR: <text>`;
  - `ERC WARNING: <text>`;
  - `ERC INFO: <N> warnings found while running ERC.`;
  - `ERC INFO: <N> errors found while running ERC.`
- **The ERC lines name the net, the pins and the parts.** They carry no file or line.
- **The netlist step adds noise:** `INFO:` and `WARNING:` lines. So does every unset
  `KICAD*_SYMBOL_DIR`.

**The board has no SKiDL format.** In `raw`, `rawCounts` counts the word "error" case-insensitively. A
traceback's `NameError:` does not match, so a crashed script could be stored as `COMPILE OK`.

## Scope

- **`check` is SKiDL ERC.**
- **The verdict reads the output, not only the exit code.** A check fails when any of these holds:
  - the script exits non-zero;
  - the `ERC INFO: <N> errors found while running ERC.` line states N > 0;
  - that line is absent. Then ERC did not run, and the check is never shown clean.

  Warnings never fail it.
- **The server decodes a new `skidl` compile format.** An exception exit is filed in the existing `python`
  format, which decodes tracebacks.
- **No board field carries the counts.** The envelope states them.

### §S1 — the declaration

- `[eda] erc` in the project's `crucible.toml` is a non-empty list of SKiDL script paths, relative to the
  project dir. Each path must exist.
- **Worked example:** P1's project dir is `hardware/`, and its one ERC entry is
  `controller-board/board.py`, which writes `controller-board.net` and its ERC log:

  ```toml
  [eda]
  erc = ["controller-board/board.py"]
  ```

- The schema's `eda` stack table gains `erc` (values: paths that hold a file; default none; not
  required), and the schema's `version` goes up by one.

### §S2 — the `check` verb

- **It runs each declared script** as `<interpreter> <script>`, with the script's directory as the working
  directory. The interpreter is CR-CRU-242's resolver. The environment is inherited, so the project's own
  `.envrc` sets `KICAD8_SYMBOL_DIR`.
- **Every script runs,** even after an earlier one fails.
- **It reads the two `ERC INFO` summary lines** from the captured stderr, and decides each script's
  verdict as this Scope's opening states.
- **The envelope** carries `erc: [{script, exit, errors, warnings}]`, with `null` where a summary line is
  absent. It is `ok: false` when any script failed.
- **`--agent` files one compile run per failing script:**
  - format `python`, with the stderr, when the script exited non-zero;
  - format `skidl`, with the stderr, otherwise.

  A clean check files nothing.
- **With no `[eda] erc` declared,** `check` passes, files nothing, and carries `check-compiled-nothing`,
  naming `[eda] erc`.
- **It takes** `--agent`, `--cycle`, `--project-dir` and `--python`.

### §S3 — the `skidl` compile format

In `src/codecs/compile.ts`:

- **Diagnostics:**
  - a line `ERC ERROR: <text>` is one `error` diagnostic, with message `<text>`;
  - a line `ERC WARNING: <text>` is one `warning` diagnostic;
  - neither has `file`, `line` or `code`;
  - no other line is a diagnostic: not `ERC INFO:`, the netlist `INFO:` and `WARNING:` lines, the
    symbol-dir warnings, or the `SyntaxWarning`s.
- **A report with no `ERC ERROR:` line** is stored as one message-only error. Its message is the report's
  `ERC INFO:` lines, or its first non-blank line, so its error count is at least 1.
- **The hint `skidl`** joins `HINT_ALIASES`. `detectFormat` is unchanged, because the client always sends
  the hint.

### §S4 — the gate

`pre-merge-gate` runs `check` first, and stops there on a failure:

- `stage: check`;
- the shared step-abort help and warning;
- `--skip-check` bypasses it.

The tier suites then run as CR-CRU-242 composes them.

## Acceptance criteria

The fixtures are SKiDL 3.0.0 stderr captures, committed as text.

- [ ] **AC1 — the three outcomes.** These run through stub interpreters that replay the captures with
  their exit codes:
  - 1 error and 17 warnings, exit 0: `check` fails, with `erc[0].errors == 1` and `warnings == 17`;
  - 0 errors and 3 warnings, exit 0: it passes and files nothing;
  - a bad pin name, exit 1: it fails.
- [ ] **AC2 — never clean on the board.**
  - With `--agent`, the ERC case files one compile run of format `skidl`, whose `errorCount` is 1 and
    whose one error diagnostic carries the `Pin conflict on net SHARED …` text.
  - The exception case files one run of format `python`, whose `errorCount` is at least 1.
- [ ] **AC3 — the summary is absent.** A script that exits 0 and prints no `ERC INFO … errors found` line
  fails, naming the missing summary. With `--agent` it is filed in the `skidl` format, with `errorCount`
  1.
- [ ] **AC4 — the codec.** On the committed capture:
  - every `ERC ERROR:` line is one error diagnostic, and every `ERC WARNING:` line one warning;
  - no `ERC INFO:`, netlist `INFO:` or `WARNING:` line, symbol-dir `WARNING`, or `SyntaxWarning` is a
    diagnostic;
  - the verdict is `COMPILE FAILED — 1 errors, 17 warnings`.
- [ ] **AC5 — every script runs.** With two declared scripts, where the first fails, both run, the first
  is filed, and the envelope lists both.
- [ ] **AC6 — the gate fails fast.** `pre-merge-gate` with a failing ERC stops at `stage: check`, and no
  tier run opens. `--skip-check` runs the tiers.
- [ ] **AC7 — the declaration.**
  - The schema's `version` is one more than at the branch's base, and it holds `[eda] erc`.
  - The agreement test drives the check.
  - A missing path is refused, naming `[eda] erc`.
- [ ] **AC8 — docs and invariants.**
  - The CHANGELOG states that SKiDL `ERC()` exits 0 on errors and that `check` reads the summary line, and
    it names the `skidl` format.
  - README and RUNBOOK name `check` and `[eda] erc`.
  - The shared modules keep their pinned sizes.
  - The code and tests this CR adds carry no CR id literal.

## Estimated size

8 points: the server format with its tests (3), the verb with its verdict and filing (3), and the gate
step, the schema field and the docs (2).

## Risk

- **A board older than this format** stores a `skidl` report as `raw`. That is accepted, as in CR-CRU-239,
  because the failing check still exits non-zero on the agent's side.
- **A SKiDL release could change the summary wording.** Then AC3's missing-summary rule fails the check.
  That is loud, never silent.

## Non-goals

- Perfboard Studio's own `run_erc` (a gate in a tier).
- KiCad's `sch erc` (CR-CRU-248).
- The netlist content checks.
- Storing the ERC counts on the board.
- Listing compile formats in health.
