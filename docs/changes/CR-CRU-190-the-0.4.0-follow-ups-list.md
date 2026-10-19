# CR-CRU-190 — the 0.4.0 follow-ups list

**Type** fix (patch CR, one list of follow-ups) · **Points** 13 (set at filing, 2026-10-14; items 6–8 added the same day, items 9–11 on
2026-10-16, item 12 on 2026-10-19; the gap analysis splits it if the list outgrows the cap) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-184 · **Status** PENDING — filed 2026-10-14 (user ruling: the open follow-ups are ONE patch
CR, not several; placed after CR-CRU-189)

## Problem

Twelve follow-ups came out of wave 8's work and Model B's mail. Each is small, and the user ruled that
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
9. **The declared python floor is not the baseline.** Found during CR-CRU-191. `pyproject.toml`
   declares `requires-python = ">=3.10"` and classifiers 3.10–3.13, but the clients and the
   installer import `tomllib`, which needs 3.11. Python 3.14 is the adopted baseline (user ruling,
   2026-10-16). The low floor is also why ruff files `tomllib` as third-party, which three
   `I001` suppressions currently paper over.
10. **One block in the rust client is indented a level too deep.** In `_smoke_refusal`, two nested
    `if`s were merged into one, but the body kept its old indent. It is valid and behaves the same,
    but it reads as nested one level deeper than it is.
11. **gitleaks reports identifiers as secrets.** pi-lens's gitleaks pass, with its default rules,
    reports 814 `generic-api-key` findings across the tree. None is a secret:
    - 694 are project keys (UUIDv7). 512 of them are this project's own key, in run output, tests
      and `.env`; the rest are test projects' keys.
    - 120 are test fixtures' made-up keys and agent ids.

    101 of the findings are in tracked files (45 test files, a design note and a project skill). The
    rest are in gitignored run output under `test-reports/` and `__pycache__/`. A real secret would
    be lost among them.
12. **A relative project dir breaks a run.** Found during CR-CRU-192. The bun, mvn, python and rust
    clients keep a relative `--project-dir` (or its environment variable) exactly as given; only
    arduino makes it absolute. The reports dir derived from it stays relative while the runner
    runs with the project dir as its cwd, so the runner writes its reports where the client never
    looks. No report is found, and the run is ingested as a compile failure. The gate's compile
    step fails the same way.

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

### §S9 — the python floor is the 3.14 baseline

`pyproject.toml` declares `requires-python = ">=3.14"`, with classifiers naming 3.14 only, and the
release workflow's python setup names 3.14. Since `tomllib` is then stdlib at the declared floor,
the three `I001` suppressions for it are removed, and the imports are ordered as ruff orders them
at that target.

### §S10 — the rust client's `_smoke_refusal` reads as it runs

The merged condition's body is indented to its real depth. Nothing else changes.

### §S11 — gitleaks reports secrets, not identifiers

A gitleaks configuration in the repo extends gitleaks' default rules. It allows a project key (a
UUIDv7) and a test fixture's key or id where it appears as a key or id value. It also excludes the
gitignored run output (`test-reports/`, `__pycache__/`). No default rule is disabled, so a real
secret anywhere in the tree is still reported.

### §S12 — a project dir is absolute from the moment it is resolved

Every client resolves its project dir, from the flag or the environment variable, to an absolute
path before anything derives from it: the reports dir, the `.env`, the `crucible.toml` and the
runner's cwd.

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
- [ ] **The floor is 3.14.** `pyproject.toml` declares `requires-python = ">=3.14"` and only the 3.14
      classifier, the release workflow sets up python 3.14, and no `I001` suppression for `tomllib`
      remains under `clients/` or `crucible_axi/`. Ruff under pi-lens's own configuration and
      Pyright 1.1.414 (pi-lens's bundled CLI) both stay clean over `clients/` and `crucible_axi/`,
      and the full python and bun suites pass on python 3.14.
- [ ] **`_smoke_refusal` is indented truly.** Its body sits one level inside the merged `if`, and the
      rust client's existing tests pass unchanged.
- [ ] **gitleaks is quiet on identifiers and loud on secrets.** pi-lens's gitleaks pass, run over the
      whole tree, reports zero findings on the current tree. With a planted fixture holding a real
      token shape (e.g. a GitHub token pattern) in a tracked test file, it reports that one. The
      repo's gitleaks configuration extends the default rules and disables none.
- [ ] **A relative project dir runs.** For EACH of the five clients, a `test` run and a
      `pre-merge-gate` started from the project's parent with a relative `--project-dir`, and again
      with the relative path in the environment variable, file the same pass and fail counts as the
      same run given the absolute path, and no compile failure.
- [ ] **No new CR literals.** No CR-shaped literal is added in `src/`, `public/`, `clients/` or test
      comments, and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: one red-green cycle per section, then verify. Before §S9's cycle this repo's
`.venv` is rebuilt on python 3.14 (`uv venv --python 3.14`, then `uv pip install
unittest-xml-reporting coverage`), so the client's runs use the baseline interpreter. Model B hears of §S2, §S4, §S5
and §S9 (the 3.14 floor) in the 0.4.0 release notes.
