# CR-CRU-199 — a lint finding reaches the board as a marked compile record, and shows as its own group

**Status:** PENDING · filed 2026-10-19 (Model B question, Sandesh #1486; user ruling: lint is Crucible's surface,
through a `lint` verb in every client, in 0.4.0) · gap analysis ran 2026-11-13
(`test-reports/work/cr199-gap-analysis.md`); design D1–D8 approved by the user 2026-11-13 · **re-scoped
2026-11-13** (user ruling, split for ease of execution): this CR is the BOARD side; the clients' `lint` verb is
CR-CRU-254, and the client hygiene that was added here on 2026-11-04 is CR-CRU-253
**Type:** feature
**Points:** 8 (13 at filing, before the split)
**Wave:** 8 (0.4.0)
**Depends on:** — (sequenced after CR-CRU-253; CR-CRU-254 depends on this)
**Labels:** server, store, codecs, ui, api
**Design reference:** CR-CRU-152 (the board decodes every report; the client parses none); CR-CRU-057 (compile
evidence stamped like run evidence); CR-CRU-017 (a compile ingest closes an open run)

## Problem

- **The board cannot tell a lint finding from a compile error.** Rust's `clippy` and its gate's clippy step file
  their findings on `/api/v2/runs/compile` as ordinary compile records (`format: "rustc"`). Every consumer branches
  on `kind === "compile"` with nothing beneath it. A clippy failure therefore reads as "does not compile" on the
  dashboard card, the Compile panel, the drill-in and `/api/v2/status`'s `lastCompile`. That is the very signal the
  user ruled `check` must keep for itself.
- **A lint finding carries no rule.** The rustc decoder captures only `error[E####]` codes. Clippy's lint name
  (`clippy::needless_return`) is dropped. The gcc decoder reads clang-tidy's lines but drops their `[check-name]`.
  There is no decoder for ruff.
- **The PRD has no lint at all.**

CR-CRU-254 gives every client a `lint` verb that posts on this route. This CR makes the board ready for it first.

## Design (user rulings 2026-11-13, D2–D4 and D8 of the gap analysis)

- **D4 — the marker.** `/api/v2/runs/compile` takes an optional `lint` field, the linter's name as a non-empty
  string (`"ruff"`, `"clippy"`, `"go vet"`, …). A record carrying it is a **lint record**; one without it is a
  compile record exactly as today. So older clients are accepted unchanged. The marker is stored, returned on the
  event, and drives every wording below. The event's `kind` stays `compile`: no new kind, no new route.
- **D3 — the board decodes.** The client posts the linter's raw output with a `format` naming the decoder. New
  decoders: `ruff` and `clippy`. Extended decoders: `gcc`, which reads clang-tidy's `[check-name]` as the code.
  Unchanged: `go` already reads `go vet`'s lines. Any other format falls to `raw`, as today.
- **D2 — levels.** Each finding keeps the level its tool gave it. A tool with no levels (ruff, go vet) gives every
  finding `error`. The pass/fail of a lint run is the client's (the linter's exit code, CR-CRU-254). The board
  records the counts and words the verdict.
- **D8 — the view.** On the Compile tab, lint records are their own **Lint** group beside the compile diagnostics,
  with rule codes shown. A lint record's card and drill-in say "lint", never "compile". `/api/v2/status` gains
  `lastLint`, and `lastCompile` stops counting lint records.

## Steps

### §S0 — the storyboard frame (before RED)

- The storyboard (`.lavish/crucible-v2-design.html`) gains a frame showing the Compile tab:
  - a compile group and a **Lint** group, side by side;
  - a lint card (failing and clean);
  - a lint record's drill-in, with rule codes.
- The user approves the frame before RED. The UI follows it.

### §S1 — the route and the store

- `/api/v2/runs/compile` accepts `lint`.
  - **Absent:** a compile record, as today.
  - **A non-empty string:** a lint record.
  - **Any other value** (empty, non-string): refused with 400, naming the field. Nothing is stored.
- `run_compiles` gains a nullable `lint` column, added through the store's existing add-column migration list. A board
  upgraded in place keeps every stored record, and every old record reads as a compile record.
- The event the store returns carries `lint` when it is set, and omits it otherwise.
- **The verdict:**
  - for a lint record: `LINT FAILED — N errors, M warnings` / `LINT OK — M warnings`;
  - for a compile record: unchanged.

### §S2 — the decoders

- **`ruff`** reads ruff's `--output-format concise` lines: `PATH:LINE:COL: CODE message`. Each finding gets file,
  line, col, code and message, at level `error`. Ruff's summary lines (`Found N errors.`, `[*] N fixable …`) are
  not findings.
