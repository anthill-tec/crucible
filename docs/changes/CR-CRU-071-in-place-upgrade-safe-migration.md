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
(`<path>.pre-upgrade-<epoch>`, extending the store's EXISTING sibling-file
convention `<path>.<kind>-<epoch>` — the same shape as `<path>.corrupt-<epoch>`
from CR-CRU-001 §S5, so one cleanup rule and one docs paragraph cover both
rather than two competing schemes) using a WAL-safe copy — never a bare file copy
of a live WAL database. A failed or interrupted migration leaves the original
recoverable, and the envelope/log names the backup path. `:memory:` is exempt.

**AC5 — a newer store is REFUSED, and refusal is NOT quarantine.** When
`user_version` exceeds the version the running code knows, the server refuses to
open it, explains both versions and the remedy (upgrade the server, or restore
the backup), and exits non-zero. It never falls back to "open it anyway".

**This is a deliberate, narrow exception to CR-CRU-001 §S5's "boot must never
fail because of a bad file".** That invariant exists for a store that cannot be
READ, and its remedy is to rename the file to `<path>.corrupt-<epoch>` and boot
on a fresh empty db (`src/store.ts`, `tests/boot-safety.test.ts:32-45`,
RUNBOOK §Corrupt database recovery). A store from a NEWER version is the
opposite case: it is perfectly readable and holds the user's live data. Sending
it down the quarantine path would rename a GOOD database aside and start empty —
silent abandonment of live data, the worst outcome available. So:

- a store that cannot be read → quarantine and boot (unchanged §S5 behaviour);
- a store that reads fine but is from the future → refuse, exit non-zero, touch
  NOTHING. No rename, no fresh db, no writes.

The version check therefore runs AFTER the existing corruption probe (a
too-new store must still be a readable one) and BEFORE the migration chain.
CR-CRU-001 §S5's wording and RUNBOOK §Corrupt database recovery are amended by
this CR to name the exception, so the invariant and the code agree.

Asserted with a store stamped to a future version: exit non-zero, and the file
is byte-identical afterwards with no `*.corrupt-*` or `*.pre-upgrade-*` sibling
created.

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

**AC8 — the upgrade is gated on this migration (absorbed from CR-CRU-072 AC5).**
CR-CRU-072 shipped its installer-upgrade path with an AC5 that reads "the
upgrade proceeds only if migration succeeds (CR-CRU-071)". Nothing could
implement that before this CR existed — `install.sh` and `crucible_axi/` contain
no migration reference at all — so 072 was closed with that AC structurally
unsatisfiable. The gate is owned HERE: a refused (AC5) or failed (AC7) migration
must fail the upgrade with the backup path named, and must not leave a new binary
pointed at a store it cannot open.

**AC9 — an upgrade restarts the daemon (absorbed from CR-CRU-072 AC7).** After
an upgrade the running service must BE the new version. Today it is not: the
unit's `ExecStart` is `$BUN_INSTALL/bin/crucible-server`, a version-INDEPENDENT
path, so the rendered unit is byte-identical on an upgrade, `_unit_stage`
computes `changed=false`, and CR-CRU-070 deliberately leaves an already-active
service alone (its docstring: *"a restart drops every live SSE subscriber"*).
Meanwhile `bun add -g` has replaced the package on disk while the process holds
the old code in memory — a new binary with an old process serving it.

Neither shipped CR can fix that alone: the `unit` stage compares unit TEXT and
cannot know the server advanced. Only the `server` stage knows, because it is the
one that re-provisioned (version-aware since CR-CRU-066). So:

- the `server` stage reports that it ADVANCED, and the `unit` stage restarts on
  that signal ALONE — never by re-reading the installed version or re-resolving
  the pin, because two sources of truth for "did the server advance?" is how this
  bug appeared;
- a run where the server converges and the unit text is unchanged still performs
  NO write and NO restart, so CR-CRU-070's idempotence holds everywhere except a
  real version change;
- an absent or inactive unit means no restart and the run still converges
  (`ok=True`, exit 0); absent systemd still skips with a reason;
- `--force` still restarts an active service, keeping it the "make it match
  whatever the state" escape hatch;
- embedding a version in `ExecStart` to force a text change is REJECTED: it would
  rewrite the unit on every upgrade and break the
  unchanged-unit-is-not-rewritten guarantee.

Verified by observing the service report the NEW version after an upgrade (health
`version` or the journal startup line), on a non-default port and temp store so
it can never collide with the dog-food instance on 3849.

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
