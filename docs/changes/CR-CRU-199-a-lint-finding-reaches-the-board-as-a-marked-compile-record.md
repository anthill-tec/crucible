# CR-CRU-199 — a lint finding reaches the board as a marked compile record, and shows as its own group

**Status:** PENDING · filed 2026-10-19 (Model B question, Sandesh #1486; user ruling: lint is Crucible's surface,
through a `lint` verb in every client, in 0.4.0) · gap analysis ran 2026-11-13
(`test-reports/work/cr199-gap-analysis.md`); design D1–D8 approved by the user 2026-11-13 · **re-scoped
2026-11-13** (user ruling, split for ease of execution): this CR is the BOARD side; the clients' `lint` verb is
CR-CRU-254, and the client hygiene that was added here on 2026-11-04 is CR-CRU-253 (merged) · Pre-review: ran
2026-11-13 (it changes the store, the ingest API, the decoders and the UI); CHANGES, 11 findings folded
**Type:** feature
**Points:** 13 (8 at the split; the pre-review's folds add the exit code, clean posts and five more consumers)
**Wave:** 8 (0.4.0)
**Depends on:** — (sequenced after CR-CRU-253; CR-CRU-254 depends on this)
**Labels:** server, store, codecs, ui, api
**Design reference:** CR-CRU-152 (the board decodes every report; the client parses none); CR-CRU-057 (compile
evidence stamped like run evidence); CR-CRU-017 (a compile ingest closes an open run); CR-CRU-080 (a field one
kind carries rides the payload: no column, no migration)

## Problem

- **The board cannot tell a lint finding from a compile error.** Rust's `clippy` and its gate's clippy step file
  their findings on `/api/v2/runs/compile` as ordinary compile records (`format: "rustc"`). Every consumer branches
  on `kind === "compile"` with nothing beneath it. A clippy failure therefore reads as "does not compile" in many
  places:
  - the dashboard card;
  - the Compile panel;
  - the drill-in;
  - the agent's last outcome;
  - the project status line;
  - `/api/v2/status`'s `lastCompile`.

  "Does not compile" is the very signal the user ruled `check` must keep for itself.
- **A lint finding carries no rule.** The rustc decoder captures only `error[E####]` codes, and clippy's lint name
  is dropped. clang-tidy's findings are warnings, so the gcc decoder's no-error fallback stores them raw, losing the
  findings and their `[check]`. There is no decoder for ruff.
- **The board never sees the linter's verdict.** A linter that fails on its own configuration (ruff exits 2 with
  `ruff failed`) prints no finding line, so its record would read clean. A clean `go vet` or clang-tidy run prints
  nothing at all, and the route refuses an empty post, so a clean lint run cannot be filed.
- **The PRD has no lint at all.**

CR-CRU-254 gives every client a `lint` verb that posts on this route. This CR makes the board ready for it first.

## Design (user rulings 2026-11-13, D2–D4 and D8 of the gap analysis; folds marked)

- **D4: the marker.**
  - `/api/v2/runs/compile` takes an optional `lint` field: the linter's name as a non-empty string (`"ruff"`,
    `"clippy"`, `"go vet"`, …).
  - A record carrying it is a **lint record**. One without it is a compile record exactly as today, so older
    clients are accepted unchanged.
  - The event's `kind` stays `compile`: no new kind and no new route.
  - *Fold F8:* the marker rides the event's payload (the CR-CRU-080 convention), so there is no new column
    and no migration.
- **The linter's exit (fold F1, F2).** A lint post carries the linter's `runnerExit`, under the rule `/runs`
  already applies.
  - The record's verdict follows the exit, so a failed linter never reads clean.
  - A clean run is filed even when the linter printed nothing.
- **D3: the board decodes.** The client posts the linter's raw output with a `format` naming the decoder.
  - New decoders: `ruff` and `clippy`.
  - Extended decoder: `gcc` reads clang-tidy's check as the code.
  - `go` already reads `go vet`'s lines.
  - *Fold F10:* a format that is not recognised falls to detection and then to `raw`, as today.
