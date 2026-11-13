# CR-CRU-252 — a client finds its board in the install when its project names none

**Status:** PENDING — filed 2026-11-13 (user ruling: in 0.4.0, wave 8, before CR-CRU-199, which stays last as the
release's hygiene CR); gap analysis ran 2026-11-13, user rulings at design · Pre-review: ran 2026-11-13 (it
changes what an install writes on a machine carrying a production board, and another project's skill documents the
old chain); CHANGES, 7 findings folded
**Type:** fix
**Points:** 8 (5 at filing)
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
  - **Accepted risk (pre-review):** the `[manifest]` stage runs after `[server]` has provisioned, so it cannot tell
    a live server's file from one placed by hand, left by a plain `uninstall`, or kept under another
    `XDG_DATA_HOME`. Every port-less server file is treated as live, so such a file can take the template port
    while another instance holds it. This follows the keep-the-live-port ruling. The install output names the port
    it wrote, so the operator sees it.
- **Only an absent key is filled.** A key present in any form, including an empty or mistyped value, is the
  operator's and is left alone. Only a regular file that parses is filled.
- **`context.board` keys off the machine's own board.** An envelope names `context.board` only when the resolved
  board differs from the install's declared `url`, or from the shipped one when the install declares none. That
  keeps CR-CRU-139's rule (a key on every line carries no signal) once the install's file names the production
  board as `http://127.0.0.1:3849`. (Orchestrator ruling, pre-review F6.)
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

`_read_project_config` and every limit keep their first-file-that-parses rule, unchanged. So does `[gate]`.

The docstrings that state "one walk, one rule" for `[client]` are rewritten: `_read_project_config`'s,
`resolve_base_url`'s, and the `[client]` intro comment in `clients/crucible.toml`.

`axi_context` compares the resolved board with the machine's own board, as Design states, and its docstring says
so.

### §S2 — the installer fills in a missing `[client] url`

In the `[manifest]` stage, when the install's operator `crucible.toml` already exists (it is not laid down by this
run), declares no non-empty `[client] url`, and the plan carries a `listener`:

- the stage writes `[client] url = <listener url>` with `apply_setting`, under the same commented block a fresh
  file gets;
- every other byte of the file is kept.

A file that declares a `url` is not touched. A plan with no `listener` (no local server) writes nothing.

### §S2a — the fill's guards (shared by §S2 and §S3)

- **What is filled:** only a regular file (not a directory, nor a dangling or other symlink to a non-file) that
  parses as TOML, and whose table has the key ABSENT. A present key with any value is left alone.
- **No race:** the file is re-read immediately before the write, and written only if the key is still absent. A
  `crucible-axi serve --port` that landed first wins.
- **The line endings are kept:** a CRLF file stays CRLF.
- **A bad write is undone:** the written file is re-parsed. If it no longer parses, or does not yield the written
  value (for example a `[client]  # note` header the line-rewriter did not recognise, giving a duplicate table),
  the original bytes are restored. The stage then reports that file as `not-filled` with the reason, and the
  install does not fail.
- **Anything else is skipped:** a file that is skipped (not regular, does not parse) is reported the same way, and
  the install does not fail.
- **Convergence:** a run that filled any file reports its `[manifest]` stage `converged: false`.

### §S3 — the installer fills in a missing `[server] port`, keeping the live one

`_resolve_listener` decides the port:

- **A destination that exists and names a port:** that port, as today.
- **A destination that exists and names no port:** the template's `[server] port`, which is the provisioned
  server's shipped declaration and the port that server boots on. No probe. A template with no `port` gives no
  listener, and nothing is filled.
- **No destination yet:** the probe of the template's range, as today.

`_resolve_listener`'s docstring, which states the opposite rule for the middle branch, is rewritten to this one.

The `[manifest]` stage writes `[server] port` into an existing server file that names none, and the `[client] url` of
§S2 comes from the same listener. So the server file and the install file agree.

### §S4 — the install record

A file filled in by §S2 or §S3 is recorded as the install's own only when its bytes before the fill matched the
install record's digest for it, because it was the install's own and unedited. Any other file stays the operator's:

- it is not recorded;
- `uninstall --purge` keeps it, as today.

### §S5 — the words

- **The help:** the shared `BOARD_CONFIGURATION_HELP`, which all six clients append to their top-level `--help`,
  states the new rule. The first file, the project's then the install's, that declares a non-empty `[client] url`
  wins. A file without one is passed over. The shipped address is the last resort. The five module docstrings that
  say "shipped default `http://localhost:3849`" name the same chain.
- **The shipped `clients/crucible.toml`:** in the `[client]` block's comment, "A project file declaring nothing here
  still wins; the install's is not read." becomes "A project file declaring no `url` here is passed over for the
  install's."
