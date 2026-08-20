# CR-CRU-068 — The server never says which store it opened

- **Type**: bugfix
- **Wave**: 5 (0.2.0)
- **Depends on**: 043, 066
- **Status**: PENDING (0.2.0)

## Problem

`resolveDbPath` (CR-CRU-043 §S1–§S3) picks the store by a four-rule cascade —
explicit `dbPath`, then `CRUCIBLE_DB`, then an **already-existing**
`<cwd>/data/crucible.db`, then `<XDG_DATA_HOME>/crucible/crucible.db`. Rule 3 is
CWD-relative by design, so **the same binary opens a different database
depending on where it was launched from**, and the server prints nothing about
which one it chose.

Observed on 2026-08-20 with the freshly published 0.1.2:

| instance | cwd | resolved store | contents |
|---|---|---|---|
| repo dev server (`bun run src/server.ts`) | repo root | `data/crucible.db` (9,187,328 B) | `projects=3 plans=70 plan_cycles=256 events=338 rollups=17` |
| installed server (`crucible-axi serve`) | `$HOME` | `~/.local/share/crucible/crucible.db` (61,440 B) | all zeros — schema only |

`$HOME/data/crucible.db` does not exist, so rule 3 misses and rule 4 wins. Both
servers bind the same default port (3849), so whichever holds the port silently
decides which store every client writes to. The split is undetectable from the
server's own output: startup logs the listen address only, and
`GET /api/health` reports status/uptime with no store identity. It was found by
a human noticing absent data, which is the only way it *can* be found today.

The resolution order is **correct and stays exactly as it is** — the XDG path
is the right Linux-convention default for an installed server, and rule 3 is
what keeps the repo dog-food instance on the repo store. This CR is about
**disclosure**, not about changing where anything resolves.

## Scope

Non-goals, explicitly:

- **No change** to `resolveDbPath`'s rules, their order, or their defaults. No
  rule-3 demotion, no new precedence, no migration, no `--db` flag.
- No change to which store any existing invocation opens. A run that resolved
  `X` before this CR resolves `X` after it, byte for byte.
- No change to the `serve` verb's argv, exit codes, or its no-envelope contract
  (CR-CRU-066): `serve` still emits no TOON-AXI envelope on stdout.

## Acceptance criteria

**AC1 — startup discloses the resolved store.** `startServer` logs the resolved
absolute store path once, at startup, alongside the listen line, before the
first request can be served. `:memory:` is disclosed verbatim as `:memory:`
rather than being absolutised. The log line names which of the four rules
matched, so a surprising store is self-explaining (`explicit` / `CRUCIBLE_DB` /
`cwd-data` / `user-data`).

**AC2 — the rule that matched is returned, not re-derived.** `resolveDbPath`
returns the matched rule together with the path, so no caller has to re-run the
cascade to describe it. The existing string-returning signature keeps working
for every current call site (additive change only — a second, richer entry
point, or a structured return whose consumers are all updated in this CR; the
`":memory:"`-in/`":memory:"`-out identity is preserved either way).

**AC3 — `/api/health` reports store identity.** Both `GET /api/health` and
`GET /api/v2/health` (health parity, CR-CRU-043 §S1) include the resolved store
path and the matched rule. Existing health fields keep their current names and
types; this is additive, so an old client parsing health does not break.

**AC4 — the disclosure is real, not a formatting of intent.** The path reported
by startup and by health is the path the `Store` actually opened — asserted by
opening a server on a temp store and reading its health back, not by
re-computing the expected value in the test.

**AC5 — a split is diagnosable from the server alone.** Two servers started
against different stores report different `store` values in health, and the
divergence is visible without shell forensics on `/proc`, `fuser`, or file
sizes. Covered by a test that boots two instances on two temp stores and
asserts the reported identities differ and each matches its own file.

## Notes

- Discovered while dog-fooding the published 0.1.2 install, not by a gate. The
  repo store was snapshotted to the XDG location with `sqlite3 .backup`
  (WAL-safe) and the dest's stale `-wal`/`-shm` dropped so no old journal could
  replay; the pre-overwrite file is kept as
  `~/.local/share/crucible/crucible-pre-overwrite-2026-08-20.db`. The repo store
  stays in place and remains the dev instance's store.
- A snapshot copy makes the data *available* to both instances at a point in
  time; the two files diverge on the next write. Unifying them is a separate
  decision and is deliberately **not** part of this CR.