- **D2: levels.** Each finding keeps the level its tool gave it. A tool with no levels (ruff, go vet) gives every
  finding `error`.
- **D8: the view.**
  - On the Compile tab, lint records form their own **Lint** group beside the compile diagnostics, with rule codes
    shown.
  - Wherever a lint record is shown or summarised, it says "lint", never "compile".
  - `/api/v2/status` gains `lastLint`, and `lastCompile` stops counting lint records.

## Steps

### §S0 — the storyboard frame (before RED)

- The storyboard (`.lavish/crucible-v2-design.html`) gains a frame showing the Compile tab:
  - a compile group and a **Lint** group side by side;
  - a lint card, failing and clean, with its icon (`data-kind`) settled here (fold F9);
  - a lint record's drill-in with rule codes;
  - the tab holding only lint records.
- The user approves the frame before RED. The UI follows it.

### §S1 — the route

`/api/v2/runs/compile` accepts two fields for a lint post: `lint` and `runnerExit`.

#### `lint`

- **Absent:** a compile record, as today.
- **A non-empty string:** a lint record.
- **Any other value** (empty, or not a string): refused with 400, naming the field. Nothing is stored.
- The marker is written to the event's payload. It is returned on the event, and in every brief built from it
  (fold F6: `eventBrief` gains `lint` when set and omits it otherwise).

#### `runnerExit` (fold F1)

- Validated as on `/runs` (`refuseBadRunnerExit`): an integer ≥ 0, or absent.
- On a lint post, a non-zero exit with no `error` finding stores one synthetic `error` diagnostic: "the linter
  exited N but its output records no error", with no file and no code.
- On a compile post, `runnerExit` keeps today's meaning: it is neither validated nor used (amended at RED 941).
- A lint post's decoded counts are never overridden by the exit: `runnerExit: 0` with a decoded error still
  answers `LINT FAILED` (amended at RED 941).

#### A clean lint post (fold F2)

- A lint post with `runnerExit: 0` may carry empty `errors`. It stores a clean lint record with zero findings.
- A lint post with empty `errors` and a non-zero `runnerExit` is stored with the one synthetic error, and answers
  `LINT FAILED`. A lint post with empty `errors` and no `runnerExit` is refused as a compile post is (amended at
  RED 941).
- The decoders' "a failed build is never shown as clean" guards (go's message-only error, gcc's no-error→raw) do
  not apply to a lint post with `runnerExit: 0`.
- A compile post with empty `errors` is still refused.

#### The verdict

- For a lint record: `LINT FAILED — N errors, M warnings` or `LINT OK — M warnings`.
- A compile record's verdict is unchanged.
- The hint after a lint post names the Lint group, not the compile panel (fold F6, `hints`).

### §S2 — the decoders (folds F3, F4, F5)

All four are proved on captured output in a new `tests/fixtures/lint/`, whose README names the tool, its version and
the command for each capture.

**`ruff`** reads `--output-format concise` lines: `PATH:LINE:COL: CODE message`.

- Each finding takes file, line, col, code and message, at level `error`.
- A fix marker `[*]` before the message is stripped.
- A syntax error (`PATH:LINE:COL: invalid-syntax: …`) is a finding coded `invalid-syntax`.
- `E902` (a file that is missing or unreadable) is an ordinary finding.
- The summary lines are not findings: `Found N errors.`, `[*] N fixable …`, `No fixes available …`,
  `All checks passed!`.

**`clippy`** reads cargo clippy's human output, as `rustc` does, with three changes:

- **The code.** Each clippy lint is coded `clippy::<name>`.
  - The name comes first from the help URL's `#<name>` (under `master/` or a versioned `rust-<v>/` path).
  - The fallback is the `= note: #[warn(clippy::<name>)]` / `#[deny(…)]` line, kebab-case `-D clippy::<name>`
    normalised to snake case.
  - A quoted source line (`#![deny(clippy::all)]` under "the lint level is defined here") is never read as a code.
- **rustc's own lints** (for example `unused_variables`) take their name from the `#[warn(<name>)]` note as the
  code, or from a `-D <name>` / `-W <name>` note (kebab case read as snake case), the form `-D warnings` prints
  (amended at GREEN 942). An `E####` error keeps its code.
