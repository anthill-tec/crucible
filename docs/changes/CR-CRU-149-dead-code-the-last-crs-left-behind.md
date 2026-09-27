# CR-CRU-149 — dead code the last CRs left behind

**Type** chore · **Points** 8 · **Wave** 7 (0.3.0), last in the wave, before the release (user ruling
2026-09-24) · **Depends on** CR-CRU-145, CR-CRU-146, CR-CRU-147, CR-CRU-150, CR-CRU-154 · **Status** PENDING

## Problem

The user asked for a thorough dead-code investigation after CR-CRU-098 (2026-09-24). Code gets
lifted, ported and re-pointed CR by CR, and what each one leaves behind is nobody's scope: CR-054
lifted client verbs into the shared module and left one client's copy of a helper; CR-056 re-pointed
44 client tests and left a stub helper in five of them; CR-013 committed an empty store file at the
repo root.

The same drift reaches the prose. Code, tests and design notes cite each other as `path:line`, and
nothing re-checks those citations, so they go stale whenever the cited file grows. **Measured
2026-09-26: of 838 `path:line` citations in scope, only 102 still land on the construct they name;
roughly 650–700 point at the wrong code, some thousands of lines away** (`handleEventDelete` cited
at `src/v2.ts:1747`, living at `:3841`). 15 of the 16 inside shipped code are wrong. Most of that
drift happened within about two months.

**User rulings 2026-09-26:** citations are rewritten to **cite by symbol**, not re-pointed; a
**standing guard test** keeps them honest; `project_config_path` **stays** as a named test seam;
the two pre-existing pi-lens warnings (a `zip()` without `strict=` in the shared client module, and
type warnings in `test_next_lane_carries_release_and_wave.py`) stay **out** of scope, being live
code.

## Census (re-measured 2026-09-26 at `develop` `de7f5ef`; re-run at the branch cut, `8f7cae3`, 2026-09-27)

