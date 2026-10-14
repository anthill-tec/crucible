# CR-CRU-190 — the 0.4.0 follow-ups list

**Type** fix (patch CR, one list of follow-ups) · **Points** 13 (set at filing, 2026-10-14; items 6–8 added the same day;
the gap analysis splits it if the list outgrows the cap) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-184 · **Status** PENDING — filed 2026-10-14 (user ruling: the open follow-ups are ONE patch
CR, not several; placed after CR-CRU-189)

## Problem

Eight follow-ups came out of wave 8's work and Model B's mail. Each is small, and the user ruled that
they are worked as one CR.

1. **An agent's badge names its cycle by a board-wide id.** Noticed by the user (2026-10-14). An agent's
   row in the project pane shows the server-composed idle line (`src/v2.ts`, `idleLine`):
   `idle · GREEN · cycle 675 · last run …`. That is `agent.boundCycleId`, an id counting every cycle
   ever filed in the project, which says nothing about where the agent is in its CR. The roadmap
   lane already names a cycle by its place in its plan: `cycle 2/5` (`roadmapCyclePosition`,
   `public/app.js`).
2. **No client's help documents where the board address comes from.** Raised by Model B's question
   (Sandesh #1444, answered in #1445). The board a client posts to is `[client] url` in
   `crucible.toml`. It is resolved from the project's file, then the install's, then the shipped one,
   and the FIRST file that reads wins. So a project `crucible.toml` with no `[client] url` falls
   straight through to the shipped `http://localhost:3849`, a production board on a machine that runs
   one. No `--help` and no error message says any of this.
3. **A late signal after a filed run is misreported.** Left over from CR-CRU-184 (its VERIFY and FIX
   round, 2026-10-13). A signal that lands while the gated-run identity is being removed, after the
   run was filed:
   - prints "no run was open on the board", because the bracket forgets the filed run's id after the
     ingest;
   - leaves stdout holding the run's own `ok: true` envelope and then the signal's `ok: false` one.

   And the abort that follows a first signal (`_abort_gated_run`) is not held, so a second signal can
   cut it short.
4. **`bun-crucible.py test` has no test-name filter.** Requested by Model B (Sandesh #1446). An agent
   iterating on one test can only run the whole file; `bun test -t "<name>"` has no client form.
5. **`python-crucible.py` runs `unittest` only.** Requested by Model B (Sandesh #1446). A pytest
   project has no client form for its runs.

6. **An archived project's release burndown reports a total of zero.** Found during CR-CRU-188
   (cycle 675): `listQueue` returns no rows for an archived project, yet its release burndown route
   still answers 200 with `totalPoints: 0`, neither its real total nor the archived refusal the
   other agent and read routes give.
7. **`cr-close` hides a failed `cr-merged` post.** Found closing CR-CRU-188: `cr-close` posts the
   `cr-merged` milestone itself, and the board refused it (HTTP 409) because the orchestrator was
   still bound to the plan's verify cycle (its `pre-merge-gate --cycle` bound it, and the close
   closed that plan). The envelope still read `ok: true, warnings: []`; the refusal appeared only in
   a trailing human line.
8. **One `--cycle` help line misdescribes its verb.** rust `docker-e2e-gate` opens no gated
   identity, but its `--cycle` help says the gated run leaves its registration and binding intact
   (the wording the gated verbs use) rather than the filing wording `check`/`compile` carry.

## Steps

### §S1 — the badge reads the cycle's place in its plan

An agent bound to a cycle reads `<CR> · cycle <n>/<m>` wherever its row names the cycle: `n` is the
cycle's 1-based place in its plan and `m` the plan's cycle count, the roadmap lane's numbering. A
cycle whose plan cannot be resolved reads `cycle #<id>`, marked as an id. An unbound agent still
reads `no cycle bound`.

### §S2 — every client's help names the board's configuration

Every client's top-level `--help`, and its error when the board cannot be reached, names:
- the `[client] url` key;
- the resolution order (project, install, shipped);
- that the first readable file wins, so a project file without `[client] url` uses the shipped
  address.

### §S3 — a late signal after a filed run is reported once and truly

The bracket keeps the filed run's id after the ingest, so a signal during the identity removal names
that run as filed. Such an exit prints one envelope, the signal's `ok: false` naming the filed run,
and no `ok: true` before it. The abort that follows a first signal runs held.

### §S4 — `bun-crucible.py test` filters by test name

`test` gains `--name <pattern>`, passed to `bun test -t <pattern>`. The run is filed under the same
tier and cycle as any other `test` run, and its envelope names the filter.

### §S5 — `python-crucible.py` runs pytest

`test` and `regression` gain `--runner {unittest,pytest}` (default `unittest`, so nothing changes for
today's projects). With `pytest`, the client runs `pytest --junitxml=<report>` and ingests that
report exactly as it ingests `xmlrunner`'s, through the same run lifecycle, interrupt trap,
temp-root and ran-nothing exits as the `unittest` path.

### §S6 — an archived project's burndown says it is archived

The release burndown, forecast and velocity routes answer an archived project the way the other
read routes do (the archived refusal), never a computed zero.

### §S7 — `cr-close` reports its own `cr-merged` post

When `cr-close`'s `cr-merged` post fails, the envelope says so: a warning naming the board's refusal,
and `help[]` naming the remedy (re-register unbound, then `milestone --type cr-merged`). The close
itself stays done. A gate's cycle binding is released when its cycle is marked done, so the close's
own post is not refused for it.

### §S8 — every `--cycle` help line describes its own verb

`docker-e2e-gate`'s `--cycle` help uses the filing wording, and a census test checks that each
verb's `--cycle` help matches whether that verb opens a gated identity.

## Acceptance criteria

- [ ] **Badge.** On a board whose plan has five cycles, an idle agent bound to the second shows
      `<CR> · cycle 2/5` in its row (DOM), the same `n/m` the roadmap lane shows, and never the
      board-wide id. A cycle with no resolvable plan reads `cycle #<id>`; an unbound agent reads
      `no cycle bound`.
- [ ] **Help names the configuration.** For EACH of the five clients, `--help` and the
      unreachable-board error name `[client] url`, the order and the fall-through rule.
- [ ] **Late signal.** Through a real client against the recording board: a SIGTERM during the
      identity removal of a filed run prints exactly one envelope, `ok: false`, naming SIGTERM and the
      filed run's id; a second signal during the post-signal abort leaves the run aborted and one
      envelope.
- [ ] **Name filter.** `bun-crucible.py test --name <pattern>` runs only the matching tests (a fixture
      with two tests, one matching), is filed with that count, and its envelope names the filter.
- [ ] **Pytest.** `python-crucible.py test --runner pytest` and `regression --runner pytest` run a
      pytest fixture, file its pass and fail counts, abort a ran-nothing run, and survive a SIGTERM
      like the `unittest` path. Without `--runner`, every existing python test passes unchanged.
- [ ] **Archived burndown.** For an archived project, the burndown, forecast and velocity routes
      answer the archived refusal, never `totalPoints: 0`.
- [ ] **A failed `cr-merged` post is reported.** Against a live in-process board that refuses the
      `cr-merged` post, `cr-close` closes the CR and its envelope carries a warning naming the refusal
      and `help[]` naming the remedy; after a gate bound the orchestrator to the verify cycle and
      that cycle is marked done, `cr-close`'s own `cr-merged` post succeeds.
- [ ] **Help matches the verb.** For EACH client, every verb's `--cycle` help matches whether the
      verb opens a gated identity.
- [ ] **No new CR literals.** No CR-shaped literal is added in `src/`, `public/`, `clients/` or test
      comments, and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: one red-green cycle per section, then verify. Model B hears of §S2, §S4 and §S5
in the 0.4.0 release notes.