- **The trailer** `error: could not compile … due to N previous error…; M warnings emitted` is not a finding.

**`gcc`** takes a trailing bracketed check as the code. When the bracket holds several comma-separated items,
the code is the first item that is not a flag (`-warnings-as-errors` is dropped). Two cases:

- On a **lint post that states its `runnerExit`** (any value), the no-error→raw fallback does not apply, so a
  clang-tidy run of only warnings keeps its findings and codes; a non-zero exit with no error still gets §S1's
  synthetic error. A lint post with no `runnerExit` keeps the fallback, so unreadable output is never filed clean
  (amended at GREEN 942).
- On a **compile post** the fallback stands, unchanged (PRD §4.5).

**Hint aliases:** `ruff`, `clippy`, `go vet` → `go`, `clang-tidy` → `gcc`.

### §S3 — every place a lint record is shown or summarised (fold F6, F9)

- **Compile tab:**
  - compile records and lint records are grouped separately;
  - the Lint group heads with its count, and each record shows its tool;
  - a tab with no lint records shows no Lint group;
  - a tab with only lint records shows the Lint group and no `no compile events yet` line.
- **A lint record's card:** names the tool and reads `N lint errors` (fail-red) or `lint clean` (pass-green), never
  `errors` alone and never "compile". Its `data-kind` is the one §S0 settles.
- **A lint record's drill-in:**
  - findings grouped by file, each with its rule code where the tool gives one;
  - a clean record reads `clean lint — no findings`;
  - the raw-output toggle is kept.
- **The agent's last outcome** (`compileOutcome`, written by `recordCompileEvent`): a lint record writes
  `lint · N errors · ingested` (`1 error` singular), or `lint · clean · ingested` when there are no errors, rather
  than `compile · …` (amended at RED 941).
- **The project status line** (`projectStatus`, `public/app-logic.mjs`): its compile verdict (`✓ compiled` /
  `✗ N errors`) is taken from the newest compile record that is not a lint record. A lint record never sets it.
  The line reads as if lint records did not exist: the projects rollup (`/api/v2/projects`) keeps `lastEvent` as
  the newest run and gains `lastEventNotLint`, the brief of the newest run that is not a lint record, or null.
  `projectStatus` reads it when `lastEvent` is a lint record. A project whose runs are all lint records shows the
  newest lint record's own wording (`✗ N lint errors` / `lint clean`), never a compile verdict (amended at RED 943).
- **`/api/v2/status`:**
  - `lastCompile` is the newest compile record that is not a lint record;
  - `lastLint` is the newest lint record, or null.
- **Retention (fold F11):** lint records count as runs, like compile records, for the retention cap, the daily
  rollup and the per-release count. This is unchanged, and documented.
- **Out of scope here:** the clients' `runs` and `run` verbs (`_run_brief`). These go to CR-CRU-254, which owns the
  client side.

### §S4 — the words (fold F7)

- **PRD:**
  - **a lint section:** lint is a client verb, run fail-fast by the gate after `check` and declared per project
    (CR-CRU-254); its findings are marked compile records; the linter's exit is the verdict; `check` never lints;
  - **§4.5:** the new decoders, and the lint exception to the gcc raw fallback;
  - **the status shape:** `{hasData, lastTest, lastCompile, lastLint}`;
  - **the compile route's body:** `lint` and `runnerExit`. No separate API doc exists: CR-CRU-227 was reverted.
- **RUNBOOK:** lint records count toward retention.
- **CHANGELOG:** an entry.

## Acceptance criteria

- [ ] **AC1 — the marker is accepted, stored and returned.**
  - A post with `lint: "ruff"` stores a record whose event, and whose brief, carry `lint: "ruff"`.
  - A post without `lint` stores a record whose event and brief carry no `lint`, byte-for-byte as today's.
  - `lint: ""` and `lint: 5` are refused with 400 naming `lint`, and store nothing.
- [ ] **AC2 — old records read as compile records.** A store holding compile records written before this change
  (no `lint` in their payload) opens and reads every record back unchanged, with no `lint`. There is no schema
  migration.