- **`clippy`** reads cargo clippy's human output, as `rustc` does. In addition, each warning or error takes its
  lint name as `code`, from the `#[warn(clippy::…)]` / `#[deny(clippy::…)]` note or from the help URL's
  `#<name>`, written `clippy::<name>`. A rustc diagnostic in the same output keeps its `E####` code.
- **`gcc`** additionally takes a trailing `[check-name]` (clang-tidy's) as `code`. A gcc line without one is
  unchanged.
- **Hint aliases:** `ruff`, `clippy`, `go vet` → `go`, `clang-tidy` → `gcc`.
- An unknown format falls to `raw`, as today.

### §S3 — the view and the status

- **Compile tab:** compile records and lint records are grouped separately. The Lint group heads with its count,
  and each record shows its tool. A tab with no lint records shows no empty Lint group.
- **A lint record's card:** names the tool and reads `N lint errors` (fail-red) or `lint clean` (pass-green).
  Never `errors` alone, never "compile".
- **A lint record's drill-in:**
  - its findings are grouped by file, each with its rule code;
  - a clean record reads `clean lint — no findings`;
  - the raw-output toggle is kept.
- **`/api/v2/status`:** `lastCompile` is the newest compile record that is not a lint record. A new `lastLint` is
  the newest lint record, or null.

### §S4 — the words

- **PRD:** a lint section covering:
  - lint is a client verb, run fail-fast by the gate after `check`, declared per project (CR-CRU-254);
  - its findings are marked compile records;
  - `check` never lints.
- **API documentation:** the `lint` field, the verdict wording and `lastLint` (the current-API doc of
  CR-CRU-227).
- **CHANGELOG:** an entry.

## Acceptance criteria

- [ ] **AC1 — the marker is accepted, stored and returned.**
  - A `/api/v2/runs/compile` post with `lint: "ruff"` stores a record whose event carries `lint: "ruff"`.
  - A post without `lint` stores a record with no `lint`, byte-for-byte as today's.
  - `lint: ""` and `lint: 5` are refused with 400 naming `lint`, and store nothing.
- [ ] **AC2 — an old board's records survive the upgrade.** A store created without the `lint` column, holding
  compile records, opens under this build. Every record reads back unchanged, with no `lint`.
- [ ] **AC3 — the verdict is worded by the marker.**
  - A lint record with errors answers `LINT FAILED — N errors, M warnings`; a clean one, `LINT OK — M warnings`.
  - A compile record's wording is unchanged.
- [ ] **AC4 — ruff is decoded.** A captured `ruff check --output-format concise` output with three findings over
  two files decodes to three diagnostics, each with file, line, col, code (e.g. `F401`) and message, at level
  `error`. The summary lines are not diagnostics.
- [ ] **AC5 — clippy's lint name is the code.**
  - A captured clippy output with a `warn` lint and a `deny` lint decodes to a `warning` and an `error`, coded
    `clippy::<name>`.
  - A rustc `E####` error in the same output keeps its code.
- [ ] **AC6 — clang-tidy's check is the code.** A gcc-format line ending in `[readability-braces-around-statements]`
  decodes with that code. A gcc line without one decodes as today.
- [ ] **AC7 — the hint aliases.** `ruff`, `clippy`, `go vet` and `clang-tidy` select their decoders. `go vet`'s
  captured output decodes through `go`.
- [ ] **AC8 — the Compile tab groups lint apart** (the approved storyboard frame).
  - With one compile record and one lint record, the tab shows a compile group and a Lint group, each holding its
    record.
  - With no lint record, no Lint group is shown.
- [ ] **AC9 — a lint record's card and drill-in say lint.**
  - A failing lint card reads `N lint errors` and names its tool; a clean one reads `lint clean`. Neither says
    "compile".
  - The drill-in shows each finding's rule code, grouped by file, and a clean record reads
    `clean lint — no findings`.
- [ ] **AC10 — status keeps compile and lint apart.** With a compile record followed by a newer lint record,
  `/api/v2/status` answers `lastCompile` = the compile record and `lastLint` = the lint record. With no lint record,
  `lastLint` is null.
- [ ] **AC11 — the words.** The PRD's lint section, the API doc's `lint` field, verdicts and `lastLint`, and the
  CHANGELOG entry exist and say what §S4 says.
- [ ] **AC12 — nothing else moves.** The existing compile, run and status suites pass unedited, apart from any test
  pinning the absence of `lastLint`. Such an edit is listed.

## Non-goals

- **The clients' `lint` verb, the `[lint]` declaration and the gate step.** These are CR-CRU-254.
- **ESLint and Biome decoders** (user ruling 2026-11-13: no consumer; their output is `raw` and the verdict still
  holds).
- **A new event kind or route.**
- **Re-filing old clippy records as lint.** Records stored before this CR stay compile records.
