# CR-CRU-139 — a connection is configuration too

**Type** feature · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-131, CR-CRU-138 · **Status** PENDING

## Problem

`crucible.toml` is this project's configuration file, and the *connection* — which port the server
listens on, which board a client posts to — is still not in it. It lives only in the environment:

| Knob | Today | Read at |
|---|---|---|
| server port | `$CRUCIBLE_PORT`, default `3849` | `src/server.ts:249` |
| server bind | `$CRUCIBLE_HOST`, default `127.0.0.1` | `src/server.ts:252` |
| client target | `$CRUCIBLE_URL`, default `http://localhost:3849` | each client, e.g. `clients/bun-crucible.py:91` (arduino also honours legacy `$CRUCIBLE_BASE`) |

CR-CRU-131 already made this move for the six limits and RETIRED their three environment variables
(`$CRUCIBLE_DEFAULT_RETENTION`, `$CRUCIBLE_RUN_ABANDON_MS`, `$CRUCIBLE_PROJECT_INACTIVE_MS`) — the
RUNBOOK's "Retired environment variables" section is the precedent. It left the connection knobs
behind on a stated argument: they *"answer where am I and who am I, and must work before any
configuration file can be found."*

**That argument holds for `CRUCIBLE_DB` and `CRUCIBLE_PROJECT_KEY`. It does not hold for the port,
the bind address, or the client's URL.** Neither side needs them to FIND its configuration:

- the server resolves its store first and reads `crucible.toml` from that directory
  (`src/limits.ts:158-159` — `dirname(resolveStore().path)`), so the port is discovered *after* the
  file is already in hand;
- a client resolves its file from the bound project dir, then the install dir
  (`clients/_crucible_axi.py`, the CR-CRU-138 §S1 chain) — a path that never involves the URL.

So three settings sit in the environment for a reason that was only ever true of a fourth.

**What it costs, concretely.** A development board on a second port beside the installed production
one is an ordinary need, and today it is only expressible as an export:

```sh
CRUCIBLE_PORT=3850 bun run src/server.ts
CRUCIBLE_URL=http://localhost:3850 python3 clients/bun-crucible.py status
```

`CRUCIBLE_URL` is bound at import from `os.environ` and is **not** read from the project `.env` (the
clients read that file, but only for `CRUCIBLE_PROJECT_KEY`). So the dev port cannot be declared as
a per-project fact: it must be exported into every shell and every sub-agent dispatch, and the
failure mode of forgetting is silent and severe — **an agent reports its runs into the PRODUCTION
board**, with no error, because `http://localhost:3849` is a working default.

That is the same class of defect as CR-CRU-138: a real, load-bearing value that no file owns.

## The role of this CR: the setting is made NON-PROGRAMMATICALLY

This is the point, and it is not "move three values for tidiness". **An operator must be able to
decide which port the server listens on and which board a client posts to by EDITING A FILE** —
the commented `crucible.toml` already laid down beside each side — and by nothing else:

- **not** by exporting an environment variable into every shell, every terminal tab, every
  sub-agent dispatch and every CI step, where the only record of the decision is a shell history;
- **not** by editing source — today the client's target is a module constant
  (`CRUCIBLE_URL = os.environ.get("CRUCIBLE_URL", "http://localhost:3849")`), so "point this
  checkout at another board" reads as a code change to a shipped file;
- **not** by inventing a launcher wrapper that supplies the env for you, which is the same secret
  kept in a second place.

A configuration file is the artifact an operator OWNS, can read back, can diff, and can hand to
someone else. That is what `crucible.toml` is for, and CR-CRU-131 already settled the principle for
the six limits — this CR finishes the job for the connection.

### The scenario this must satisfy (user, 2026-09-16)

**Two Crucible instances on one machine.** The Crucible and Model B projects dog-food the
DEVELOPMENT instance; every other project on the workstation uses the PRODUCTION one. The
production instance is installed and managed separately — not this repo's concern.

The separation on the data axis already works and needs nothing: a server booted from this repo
adopts `<repo>/data/crucible.db` (the `cwd-data` rule — measured here, schema 13), while an
installed production server creates its own store under `~/.local/share/crucible/`. **Only the port
and the client's target are unresolved**, and today both are only expressible as exports.

