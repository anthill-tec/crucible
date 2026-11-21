# CR-CRU-190 — the 0.4.0 follow-ups list

**Type** fix (patch CR, one list of follow-ups) · **Points** 8 (re-scored at gap analysis
2026-10-19) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-184 · **Status** DONE — merged
2026-10-19; filed 2026-10-14 (user ruling: the open follow-ups are ONE patch CR, not several). Split at gap analysis
2026-10-19 (user ruling): the bun test-name filter moved to CR-CRU-194, the pytest runner to
CR-CRU-197, and the python floor, the rust indent and the gitleaks configuration to CR-CRU-198; the
late-signal follow-up was dropped.

## Problem

Six follow-ups came out of wave 8's work and Model B's mail. Each is small, and the user ruled that
they are worked as one CR.

1. **An agent's badge names its cycle by a board-wide id.** Noticed by the user (2026-10-14). An
   idle agent's row in the project pane shows the server-composed idle line (`src/v2.ts`,
   `idleLine`): `idle · GREEN · cycle 675 · last run …`. That is `agent.boundCycleId`, an id counting
   every cycle ever filed in the project, which says nothing about where the agent is in its CR. The
   roadmap lane already names a plan's active cycle by its place: `cycle 2/5`
   (`roadmapCyclePosition`, `public/app.js`).