**Branch-cut re-run (AC1), 2026-09-27 at `8f7cae3`, after CR-CRU-154 landed:** unchanged. Items 1–11
hold as listed; vulture reports the same 58 lines (nothing CR-CRU-154 added); `tsc
--noUnusedLocals` the same 17 test-file errors (plus `reply`'s two excluded parameters); the
citation scan 838 in scope (98 still landing on their construct, 506 moved, 100 no longer
matching, 104 with no identifier to check, 28 unresolved paths, 2 out of range); e2e 734/0.

**Method.** `knip@5` over the TS/JS tree (entries: `src/server.ts`, `bin/`, `public/app.js`,
`scripts/`, every test), `vulture` (confidence ≥ 60) over `clients/`, `crucible_axi/` and
`tests/client/`, `tsc --noUnusedLocals --noUnusedParameters`, an AST pass listing every Python
function referenced only at its definition, and a citation scan (below). **Every candidate was then
checked by hand**: `git grep -w` across `src/`, `public/`, `clients/`, `crucible_axi/`, `tests/`,
`scripts/`, `bin/` and `docs/research/`, plus `git log -S` for where it came from. Candidates that
turned out to be used are under "Measured and excluded" with the reason.

### §S1 — production code nothing calls

| # | Symbol | Where | Evidence | Lineage |
|---|---|---|---|---|
| 1 | `_fleet_context` | `clients/bun-crucible.py` | referenced only at its definition | lifted to the shared module by CR-054 (`1ad64d0`); this copy was left behind |
| 2 | `_disk_precheck` | `clients/rust-crucible.py` | referenced only at its definition | added in CR-008 (`8a95e0e`), never called |
| 3 | `project_config_path` | `clients/_crucible_axi.py` | no production caller; four test files call it | **kept** (user ruling 2026-09-26): a one-line public accessor over `_read_project_config()[0]` naming the file a client's limits resolve from. Four test files use it as the §S1 seam of CR-131/CR-138; deleting it would make them index a private tuple, which is worse, not simpler. |

### §S2 — test code nothing calls

| # | Symbol | Where | Evidence |
|---|---|---|---|
| 5 | `waitForDom` | `tests/helpers/dom-settle.ts` | no caller (`settleDom` in the same file is used) |
| 6 | `_no_active_cycle_plans` | `tests/client/test_{python,rust,mvn,arduino}_crucible_axi.py`, `test_bun_crucible_toon_envelope.py` | no caller; left by CR-056's re-point (`8410214`) |
| 6b | `_no_open_plans_at_all` | `tests/client/test_{python,rust,mvn,arduino}_crucible_axi.py` | no caller; added by CR-030 (`c8ae2f3`), never called. **New in this census.** |
| 7 | 17 unused locals, imports and types | 16 test files (the `tsc --noUnusedLocals` list, reproduced in the RED commit) | compiler-reported |
| 8 | `NO_SPLIT_CLIENTS`, `CLIENT_NAMES`, `SUCCESS_CALLS`, `other_stored` | `test_client_tier_run_modality.py`, `test_cr046_pep723_metadata.py`, `test_cr091_roadmap_verbs.py`, `test_cr092_next_decision_resolver.py` | vulture 60%; each has one reference, its assignment |

### §S3 — repository leftovers

| # | Item | Evidence |
|---|---|---|
| 9 | `crucible.db` at the repo root | 0 bytes, tracked since `c1b57e6` (CR-013). Nothing resolves `<repo>/crucible.db`: the server's rule is `<cwd>/data/crucible.db`. Checked from git metadata only; the file was never opened. |
| 10 | devDependencies `@cucumber/gherkin`, `happy-dom` | no direct import anywhere. `playwright-bdd` carries its own `@cucumber/gherkin`, and `@happy-dom/global-registrator` depends on `happy-dom`. |
| 11 | `playwright` imported but not declared | `tests/roadmap-visual-grammar.test.ts` imports `playwright`, which resolves only through `@playwright/test`. Used, not declared. |

### Measured and excluded (not dead)

- **Unused exports**: `public/app-logic.mjs`'s exports reach `app.js` through the `L.` namespace
  and are typed by `app-logic.d.mts`; `export` on symbols used inside their own file (`src/store.ts`,
  `src/analytics.ts`, `src/next.ts`, `src/limits.ts`, test helpers) is unnecessary but not dead.
- **knip "unused files"**: `public/app-logic.d.mts` (read by `tsc`) and `public/vendor/*` (loaded by
  the HTML's script tags).
- **`bun-types`** (named in `tsconfig.json`'s `types`), and **`__exit__(exc_type, exc, tb)`** (a
  protocol signature).
- **`reply(req, url, …)` in `src/v2.ts`**: the two unused parameters are kept on purpose, by its own
  comment.
- **vulture's unused test classes** `QueueAsksForMergedRecordsByType`,
  `NoScanDepthSurvivesOnTheQueueReadPath`: `unittest` discovers them.
- **vulture's HTTP-handler members** (`protocol_version`, `do_POST`, `log_message`, `fileno`,
  `readline`, `daemon_threads`, `__enter__`/`__exit__`): framework and protocol hooks.
- **`open_plan_1`, `open_plan_2`** in `test_status_verb_shows_open_plans_end_to_end.py`: the stored
  ids are unread, but the calls that produce them are the fixture.
- **`backdateEvent`, `backdateAgent`** (`tests/helpers/server-limits-fixture.ts`), filed as item 4:
  nothing imports them, but `projectLastActiveAgo` in the same file calls both, and two live test
  files use it. The census counted importers and missed in-file callers (found by C1 GREEN,
  2026-09-27). Live code; inlining them would be refactoring, a non-goal.
- **`scripts/plans-contention-curve.ts`**: CR-126 §S2a's run-it-deliberately harness.
- **CSS**: no dead selectors.
- **Duplicate predicates**: duplication, not dead code.

### §S4 — citations cite by symbol (user ruling 2026-09-26)

A citation of a source file names the file and the **construct**, never a line:
`handleEventDelete (src/v2.ts)`, `` `plan_merge_map` in `scripts/release.sh` ``. Where an old cite
pointed inside a construct (a guard, a branch, a CSS rule), it names the enclosing function,
constant or selector and says which part. A citation naming a construct that no longer exists is
rewritten to name its successor, or removed with the sentence that depended on it. A line range
kept for a genuine reason (none is known) would need its own reasoned exception in the guard (§S5).

**In scope:** every `path:line` citation into a source file (`.ts`, `.mts`, `.js`, `.mjs`, `.py`,
`.sh`, `.css`, `.html`, `.toml`) from `src/`, `public/`, `clients/`, `crucible_axi/`, `tests/`,
`scripts/`, `bin/` and `docs/research/`. **Measured 2026-09-26: 838 citations in 192 files** (16 in
shipped code, the rest in tests and design notes). The scan also finds strings that only look like
citations: test fixture data (`file.ts:10`, `src/x.ts:1`) and cites of test files since deleted.
The first are data, not citations, and stay; the second are stale and are rewritten or removed.

**Out of scope:** `docs/changes/` (a spec describes the tree it was written against) and the dated
history notes inside `tests/project-namespace-tripwire.test.ts`. Both are records, not pointers.

### §S5 — a standing guard (user ruling 2026-09-26)

One test scans the in-scope trees and fails when:

- a `path:line` citation into a source file appears (fixture strings are exempted by name, each
  with its reason, in the test), in any notation: `path:123`, a bare `:123`, or a word form such as
  `path ~L123`, `~line 45`, `line 91` (VERIFY finding, cycle 540; user ruling 2026-09-27). A line
  number in a spec record ("AC line 267") and a captured stack trace are not citations of source;
- a cited source path names no file that exists;
- a line cites a source file and names a backticked identifier that does not occur in that file.

It is a test, not CI machinery, and it is the only way AC8's repair stays true after this CR.

## Scope

Delete §S1–§S3's items (item 3 stays), rewrite §S4's citations by symbol, and add §S5's guard.
Anything a re-run of the census adds before the branch cut is in scope; anything it removes drops
out.

## Acceptance criteria

- **AC1** — The RED commit carries this census table, re-measured at the branch cut and updated,
  not re-argued.
- **AC2** — Items 1, 2, 5, 6, 6b and every item of 7 and 8 have no definition left (item 4 proved
  live and moved to "Measured and excluded").
- **AC3** — Item 3, `project_config_path`, stays, with its reason in the census table.
- **AC4** — Item 9: `crucible.db` is untracked and ignored. The server's store resolution is
  unchanged (its tests are green untouched).
- **AC5** — Item 10: both devDependencies are removed; `bunx bddgen`, the e2e suite and every
  happy-dom test still pass.
- **AC6** — Item 11: `playwright` is either declared or no longer imported directly.
- **AC7** — No behaviour changes. The full bun, python and e2e runs match the branch-cut baseline
  (e2e 734/0 measured at `de7f5ef`) except for tests this CR deletes, each named in the RED commit.
- **AC8** — §S4: no in-scope line citation into a source file remains, in any notation (`path:123`,
  a bare `:123`, `~L123`, `~line 45`, `line 91`); every rewritten
  citation names a construct that exists in the cited file. The census table lists each rewrite:
  citing file, old cite, new cite, construct.
- **AC9** — Citation pins and `PROSE_CITATIONS` that this CR's own edits shift are re-pinned once,
  at close-out.
- **AC10** — §S5: the guard test exists, covers every in-scope tree, and fails on a planted
  `path:line` citation, on a planted cite of a missing file and on a planted backticked identifier
  absent from its cited file (each proven in the test itself); it passes on the tree this CR
  leaves.

## Non-goals

- **A standing dead-code guard** (knip or vulture in CI). The §S5 citation guard is a test and is
  in scope; a dead-code guard is still a separate decision.
- **Anything in "Measured and excluded".**
- **Refactoring live code**, including the two pi-lens warnings named above.