So the acceptance bar is behavioural, not structural: with the two files edited and NOTHING
exported, a verb run from this checkout reaches the development board, and the same verb run from
another project reaches production. A reader must be able to answer "which board does this project
talk to?" by opening one file.

## Scope

### §S1 The server's listener is declared in its own `crucible.toml`

`src/crucible.toml` gains a `[server]` table carrying `port` and `host`, documented in the same
commented style as the limits, and `startServer` resolves them through the existing
point-of-use read rather than from `process.env`.

Precedence, matching CR-CRU-131's shape for limits: an explicit `opts` argument (a test's own
choice) wins, then the file, then the shipped default. `$CRUCIBLE_PORT` and `$CRUCIBLE_HOST` are
**retired** exactly as the three limit variables were — they stop being read, and the RUNBOOK's
"Retired environment variables" section gains them with the same "declare it in the table instead"
wording. A retired variable that silently still works is worse than either state.

**The listener is RESOLVED BY A PURE FUNCTION and then DISCLOSED, exactly as the store already is
(user ruling 2026-09-16, option b; contract corrected 2026-09-16 after RED found the first wording
self-contradictory).** The store's shape is the whole precedent and this copies it rather than
inventing a sibling: `resolveStore(opts?)` is a PURE exported function with injectable `env`/`cwd`
returning `{ path, rule }` (`src/server.ts:39-79`), `startServer` calls it, keeps the answer on its
handle as `storeResolution` (`:94,:218,:291`), and repeats it at ONE shared `healthPayload` site so
`/api/health` and `/api/v2/health` cannot drift (`:226-245`, CR-CRU-068 §S1).

So the listener gets the same three things:

- **`resolveListener(opts?)`** — a pure exported function, `env` injectable like `resolveStore`'s,
  returning `{ port, host, portRule, hostRule }`. It reads the file and the shipped default and
  BINDS NOTHING. This is what makes the shipped-default case provable: call it with no file and no
  argument and assert `port` is the shipped default with `portRule: "shipped"` — no socket, no
  flakiness, and `3849` is never bound.
- **`listenerResolution` on the handle**, the answer `startServer` actually used.
- **A `listener` block at that same single `healthPayload` site**, so the two health routes cannot
  disagree.

**Two corrections RED's escalation forced, both of which were defects in my wording, not in its
reading:**

- **The rule is PER AXIS: `portRule` and `hostRule`, not one `rule` for two values.** Port and host
  resolve independently, so a single field cannot describe a boot that takes its port from an
  argument and its host from the file. One `rule` covering two axes was ambiguous the moment the
  mixed case existed; the store has one axis and needs only one word.
- **The disclosure describes the RESOLUTION, and it must never contradict the socket.** My first
  wording asked for `portRule: "shipped"` on a boot that passed a port explicitly — irreconcilable
  with the vocabulary in the same breath, and the `port: 0` reading that would rescue it is worse:
  it would have `listenerResolution.port` report `3849` while the server was really on a kernel
  port, which is a disclosure that lies about where the server listens. The pure function removes
  the need for the trick entirely. An explicit argument — including `port: 0` — is `explicit`, the
  same word `resolveStore` already uses for an explicit `dbPath`, and what the handle discloses for
  a running server always matches the socket it bound.

### §S1a The INSTALLER writes the connection, so nothing needs an environment

**User ruling 2026-09-16, and it removes the last excuse for the environment layer:** the installer
already lays `crucible.toml` down (CR-CRU-138 §S2 beside the database, §S4 beside the fleet), so it
is the thing that SETS these values — an operator does not hand-edit a fresh install, and no
process needs `Environment=CRUCIBLE_PORT=` to be told where to listen.

So `crucible-axi install` accepts the connection settings and WRITES them into the files it lays
down: the listener into the server's `[server]` table, the board URL into the fleet's
`[client]` table. An install on a machine that already carries a production instance is
therefore configured at install time, in the file, once — which is exactly the two-instance
scenario above.

