# CR-CRU-254 — each stack's lint runs through its client, and the gate runs it after check

**Status:** PENDING · filed 2026-11-13 (user ruling: CR-CRU-199 split in three for ease of execution; this is
the client side of the lint design Model B asked for, Sandesh #1486 → #1488) · gap analysis:
`test-reports/work/cr199-gap-analysis.md`; design D1, D2, D5–D7 approved by the user 2026-11-13; Crucible's own
gate declares ruff (user ruling 2026-11-13)
**Type:** feature
**Points:** 8
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-199 (the board accepts the `lint` marker and decodes ruff and clippy); CR-CRU-253 (the
project's ruff rule set, and a tree clean on it)
**Labels:** clients, shared-module, gate, installer, docs
**Design reference:** CR-CRU-199 (the marker, the decoders, the view); CR-CRU-155 / the `[gate] skip`
declaration (a project table read project → install, first file wins, a malformed one refused); CR-CRU-221 (a
shared client module of its own, shipped with the fleet); CR-CRU-056 (the gated-run pre-flight)

## Problem

- **Only rust lints.** Its `clippy` and `workspace-clippy` verbs run clippy, and its `pre-merge-gate` starts with a
  fail-fast workspace clippy step. No other client lints.
- **The gate is the wrong place for a linter command.** Model B wants a lint step in every project's gate. Without
  a client verb, its stack files would each name a linter command beside the client (#1486).
- **`check` must stay "does it compile".** Folding lint into `check` would blur the signal an agent reads as "does
  not compile". The user ruled this out (2026-10-19).

## Design (user rulings 2026-11-13)

- **D1 — the declaration.** A project names its linter in a `[lint]` table of `crucible.toml`:

  ```toml
  [lint]
  command = ["ruff", "check", "--output-format", "concise", "."]
  format  = "ruff"
  ```

  - **Resolution:** the table is resolved as `[gate]` is: the project's own file first, then the install's. The
    first file that parses wins.
  - **The fields:**
    - `command` is a non-empty list of non-empty strings, run in the project directory;
    - `format` names the board's decoder (CR-CRU-199), and may be omitted, which means `raw`.
  - **A malformed table is refused**, naming the file, before any linter starts.
  - **Defaults when nothing is declared:**
    - rust: `cargo clippy --workspace --all-targets --all-features -- -D warnings`, format `clippy`. This is today's
      gate step, so nothing changes for a rust project.
    - go: `go vet ./...`, format `go vet`.
    - python, bun, maven and arduino have no default.
  - **A declared `command` replaces the default** (D7: golangci-lint replaces `go vet`; it does not run beside it).
- **D2 — the verdict is the linter's.** `lint` fails when the linter exits non-zero, so the project's own linter
  configuration decides what blocks.
- **Nothing to lint.** With no declaration and no default, `lint` answers `ok: true` with `skipped: not-declared`.
- **D5 — rust keeps its verbs.**
  - `clippy` and `workspace-clippy` stay, unchanged in what they run.
  - `clippy` and `workspace-clippy` filings carry the `lint` marker from now on.
  - The rust gate's clippy step becomes its `lint` step.
- **D6 — maven and arduino** lint only what a project declares, such as `mvn checkstyle:check` or `clang-tidy …`.
- **The gate.** Every client's `pre-merge-gate` runs `lint` fail-fast **after `check`** and before the tests.
  - A failing lint stops the gate there.
  - A skipped lint lets the gate continue, with a `lint-not-declared` warning.
- **`check` never runs a linter.**

## Steps

### §S1 — one shared lint runner

- A new shared client module, `clients/_crucible_lint.py`, holds everything common:
  - the `[lint]` resolution and its refusals;
  - running the command;
  - the post to `/api/v2/runs/compile` with `format`, `lint`, the raw output and the run context;
  - the envelope;
  - the help steps.
- The shared core, which has 83 lines left under its guard, gains only the loader for this module.
- The installer ships `_crucible_lint.py` with the client fleet, as it ships `_crucible_run.py`.

### §S2 — the `lint` verb in every client

`python-crucible.py`, `bun-crucible.py`, `rust-crucible.py`, `go-crucible.py`, `mvn-crucible.py` and
`arduino-crucible.py` each gain `lint [--agent ID] [--cycle N]`, built on §S1.

**The envelope** names:

- `linter`, the command's first word;
- `declared`: `flag`, `declared:<file>` or `default`;
- `exit`;
- `errors`, `warnings`;
- the filed `event`;
- or `skipped: not-declared`.

**Cases:**

- **The linter is not on PATH:** `lint` is refused, naming it. Nothing is posted.
- **The board is unreachable:** the client's existing ingest-failed warning applies, and the verdict still follows
  the exit code.
- **Every post** (CR-CRU-199's pre-review folds) carries the linter's `runnerExit`, and a clean run is posted
  even when the linter printed nothing, so the board records every lint run with the linter's own verdict.
- **The clients' `runs` and `run` verbs** (`_run_brief`) say `lint`, not `compile`, for a record carrying the
  marker, naming its tool (moved here from CR-CRU-199 §S3).
- **The rust client:**
  - `lint` uses the default or declared command;
  - `clippy` and `workspace-clippy` keep their own arguments;
  - every clippy filing carries `lint: "clippy"` and `format: "clippy"`.

### §S3 — the gate

- Every client's `pre-merge-gate` gains a `lint` stage after `check`.
  - **Failing:** the gate stops there and answers the failure, with the lint event.
  - **Skipped:** the gate continues, and the envelope's warnings carry `lint-not-declared`.
- The rust gate's former clippy stage is this stage. With nothing declared it runs the same command.

### §S4 — Crucible's own declaration

- This checkout's own `crucible.toml`, at the repo root, is git-ignored operator state (CR-CRU-131). At this CR's
  merge the orchestrator adds this table to it, beside its `[client]` url, which is not touched (user ruling
  2026-11-13). The ruff rule set itself is the tracked `pyproject.toml`'s (CR-CRU-253):

  ```toml
  [lint]
  command = ["ruff", "check", "--output-format", "concise", "clients", "crucible_axi", "tests"]
  format = "ruff"
  ```

- Crucible's own gate therefore lints its python. The table is local, so the RUNBOOK's Lint section tells a new
  checkout to add the same table.
- The shipped `clients/crucible.toml` documents `[lint]` in a commented block and declares nothing.

### §S5 — the words

Each of these says what §S1–§S4 say:

- **every client's `--help`:** the `lint` verb, and the gate's stage order;
- **the RUNBOOK:** a "Lint" section, with the table, the defaults and the gate;
- **the CHANGELOG.**

Then Model B is told over Sandesh, answering #1488.

## Acceptance criteria

- [ ] **AC1 — a declared linter runs and files.**
  - In a scratch python project declaring `[lint]` ruff, against a board double, `python-crucible.py lint` runs
    the declared command in the project directory.
  - It posts `format: "ruff"`, `lint: "ruff"`, the linter's `runnerExit` and the raw output to
    `/api/v2/runs/compile`.
  - A clean run whose linter printed nothing is posted too, with `runnerExit: 0`.
  - It answers `ok` and the linter's exit verdict, with `declared: declared:<file>`.
- [ ] **AC2 — the linter's exit code is the verdict.**
  - A linter exiting 1 makes `lint` answer `ok: false`, and the client exits non-zero.
  - A linter exiting 0 answers `ok: true`, even if its output holds warnings.
- [ ] **AC3 — nothing declared is skipped, not refused.** A python project with no `[lint]` answers `ok: true`,
  `skipped: not-declared`, and posts nothing.
- [ ] **AC4 — a malformed declaration is refused.** `command = "ruff check"` (a string), `command = []`, an empty
  entry, or a non-string `format` is refused before anything runs. The refusal names the file.
- [ ] **AC5 — a missing linter is refused.** A declared command whose first word is not on PATH is refused, naming
  it, and posts nothing.
- [ ] **AC6 — the defaults.**
  - A rust project with no `[lint]` runs the workspace clippy command, filed with `format: "clippy"`.
  - A go project runs `go vet ./...`, filed with `format: "go vet"`.
  - In each, a declared `command` replaces the default.
- [ ] **AC7 — every client has the verb.** Each of the six clients' `lint` resolves through the shared module.
  The help census and the envelope census cover it.
- [ ] **AC8 — rust's clippy verbs carry the marker.** `clippy` and `workspace-clippy` keep their arguments and
  commands. Their posts carry `lint: "clippy"` and `format: "clippy"`.
- [ ] **AC9 — the gate runs lint after check.** In each client's `pre-merge-gate`:
  - a failing lint stops the gate after `check` and before any test tier, naming the lint stage;
  - a skipped lint continues, with a `lint-not-declared` warning.
- [ ] **AC10 — check never lints.** Each client's `check` runs no declared linter, whatever `[lint]` declares.
- [ ] **AC11 — the module ships.** A sandboxed install lays `_crucible_lint.py` down with the fleet, and an
  installed client's `lint` loads it.
- [ ] **AC12 — Crucible's own declaration.**
  - Ruff passes on `clients`, `crucible_axi` and `tests` with the project's rule set.
  - The RUNBOOK names the table a checkout adds.
  - After the merge, the orchestrator adds the table to the local root file without touching `[client]`. A
    `bun-crucible.py lint` there answers `declared: declared:<root file>` and `ok: true`. This is recorded at
    close-out, since a test cannot read an untracked file.
- [ ] **AC13 — the words.** Every client's help, the shipped toml's commented `[lint]` block, the RUNBOOK's Lint
  section and the CHANGELOG say what §S1–§S4 say.
- [ ] **AC14 — budgets and boundaries.**
  - The core stays at or under 9200 lines.
  - `SHARED_MODULE_LINE_BUDGETS` pins `_crucible_lint.py` in all three copies.
  - No `src/` or `public/` file changes.
- [ ] **AC15 — the clients' `runs` and `run` say lint.** For a lint record, `runs` and `run` name it `lint` and its
  tool; a compile record's wording is unchanged.

## Non-goals

- The board side: the marker, the decoders and the view. These are CR-CRU-199.
- ESLint and Biome decoders. Their output is `raw` (user ruling 2026-11-13).
- Running two linters at once, or a list of commands.
- Auto-fixing (`ruff --fix`, `clippy --fix`).
