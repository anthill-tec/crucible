# CR-CRU-222 — a bun project's regression runs its own runner

**Type** feature · **Points** 5 (to be re-scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING — filed 2026-10-30 (Model B request, Sandesh 1499; user ruling: its own CR in 0.4.0, at the
end of wave 8)

## Problem

Raised by Model B (2026-10-30), from a Bun workspace whose suites run Vitest on the Bun runtime. The bun
client's `regression` verb always builds `bun test` (`cmd_regression` in `clients/bun-crucible.py`, whose
`script` is `None` on its own path), so on such a project it runs the wrong runner, or nothing.

What already holds: `test` runs through the project's declared test script when the project declares one
(`crucible.testScript` in `package.json`, CR-CRU-194), and `bun test` only when it declares none; the tier verbs
(`unit`, `module`, `integration`, `e2e`, `bdd`) run the declared `test:<tier>` scripts; `pre-merge-gate` runs every
declared suite (CR-CRU-112). Only `regression`, and a gate whose project declares no suite, which runs
`regression`'s body, have no declared form.

Model B's bun hook (CR-MDB-066) now blocks direct Vitest runs in bun projects and tells the agent that `test` and
`regression` run `bun test`; it rewords that line once this CR lands.

## Design (user ruling 2026-10-30)

- Its own CR, in 0.4.0.
- To be decided at this CR's gap analysis, and put to the user as design forks: what `regression` runs on a project
  that declares a runner — the declared test script (`crucible.testScript`), every declared `test:<tier>` script,
  or a declaration of its own (a `package.json` key, or a `[bun]` key in `crucible.toml`); and how its coverage-free
  form and its `--coverage` (CR-CRU-212) reach a declared script.

## Steps

Written at its gap analysis.

## Acceptance criteria

Written at its gap analysis, and at least:

- [ ] **AC1 — a declared runner is run.** On a bun project that declares its runner, `regression` runs it, not
      `bun test`; on a project that declares none, `regression` runs `bun test`, unchanged.
- [ ] **AC2 — coverage stays opt-in.** `regression` without `--coverage` measures and files no coverage on either
      kind of project.

## Non-goals

- `test` and the tier verbs, which already run the declared scripts.
- Model B's hook wording (CR-MDB-066), reworded on their side once this lands.
