# CR-CRU-252 — a client finds its board in the install when its project names none

**Status:** PENDING — filed 2026-11-13 (user ruling: in 0.4.0, wave 8, before CR-CRU-199, which stays last as the
release's hygiene CR); gap analysis ran 2026-11-13, user rulings at design · Pre-review: due (it changes what an
install writes on a machine carrying a production board, and another project's skill documents the old chain)
**Type:** fix
**Points:** 5
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** clients, installer, shared-module
**Design reference:** CR-CRU-139 (a connection is configuration: the `[client]` chain, the installer's listener);
CR-CRU-138 (the server's operator file, laid down by `[manifest]`); CR-CRU-131 (the install record and `--purge`)

## Problem

- **A project's file hides the install's board.** `resolve_base_url` reads `[client] url` from the first
  `crucible.toml` in the chain that parses: the project's, then the install's. A project file that has no `[client]`
  (every Model B project's file declares only `[gate] skip`) still counts as found. The client then goes to the
  shipped `http://localhost:3849` and never reads the install's file.
- **An existing install never learns its board.** The installer resolves a listener (CR-CRU-139) and writes
  `[client] url` and `[server] port`. It writes them only into files it lays down fresh, because `lay_down_config`
  never overwrites. A machine installed before that change keeps files with no `[client]` and no `[server] port`.
  On this machine:
  - the production install's `crucible.toml` has no `[client]`;
  - its clients reach the board only through the shipped literal.
- **The installer's answer and the server's disagree.** For an existing server file that names no port, the
  installer probes the range and builds the client URL from the probed port. But it writes neither. The server then
  boots on its shipped port, so the install reports one board and the server listens on another.

## Design (user rulings 2026-11-13)

- **The chain resolves `[client]` by table.** A client takes `[client] url` from the first file in the chain that
  DECLARES a non-empty one: the project's `crucible.toml`, then the install's. Only then does it fall back to the
  shipped declaration. A file that parses but declares no `[client] url` is passed over. `[limits]` keeps its own
  rule, unchanged.
- **The shipped address stays, documented.** `clients/crucible.toml` keeps `[client] url = "http://localhost:3849"`
  as the chain's last resort. Every place that describes the chain names all three steps.
- **A re-install fills in what is missing and never overwrites.**
  - An existing install `crucible.toml` with no `[client] url` gets the install's resolved board URL.
  - An existing server file with no `[server] port` gets a port.
  - A value already set is never changed.
- **The live port is kept.** An existing server file that names no port gets the port its server boots on today:
  `[server] port` from the provisioned server's own shipped declaration. It is never re-probed. A re-probe on this
  machine would move the production board off its port at its next restart.
  - The range is probed only for a server file the install lays down fresh, as today.
- **Out of scope:** the server's shipped `port = 3849` stays its packaged default (user ruling).
- **Non-goal:** a checkout is still its own install. Its clients read the checkout's `crucible.toml`, and this
  repo's root file is what keeps its agents on the dev board.

## Steps

### §S1 — the client's chain, by table

`resolve_base_url` walks the same candidates as today, at the point of use, and never caches:

1. the bound project dir's `crucible.toml`;
2. the install's `crucible.toml`.

It answers the `[client] url` of the first candidate whose file parses and declares a non-empty string `url`, with
the value stripped. Otherwise it answers `shipped_board()`.

A file that is absent, does not parse, has no `[client]` table, or whose `url` is missing, empty or not a string is
passed over. It never raises.

`_read_project_config` and every limit keep their first-file-that-parses rule, unchanged.

### §S2 — the installer fills in a missing `[client] url`

In the `[manifest]` stage, when the install's operator `crucible.toml` already exists (it is not laid down by this
run), declares no non-empty `[client] url`, and the plan carries a `listener`:

- the stage writes `[client] url = <listener url>` with `apply_setting`, under the same commented block a fresh
  file gets;
- every other byte of the file is kept.

A file that declares a `url` is not touched. A plan with no `listener` (no local server) writes nothing.

### §S3 — the installer fills in a missing `[server] port`, keeping the live one

`_resolve_listener` decides the port:

- **A destination that exists and names a port:** that port, as today.
- **A destination that exists and names no port:** the template's `[server] port`, which is the provisioned
  server's shipped declaration and the port that server boots on. No probe.
- **No destination yet:** the probe of the template's range, as today.

The `[manifest]` stage writes `[server] port` into an existing server file that names none, and the `[client] url` of
§S2 comes from the same listener. So the server file and the install file agree.

### §S4 — the install record

A file filled in by §S2 or §S3 is recorded as the install's own only when its bytes before the fill matched the
install record's digest for it, because it was the install's own and unedited. Any other file stays the operator's:

- it is not recorded;
- `uninstall --purge` keeps it, as today.

### §S5 — the words

- **The help:** the five clients' `--help` text "shipped default `http://localhost:3849`" becomes the chain:
  "the project's `crucible.toml`, else the install's, else the shipped `http://localhost:3849`". The go client's help
  names the same chain.
- **The shipped `clients/crucible.toml`:** in the `[client]` block's comment, "A project file declaring nothing here
  still wins; the install's is not read." becomes "A project file declaring no `url` here is passed over for the
  install's."
- **The other docs:**
  - the PRD and the client-fleet DN, wherever they describe the chain;
  - `docs/RUNBOOK.md`, where it describes the chain;
  - a CHANGELOG `### Changed` line.
- **The install output:** the installer's report names each file it filled in and the key.

### §S6 — Model B is told

At merge, the orchestrator sends Model B the new chain over Sandesh. The global `crucible` skill's Connection
section, which Model B owns, then needs to say:

- a project file without `[client]` falls through to the install's;
- a Model B project reaches the board its install names.

This step is not part of the code and has no AC.

## Acceptance criteria

- [ ] **AC1 — a project file without `[client]` falls through to the install's.** A scratch fleet whose install
  `crucible.toml` declares `[client] url = <board double>`, and whose project `crucible.toml` declares only
  `[gate] skip`, posts a verb's requests to the double. The envelope's `context.board` names it.
- [ ] **AC2 — the project's own `url` still wins.** With both files declaring a `url`, the project's is used.
- [ ] **AC3 — what is passed over.** Each of these project files falls through to the install's `url`:
  - no `[client]` table;
  - `[client]` with no `url`;
  - an empty or whitespace `url`;
  - a non-string `url`;
  - a file that does not parse;
  - no file.

  With neither file declaring one, the shipped `http://localhost:3849` is answered, and nothing raises.
- [ ] **AC4 — limits are unchanged.** A project file that parses with no `[limits]` still decides the limits as
  today. The existing limit-chain tests pass unedited.
- [ ] **AC5 — a re-install writes the missing `[client] url`.** In a throwaway `HOME`, an existing install
  `crucible.toml` in the 17 Sep shape (limits, no `[client]`) gains `[client] url = <listener url>` under its comment
  block after `install`. Every other byte is kept. A second `install` changes nothing, and its stage converges.
- [ ] **AC6 — a set `url` is never overwritten.** An install file that declares `[client] url = X` keeps `X`, byte
  for byte, after `install`.
- [ ] **AC7 — the live port is kept.** In a throwaway `HOME` with a provisioned server whose existing server file
  names no port, `install` writes the template's `[server] port` (no probe), and the install file's
  `[client] url` names the same port. The proof holds even while that port is occupied on the machine, so it shows
  no probe ran.
- [ ] **AC8 — a fresh install still probes.** With no server file yet, the port is the first bindable one in the
  range, as today. The existing CR-CRU-139 installer tests pass unedited.
- [ ] **AC9 — the record.** A filled-in file that matched its recorded digest is re-recorded. A filled-in file that
  did not, or that had no record, is not recorded, and `uninstall --purge` keeps it.
- [ ] **AC10 — the words.**
  - No client's `--help` says "shipped default" without naming the install's file before it.
  - The shipped `[client]` comment states the fall-through.
  - The PRD, DN and RUNBOOK describe the three-step chain.
  - The CHANGELOG has the line.
  - The install output names a filled-in file and its key.
- [ ] **AC11 — production is never touched.** Every test runs against a throwaway `HOME` and a board double or a
  scratch board. No test reads or writes `~/.crucible`, `~/.local/share/crucible`, :3849 or :3850.

## Non-goals

- The server's shipped `[server] port = 3849` and its resolution (user ruling).
- A client with no board anywhere refusing to run. The shipped address stays its last resort (user ruling).
- A checkout's clients reading the machine's install instead of the checkout's own `crucible.toml`.
- Rewriting an operator's set `url` or `port`, even when it names a board that is down.
