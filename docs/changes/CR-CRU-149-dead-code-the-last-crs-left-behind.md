# CR-CRU-149 — dead code the last CRs left behind

**Type** chore · **Points** 3 · **Wave** 7 (0.3.0), last in the wave, before the release (user ruling
2026-09-24) · **Depends on** CR-CRU-145, CR-CRU-146, CR-CRU-147,
CR-CRU-150 ·
**Status** PENDING

## Problem

The user asked for a thorough dead-code investigation after CR-CRU-098 (2026-09-24). Code gets
lifted, ported and re-pointed CR by CR, and what each one leaves behind is nobody's scope: CR-054
lifted client verbs into the shared module and left one client's copy of a helper; CR-056 re-pointed
44 client tests and left a stub helper in five of them; CR-013 committed an empty store file at the
repo root.

## Census (measured 2026-09-24 at `develop` `5d55d37`)

**Method.** `knip@5` over the TS/JS tree (entries: `src/server.ts`, `bin/`, `public/app.js`,
`scripts/`, every test), `vulture` over `clients/`, `crucible_axi/` and `tests/client/`,
`tsc --noUnusedLocals --noUnusedParameters`, a CSS-selector scan of `public/styles.css`, and an
AST pass listing every top-level Python function referenced only at its own definition. **Every
candidate was then checked by hand**: `git grep -w` across `src/`, `public/`, `clients/`,
`crucible_axi/`, `tests/`, `scripts/` and `docs/`, plus `git log -S` for where it came from.
Candidates that turned out to be used are listed under "Measured and excluded" with the reason.

### §S1 — production code nothing calls

| # | Symbol | Where | Evidence | Lineage |
|---|---|---|---|---|
| 1 | `_fleet_context` | `clients/bun-crucible.py:2129` | referenced only at its definition, anywhere | lifted to the shared module by CR-054 (`1ad64d0`); this copy was left behind |
| 2 | `_disk_precheck` | `clients/rust-crucible.py:1343` | referenced only at its definition, anywhere | added in CR-008 (`8a95e0e`), never called |
| 3 | `project_config_path` | `clients/_crucible_axi.py:224` | **no production caller**; 4 test files call it as the CR-131/CR-138 §S1 seam | added CR-131 (`927f83a`), production callers gone since CR-138 (`62851e5`) |

Item 3 is the only one with a lineage question: its tests treat it as the §S1 resolver's API. The
gap analysis decides between deleting it (tests move to what production actually calls) and
keeping it as a named test seam, and records why.

### §S2 — test code nothing calls

| # | Symbol | Where | Evidence |
|---|---|---|---|
| 4 | `backdateEvent`, `backdateAgent` | `tests/helpers/server-limits-fixture.ts:286`, `:293` | no caller |
| 5 | `waitForDom` | `tests/helpers/dom-settle.ts:81` | no caller (`settleDom` in the same file has 122) |
| 6 | `_no_active_cycle_plans` | `tests/client/test_{python,rust,mvn,arduino}_crucible_axi.py`, `test_bun_crucible_toon_envelope.py` | no caller; left by CR-056's re-point (`8410214`) |
| 7 | 17 unused locals, imports and types | 16 test files (the `tsc --noUnusedLocals` list, reproduced in the RED commit) | compiler-reported |
| 8 | `NO_SPLIT_CLIENTS`, `CLIENT_NAMES`, `SUCCESS_CALLS`, `other_stored` | `test_client_tier_run_modality.py:290`, `test_cr046_pep723_metadata.py:53`, `test_cr091_roadmap_verbs.py:515`, `test_cr092_next_decision_resolver.py:307` | vulture 60%, each to be confirmed by hand |

### §S3 — repository leftovers

| # | Item | Evidence |
|---|---|---|
| 9 | `crucible.db` at the repo root | 0 bytes, tracked since `c1b57e6` (CR-013). Nothing resolves `<repo>/crucible.db`: the server's rule 3 is `<cwd>/data/crucible.db` (`src/server.ts:71`). Checked from git metadata only; the file was never opened. |
| 10 | devDependencies `@cucumber/gherkin`, `happy-dom` | no direct import anywhere. `playwright-bdd` carries its own `@cucumber/gherkin` (^39), and `@happy-dom/global-registrator` depends on `happy-dom`. |
| 11 | `playwright` imported but not declared | `tests/roadmap-visual-grammar.test.ts:54` imports `playwright`, which resolves only through `@playwright/test`. The opposite of item 10: used, not declared. |

### Measured and excluded (not dead)

- **18 "unused exports" in `public/app-logic.mjs`**: `app.js` consumes them through the `L.`
  namespace, and `app-logic.d.mts` types them. knip cannot see that path.
- **`export` on symbols used inside their own file** (`src/store.ts`, `src/analytics.ts`,
  `src/next.ts`, `src/limits.ts`, test helpers): the export keyword is unnecessary, but nothing is
  dead.
- **`reply(req, url, …)` in `src/v2.ts`**: the two parameters are unused, and its own comment keeps
  them on purpose ("dropping them would mean editing all 16 call sites for no behavioural gain").
  It's out of scope unless the user rules otherwise.
