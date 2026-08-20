# CR-CRU-072 — The installer cannot upgrade: bare `uv tool install` no-ops on an existing install

- **Type**: bugfix
- **Wave**: 5 (0.2.0)
- **Depends on**: 066, 069, 071
- **Status**: COMPLETED (0.2.0) — merged at b6132ab; AC5 → CR-CRU-071 AC8, AC7 → CR-CRU-071 AC9

## Problem

`install.sh:57` runs bare `uv tool install crucible-axi`. uv's `install` does not
upgrade an already-installed tool — that is `uv tool upgrade` (or
`install --upgrade`/`--force`). Verified in an isolated `UV_TOOL_DIR`:

```
$ uv tool install crucible-axi==0.1.1
crucible-axi v0.1.1

$ uv tool install crucible-axi          # exactly what install.sh runs
Checked 1 package in 0.02ms
Installed 1 executable: crucible-axi
$ uv tool list
crucible-axi v0.1.1                     # ← STILL 0.1.1

$ uv tool upgrade crucible-axi
 + crucible-axi==0.1.2
crucible-axi v0.1.2
```

The README one-liner is both the documented install path *and* the obvious thing
a user re-runs to update. On any machine that already has Crucible it silently
changes nothing, and the failure compounds:

1. the Python CLI stays at the old version;
2. `crucible-axi install` then runs the **old** version's stages, which pin the
   server to the **old** release (the version-aware convergence CR-CRU-066 added
   correctly re-provisions — to the old pin it was released with);
3. so both halves stay stale while the user is told
   `==> Crucible bootstrap complete`.

Every existing 0.1.x user is on this path today.

## Design — use uv's mechanism, then our own

The installer must distinguish first install from upgrade and delegate the
Python half to **uv's own upgrade machinery** rather than reimplementing it,
then run the custom logic only Crucible knows about:

```
fresh machine   : uv tool install crucible-axi        → crucible-axi install
existing install: uv tool upgrade crucible-axi        → crucible-axi install
                  (uv resolves + swaps the CLI)         (re-pins server, refreshes
                                                         unit, gates on migration)
```

The staged verb is already idempotent and version-aware (CR-CRU-066), so the
custom half needs no upgrade-specific branch — it needs to *run after* the CLI
has actually changed, which today it never does.

## Acceptance criteria

**AC1 — the installer detects an existing install and upgrades it.** When
`crucible-axi` is already installed, `install.sh` uses uv's upgrade mechanism
(`uv tool upgrade`, or `install` with the upgrade flag) so the CLI actually
advances; on a fresh machine it installs. Both paths end with the same staged
verb run.

**AC2 — the no-op is impossible to reintroduce.** A test drives the installer's
Python-half decision against an isolated `UV_TOOL_DIR` seeded with an OLDER
version and asserts the resulting version is the NEWER one. A bare
`uv tool install` in that position fails the test. This is the regression guard
for the exact defect above.

**AC3 — the transition is reported, not silent.** The installer states which
path it took and the version transition (`0.1.1 → 0.1.2`, or
`already current: 0.1.2`). `==> Crucible bootstrap complete` must never be
printed over an upgrade that did not happen.

**AC4 — the server half follows the CLI.** After the CLI advances, the staged
`[server]` stage re-provisions the server to the new release's pin (CR-CRU-066's
version-aware convergence), so CLI and server land in lockstep. Asserted by an
old→new transition, not by re-reading the pin.

**AC5 — upgrade is gated on a safe store migration. → MOVED to CR-CRU-071 AC8.**
This AC was unsatisfiable when written: the gate needs a versioned migration to
gate ON, and nothing in `install.sh` or `crucible_axi/` referenced migration at
all. This CR was merged and closed with it outstanding — recorded here rather
than quietly dropped. CR-CRU-071 AC8 now owns it: a refused or failed migration
fails the upgrade with the backup path named, and never leaves a new binary
pointed at a store it cannot open.

**AC6 — idempotent and re-runnable.** Re-running the one-liner on a
fully-current machine converges: no reinstall, no re-provision, exit 0, and it
says `already current`. Running it twice is indistinguishable from once.

**AC7 — the unit follows too. → MOVED to CR-CRU-071 AC9.**
Verified after merge: the unit's `ExecStart` is
`$BUN_INSTALL/bin/crucible-server`, which is version-INDEPENDENT, so on an
upgrade the rendered unit is byte-identical, `_unit_stage` computes
`changed=false`, and an already-active service is deliberately left alone
(CR-CRU-070's idempotence: a restart drops every live SSE subscriber).
`bun add -g` swaps the package on disk while the running process keeps
serving the OLD code in memory — precisely what this AC forbids. The two
shipped CRs contradict each other and neither can resolve it alone, because the
unit stage compares unit TEXT and cannot know the server package advanced — only
the `server` stage does, since it is the stage that re-provisioned.

The fix lands in CR-CRU-071, which owns the in-place upgrade end to end and is
still pending: the daemon that serves after an upgrade is part of the same
transition as the store that survives it. There, the `server` stage reports that it advanced and the `unit` stage restarts
on that signal ALONE, so a no-op re-run still never restarts and CR-CRU-070's
idempotence (a restart drops every live SSE subscriber) holds everywhere except
a real version change. Embedding a version in `ExecStart` to force a text change
is rejected: it would rewrite the unit on every upgrade and break the
unchanged-unit-is-not-rewritten guarantee.

## Scope

Non-goals, explicitly:

- **uv's resolver is not reimplemented.** Version selection, pinning, and Python
  environment handling stay uv's job; this CR only calls the right uv verb.
- No pinning of `crucible-axi` to a specific version in `install.sh` — the
  one-liner tracks the latest release, as today.
- No change to `crucible-axi install`'s stages, argv, or envelope (CR-CRU-066).
- No downgrade support: uv can install an older version explicitly, but the
  installer's upgrade path only moves forward (and CR-CRU-071's AC5 refuses a
  newer store under an older server).

## Notes

- Found 2026-08-20 while reviewing the install/uninstall/upgrade lifecycle;
  reproduced in an isolated `UV_TOOL_DIR` rather than inferred from uv's docs.
- This is the third half of the same lifecycle: CR-CRU-066 made the server
  binary upgrade version-aware, CR-CRU-071 makes the store upgrade safe, and
  this CR makes the *installer* actually perform an upgrade at all.