- [ ] **AC3 — the verdict follows the linter.**
  - A lint record with errors answers `LINT FAILED — N errors, M warnings`; a clean one, `LINT OK — M warnings`.
  - A lint post with `runnerExit: 2` and output holding no finding (`ruff failed …`) stores one synthetic error
    naming exit 2, and answers `LINT FAILED`.
  - A bad `runnerExit` is refused as on `/runs`.
  - A compile record's wording is unchanged.
- [ ] **AC4 — a clean lint run is filed.**
  - A lint post with `format: "go vet"`, `runnerExit: 0` and empty `errors` stores a clean lint record with zero
    findings, answering `LINT OK — 0 warnings`.
  - A captured clean clippy run and a captured ruff `All checks passed!` do the same.
  - A compile post with empty `errors` is still refused.
- [ ] **AC5 — ruff is decoded.** A captured ruff 0.16 output holding a fixable finding (`[*]`), an unfixable one,
  an `invalid-syntax` line and both summary lines decodes to exactly its findings. Each has file, line, col, code
  and a message without `[*]`, at level `error`. No summary line becomes a finding.
- [ ] **AC6 — clippy is decoded.** A captured clippy output decodes to exact counts. It holds:
  - a `warn` lint;
  - a `deny` lint (declared through `#![deny(clippy::all)]`);
  - a lint under `-D warnings`;
  - a rustc `unused_variables` warning;
  - an `E####` error;
  - the `could not compile` trailer.

  The decoded codes:
  - the clippy lints are `clippy::<name>`, from the URL;
  - `unused_variables` is coded `unused_variables`;
  - the `E####` keeps its code;
  - none is `clippy::all`;
  - the trailer is not a finding.
- [ ] **AC7 — clang-tidy is decoded.**
  - On a lint post, a captured warning line ending `[readability-braces-around-statements]` decodes as a warning
    with that code, and is not stored raw.
  - A captured `--warnings-as-errors` line (`[…,-warnings-as-errors]`) decodes as an error with the check's code.
  - On a compile post, gcc output with no error falls to raw as today.
- [ ] **AC8 — the hint aliases.** `ruff`, `clippy`, `go vet` and `clang-tidy` select their decoders. A captured
  `go vet` output decodes through `go`.
- [ ] **AC9 — the Compile tab groups lint apart** (the approved storyboard frame).
  - With one compile record and one lint record: a compile group and a Lint group, each holding its record.
  - With no lint record: no Lint group.
  - With only lint records: the Lint group, and no `no compile events yet`.
- [ ] **AC10 — a lint record says lint wherever it is shown.**
  - **Card:** a failing lint card reads `N lint errors` and names its tool; a clean one reads `lint clean`; neither
    says "compile".
  - **Drill-in:** codes grouped by file, or `clean lint — no findings`.
  - **Agent outcome:** after a lint post, the agent's last outcome reads `lint · …`.
  - **Project status line:** a newer lint record does not change the line's compile verdict.
- [ ] **AC11 — status keeps compile and lint apart.** With a compile record followed by a newer lint record,
  `/api/v2/status` answers `lastCompile` = the compile record and `lastLint` = the lint record. With no lint record,
  `lastLint` is null.
- [ ] **AC12 — the words.** Each of these exists and says what §S4 says:
  - the PRD's lint section;
  - §4.5's decoders and lint exception;
  - the status shape and route body;
  - the RUNBOOK retention line;
  - the CHANGELOG entry.
- [ ] **AC13 — nothing else moves.** The existing compile, run, status, brief, agent-outcome and project-status
  suites pass unedited. The pre-review found no test this breaks. Any edit is listed.

## Non-goals

- **The client side** — the clients' `lint` verb, the `[lint]` declaration, the gate step and the clients'
  `runs`/`run` wording. That is CR-CRU-254.
- **ESLint and Biome decoders** (user ruling 2026-11-13). Their output is `raw`, and the verdict still holds.
- **A new event kind, route or store column.**
- **Re-filing old clippy records as lint.** Records stored before this CR stay compile records.