2. **No client's help documents where the board address comes from.** Raised by Model B's question
   (Sandesh #1444, answered in #1445). The board a client posts to is `[client] url` in
   `crucible.toml`. It is resolved from the project's file, then the install's, then the shipped one,
   and the FIRST file that exists and parses wins, whether or not it holds a `[client]` table. So a
   project `crucible.toml` with no `[client] url` falls straight through to the shipped
   `http://localhost:3849`, a production board on a machine that runs one. Each client's module
   docstring names `[client] url`, but no `--help` prints it, and the transport's connection error
   (`connection failed: … (is Crucible running at <url>?)`) names neither the key, the order nor the
   fall-through.
3. **An archived project's analytics are answered as if it were live.** Found during CR-CRU-188
   (cycle 675). The four analytics routes (velocity, burndown, forecast, changes) check only that
   the project exists. An archived project's queue reads as empty, while its declaration journal
   does not, so its release burndown answers 200 with `totalPoints: 0`: neither its real total nor
   the archived refusal the agent and write routes give.
4. **`cr-close` hides a failed `cr-merged` post.** Found closing CR-CRU-188: `cr-close` posts the
   `cr-merged` milestone itself, and the board refused it (HTTP 409, a stale binding) because the
   orchestrator was still bound to the plan's verify cycle: its `pre-merge-gate --cycle` bound it,
   and the close-out's unregister-then-register step had been skipped. The envelope, emitted before
   the post was made, still read `ok: true, warnings: []`, and the command exited 0; the refusal
   appeared only in a trailing stderr line.
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

The server composes the idle line of an agent bound to a cycle as
`idle · <role> · <CR> · cycle <n>/<m> · last run <message>, <age>` (or `· seen <age>` for an agent
that never ran), where `<CR>` is the bound cycle's plan's CR, `n` the bound cycle's 1-based place
in its plan's cycle order, whatever that cycle's status, and `m` the plan's cycle count. While the
bound cycle is the plan's active one, `n/m` is the roadmap lane's numbering. A bound cycle whose
plan cannot be resolved reads `cycle #<id>`; an unbound agent still reads `no cycle bound`. The
plan lookup is built once per agents read, not once per agent.

### §S2 — every client's help names the board's configuration

One shared text in the shared client module names:

- the `[client] url` key;
- the resolution order (the project's `crucible.toml`, then the install's, then the shipped one);
- that the first file that exists and parses wins, so a project file without `[client] url` uses
  the shipped address, while a malformed one falls through to the next file.

It is appended to each of the five clients' top-level `--help` description, and the transport's
connection-failure and timeout messages name `[client] url` and the order.

### §S3 — an archived project's analytics are refused

The velocity, burndown, forecast and changes handlers refuse an archived project with `404`,
`error: "project is archived: <key>"` and the archived help, after their existing malformed-key
`400` and unknown-project `404`.

### §S4 — `cr-close` reports its own `cr-merged` post

`cr-close` emits its one envelope after the `cr-merged` post. When the close succeeds but that post
fails (a board refusal or no answer), the envelope reads `ok: false` and the command exits 1. It
carries a `cr-merged-not-recorded` warning whose detail says the CR is closed, its `cr-merged`
marker is not on the board, and the board's error. Its `help[]` names the remedy:
`unregister --agent <id>`, then `register --agent <id> --role ORCHESTRATOR` (no `--cycle`), then
`milestone --type cr-merged --cr <CR> --label <CR> --commit <sha> --agent <id>`. This holds on both
close paths, with and without an accepted failing-gate reason. A post that succeeds leaves the
envelope as it is today.

### §S5 — every `--cycle` help line describes its own verb

Each verb that takes a run's `--cycle` uses the gated wording if and only if running it opens a
gated identity (posts the gated-run identity), and the filing wording otherwise.
`docker-e2e-gate`'s line changes to the filing wording, and any other mismatch the census finds is
fixed the same way.

### §S6 — a project dir is absolute from the moment it is resolved

Every client resolves its project dir, from the flag or the environment variable, to
`os.path.abspath` of it before anything derives from it: the reports dir, the `.env`, the
`crucible.toml` and the runner's cwd.

## Acceptance criteria

- [x] **Badge.** Against a real board, an idle agent bound to the second cycle of a five-cycle plan
      reads `idle · <role> · <CR> · cycle 2/5 · …` in its row (DOM), the same `2/5` the roadmap lane
      shows while that cycle is active, and never the board-wide id. An unbound agent reads
      `no cycle bound`. A unit test of the composer proves `cycle #<id>` for an unresolvable plan.
      The three tests that pin today's idle line are rewritten to the new line, with synthetic CR
      labels in their fixtures.
- [x] **Help names the configuration.** For EACH of the five clients (arduino, bun, mvn, python,
      rust), top-level `--help` contains `[client] url`, the project → install → shipped order and
      the fall-through rule, from the one shared text. The transport's connection-failure and timeout
      messages contain `[client] url`.
- [x] **Archived analytics are refused.** For an archived project, EACH of the velocity, burndown,
      forecast and changes routes answers `404` with `error` `project is archived: <key>` and the
      archived help. A malformed key still answers `400` and an unknown key the unknown-project
      `404`. A live project's answers are unchanged.
- [x] **A refused `cr-merged` post is reported.** Against a real board: an orchestrator bound to a
      plan's last cycle by a gate run, after `cycle-done` and without re-registering, runs
      `cr-close`. The plan is closed; the command prints ONE envelope, `ok: false`, exit 1, carrying
      the `cr-merged-not-recorded` warning (its detail names the board's error) and the three-step
      `help[]` remedy. Running that remedy records the `cr-merged` milestone. The same holds on the
      accepted-failing-gate path. With a clean binding, `cr-close` is `ok: true`, exit 0, as today.
- [x] **Help matches the verb.** For EACH client, every verb that takes a run's `--cycle`
      (`register`'s `--cycle` and `plan-file`'s `--cycle` excluded) carries the gated wording if and
      only if driving it posts the gated-run identity, measured by driving each verb against a
      recording board.
- [x] **A relative project dir is absolute.** For EACH of the five clients, the project-dir
      resolution returns an absolute path, and binds it, for a relative flag and for a relative
      environment value. A real python `test` run and a python `pre-merge-gate` started from the
      project's parent with a relative `--project-dir` file the same pass and fail counts as with the
      absolute path, and no compile failure.
- [x] **No new CR literals.** No CR-shaped literal is added in `src/`, `public/` or `clients/`, the
      citation tripwire's pins are unchanged, and the citations already on rewritten lines are kept.

## Non-goals

- Releasing a cycle binding when its cycle is marked done. The close-out's unregister-then-register
  step stays the way the orchestrator clears its own binding.
- A failing-gate reason on a `cr-merged` marker posted by the remedy; the plan's merge record keeps
  the reason.
- `/next` and the other archived reads (queue, releases, milestones, proposals), which keep their
  answers.
- A busy agent's row, which keeps its run message.
- The test-name filter (CR-CRU-194), the pytest runner (CR-CRU-197), the python floor, the rust
  indent and the gitleaks configuration (CR-CRU-198), and a signal landing after a filed run.

## How it is worked

On a feature branch: one red-green cycle per section, then verify. Model B hears of §S2 and §S4 in
the 0.4.0 release notes.
