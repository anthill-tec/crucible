# CR-CRU-134 — a figure in prose is derived, or it drifts

**Type** fix · **Wave** 6 (0.2.0) · **Depends on** CR-CRU-131 · **Status** PENDING

## Problem

`docs/RUNBOOK.md` documents a schema version that has been wrong for eight migrations.

Measured 2026-09-14 on `release/0.2.0` at `42766fe`:

- `docs/RUNBOOK.md:260` — the health payload example shows `"schemaVersion":5`
- `:281` — the boot banner example shows `schema v5`
- `:282` — the migration banner shows `migrated store schema v0 -> v5`
- The live board reports **13** (`GET /api/health`, `PRAGMA user_version`), and its actual boot
  banner reads `store … (rule: cwd-data, schema v13)`.

An operator matching their own banner against the RUNBOOK's finds a mismatch and has no way to know
which is stale. Worse for the migration line: `v0 -> v5` describes a migration path that no longer
exists.

## Why this is the same defect CR-CRU-131 just fixed, one document over

CR-CRU-131 established that **a limit's documented figure and its enforced figure must be one
datum**, and proved it constructionally: `tests/docs-runbook-documents-every-limit.test.ts` reads
every limit's `recommended`/`min`/`max` from the shipped `crucible.toml` and fails if the RUNBOOK
disagrees. The precedent cited in that CR's own spec was `src/hints.ts` omitting `release` for a
month.

The schema figures are the identical shape: a number that lives in code, retyped into prose, with
nothing asserting they agree. Retyping `13` fixes today's reading and re-arms the same trap at the
next migration. **The figure must be DERIVED, and a guard must fail when the document disagrees** —
the pattern CR-CRU-131 already demonstrates in this very document.

## Scope

### §S1 The documented schema figure agrees with the store's, by construction

A guard reads the store's current schema version from the source of truth and fails if the RUNBOOK's
examples disagree — extending `tests/docs-runbook-documents-every-limit.test.ts`, which already
parses this document and already derives its expectations, rather than adding a second walker. It is
the only test in the tree that parses `docs/RUNBOOK.md` as structured data (verified by grep), so
extending it is the same walker-reuse discipline CR-CRU-128 §S2 applied to a differently-shaped
scan — not a claim that CR-128 itself governs markdown documentation walkers.

### §S2 The migration example describes a migration that exists

`v0 -> v5` is not a path the current code can take. The example states a real one, or states the
shape without pinning versions it cannot keep current.

### §S3 The census — no other retyped figure in the document

The two figures found here were found by accident, during a CR about a different section. A one-time
sweep for numbers in `docs/RUNBOOK.md` that are copies of values living in code, each either derived
or explicitly marked as an illustration that no guard checks.

## Acceptance criteria

- [ ] The RUNBOOK's schema figures agree with the store's current version, asserted by a guard that
      READS the version rather than pinning it — so the next migration cannot make the document
      wrong without a test going red.
- [ ] The guard has a CONTROL: a deliberately wrong figure is caught, and the real document passes —
      a green result must be the agreement's doing, not an empty walk.
- [ ] No figure is transcribed into the guard; it derives both sides.
- [ ] The migration banner example describes a path the current code can take, or is marked as an
      illustration with the guard knowing it is one.
- [ ] §S3's census is recorded in the CR with a verdict per figure: derived, marked, or removed.
- [ ] The guard extends the existing RUNBOOK guard rather than adding a new walker.

## Non-goals

- Rewriting the RUNBOOK's structure or prose beyond the figures and their immediate sentences.
- Auditing figures in any other document. If the census suggests the problem is repo-wide, that is a
  finding to report, not scope to absorb here.