- **The other docs:**
  - `docs/RUNBOOK.md`: its `[client]` section and its `context.board` sentence. The PRD and the client-fleet DN do
    not describe the chain, and gain no text.
  - a CHANGELOG `### Changed` line.
- **The install output:** the `[manifest]` stage row carries `filled: [{path, key, value}]` and
  `notFilled: [{path, key, reason}]`. Each list is omitted when empty. `run_install` threads both, and
  `cmd_install` renders them, so an operator reads each filled file, its key and the value written, including the
  port.

### §S6 — Model B is told

At merge, the orchestrator sends Model B the new chain over Sandesh. The global `crucible` skill's Connection
section, which Model B owns, then needs to say:

- a project file without `[client]` falls through to the install's;
- a Model B project reaches the board its install names.

This step is not part of the code and has no AC.

## Acceptance criteria

- [ ] **AC1 — a project file without `[client]` falls through to the install's.** A scratch fleet whose install
  `crucible.toml` declares `[client] url = <board double>`, and whose project `crucible.toml` declares only
  `[gate] skip`, posts a verb's requests to the double. The envelope names no `context.board`, because the board is
  the install's own (see AC3's `context.board` bullet).
- [ ] **AC2 — the project's own `url` still wins.** With both files declaring a `url`, the project's is used.
- [ ] **AC3 — what is passed over.** Each of these project files falls through to the install's `url`:
  - no `[client]` table;
  - `[client]` with no `url`;
  - an empty or whitespace `url`;
  - a non-string `url`;
  - a file that does not parse;
  - no file.

  With neither file declaring one, the shipped `http://localhost:3849` is answered, and nothing raises.
  - **`context.board`:** with the install declaring `url = U`, a verb resolving `U` names no `context.board`, and a
    verb resolving another board names it.
- [ ] **AC4 — limits are unchanged.** A project file that parses with no `[limits]` still decides the limits as
  today. The existing limit-chain tests pass unedited.
- [ ] **AC5 — a re-install writes the missing `[client] url`.** In a throwaway `HOME`, an existing install
  `crucible.toml` in the 17 Sep shape (limits, no `[client]`) gains `[client] url = <listener url>` under its comment
  block after `install`. Every other byte is kept.
  - The filling run's `[manifest]` stage is `converged: false`, and its output names the file, the key and the value.
  - A second `install` changes nothing, and its stage converges.
  - A CRLF file stays CRLF.
  - These are left byte-identical, reported under `notFilled`, and the install still succeeds:
    - a file that does not parse;
    - a directory at the path;
    - a file whose fill would not re-parse (a `[client]  # note` header).
- [ ] **AC6 — a set `url` is never overwritten.** An install file that declares `[client] url = X` keeps `X`, byte
  for byte, after `install`.
- [ ] **AC7 — the live port is kept.** In a throwaway `HOME` with a provisioned server whose existing server file
  names no port, `install` writes the template's `[server] port` (no probe), and the install file's
  `[client] url` names the same port. The proof holds even while that port is occupied on the machine, so it shows
  no probe ran. The output names the port written.
  - The CR-CRU-139 test `test_a_file_that_exists_but_names_no_port_is_probed_not_defaulted` states the old rule.
    It is inverted under this AC.
  - A template with no `port` fills nothing.
  - A `port` present with a mistyped value (`"3850"`) is left as it is.
- [ ] **AC8 — a fresh install still probes.** With no server file yet, the port is the first bindable one in the
  range, as today. Every other CR-CRU-139 installer test passes unedited.
- [ ] **AC9 — the record.** A filled-in file that matched its recorded digest is re-recorded. A filled-in file that
  did not, or that had no record, is not recorded, and `uninstall --purge` keeps it.
- [ ] **AC10 — the words.**
  - Each of the six clients' real top-level `--help` states that the first file declaring a non-empty
    `[client] url` wins and a file without one is passed over. No `--help` says a project file without one uses
    the shipped address. `tests/client/test_every_clients_help_names_where_its_board_comes_from.py`, which pins the
    old rule, is edited under this AC.
  - The shipped `[client]` comments state the fall-through.
  - The RUNBOOK describes the three-step chain and the `context.board` rule.
  - The CHANGELOG has the line.
  - The real `crucible-axi install` output, under a throwaway `HOME`, names a filled file, its key and its value.
- [ ] **AC11 — production is never touched.** Every test runs against a throwaway `HOME` and a board double or a
  scratch board. No test reads or writes `~/.crucible`, `~/.local/share/crucible`, :3849 or :3850.

## Non-goals

- The server's shipped `[server] port = 3849` and its resolution (user ruling).
- A client with no board anywhere refusing to run. The shipped address stays its last resort (user ruling).
- A checkout's clients reading the machine's install instead of the checkout's own `crucible.toml`.
- Rewriting an operator's set `url` or `port`, even when it names a board that is down.