**The installer DISCOVERS the port; nobody picks a number (user ruling 2026-09-16).** The shipped
`[server]` table declares the RANGE this project may occupy — **`3800`–`3899`**, a hundred ports in
the 3000s around the `3849` this project has always used — documented the way the limits are, so
the range is read where it is set. At install time the installer probes that range on whatever
machine it is running on, takes the first port it can BIND, and writes that concrete port into the
file it lays down. The client file's `[client] url` is written from the SAME resolved value, so one
install's two files cannot disagree.

The range is read from the RESOLVED server config file — the same
`_provisioned_server_config_source()` an install already reads its template from — never from a
constant in the installer. That is what makes exhaustion TESTABLE without an environment knob and
without occupying a hundred real ports: an install test already stands up a temp provisioned
server package, so it declares its own two bounds in that file and occupies the handful of ports
between them. A range that could only be narrowed by an export would smuggle back the exact
mechanism this CR retires.

Keep it simple. Three rules, no more:

- **Probe by BINDING, not by connecting.** A refused connection proves only that nothing is
  listening *right now*; binding proves the port is ours to take. A connect-based probe will hand
  out a port another service has reserved but is not yet serving.
- **A configured port is never re-probed.** If the file already names one, the install USES it —
  a re-install that renumbers a running instance orphans every client whose file names the old
  port. Probing happens on a FRESH install, where there is nothing to honour.
- **Exhaustion STOPS the install and ASKS.** If no port in the range can be bound, the installer
  halts and prompts the operator — naming the range and what occupies it — exactly as it already
  prompts before a destructive purge. It never drifts outside the range and never falls back to the
  shipped default: a silent fallback is how two instances end up on one port. A NON-interactive run
  cannot prompt, so it fails definitively with the same message (the installer's existing
  interactive/non-interactive split, unchanged).

That is the whole mechanism. Production installs and takes a port; this repo's development instance
installs and takes the next free one; neither knows about the other, and both record what they took.

**The install's own write must not read as an operator's edit (user ruling 2026-09-16, option a).**
`_operator_config_is_untouched` (`crucible_axi/install.py:1300-1326`) decides "did the operator
change this?" by comparing the file's BYTES against the shipped template, and CR-CRU-138 §S2's
uninstall/purge convergence depends on that answer. Writing a probed port in would make every
installed file differ from its template forever — so the install's own value would be
indistinguishable from an operator's, purge would take the retention branch on every machine that
ever probed a port, and `converged` would go false for a reason no operator caused.

So the `[manifest]` stage RECORDS the bytes it actually wrote, and that recorded value — not the
shipped template — is what `_operator_config_is_untouched` compares against for a file the install
authored. The rule's MEANING is unchanged ("is this still exactly what the install put here?"); only
its baseline moves, from "the template" to "what was written", which is the same sentence once the
installer is allowed to write. An operator's later edit still diverges from the recording and is
still preserved. A file with no recording (an older install, a hand-placed file) falls back to the
template comparison, so the existing fail-safe direction is untouched.

**Nothing else needs to know the port — including the service.** `_unit_environment()` stops
forwarding `CRUCIBLE_PORT`/`CRUCIBLE_HOST` (`crucible_axi/install.py:863-879`): the unit only ever
carried them because the server had no file to read. The unit boots the server, the server reads
its own `crucible.toml`, and it binds what the install wrote there. No port in the unit, none in
the bootstrap, none in a skill — one datum, one file.

### §S1b A test overrides in-process or with its own file — never through the environment

Tests are not production, and they do not need an environment layer to redirect a client: today
**58 setter sites across 28 files** under `tests/` inject one of these four variables to point a
client or a server at an ephemeral port (measured 2026-09-16; the count excludes the `ENV_KEYS`
hygiene tuples that only POP them, which are not setters and do not migrate). Every one of those
fixtures ALREADY owns a temp root and writes files into it.

Three mechanisms replace it, each stronger than an export:

- **In-process** — `startServer({ port })` already wins over everything (`src/server.ts:249`), and
  stays the server-side seam for the TypeScript suites. A test naming its own port is explicit,
  local and unambiguous.