- **`scripts/plans-contention-curve.ts`**: nothing references it, by design. It is CR-126 §S2a's
  run-it-deliberately harness.
- **CSS**: no dead selectors. The one hit, `.w3`, is inside an SVG data URI. Five names appear only
  in tests (`ahead`, `at-risk`, `completed_untracked`, `in_progress`, `org`); they are status and
  health values that `app.js` applies dynamically.
- **`bun-types`**: `tsconfig.json`'s `types` uses it. **`__exit__(exc_type, exc, tb)`**: a
  protocol signature.
- **Duplicate predicates** (the two dead-CR checks, the inline landed-status sets): these are
  duplication, not dead code. CR-CRU-147 owns the dead-CR one.
- **~160 stale line citations** found at CR-098's close-out: prose, not code. **Moved into scope
  as §S4 by user ruling (2026-09-24).**

### §S4 — line citations that point at the wrong line (added by user ruling 2026-09-24)

Found at CR-CRU-098's close-out re-pin (`10ebfb8`). Code and tests cite each other as
`path:line`, and nothing re-checks most of them, so they drift silently whenever the cited file
grows. Measured then:

- **About 170 citations into `src/v2.ts` and `clients/_crucible_axi.py`, of which about 160 were
  already wrong at `7f2a85c`, before CR-098 touched either file.** Some are off by hundreds of lines
  (`handleCrPlan` cited far from its base `:2978`; `_is_actionable` cited at `:1301`, base `:2365`).
- **Citations naming functions CR-098 deleted:** `tests/roadmap-wave-rollup.test.ts:301` and
  `:317`, `tests/roadmap-wave-rows.test.ts:798`, `tests/queue-canonical-order.test.ts:146`,
  `public/app-logic.mjs:1246`.
- **Stale in `public/`:** `app-logic.mjs:1360` (`v2.ts:2053`) and `app.js:1781` (`v2.ts:771-773`).
- **Stale in `docs/research/DN-crucible-wave-track-release.md`** (targets measured at `10ebfb8`):
  - `:239`: `_crucible_axi.py:4647` → `post_gate`, now `:5329`
  - `:256`: `:4801` / `:1315` → the `0 < nsteps < 9` guard is gone from the file; only its docstring
    mentions remain (`:5507`, `:5520`)
  - `:257`: `:4811-4819` / `:1306-1310` → the `gate_from_axi(final=True)` fallback, now `:2008`,
    with the fallback at `:2042`

Only the two most-edited files were swept. `src/store.ts` and every other cited file are
unmeasured, so the census re-run (AC1) covers **every** `path:line` citation into a source file,
from `src/`, `public/`, `clients/`, `crucible_axi/`, `tests/`, `scripts/` and `docs/research/`.

**Out of scope:** `docs/changes/` (a spec describes the tree it was written against) and the dated
history notes inside `tests/project-namespace-tripwire.test.ts`. Both are records, not pointers.

**The form of the repair is a decision for this CR's gap analysis, and it goes to the user**:
re-point each line number, or cite by symbol (`v2.ts handleCrPlan`) so the next edit cannot break
it. The second is the subtractive option and removes the drift class. The first keeps the
existing convention. Either way, the AC is the same: every in-scope citation resolves.

## Scope

Delete §S1–§S3's items and repair §S4's citations, after re-running the census at the branch cut.
This CR runs last in the wave, so five CRs land between this census and that one, and **the analysis
re-measures rather than trusting this table**. Anything the re-run adds is in scope; anything it
removes drops out.

## Acceptance criteria

- **AC1** — The gap analysis re-runs the census by the method above on the branch-cut tree, and
  the RED commit carries the resulting table. It is this table updated, not re-argued.
- **AC2** — Items 1, 2, 4, 5, 6 and every confirmed item of 7 and 8 have no definition left.
- **AC3** — Item 3 is resolved one way or the other, with the reason in the spec. If it is deleted,
  its tests call what production calls, with no assertion weakened.
- **AC4** — Item 9: `crucible.db` is untracked and ignored. The server's store resolution is
  unchanged (its tests are green untouched).
- **AC5** — Item 10: both devDependencies are removed; `bunx bddgen`, the e2e suite and every
  happy-dom test still pass.
- **AC6** — Item 11: `playwright` is either declared or no longer imported directly.
- **AC7** — No behaviour changes. The full bun, python and e2e runs match the branch-cut baseline
  except for tests this CR deletes, each named in the RED commit.
- **AC8** — **§S4:** every `path:line` citation in scope resolves to the construct it names, in the
  form the gap analysis settles with the user. A citation naming a construct that no longer exists
  is rewritten to name its successor, or removed. The census table lists each one: citing file,
  old cite, new cite, construct.
- **AC9** — Citation pins and `PROSE_CITATIONS` that this CR's own deletions shift are re-pinned
  once, at close-out.

## Non-goals

- **A standing dead-code guard** (knip or vulture in CI). That would be new machinery to maintain;
  it's a separate decision if the user wants one.
- **Anything in "Measured and excluded".**
- **Refactoring live code.** Only unreferenced code is deleted.
