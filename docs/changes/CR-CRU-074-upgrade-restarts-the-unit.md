# CR-CRU-074 — An upgrade leaves the old server process serving

- **Type**: bugfix
- **Wave**: 5 (0.2.0)
- **Depends on**: 070, 072
- **Status**: PENDING (0.2.0)

## Problem

After an upgrade, the systemd `--user` service keeps running the **old** server
code. Found by gap analysis of CR-CRU-071, against merged code.

The unit's `ExecStart` is `$BUN_INSTALL/bin/crucible-server` — a stable,
**version-independent** path. So on an upgrade the rendered unit text is
byte-identical to the one on disk, and `_unit_stage` concludes there is nothing
to do:

```python
changed = _existing_unit_text(unit_path) != desired          # false on upgrade
...
"converged": not changed and not force and provisioned       # -> converged
```

CR-CRU-070 made that deliberate, and for good reason — its docstring: *"an
already-enabled, already-active service is not touched (a restart drops every
live SSE subscriber)."* Meanwhile `bun add -g` has replaced the package on disk,
but the running process holds the previous code in memory. Net effect: a new
binary with an old process serving it, which is exactly what CR-CRU-072 AC7
forbade in writing:

> an upgrade refreshes it and restarts the service so the running daemon is the
> new version — never a new binary with an old process still serving.

Two shipped CRs therefore contradict each other, and **neither can resolve it
alone**: the `unit` stage compares unit *text* and cannot know the server
package advanced. Only the `server` stage knows that — it is the stage that
re-provisioned (version-aware since CR-CRU-066).

## Design

Make the fact travel between stages. The `server` stage already distinguishes
"converged" from "re-provisioned"; the `unit` stage restarts when, and only
when, the server actually advanced in this run.

Idempotence is preserved where it matters: a re-run that changes nothing still
does not touch the service, so the SSE-subscriber cost is paid only on a real
version change — where the alternative is silently serving stale code.

## Acceptance criteria

**AC1 — a server version change restarts the service.** When the `server` stage
re-provisions to a different version and a unit is installed and active, the
`unit` stage restarts the service, so the running daemon is the new version. The
restart is asserted through the recorded `systemctl` argv, not inferred from
stage text.

**AC2 — nothing else restarts it.** A run where the server stage converges (same
version) and the unit text is unchanged still performs NO write and NO restart —
CR-CRU-070's idempotence holds, and a plain re-run cannot drop SSE subscribers.

**AC3 — the signal is explicit, not re-derived.** The `unit` stage learns that
the server advanced from the stage sequence itself (a value the `server` stage
reports), never by re-reading the installed version or re-running the pin
resolution. Two sources of truth for "did the server advance?" is how this class
of bug appears in the first place.

**AC4 — a unit that is absent or inactive is unaffected.** With no unit
installed, or one installed but not active, an advancing server stage performs no
`systemctl` restart and the run still converges (`ok=True`, exit 0). Absent
systemd still skips with a reason (CR-CRU-070 AC4).

**AC5 — `--force` still restarts.** `crucible-axi install --force` re-runs every
stage, and an active service is restarted, so `--force` remains the "make it
match, whatever the state" escape hatch.

**AC6 — the running daemon is verified, not assumed.** Verification observes the
service reporting the NEW version after an upgrade (health `version`, or the
journal's startup line), on a non-default port and a temp store so it can never
collide with the dog-food instance on 3849.

## Scope

Non-goals, explicitly:

- No change to the unit's content contract (CR-CRU-070 AC1): `ExecStart` stays
  the version-independent absolute path plus the resolved-Bun `PATH`. Embedding
  a version in `ExecStart` to force a text change is explicitly rejected — it
  would make every upgrade rewrite the unit and would break the
  unchanged-unit-is-not-rewritten guarantee.
- No change to the uninstall order (`unit`, `server`, `config`, `store`).
- No graceful-handover or zero-downtime restart; a brief interruption on a real
  version change is accepted, and SSE clients already reconnect.

## Notes

- Found 2026-08-20 by CR-CRU-071's gap analysis (DRIFT-4), reading merged code
  rather than trusting the closed CR records. CR-CRU-072's AC7 is annotated as
  unsatisfied and points here.
- The related CR-CRU-072 AC5 ("gate the upgrade on a safe migration") was
  likewise unimplementable at merge time and is now owned by CR-CRU-071 AC8.
  Both corrections are recorded on 072 rather than dropped.