- **A server-side config file, for a server started as a SUBPROCESS** — five python suites spawn
  the real server (`bun run src/server.ts`) on a `_free_port()`, and `startServer({ port })` is
  in-process TypeScript they cannot reach. They already hand the child
  `CRUCIBLE_DB=<tmpdir>/crucible.db`, and `serverConfigPath()` (`src/limits.ts:158`) resolves to
  `dirname(db)/crucible.toml` — so the fixture writes `[server] port = <_free_port()>` into
  `<tmpdir>/crucible.toml` and the subprocess reads its own file. The suites are
  `test_cr092_next_decision_resolver.py`, `test_cycle_add_targets_the_plan_it_means.py`,
  `test_gate_names_the_release_it_gates.py`, `test_next_lane_carries_release_and_wave.py` and
  `test_plan_file_names_the_release_it_plans.py`.
- **A client-side config file** — a client test writes a `crucible.toml` carrying `[client] url`
  into the temp project (or install) root its fixture already creates, and the CR-CRU-138 §S1 chain
  resolves it. This has a property the export never had: the test exercises the REAL resolution
  path, so it proves the mechanism operators use rather than a bypass only tests can reach.

**Four shipped contracts are REVERSED by this CR, and each is re-subjected rather than deleted:**

- `tests/client/test_cr070_systemd_unit.py:793-845` asserts the unit MUST carry
  `Environment=CRUCIBLE_HOST/PORT` (CR-CRU-070 AC1), plus the inverse that an unset knob is not
  emitted as an empty assignment. `CRUCIBLE_DB` STAYS, so this becomes a one-variable assertion —
  the unit forwards the store and nothing else — not a deleted test.
- `tests/client/test_cr066_serve_and_target_dir.py:354-390` (`ServeEnvironmentForwardingTest`,
  "AC5 (env)") asserts `serve` forwards both to the child. Its subject becomes: `serve` composes no
  listener environment, and the child listens per its own file.
- `tests/client/test_cr054_http_core_lift.py:141-145` reads each client's base-URL module constant
  back dynamically; `tests/client/test_gate_multi_suite_coverage.py:565` patches it
  (`mock.patch.object(module, "CRUCIBLE_URL", …)`). §S2 deletes those constants, so both move to the
  shared resolver in `_crucible_axi.py` — the value is still read back and still overridable, from
  one place instead of five.

Migrating the 58 sites is the bulk of this CR's work and is deliberate: it is the difference
between configuration that is tested and configuration that is merely shipped.

### §S2 A client's target board is declared in its own `crucible.toml`

`clients/crucible.toml` gains a `[client]` table carrying `url`, resolved through the CR-CRU-138
§S1 chain — project dir first and overriding, then the install dir, then the shipped default. That
is what makes a dev board a per-PROJECT fact: a checkout pointed at `http://localhost:3850` keeps
pointing there for every verb and every sub-agent, with nothing to export and nothing to forget.

The base URL stops being a per-client module constant bound at import. All five clients resolve it
from the one shared place (`_crucible_axi.py`), which is the CR-CRU-133 §S2 "spelled in ONE place"
pattern; the four `CRUCIBLE_URL` constants and arduino's `CRUCIBLE`/`CRUCIBLE_BASE` pair collapse
into it.

`$CRUCIBLE_URL` is **retired** with the others. A single mechanism, or the one that is easiest to
forget wins by accident.

### §S3 `CRUCIBLE_DB` and `CRUCIBLE_PROJECT_KEY` stay in the environment, and the file says why

These two genuinely precede configuration discovery: the store path is how the server FINDS its
file, and the project key is identity, read from the project `.env` the clients already load. They
stay environment-resolved, and both shipped `crucible.toml` files state that explicitly — so a
reader who finds `[server] port` in the file does not conclude the store belongs there too, and a
later CR does not "finish the job" by moving a value that cannot move.

### §S4 One rule, so a second board cannot be reached by accident

A client that resolves a URL from configuration must SAY which board it is talking to when that
board is not the shipped default — in the envelope `context`, beside `projectKey`. The silent
failure this CR exists to remove is an agent reporting into the wrong board; the defence is that
the envelope names the target, so a misdirected run is visible in its own output rather than
discovered later on the wrong dashboard.

