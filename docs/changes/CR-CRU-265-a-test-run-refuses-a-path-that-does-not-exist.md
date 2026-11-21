# CR-CRU-265 — a test run refuses a path that does not exist

**Status:** PENDING · filed 2026-11-20 (release fix; user ruling 2026-11-20: todo #29, from VERIFY 978 Sug2, is fixed in
0.4.0) · gap analysis 2026-11-20 (SPEC_UPDATE_NEEDED; user rulings: refuse, not warn; a declared script's
entries stay filters; re-scored 3 → 5)
**Type:** fix
**Points:** 5 (re-scored from 3 at the gap analysis, 2026-11-20, user ruling)
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** client, bun, tests
**Design reference:** `test-reports/work/verify978-report.md` (Sug2); `test-reports/work/cr265-gap-analysis.md`

## Problem

`bun-crucible.py test --tests <path> …` hands its paths to `bun test` unchanged, and bun reads each one as a **filter**
on file names, not as a path:

- a path that does not exist matches nothing and is dropped without a word. With other paths beside it the run goes on
  green over fewer files than were asked for: VERIFY 978 gave 20 paths, 18 ran, `warnings: []`. Probed 2026-11-20:
  `bun test <an existing unit file> tests/unit/no-such-file.test.ts` → `Ran 6 tests across 1 file`, exit 0;
  `bun test tests/unit/no-such-dir/ <file>` → the same;
- an existing path is matched as a substring, so it can also select other files whose path contains it.

A run that quietly runs less than it was asked to is the silent-green defect 0.4.0 closes elsewhere ("a runner that
failed is never filed as green").

## Design

- **Every `--tests` entry is a path, checked before anything runs.** `test` resolves each entry against the package
  directory. When one or more do not exist as a file or a directory, the verb runs nothing, opens no run, sends nothing
  to the board, and exits non-zero with one `ok: false` envelope: error code `tests-not-found`, listing every missing
  entry as given, with a `help` line naming the fix. No partial run.
- **The paths reach bun as paths.** An entry that exists is handed to `bun test` in bun's path form (`./<path>` when it
  is relative and does not already start with `./` or `../`), so bun never widens it to a substring match.
- **A declared script's entries stay filters** (user ruling). When the package's `crucible.targets` marks a `test`
  script, its runner (vitest, playwright) reads the `--tests` entries as filters, so they are neither checked nor
  rewritten: they reach the script unchanged, as today.
- **Unchanged:** `--name`; `test` with no `--tests`; every other verb.

## Acceptance criteria

- [ ] **AC1 — a missing path refuses the run.** `bun-crucible.py test --tests <existing> <missing>` (with and without
  `--agent`) runs no runner, opens no run, makes no board request, exits non-zero, and prints one envelope with
  `tests-not-found` naming `<missing>` and only it. The same holds when every entry is missing.
- [ ] **AC2 — existing paths run as paths.** `test --tests <existing file>` runs `bun test` with `./<file>`; a run of two
  existing files whose names are substrings of another test file's path runs exactly those two files.
- [ ] **AC3 — a declared script's entries pass unchanged.** With a marked `test` script, `--tests` entries (a filter
  that names no file among them) reach the script exactly as given, and nothing is refused.
- [ ] **AC4 — help says it.** `test --help`'s `--tests` line says that, for `bun test`, the entries are paths and a
  missing one is refused, and that a declared script receives them unchanged as its runner's filters.

## Non-goals

- The other clients' test selectors: python's dotted ids and pytest node ids already fail loudly when they name
  nothing; maven's `-Dtest` and rust's `--test`/`--filter` are patterns, not paths; arduino's `--tests` stems are
  resolved by the project's own Makefile (see the gap analysis).
- `--name` patterns that match no test.
- Warning and running the rest (user ruling: refuse — a partial run is the defect).
