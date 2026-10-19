# CR-CRU-190 — the 0.4.0 follow-ups list

**Type** fix (patch CR, one list of follow-ups) · **Points** 8 (re-scored at gap analysis
2026-10-19) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-184 · **Status** PENDING — filed
2026-10-14 (user ruling: the open follow-ups are ONE patch CR, not several). Split at gap analysis
2026-10-19 (user ruling): the bun test-name filter moved to CR-CRU-194, the pytest runner to
CR-CRU-197, and the python floor, the rust indent and the gitleaks configuration to CR-CRU-198; the
late-signal follow-up was dropped.

## Problem

Six follow-ups came out of wave 8's work and Model B's mail. Each is small, and the user ruled that
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
   one. Each client's module docstring names `[client] url`, but no `--help` prints it, and no
   error message names the key, the order or the fall-through.
3. **An archived project's analytics are answered as if it were live.** Found during CR-CRU-188
   (cycle 675). The four analytics routes (velocity, burndown, forecast, changes) check only that
   the project exists. An archived project's queue reads as empty, while its declaration journal
   does not, so its release burndown answers 200 with `totalPoints: 0`: neither its real total nor
   the archived refusal the agent and write routes give.
4. **`cr-close` hides a failed `cr-merged` post.** Found closing CR-CRU-188: `cr-close` posts the
   `cr-merged` milestone itself, and the board refused it (HTTP 409) because the orchestrator was
   still bound to the plan's verify cycle (its `pre-merge-gate --cycle` bound it, and the close
   closed that plan). The envelope still read `ok: true, warnings: []`, emitted before the post was
   made; the refusal appeared only in a trailing human line.
5. **One `--cycle` help line misdescribes its verb.** rust `docker-e2e-gate` opens no gated
   identity, but its `--cycle` help says the gated run leaves its registration and binding intact
   (the wording the gated verbs use) rather than the filing wording `check`/`compile` carry.
6. **A relative project dir breaks a run.** Found during CR-CRU-192. The bun, mvn, python and rust
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

### §S3 — an archived project's analytics are refused

The velocity, burndown, forecast and changes routes refuse an archived project with the archived
404 and its help, as the agent and write routes do, never a computed answer.

### §S4 — `cr-close` reports its own `cr-merged` post

`cr-close` emits its envelope after the `cr-merged` post. When that post fails, the envelope says
so: a warning naming the board's refusal, and `help[]` naming the remedy (re-register unbound,
then `milestone --type cr-merged`). The close itself stays done. A gate's cycle binding is released
when its cycle is marked done, so the close's own post is not refused for it.

### §S5 — every `--cycle` help line describes its own verb

`docker-e2e-gate`'s `--cycle` help uses the filing wording, and a census test checks that each
verb's `--cycle` help matches whether that verb opens a gated identity.

### §S6 — a project dir is absolute from the moment it is resolved

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
- [ ] **Archived analytics are refused.** For an archived project, EACH of the velocity, burndown,
      forecast and changes routes answers 404 with the archived help, never a 200. A live
      project's answers are unchanged.
- [ ] **A failed `cr-merged` post is reported.** Against a live in-process board that refuses the
      `cr-merged` post, `cr-close` closes the CR and prints ONE envelope, carrying a warning naming
      the refusal and `help[]` naming the remedy. After a gate bound the orchestrator to the verify
      cycle and that cycle is marked done, the orchestrator holds no binding and `cr-close`'s own
      `cr-merged` post succeeds.
- [ ] **Help matches the verb.** For EACH client, every verb's `--cycle` help matches whether the
      verb opens a gated identity.
- [ ] **A relative project dir runs.** For EACH of the five clients, a `test` run and a
      `pre-merge-gate` started from the project's parent with a relative `--project-dir`, and again
      with the relative path in the environment variable, file the same pass and fail counts as the
      same run given the absolute path, and no compile failure.
- [ ] **No new CR literals.** No CR-shaped literal is added in `src/`, `public/`, `clients/` or test
      comments, and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: one red-green cycle per section, then verify. Model B hears of §S2 and §S4 in
the 0.4.0 release notes; §S4's released binding makes the close-out's unregister-then-register step
unnecessary, and the notes say so.
