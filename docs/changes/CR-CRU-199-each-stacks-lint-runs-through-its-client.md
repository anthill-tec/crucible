# CR-CRU-199 — each stack's lint runs through its client, and its findings reach the board

**Type** feature · **Points** 13 (provisional, set at filing 2026-10-19; the estimate is revisited at
gap analysis, which splits it if it outgrows the cap) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING — filed 2026-10-19 (Model B question, Sandesh #1486; user ruling: a `lint` verb in
every client, in 0.4.0; design is settled with the user before its gap analysis)

## Problem

Raised by Model B (2026-10-19), which wants a lint step in every project's pre-merge gate. Lint is
per stack (ruff for python, clippy for rust, Biome or ESLint for bun, and so on), and Model B's
stack files would otherwise have to name each stack's linter command beside the client.

Today only the rust client lints: its `clippy` and `workspace-clippy` verbs run clippy, file the
findings through the compile route, and its `pre-merge-gate` starts with a fail-fast clippy step.
No other client lints. Each client's `check` verb is a compile or typecheck step (`py_compile`,
`tsc`, the maven compile, `cargo check`, `arduino-cli compile`), and its failure is what an agent
reads as "does not compile".

## Intent (settled with the user, 2026-10-19)

- **Lint is Crucible's surface.** Each stack client gains a `lint` verb that runs the linter the
  project declares, configured by the project's own files (ruff reading `pyproject.toml`, Biome or
  ESLint reading the package's configuration, clippy, and so on).
- **`check` stays compile and typecheck.** A lint finding never fails `check`.
- **The findings reach the board on the compile route** (user ruling, 2026-10-19), the route rust's
  clippy already uses, as a compile record with an additive marker naming it lint and the tool that
  produced it, so older clients' compile records are still accepted. Each finding keeps the record's
  existing `error` or `warning` level: a finding the project's linter configuration treats as
  blocking is an `error` and fails `lint` and the gate; an advisory one is a `warning`, shown but not
  blocking. Each finding carries its rule code in the record's existing `code` field.
- **The Compile view shows lint as its own group** beside the compile diagnostics, rule codes
  visible. It needs a storyboard frame before RED.
- **The gate runs it.** `pre-merge-gate` runs `lint` fail-fast after `check`, so Model B's stack
  files name only the client verbs.

## Open design questions (settled with the user before gap analysis)

- **The declaration.** Where a project names its linter and its command, per stack (beside each
  stack's existing target declarations, or in `crucible.toml`), and what happens when none is
  declared (the gate skips lint and says so, or refuses).
- **Severity mapping per linter.** How each linter's own severities map onto `error` and `warning`
  (ruff reports every selected rule as a violation; clippy separates warn from deny).
- **Where findings are decoded.** In each client, or by server codecs as CR-CRU-152 does for the
  other report kinds.
- **The marker's shape.** The marker's field name and values in the store and the ingest payload.
- **Rust's clippy verbs.** Whether `lint` replaces, wraps or sits beside `clippy` and
  `workspace-clippy`.
- **Arduino and maven.** Which linter each runs, if any.

## Steps

Written at design, once the questions above are answered.

## Acceptance criteria

Written at design.
