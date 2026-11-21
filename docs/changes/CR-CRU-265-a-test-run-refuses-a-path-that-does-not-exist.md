# CR-CRU-265 — a test run refuses a path that does not exist

**Status:** PENDING · filed 2026-11-20 (release fix; user ruling 2026-11-20: todo #29, from VERIFY 978 Sug2, is fixed in
0.4.0) · gap analysis 2026-11-20 (SPEC_UPDATE_NEEDED; user rulings: refuse, not warn; a declared script's
entries stay filters; re-scored 3 → 5) · spec pre-review 2026-11-20 (CHANGES, F1–F10 folded; user rulings: an
existing non-test file is refused under its own code; duplicate entries are a non-goal)
**Type:** fix
**Points:** 5 (re-scored from 3 at the gap analysis, 2026-11-20, user ruling)
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** client, bun, tests
**Design reference:** `test-reports/work/verify978-report.md` (Sug2); `test-reports/work/cr265-gap-analysis.md`;
`test-reports/work/prereview265-report.md`

## Problem

`bun-crucible.py test --tests <path> …` hands its paths to `bun test` unchanged, and bun reads each one as a **filter**
on file names, not as a path:

- a path that does not exist matches nothing and is dropped without a word. With other paths beside it the run goes on
  green over fewer files than were asked for: VERIFY 978 gave 20 paths, 18 ran, `warnings: []`. Probed 2026-11-20:
  `bun test <an existing unit file> tests/unit/no-such-file.test.ts` → `Ran 6 tests across 1 file`, exit 0;
  `bun test tests/unit/no-such-dir/ <file>` → the same;
- an existing path is matched as a substring, so it can also select other files whose path contains it (probe:
  `bun test a.test.ts` beside `sub/xa.test.ts` → 2 files).

Handing bun the `./` path form alone is not enough (pre-review F1): `bun test ./src/foo.ts`, an existing file that is not
a test, imports and runs it — its top-level code executes — and reports `Ran 0 tests across 1 file`, exit 0, where the
bare entry fails loudly today.

A run that quietly runs less than it was asked to is the silent-green defect 0.4.0 closes elsewhere ("a runner that
failed is never filed as green").

## Design

- **Where the check sits** (F3). In `cmd_test` the refusals that exist today keep their order: the package directory,
  `_refuse_old_keys`, then `_marked_test_script`. A marked `test` script skips this CR's check (below). For a plain
  `bun test` run the check comes next — **before** `_reports_dir`, its `makedirs` and `_wipe`, and before `gated_run`,
  so a refused run touches neither the reports directory nor the board (no identity heartbeat, no pre-flight, no run).
- **What it checks.** Each `--tests` entry is resolved against the **resolved package directory** — from
  `--package-dir`, `$BUN_CRUCIBLE_PACKAGE_DIR` or `[bun] package_dir`, whichever `_resolve_package_dir` took (F4) —
  unless it is absolute. An entry is refused when:
  - it names nothing that exists: code `tests-not-found`;
  - it names an existing **file** whose name carries none of bun's test-file markers (`.test`, `_test_`, `.spec`,
    `_spec_`): code `tests-not-a-test-file` (F1, user ruling). An existing directory passes.
- **The refusal** (F2). When any entry is refused, nothing runs and the verb exits **1** with ONE `ok: false`
  envelope:
  - `error` lists every refused entry exactly as given;
  - `warnings` holds one item per refusal kind present, `{code: "tests-not-found" | "tests-not-a-test-file", detail}`,
    each detail naming its entries;
  - `help[0]` names the directory the entries were resolved against ("paths are relative to `<package_dir>`").

  It is emitted either by `_emit_target_refused` taking its code and help as arguments, or by a typed hard stop beside
  `_crucible_axi.NarrowingRefused`; `_emit_target_refused` as it stands (`target-refused`, a `crucible.targets` help
  line) is not reused unchanged.
- **The paths reach bun as paths** (F5). The rewrite lives in `cmd_test`, not in `_bun_test_cmd`: a relative entry
  that does not start with `./` or `../` is handed to `bun test` as `./<entry>`; an entry starting with `./` or `../`,
  and an absolute one, are handed on as given. bun then never widens an entry to a substring match. The junit `file=`
  attribute and the console's file headers are the same in both forms (pre-review probe), so narration, the relay and
  the board's file paths are unaffected; the printed `running:` line shows the `./` form.
- **A declared script's entries stay filters** (user ruling). When the package's `crucible.targets` marks a `test`
  script, its runner (vitest, playwright) reads the `--tests` entries as filters, so they are neither checked nor
  rewritten: they reach the script unchanged, as today.
- **Unchanged:** `--name`; `test` with no `--tests`; every other verb (only `test` takes `--tests`; F9).

## Acceptance criteria

- [ ] **AC1 — a missing path refuses the run.** `bun-crucible.py test --tests <existing> <missing>` — without
  `--agent`, with `--agent`, and with `--agent --cycle` — runs no runner, opens no run, makes no board request, leaves
  an existing `junit.xml` in the reports directory in place, exits 1, and prints one envelope as the Design pins it,
  with `tests-not-found` naming `<missing>` and only it. The same holds when every entry is missing.
- [ ] **AC1b — an existing file that is not a test refuses the run.** `test --tests <existing non-test source>` (a file
  whose top-level code writes a sentinel) is refused with `tests-not-a-test-file` naming it; nothing runs and the
  sentinel is absent. An entry naming an existing directory is not refused.
- [ ] **AC1c — paths resolve against the package directory.** With `[bun] package_dir` declared in the project's
  `crucible.toml`, an entry written relative to the project root that does not exist under the package directory is
  refused, and `help[0]` names the package directory.
- [ ] **AC2a — existing entries reach bun as paths** (integration, fake bun). The `bun test` argv carries `./<file>`
  for a relative entry, and an entry starting with `./` or `../` and an absolute entry exactly as given.
- [ ] **AC2b — and run exactly those files** (integration, real bun in a scratch package). `test --tests a.test.ts`
  beside `sub/xa.test.ts` runs `a.test.ts` alone.
- [ ] **AC3 — a declared script's entries pass unchanged.** With a marked `test` script, `--tests` entries — including
  one that names no existing path, and an existing relative file, which reaches the script without a `./` prefix —
  reach the script exactly as given, and nothing is refused.
- [ ] **AC4 — help says it.** `test --help` — the verb's description and its `--tests` line — says that for `bun test`
  the entries are paths relative to the package directory, that a missing entry or a file that is not a test is
  refused, and that a declared script receives them unchanged as its runner's filters.

## Non-goals

- The other clients' test selectors: python's dotted ids and pytest node ids already fail loudly when they name
  nothing; maven's `-Dtest` and rust's `--test`/`--filter` are patterns, not paths; arduino's `--tests` stems are
  resolved by the project's own Makefile (see the gap analysis).
- `--name` patterns that match no test.
- Warning and running the rest (user ruling: refuse — a partial run is the defect).
- Duplicate or overlapping entries (user ruling): bun counts them as extra files with an empty suite, and the
  narrator clamps the pre-scan (F6).
- An existing directory holding no test: it passes the check, then bun exits 1 and the run is filed as failed — loud
  (F7).
- A marked script with `framework: bun-test`, and the tier verbs' `-- ARGS` passthrough: their entries stay filters,
  as the declared-script ruling says (F8).
