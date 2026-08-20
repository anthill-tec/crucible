# CR-CRU-071 — In-place upgrade: versioned, backed-up, refusable DB migration

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 001, 043, 068
- **Status**: PENDING (0.2.0)

## Problem

A new server version can add or change tables and columns, but nothing governs
what happens when that version opens an **existing** store. Measured on the live
9.1 MB dog-food DB:

```
PRAGMA user_version → 0          # never set, by any version, ever
tables              → 7
```

`Store.open` → `migrate()` retrofits schema by **probing for each column and
issuing an ad-hoc `ALTER TABLE`** (`src/store.ts:439-506`: `ADD COLUMN action`,
`first_seen`, `payload`, `RENAME COLUMN phase TO role`, `ADD COLUMN role`,
`role_inferred`, `activated_at`, `done_at`, `active_ms_accumulated`, …), guarded
only by "does this column exist yet". That yields four structural gaps:

1. **No schema version.** `user_version` is 0 on every store, so no code can ask
   "what shape is this DB?" — it can only re-probe every column on every boot.
   The probe list grows without bound and is order-dependent by construction.
2. **No downgrade guard.** An OLDER server opening a NEWER store passes every
   probe (`CREATE TABLE IF NOT EXISTS` + "column exists" both succeed) and
   proceeds to read and **write** against a schema it does not understand. That
   is a live data-corruption path the moment a user rolls a version back.
3. **No recovery point.** The retrofit ALTERs are separate `exec` calls, not one
   atomic unit. An interrupted upgrade leaves a half-migrated store, and nothing
   was copied first — there is no defined way back.
4. **Upgrade is not gated on migration.** `bun add -g` swaps the binary
   (version-aware since CR-CRU-066) and the next boot migrates implicitly and
   silently; a failed migration is discovered as a query error later, not as a
   refused upgrade.

CR-CRU-043 records that the live dog-food store is the highest-value database in
the project. Today an upgrade mutates it in place, unversioned, unbacked-up.

## Acceptance criteria

**AC1 — the store carries a schema version.** `PRAGMA user_version` becomes the
single schema-version authority, written inside the same transaction as the
migration that advances it. A store is never left at a version it does not
structurally match.

**AC2 — existing stores are baselined without loss.** A `user_version = 0` store
(every store in existence today, including the 9.1 MB dog-food DB) is inspected
once, matched to the schema it actually has, and stamped with that version — no
data movement, no re-running of retrofits already applied. Proven against a
**copy of the real dog-food store**, not a synthetic fixture: same row counts
for `projects`/`plans`/`plan_cycles`/`events`/`rollups` before and after.

**AC3 — migrations are an ordered, idempotent chain.** Each step declares the
version it moves the store from and to, runs in a transaction, and is a no-op
when already applied. Re-running the chain converges. The existing ad-hoc
probe-and-ALTER retrofits become numbered steps; none of their effects change.

**The existing order is load-bearing and must be preserved exactly.** The
retrofits are not independent: `RENAME COLUMN phase TO role` must run BEFORE the
additive `ADD COLUMN role`, or the rename is skipped and a fresh empty `role`
column shadows CR-CRU-057's backfill — 299 of 338 events on the live dog-food
store. `migrate()` keeps this coherent by mutating its own PRAGMA snapshot
(`eventCols.delete("phase"); eventCols.add("role")`) so a later guard in the same
pass sees the new name. Numbering the steps must reproduce that sequencing and
that within-pass state, not merely the set of statements.

Data backfills that live inside the current pass (`backfillInferredEventRoles`,
and CR-CRU-057 §S4's labeled backfill) are part of the chain, not separate: a
step that alters a column and the backfill that populates it must land in the
same version, or a store can stop between them and report a version whose data
contract is not yet true.

**AC4 — a recovery point exists before any mutation.** Before the first
migrating write, the store is copied to a timestamped sibling
(`crucible-pre-upgrade-<version>-<date>.db`, matching the existing
`crucible-pre-*.db` convention) using a WAL-safe copy — never a bare file copy
of a live WAL database. A failed or interrupted migration leaves the original
recoverable, and the envelope/log names the backup path. `:memory:` is exempt.

**AC5 — a newer store is REFUSED, not opened.** When `user_version` exceeds the
version the running code knows, the server refuses to open it, explains both
versions and the remedy (upgrade the server, or restore the backup), and exits
non-zero. It never falls back to "open it anyway". This is the downgrade guard;
it is asserted with a store stamped to a future version.

**AC6 — migration outcome is disclosed, not silent.** Startup and
`GET /api/health` report the store's schema version alongside the store path and
matched rule (CR-CRU-068), and a boot that migrated says so, naming from-version
→ to-version and the backup it wrote. An upgrade that changed the DB is visible
without shell forensics.

**AC7 — a failed migration fails the upgrade.** A migration step that throws
aborts its transaction, leaves `user_version` at the pre-step value, exits
non-zero, and points at the backup. No partial version stamp, and the server
does not begin serving on a half-migrated store.

## Scope

Non-goals, explicitly:

- **No down-migrations.** Reversal is "restore the backup" (AC4), not scripted
  downgrade steps. AC5's refusal is what makes that sufficient.
- No change to store *location* or `resolveDbPath`'s rules (CR-CRU-043,
  CR-CRU-068) — this CR is about the store's *contents*, not its path.
- No schema redesign; no table is added, dropped, or renamed by this CR beyond
  formalising the retrofits that already run.
- No client-visible API change beyond the additive health/startup fields.

## Notes

- Raised 2026-08-20 by the maintainer while reviewing the install/uninstall
  lifecycle: an in-place upgrade must migrate safely when new versions add to or
  modify DB structures.
- CR-CRU-066 made the *binary* upgrade version-aware; this CR makes the *store*
  upgrade version-aware. Both halves are needed for `bun add -g` of a newer
  server to be a safe operation.
- The migration-only `migrationOnlyRoleFromAgentIdSuffix` helper
  (`src/store.ts:277`, banner at 262/596) must remain migration-only — folding
  it into a numbered step must not put it on a runtime path.