## Acceptance criteria

- [ ] `src/crucible.toml` declares `[server]` with `port` and `host`, each with the description /
      default commentary the limits tables carry.
- [ ] A server booted with a `[server] port` set listens on THAT port, proven by a real request to
      it.
- [ ] With no file present the SHIPPED default is what resolves — asserted on the PURE
      `resolveListener()` with no file and no argument: `port` equals the shipped file's declared
      port, `portRule` is `shipped`. No socket is bound, so `3849` is never touched; binding the
      real default would be flaky on exactly the two-instance machine this CR serves.
- [ ] `resolveListener(opts?)` is exported and pure, with `env` injectable the way `resolveStore`'s
      is, and binds nothing — asserted by calling it directly for every layer and by the absence of
      any listener afterwards.
- [ ] `portRule` and `hostRule` are PER AXIS and each names the layer that won: `explicit` for an
      argument (the word `resolveStore` already uses), `file` for a `[server]` table, `shipped` for
      neither. The MIXED case is asserted explicitly — a port from the argument and a host from the
      file yields `portRule: "explicit"` with `hostRule: "file"`, which is the case a single `rule`
      field could not express.
- [ ] `startServer` discloses `listenerResolution { port, host, portRule, hostRule }` on its handle,
      and the ONE shared `healthPayload` site carries the same values as a `listener` block — so
      `/api/health` and `/api/v2/health` cannot drift, the way CR-CRU-068 §S1 already binds the
      `store` block. Asserted by fetching BOTH routes and comparing them to each other and to the
      handle.
- [ ] What a RUNNING server discloses always matches the socket it bound: for every boot in these
      tests, `listenerResolution.port` equals the handle's real `server.port`. A disclosure that
      names a port the server is not listening on is the defect this criterion forbids.
- [ ] An explicit `startServer({ port })` still wins over the file — the test seam is unchanged.
- [ ] `$CRUCIBLE_PORT` and `$CRUCIBLE_HOST` are no longer read: a server booted with both exported
      to junk values still listens per its file/default. Asserted by an actual boot, not by grep.

**C2 — a client's board is its project's configuration** (§S2, and every site that steers by the
retired variables; retire and migrate in ONE cycle, which is the ordering lesson C1 paid for)

- [ ] A checkout whose project-dir `crucible.toml` names a board has every one of the five clients
      post THERE, for every verb, with nothing exported — proven by running verbs against two live
      boards and reading which one recorded each run.
- [ ] Project dir beats install dir beats shipped default, by the chain CR-CRU-138 §S1 already
      built.
- [ ] `$CRUCIBLE_URL` and `$CRUCIBLE_BASE` are dead: exported to junk, nothing changes. No client
      holds its own base-URL constant.
- [ ] No file under `tests/` steers a client or a server by any of the four retired variables, and
      the suites that did still prove what they always proved — including the offline-degradation
      contract (a client formats output with no board reachable) and the two tests that read or
      patched a client's base-URL constant.
- [ ] This checkout carries a committed `crucible.toml` naming the development board, so the
      orchestrator's own verbs reach it with nothing exported. The CR proves itself on its author.

**C4 — the board is named, and the documentation matches** (§S4, docs, close-out)

- [ ] A verb whose resolved board is not the shipped default names that board in its envelope
      `context`, beside `projectKey`.
- [ ] `docs/RUNBOOK.md` documents the connection as configuration: the retired variables listed as
      retired, the environment section reduced to the two that remain (`CRUCIBLE_DB`,
      `CRUCIBLE_PROJECT_KEY`) with the shipped tomls saying why those two cannot move, and
      dev-beside-production shown as a pair of file edits rather than exports.
- [ ] The guards that currently require the retired variables to be documented move with the
      RUNBOOK in the same cycle and still pin a real rule.
