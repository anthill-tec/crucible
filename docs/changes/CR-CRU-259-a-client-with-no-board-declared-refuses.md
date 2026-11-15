# CR-CRU-259 — a client with no board declared refuses

**Status:** PENDING · filed 2026-11-15 (release fix: found by the 0.4.0 leak census; user rulings 2026-11-15: the
client's 3849 fallback goes, and the fix is a release-fix CR committed on `release/0.4.0`) · Pre-review: ran — the
gap analysis needed user rulings; it changes the clients and `crucible.toml` contract other projects consume
**Type:** fix
**Points:** 5
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** client, config, installer, release
**Design reference:** `test-reports/work/rel040-test-gap-analysis.md` (L2, §8); `test-reports/work/cr259-gap-analysis.md`
(F1–F11); `test-reports/work/prereview259-report.md` (F1–F10, folded); CR-CRU-139 (`resolve_base_url`, the one place
the board is spelled; this CR reverses its shipped last resort); CR-CRU-252 (the installer writes `[client] url`; the
server's packaged port stays 3849); CR-CRU-221 (a shared module is split before it outgrows its guard)

## Problem

A client resolves its board from the project's `crucible.toml`, then the install's, then a last resort: the
`[client] url` in the shipped data file `clients/crucible.toml`, which is `http://localhost:3849`, the production
board's packaged port (`shipped_board()` in `_crucible_axi.py`).

The installer has written a probed `[client] url` into every install file since CR-CRU-252, so an installed client
reaches the last resort only when something is wrong. When it does, it posts silently to whatever answers on 3849:
on this machine, the production board. The 0.4.0 leak census caught five test modules doing exactly that from a
project with no board declared (`test_{arduino,mvn,python,rust}_crucible_axi`, `go_client_harness`). They passed
only because they tolerate a board that does not answer.

## Design

- **No last resort.** `resolve_base_url` walks the project's file, then the install's, as today. When no file in the
  chain declares a non-empty `[client] url`, it raises the no-board refusal instead of returning a shipped address.
  `shipped_board()` and the shipped data file's `[client] url` are removed; the file keeps a commented `[client]`
  section saying the installer writes the url and how to declare one. The limits chain keeps its shipped last resort
  (that is the limits' data, not the board's).
- **The refusal.** **PROPOSED (gap analysis F1, awaiting the user's ruling):** a typed hard stop, a direct
  `Exception` subclass (never `OSError` or `ValueError`, which `remove_agent_silent`, `_declared_board` and
  `run_verb`'s generic clause catch), carrying its own `help`, converted by `run_verb` the way `DeclarationRefused`
  is. The pre-review showed the alternative (the transport answering `{ok: false, error}` like an unreachable board)
  cannot refuse before a suite runs, because the pre-flight treats an unanswered board as a courtesy failure.
- **What it says.** `ok: false`; the error names every file in the chain, in precedence order and home-abbreviated,
  each with why it was passed over (absent, no `[client] url`, does not parse); `help` names the two fixes: re-run the
  installer, or declare `[client] url = "http://<host>:<port>"` in the project's `crucible.toml`. Non-zero exit, as
  every other refusal. No request is sent.
- **Resolved at first use, refused at first contact.**
  - `ClientOps.base_url` (and every client's `_ops()` that fills it) resolves lazily, at the first request, never when
    the ops object is built. So a verb that sends nothing — `test`, `lint` or `pre-merge-gate` without `--agent`,
    `--help` — never resolves a board and works as today. `project-create` resolves after it binds the project
    directory, so the project's own url counts.
  - The refusal passes through every courtesy catch: `preflight_cycle_warnings` and `_active_cycle_ids` re-raise it,
    as `UnattributedRunRefused` already passes through. So a board-reaching verb whose first contact is the
    pre-flight (`lint --agent`, `pre-merge-gate --agent`, arduino `auto-ingest`, the run verbs) refuses before it
    spawns a runner, a linter or a compile.
  - `run_verb`'s gate tail (`record_gate_outcome` after `ops_fn()`) never raises the refusal outside the conversion.
- **The envelope context.** `axi_context` never raises: on a project with no board declared it omits `board`. It
  names the board when the resolved one differs from the install's declared url; when the install declares none, a
  project-declared board is always named. `_machine_board` is the install's declared url or none; nothing compares
  against a shipped address.
- **The installer says when it leaves no board.** When the `[manifest]` stage ends with the client's
  `<target>/crucible.toml` declaring no `[client] url` (no listener: no local server, or an upgrade of an install
  whose file never had one), the stage row carries a warning naming that file and the `[client] url` key, and the
  envelope's `help` names declaring it. **PROPOSED (pre-review F4, awaiting the user's ruling).**
- **Help and docs say what is true.** `BOARD_SOURCE`, `BOARD_CONFIGURATION_HELP`, the six clients' help and module
  docstrings drop "the shipped address is the last resort" and say a client with no board declared refuses.
  `docs/RUNBOOK.md`'s board section ("The board — `[client]`", including the `context.board` rule) says the same; the
  `[client]` comment in `clients/crucible.toml` explains that the installer writes the url. The stale comment at
  `_crucible_axi.py` 1362 names "the dev board" instead of a port.
- **The record.** `CHANGELOG.md`'s release section `## [0.4.0]` gains a **Changed** line: a client whose project and
  install name no board refuses instead of posting to the packaged port; an install with no local server, or an
  upgraded one whose file never named a board, must declare `[client] url`. CR-CRU-252's spec gains an amendment note
  (its lines 37 and 227: "the shipped address stays" and the non-goal) pointing here.
- **The server is untouched**: `src/crucible.toml` `[server] port = 3849` stays its packaged default.
- **Core size.** `_crucible_axi.py` is 9119 lines against its 9120 budget. If the change does not fit, the board
  resolution (`resolve_base_url`, `_declared_board`, `_machine_board`, `BOARD_SOURCE`, `BOARD_CONFIGURATION_HELP`, the
  refusal type and its emitter) moves into a sibling shared module loaded by path, as CR-CRU-221 split
  `_crucible_run.py`, with `SHARED_MODULE_LINE_BUDGETS` updated in its three copies and the installer's fleet list
  shipping it. **PROPOSED (pre-review F10, awaiting the user's ruling).**
- **The tests' own boards.** `install_project` in `tests/client/live_run_harness.py` and its four copies in the
  lifecycle modules (arduino, bun, mvn, rust) write the project's own `[client]` table instead of replacing the
  shipped url line. A test that asserts the refusal does it in-process with `_INSTALL_DIR` patched to a scratch
  directory (the seam `test_gate_run_declared_skip_defaults` uses), so it never reads the operator's root
  `crucible.toml`; a test that drives a client as a subprocess declares a fake board.

## Acceptance criteria

- [ ] **AC1 — refusal.** In-process, with `_INSTALL_DIR` patched to a scratch directory and a bound project, when no
  file declares a url, each client's `status` returns non-zero with the refusal envelope: the error names every file
  in the chain with why it was passed over (absent / no url / does not parse), `help` names the installer and the
  `[client] url` key, and the recording fake transport saw no call. Covers the deduplicated chain (project dir = the
  install dir) and an unbound project dir.
- [ ] **AC2 — the chain still resolves.** A project file's url wins over the install's; an install file's url is used
  when the project declares none; a file that does not parse or declares an empty url is passed over. Includes
  `project-create` on a project that declares a board and an install that declares none.
- [ ] **AC3 — no shipped board.** `clients/crucible.toml` declares no `[client] url`; `shipped_board` no longer exists;
  no client code or string literal spells `3849`.
- [ ] **AC4 — install still writes the board.** With the existing installer seam (a patched
  `_provisioned_server_config_source` whose template declares an ephemeral port range, never 3800–3899, throwaway
  HOME/XDG/BUN_INSTALL, `--no-service`), a fresh install writes `[client] url`, and `<target>/clients/_crucible_axi.py`
  loaded in-process with a project that declares no url resolves exactly that url.
- [ ] **AC5 — help and docs.** No client help, RUNBOOK sentence or `clients/crucible.toml` comment describes a shipped
  last-resort board; each client's top-level help says a client with no board declared refuses.
- [ ] **AC6 — the census modules.** The five modules the census caught, `install_project` and its four copies declare
  their own board (a fake) or assert the refusal in-process; the tests that pinned the last resort or its literal are
  updated (`test_a_clients_board_falls_through_to_the_install_when_its_project_names_none`,
  `test_the_envelope_names_the_board_it_posted_to`, `test_client_fleet_envelope_census`,
  `test_every_clients_help_names_where_its_board_comes_from`, `test_no_test_steers_a_client_by_a_retired_variable`,
  `test_an_installed_deployment_resolves_its_configuration`, `project_create_harness`, `tests/helpers/client-board.ts`,
  `server-limits-fixture.ts`, `project-namespace-tripwire.test.ts`). Orchestrator check, not a test: a hermetic run
  of the five modules under the census tripwire records no connection.
- [ ] **AC7 — no board, no contact.** With no board declared anywhere, `test`, `lint` and `pre-merge-gate` without
  `--agent`, and `--help`, succeed as today with one envelope each, no `board` in it, and no traceback.
- [ ] **AC8 — refused before the work.** With no board declared, `lint --agent` and `pre-merge-gate --agent` refuse
  before spawning a linter, runner or compile (proved with a recording runner seam), and the gate records no outcome.
- [ ] **AC9 — the installer warns.** An install whose client file ends with no `[client] url` names the file and the
  key in its `[manifest]` row and its `help` (if the user rules the warning in).
- [ ] **AC10 — the record and the budget.** `CHANGELOG.md`'s `## [0.4.0]` carries the Changed line; CR-CRU-252's spec
  carries the amendment note; the shared-module line budgets pass.

## Non-goals

- The server's packaged port, the installer's port probe, and any env-var override (CR-CRU-131 stands).
- The suite-wide test install (CR-CRU-260) and hermetic CI (CR-CRU-263).
- Model B's own skills and agent templates that describe the old chain (raised with Model B, todo #26).
