# CR-CRU-259 — a client with no board declared refuses

**Status:** PENDING · filed 2026-11-15 (release fix: found by the 0.4.0 leak census; user rulings 2026-11-15: the
client's 3849 fallback goes, and the fix is a release-fix CR committed on `release/0.4.0`)
**Type:** fix
**Points:** 3
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** client, config, release
**Design reference:** `test-reports/work/rel040-test-gap-analysis.md` (L2, §8); CR-CRU-139 (`resolve_base_url`, the
one place the board is spelled); CR-CRU-252 (the installer writes `[client] url`; the server's packaged port stays
3849)

## Problem

A client resolves its board from the project's `crucible.toml`, then the install's, then a last resort: the
`[client] url` in the shipped data file `clients/crucible.toml`, which is `http://localhost:3849`, the production
board's packaged port (`shipped_board()` in `_crucible_axi.py`).

The installer has written a probed `[client] url` into every install file since CR-CRU-252, so an installed client
reaches the last resort only when something is wrong. When it does, it posts silently to whatever answers on 3849:
on this machine, the production board. The 0.4.0 leak census caught eleven tests doing exactly that from a project
with no board declared (`test_{arduino,mvn,python,rust}_crucible_axi`, `go_client_harness`). They passed only because
they tolerate a board that does not answer.

## Design

- **No last resort.** `resolve_base_url` walks the project's file, then the install's, as today. When neither
  declares a non-empty `[client] url`, it raises a typed error (no board declared) instead of returning a shipped
  address. `shipped_board()` and the shipped data file's `[client] url` are removed; the file keeps a commented
  `[client]` section that says the installer writes the url and how to declare one.
- **The refusal is an envelope.** A verb that needs the board answers `ok: false` with an error naming both files it
  read (project's and install's, home-abbreviated) and `help` naming the two fixes: re-run the installer, or declare
  `[client] url = "http://<host>:<port>"` in the project's `crucible.toml`. Exit code as every other refusal. No
  request is sent.
- **Verbs that do not reach the board are unaffected** (`--help`, local-only verbs). The envelope `context` names the
  board only when one is declared (`axi_context` no longer compares against a shipped address: `_machine_board` is
  the install's declared url or none).
- **Help and messages say what is true.** `BOARD_SOURCE`, `BOARD_CONFIGURATION_HELP` and the six clients' help and
  docstrings drop "the shipped address is the last resort" and say a client with no board declared refuses. README
  and `docs/RUNBOOK.md` say the same where they describe the chain.
- **The installer is unchanged in behaviour.** It already appends the `[client]` block when the laid-down file
  carries no url (`apply_setting` with `_CLIENT_TABLE_BLOCK`); a fresh install still gets the probed url. An install
  with no listener (no server on this machine) gets no url and its clients refuse until one is declared; the install
  output already names the file.
- **The server is untouched**: `src/crucible.toml` `[server] port = 3849` stays its packaged default (CR-CRU-252
  ruling).
- **Core size.** The change must not grow `_crucible_axi.py` past its pinned budget (`SHARED_MODULE_LINE_BUDGETS`,
  `CORE_LINE_LIMIT`); removing `shipped_board()` is expected to pay for the refusal.

## Acceptance criteria

- [ ] **AC1 — refusal.** With a project file and an install file that both declare no `[client] url`, every client's
  `status` (a board-reaching verb) exits non-zero with an envelope whose `error` names both files and whose `help`
  names the installer and the `[client] url` key; no connection is attempted (proved with an in-process fake
  transport that records calls, not a socket).
- [ ] **AC2 — the chain still resolves.** A project file's url wins over the install's; an install file's url is used
  when the project declares none; a file that does not parse or declares an empty url is passed over.
- [ ] **AC3 — no shipped board.** `clients/crucible.toml` declares no `[client] url`; `shipped_board` no longer exists;
  no client source spells `3849`.
- [ ] **AC4 — install still writes the board.** A sandboxed fresh install with a listener (throwaway HOME/XDG,
  `--no-service`, ephemeral port) writes `[client] url` into the install's `crucible.toml`, and a client run from that
  install resolves it.
- [ ] **AC5 — help and docs.** No client help, README or RUNBOOK sentence describes a shipped last-resort board; each
  client's top-level help says a client with no board declared refuses.
- [ ] **AC6 — the eleven tests.** The modules the census caught declare their own board (a fake, or the refusal they
  assert); a hermetic run of them with a tripwire on 3849/3850 records no connection.

## Non-goals

- The server's packaged port, the installer's port probe, and any env-var override (CR-CRU-131 stands).
- The suite-wide test install (CR-CRU-260).