- [ ] Figures in the docs are derived from the shipped tomls, never retyped (CR-CRU-134's rule).

**§S1a — the installer sets it, so an operator never has to**

- [ ] `crucible-axi install` accepts the connection settings and WRITES them into the files it lays
      down: the listener into the server file's `[server]` table, the board URL into the fleet's
      `[client]` table. Asserted by running a real install into a temp target and reading the
      resulting files, not by reading the installer's own output.
- [ ] A second install on the same machine, given different settings, produces a second instance
      whose files name its own port and board — the two-instance scenario, proven end to end: boot
      both, run a verb against each, and assert each run landed on the board its own file names.
- [ ] The shipped `[server]` table declares the PORT RANGE this project may occupy, documented the
      way the limits are (a sentence plus bounds), so the range is read where it is set.
- [ ] The installer PROBES that range and writes the first port it can BIND into the file it lays
      down; the fleet's `[client] url` is written from the SAME resolved value, so one install's two
      files cannot disagree. Asserted by reading both files after a real install.
- [ ] The probe binds rather than connects: with a listener occupying the first port of the range,
      the install takes the NEXT one — and with a socket bound but not listening on it, the install
      still skips it. A connect-based probe passes the first case and fails the second, so both are
      asserted.
- [ ] A RE-INSTALL never re-probes: if the file already names a port the install USES it, even while
      the instance is running on it — the file is unchanged and no client is orphaned. Probing
      happens only on a fresh install, where no port is configured.
- [ ] Range exhaustion STOPS the install and PROMPTS the operator, naming the range and what
      occupies it — asserted by declaring a NARROW range in the temp provisioned server's own
      config file, occupying every port in it, and reading the prompt. It never drifts outside the
      range and never falls back to the shipped default.
- [ ] The range is read from the RESOLVED server config file, not from a constant in the installer:
      a test that declares different bounds in that file gets an install that probes THOSE bounds.
      This is what makes the exhaustion criterion above satisfiable without any environment knob.
- [ ] A NON-interactive run cannot prompt, so exhaustion fails it definitively with the same
      message — the installer's existing interactive/non-interactive split, unchanged.
- [ ] The declared range is `3800`–`3899` in the shipped file, and the install's chosen port lies
      inside it — asserted against the FILE's declared bounds, not a retyped pair of numbers
      (CR-CRU-134's rule).
- [ ] Two installs on one machine, run with no knowledge of each other, land on DIFFERENT ports and
      each records its own: boot both, run a verb against each, assert each run landed on the board
      its own file names.
- [ ] An operator-EDITED connection value SURVIVES a re-install: configuration the operator changed
      is data, not an artifact.
- [ ] The `[manifest]` stage RECORDS the bytes it wrote for each config file it authored, and
      `_operator_config_is_untouched` (`crucible_axi/install.py:1300-1326`) compares an authored
      file against THAT recording rather than against the shipped template. Asserted three ways, on
      a real install into a temp target: (1) a file the install wrote a probed port into is reported
      UNTOUCHED, so `uninstall --purge` removes it and reports `converged`; (2) the same file after
      an operator edit is reported touched, RETAINED by purge with the existing reason sentence; and
      (3) a file with NO recording (an older install, or one placed by hand) still falls back to the
      template comparison, so the fail-safe direction is unchanged.
- [ ] CR-CRU-138 §S2/§S3's purge convergence still holds on a machine that probed a port — the
      regression this recording exists to prevent: without it every installed file would read as
      operator-edited forever and `converged` would go false with no operator involved.
- [ ] `_unit_environment()` (`crucible_axi/install.py:863-879`) no longer forwards `CRUCIBLE_PORT`
      or `CRUCIBLE_HOST`; the rendered unit carries neither, and the installed server still listens
      on its configured port — asserted by reading the rendered unit text AND by the server's own
      `/api/health`.

**Close-out**

- [ ] Citations into the files this CR edits are re-verified and re-recorded ONCE, at close-out —
      never a mid-cycle re-pin per drift, which cost CR-CRU-138 three approval round-trips.
      (C1 done: `src` head 724 → 736, measured; `public` and `clients` unmoved.)

## Non-goals

- Moving `CRUCIBLE_DB` or `CRUCIBLE_PROJECT_KEY` into the file (§S3 — they precede discovery).
- Merging the client and server tomls. Still disjoint by design, still two packages (CR-CRU-131
  §S1c).
- Authentication or multi-board routing. One declared target per project, not a board registry.
