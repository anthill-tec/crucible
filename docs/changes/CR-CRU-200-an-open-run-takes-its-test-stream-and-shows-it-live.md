# CR-CRU-200 — an open run takes its test stream, and the board keeps it as the run's record

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152, CR-CRU-206, CR-CRU-219, CR-CRU-220, CR-CRU-223 · **Status** PENDING
- **Filed 2026-10-20.** User ruling: live progress is designed after CR-CRU-194 and split from CR-CRU-152. The design is in
  `DN-crucible-live-test-progress.md`.
- **Re-scoped 2026-10-30 at its gap analysis.** User rulings:
  - split by layer: the live view first (CR-CRU-223), then this CR (the board), then the client (CR-CRU-224);
  - a stream's batches persist, and the run is decoded from the stored stream at close;
  - pytest keeps its JUnit record.
- **Gap analysis re-run 2026-10-30 after CR-CRU-223 merged (Rule 20).** It wrote §S1–§S5 and the ACs. User rulings:
  - a stream's batches are deleted once the run is decoded;
  - the live state reaches the screen through throttled `events` frames;
  - a stream's total is bounded by `ingest_body_bytes`, and the frame cadence is a named constant;
  - a streamed run that is aborted keeps the tests it streamed;
  - the analysis's own choices P1–P5 are approved (the user's Lavish approval of the design).

The file keeps its first slug.

**Pre-review: ran** — the CR scores 13 points, and its gap analysis needed rulings from the user.
- The pre-review was `CR-CRU-200-SPEC-REVIEW`, on 2026-10-30. F1–F11 and its smaller findings are folded in.
- **P1, P2, P3 and P5 are folded in their pre-review form:**
  - **P1:** the close is a `POST /api/v2/runs` ingest that decodes the held stream, reusing that route's whole pipeline (F7).
  - **P2:** a close with no test is filed when the runner exited non-zero.
  - **P3:** the agent's line is composed in the browser from the open run's `live` (F1).
  - **P5:** a failure's fallback id carries the test's ordinal.
- **P4 stands as written.**

## Problem

A run's live progress is a count, not data.
- **What exists today:** while a run works, each client counts the console lines that match one stack-specific pattern. It sends
  `running N/M · <file>` as an agent heartbeat.
- **What the board misses:** it learns no test name, status or failure until the final report arrives. A runner the pattern
  doesn't know narrates nothing.

`DN-crucible-live-test-progress.md` settles the answer:
1. the runner writes a structured event stream;
2. the client relays it to the run it opened;
3. the board decodes it as it arrives and keeps it as the run's record.

This CR is the board's part:
- the route the stream reaches, and where it is held until the run closes;
- the codec that reads it;
- the record made from it at close;
- the live state CR-CRU-223 shows.

## Design (user rulings 2026-10-20 and 2026-10-30)

- **One Crucible event shape**, newline-delimited JSON:
  - a `run-start` event, carrying the runner's total when it has one;
  - a `test-end` event per test;
  - a `run-end` event carrying the runner's own totals.

  The board's `crucible-events` codec decodes it into the canonical run, through JUnit's own reading rules.
- **The stream reaches the open run in batches** that the client sends as written. The board appends each batch at the byte
  offset it states, decodes the lines it completes, and answers how much of the stream it holds.
- **The batches persist** in a new table with a versioned migration, so a board restart loses nothing it acknowledged.
  - At close, the run is decoded from the stored stream, and then the batches are deleted. The decoded run is the record, as it
    is for a JUnit report, whose text the board doesn't keep either.
  - A stream's total size is bounded by `ingest_body_bytes`, the bound one final report body already has.
- **The stream is the record.** No final test report is read for a streamed run.
  - The run closes through the ingest it closes with today, `POST /api/v2/runs` with its `runId`, naming `crucible-events` and
    sending no report.
  - A run whose tests disagree with its `run-end` totals, has no `run-end`, holds undecodable lines or was cut at the size
    bound is stored **flagged incomplete**, not trusted.
  - Coverage stays a final report, sent at close.
  - A streamed run that is aborted keeps the tests it streamed, flagged incomplete, with its abort reason as today.
- **The live state** that CR-CRU-223 defines (`openRunBrief`'s `live`, `GET /api/v2/runs/<runId>/live`):
  - it is filled from each batch as it arrives;
  - it moves the screen through the existing `events` frame, throttled per project to one frame per `LIVE_FRAME_MS` (2
    seconds, the cadence the client narrator already posts at) while a streamed run is open;
  - for a streamed run, the agent's row reads the live count in place of the narration.

## Steps

### §S1 — the event shape and the `crucible-events` codec

**The shape.** A stream is UTF-8 text, one JSON object per line, each with an `event` key.

| `event` | Keys | Required |
|---|---|---|
| `run-start` | `total` (integer ≥ 0, the runner's own count) | `event`; `total` optional |
| `test-end` | `id`, `name`, `suite`, `file`, `status` (`pass` \| `fail` \| `pending`), `duration_ms` (number ≥ 0), `failure` (`{message?, type?, trace?}`) | `event`, `name`, `status`; the rest optional |
| `run-end` | `total`, `passed`, `failed`, `pending` (integers ≥ 0), `duration_ms` (number ≥ 0) | `event`, `total`, `passed`, `failed`, `pending` |

**Reading rules:**
- **Line handling:**
  - A line whose `event` names no known kind is skipped silently, so the format can grow forward.
  - A line that isn't JSON, or a known event missing a required key or holding a wrong type, is **undecodable**: it is skipped
    and counted.
  - Blank lines are ignored.
  - The last line of a stream without a trailing newline is read at close as a complete line.
- **Order and repetition:**
  - The last `run-start` sets the total.
  - The last `run-end` gives the totals.
  - Each `test-end` is one test, including a repeated `id`. A runner that retries emits one `test-end` per test.
  - A `test-end` after a `run-end` is counted, and flags the stream incomplete.
- **Suites:** one `SuiteNode` per distinct `suite`, in first-seen order. A stream has no element boundary to keep two runs of
  one suite apart. A test with no `suite` joins the node `?`, the name JUnit gives a blank suite.

**The shared reading.** `src/codecs/junit.ts` exports two helpers, and both its own `toFailure` / `toNode` and
`crucible-events` call them:
- `failureOf({message?, type?, trace?})`: the message cut to `MESSAGE_LIMIT`, falling back to the trace's first non-blank line;
  the trace cut to `TRACE_LIMIT`;
- `suiteStatus(children)`: `fail` when a child failed, else `pass`.

A leaf's `name` is the test's `name`, `?` when blank. Its `duration_ms` is rounded as JUnit rounds it. `files` are the distinct
non-blank `file` values, with `\` read as `/`, else the suite name. This is JUnit's `fileOf` rule.

**The codec.**
- **Registration:** `crucible-events` is registered in `src/codecs/index.ts`, with a new `Codec.stream: true` marking it a
  stream codec.
- **`parse(text)`:** synchronous. It answers the `DecodedRun` plus `incomplete`, the reasons the stream can't be trusted.
  `incomplete` is absent when there are none. The reasons, in this order, joined by `; `:
  1. no `run-end`;
  2. `run-end` totals that differ from the leaves' counts (stating both);
  3. a test after `run-end`;
  4. N undecodable lines;
  5. cut at `ingest_body_bytes`.
- **Summary:** counts from the leaves. `duration_ms` is the `run-end`'s when it has one, else the leaves' sum.
- **Single-shot use is refused.** A stream codec can't be sent as a report: `POST /api/v2/runs` with a stream codec and `data`
  or `dataPath` is a 400 (see §S3).

`health`'s `codecs.test` lists `crucible-events`.

### §S2 — the stream route and where the stream is held

**`POST /api/v2/runs/<runId>/stream`** takes `{projectKey, agentId, codec, from, data}`.

**Caller rules,** the same as every ingest:
- the body is read by `readIngestBody`, so a body over `ingest_body_bytes` is a 413;
- `requireProject`: an unknown project is a 404, an archived one is a 404 with its hint;
- `requireRegisteredCaller`: an unregistered caller is refused.

**Run rules,** the same refusals as `resolveRunClose`:
- unknown run, another project's or another agent's → 400;
- a settled run → 409, carrying `state` and `eventId`.

**Shape rules:**
- `from` that isn't a non-negative integer → 400;
- `data` that isn't a string, or holds a lone surrogate → 400;
- `codec` not a stream codec, or differing from the stream codec the run's first batch fixed → 400.

Every refusal states that nothing was stored.

**The batch** is one synchronous SQLite transaction, which re-reads the run's open state inside it, as `abortOpenRun` does:
- **Overlap.** Byte offsets are counted in UTF-8 bytes. A batch whose `from` is below the held length must match the held bytes
  across the overlap; it then appends only the bytes past them. An overlap that differs → 409 with `held`, with nothing
  appended.
- **A gap:** `from` above the held length → 409 with `held`, with nothing appended.
- **The size bound:** a batch taking the stream past `ingest_body_bytes` in total → 413, naming the limit and carrying `held`,
  with nothing appended. The run records that its stream was cut, and its record says so (§S1, reason 5).
- **What a batch writes:** the appended bytes; the live state's update (§S4); and a quiet touch of the agent's `lastSeen`,
  which emits no `agents` frame. A streaming agent therefore stays live without heartbeats, and a batch moves no agents slice.
- **The answer:** `200 {ok: true, runId, held}`.

**The store:**
- **Migration v21** adds:
  - a table of a run's batches: run id, start offset, text, so appending never rewrites earlier rows;
  - the live-state tables (§S4).
- **Lifetime:** both are deleted inside `endRun` and `abortRun`, so every place a run settles deletes them. These are the
  `/runs`, `/runs/parsed` and `/runs/compile` closes, the abort route and the sweep. They are also deleted by a project's
  cascade delete.
- **The schema** goes from v20 to v21, and `docs/RUNBOOK.md`'s schema figures follow it.

### §S3 — the record at close

**The close is `POST /api/v2/runs`, with `runId`, `codec: "crucible-events"` and no `data` or `dataPath`.** The route runs its
whole pipeline unchanged:
`refuseBadStack` → `refuseBadRunnerExit` → `resolveRunRelease` → `resolveIngestAttach` / `refuseIngest` →
`resolveRunClose` → `fileRunnerExit` → the hints.
- The report it decodes is the run's held stream, in place of a body report. `coverage` and `raw` are read from the body as
  today.
- The decode, `recordTestEvent`, `endRun` and the deletion of the batches and the live state are one synchronous transaction,
  which re-reads the run's open state inside it. A racing batch, abort or sweep therefore either lands before it or is refused
  after it, and exactly one event is written.
- The answer is `runResponse`, with `files`, `verdict` and `help`. When the stream is incomplete, it also carries the warning
  `stream-incomplete`, stating the reason.

**Refusals and edge cases at the close:**
- **A stream codec with no held stream:** `codec: "crucible-events"` on a run holding no stream → 400.
- **A body report with a stream codec:** `data` / `dataPath` with a stream codec → 400. In both cases nothing is stored and the
  run stays open.
- **A streamed run closed another way:** a run holding a `crucible-events` stream, closed by `/runs` naming another codec, or
  by `/runs/parsed`, or by `/runs/compile` → 400 ("this run streams its record; close it with codec `crucible-events`"). Nothing
  is stored and the run stays open.
- **No test held:**
  - with a `runnerExit` above 0, the close is filed red, as `fileRunnerExit` files today, and flagged incomplete;
  - with the exit 0 or absent → 400, the run left open for the sweep or the client's abort.
- **A resent close:** a close arriving after the run settled gets the existing 409, which now also carries `state` and
  `eventId`, so a client can tell its own lost answer from a refusal.

**The completeness flag** is stored on the run's event as `incomplete` (the reason text), and is absent on a complete run.
- `GET /api/v2/events/<id>` and the event brief carry it.
- The run detail's header states `incomplete — <reason>` in the fail colour, beside an aborted run's abort banner.

**A streamed run that is aborted keeps what it streamed.** This applies to the sweep (`agent died` / `abandoned`) and to the
client's `POST /api/v2/runs/<runId>/abort`:
- `Store#abortRun` decodes the held stream with the `crucible-events` codec, a new runtime import into `src/store.ts`;
- its aborted event carries that tree and its counts, with `incomplete` stating the reason, plus `status: "aborted"` and
  `abortReason` as today;
- the batches and live state are deleted in the same transaction.

An aborted run that streamed nothing is stored exactly as today.

**An aborted run's counts are not a verdict.** Today an aborted event carries no counts. Now that one can, its readers skip
`status: "aborted"`:
- `pairTransitions` and the inferred cycle status in `public/app-logic.mjs`: an aborted run opens no RED streak and closes none,
  and it marks no cycle done;
- `Store#foldIntoRollup`: an aborted run folds into no rollup or trend.

### §S4 — the live state

**The tables (migration v21).**
- One live-state row per open run that has streamed: `completed`, `total?`, `passed`, `failed`, `pending`, `currentFile?`, the
  byte offset up to which lines are decoded, the undecodable count, and whether the stream was cut.
- Its failures in their own rows, in order.

The partial line is never rewritten: it stays in the batch rows and is read back from that offset on the next batch.

**Each batch fills it**, inside its transaction, decoding only the lines the batch completes:
- a `run-start` sets `total`, and a `total` of 0 is stored as none;
- each `test-end` adds one to `completed` and to its status count, and sets `currentFile` to its non-blank `file`;
- on `fail`, it appends a failure `{id, name, suite, file, message?, type?}`:
  - `id`: the test's `id`, else `<suite>::<name>#<n>`, `n` being the test's 1-based ordinal in the stream;
  - `suite` and `file`: `?` when blank;
  - `message`: the first line of `failureOf`'s message, and `type` the failure's type.

**The reads:**
- **`Store#runLive(runId)`** answers the open run's `RunLive` (CR-CRU-223 §S1), or `null` when the run holds no live state.
- **`handleRunLive` and `openRunBrief`** stay CR-CRU-223's, unchanged.

**The frames.** A batch that changes the live state emits the store's `events` change for its project, at most once per project
per `LIVE_FRAME_MS`:
- a change inside the window is deferred to the window's end, so the last batch is always shown;
- the deferred timer is `unref`'d, and is cleared when its project's last streamed run settles and by a new
  `Store#dispose()`;
- a frame deferred across a board restart is lost by design, since a reconnecting page re-reads everything;
- the run's settling emits as it does today.

`LIVE_FRAME_MS` is one named constant (2000) in `src/store.ts`. It is not a server limit. The Store takes an optional scheduler
(the clock and the timer) so a test can drive the window without real waits. That option is a test seam, not configuration.

**The agent's row.** `AgentRow` (`public/app.js`) composes the agent's line in the browser from `state.openRuns`. That slice is
already moved by `events` frames and already served by CR-CRU-223.
- **Which run:** the newest open run of that agent carrying `live`.
- **The line:** it reads `running <completed>/<total> · <currentFile>`, or `running <completed> done · <currentFile>` without a
  total, with the file part absent without one.
- **No live run:** without such a run, the row reads the agent's `message` as today.
- **No server field is added.** The client stops narrating a streamed run in CR-CRU-224.

### §S5 — the record of the design, and the close-out

- **The PRD, `docs/research/PRD-crucible-v2.md`:**
  - §4.13 records `LIVE_FRAME_MS` as the one cadence compiled into source (user ruling), and records `ingest_body_bytes` as also
    bounding a stream's total;
  - §4.4 and §3.3 name the `crucible-events` codec, the stream route and the close that decodes the held stream.
- **`ingest_body_bytes`' description** in `src/crucible.toml` and in `docs/RUNBOOK.md`'s limits table states that it bounds
  one request body and a stream's total.
- **The DN** names Playwright's steps in the live state as CR-CRU-201's, and states that a stream which only feeds the view
  (`bun-console`, maven's console) is CR-CRU-201's and CR-CRU-203's to define.
- **The guards that follow §S1 and §S2:** `tests/health-names-the-codecs-it-decodes.test.ts`'s codec list and
  `docs/RUNBOOK.md`'s schema figures.
- **The citation floors:** the `PROSE_CITATIONS` pins for `src` and `public` (`tests/project-namespace-tripwire.test.ts`) are
  re-measured at the close-out. They are re-recorded once, in their own commit, by exactly the measured delta.

## Acceptance criteria

- [ ] **AC1 — the codec reads the shape.** `crucible-events` is registered with `stream: true` and decodes a stream as §S1
  states:
  - one `SuiteNode` per distinct suite in first-seen order (blank → `?`), one leaf per `test-end` in stream order, a repeated
    `id` counted each time;
  - the last `run-start` / `run-end` wins, and a `test-end` after `run-end` is counted and flagged;
  - unknown kinds and blank lines are skipped, undecodable lines are counted, and a final line with no newline is read;
  - `files` follow JUnit's file rule.

  The failure and suite-status rules are JUnit's `failureOf` and `suiteStatus`: they are exported from `src/codecs/junit.ts`,
  called by `toFailure` / `toNode`, and imported by the codec, which a source check asserts. `GET /api/health` lists
  `crucible-events` under `codecs.test`.
- [ ] **AC2 — the stream equals the JUnit record.** For each fixture in `tests/fixtures/reports/<stack>/`:
  - its tests are re-expressed in the test as a `crucible-events` stream, from the fixture's JUnit-decoded run;
  - the stream is sent in several batches, one of them splitting a line and one a multibyte character, and closed;
  - the stored run's summary and tree equal what `POST /api/v2/runs` stores from the fixture's JUnit report.

  No new fixture file is added.
- [ ] **AC3 — the route takes batches.** Batches to `POST /api/v2/runs/<runId>/stream` answer `held`. The route also behaves as
  follows:
  - **Resends:** a resend whose overlap matches appends only its tail; an overlap that differs, or a gap, is a 409 with `held`
    and appends nothing.
  - **Codecs:** a non-stream codec, or one differing from the run's first, is a 400.
  - **Size:** a batch past `ingest_body_bytes` in total is a 413 naming the limit and carrying `held`; a body over it is a 413.
  - **Shape:** a malformed `from` or `data` (a negative or fractional `from`, a missing `data`, a lone surrogate) is a 400.
  - **Callers and runs:** an unknown or archived project is a 404; an unregistered caller, an unknown run, or another project's
    or agent's run is refused as `resolveRunClose` refuses it; a settled run is a 409 carrying `state` and `eventId`.

  Every refusal states that nothing was stored.
- [ ] **AC4 — the stream survives a restart.** A stream whose batches were acknowledged through one Store is closed through a
  second Store opened on the same database file. It decodes to the same run as one sent through a single Store, and the live
  state read through the second Store equals the first's.
- [ ] **AC5 — the close.** `POST /api/v2/runs` with `runId`, `codec: "crucible-events"` and no report stores one event, decoded
  from the whole held stream, and the run reads `ended`. The event carries the coverage sent at close (none on a failing run),
  the raw output (capped by `raw_output_chars`), and the lifecycle stamp, attach context, role and release. Further cases:
  - a `runnerExit` above 0 over a green stream is filed red;
  - a changed `stack` or `tier` is a 400;
  - a bound agent whose cycle went terminal is answered as `/runs` answers it today.

  After the close, the batches and live state are gone. Each refusal below stores nothing and leaves the run open:
  - a stream codec with `data` / `dataPath` → 400;
  - a stream codec on a run holding no stream → 400;
  - a run holding a stream closed by another codec, by `/runs/parsed` or by `/runs/compile` → 400.

  A close with no test held is filed red and flagged when `runnerExit` > 0, and is a 400 otherwise. A close resent after the
  run settled is a 409 carrying `state` and `eventId`.
- [ ] **AC6 — completeness.** A stream with no `run-end`, with `run-end` totals differing from its tests, with a test after
  `run-end`, with undecodable lines, or cut at `ingest_body_bytes` stores a run whose `incomplete` states each reason. That
  reason is:
  - answered as the `stream-incomplete` warning at close;
  - served on `GET /api/v2/events/<id>` and the event brief;
  - shown in the run detail's header as `incomplete — <reason>`.

  A complete stream's run carries no `incomplete` key.
- [ ] **AC7 — an aborted streamed run.** A streamed run aborted by `POST /api/v2/runs/<runId>/abort`, or by the sweep (`agent
  died`, `abandoned`), stores its aborted event with:
  - the tree and counts decoded from the held stream;
  - `incomplete` stating why;
  - `status: "aborted"` and `abortReason` as today.

  Its batches and live state are deleted. A run that streamed nothing is aborted exactly as today. An aborted streamed run
  with failures, and one with only passes, each open or close no transition in `pairTransitions`, mark no inferred cycle done,
  and fold into no rollup (`foldIntoRollup`).
- [ ] **AC8 — the live state.** While a streamed run is open:
  - `Store#runLive` answers its counts, `total` (absent for none or 0), `currentFile` and every failure in order, with §S4's
    fields (the `#<n>` fallback id, `?` for a blank suite or file);
  - `GET /api/v2/runs/<runId>/live` and the open-run brief's `live` serve them through CR-CRU-223's unchanged readers;
  - a test line split across two batches is counted once, when it completes.

  A run that has not streamed answers `null` and 404, as CR-CRU-223 left it.
- [ ] **AC9 — the batch is atomic and keeps the agent live.**
  - A batch racing a close or an abort is refused after it, or lands before it, and exactly one event is written. That
    includes the sweep against a close.
  - An agent that only streams, for longer than its tombstone window, is not swept.
  - A batch emits no `agents` frame.
- [ ] **AC10 — the frames are throttled.** Driven through the Store's scheduler seam:
  - many batches across a project's streamed runs inside one `LIVE_FRAME_MS` window emit at most one `events` change for that
    project in the window, plus one at the window's end when a batch changed a live state after the last emission;
  - a run's settling emits as today;
  - `Store#dispose()` clears a pending timer, so no frame fires after it.

  `LIVE_FRAME_MS` is one named constant, and the server's limits stay five.
- [ ] **AC11 — the agent's row.** For an agent whose newest open run carries `live`, `AgentRow` reads §S4's `running …` line.
  Without one, the row reads the agent's `message` as today. The agents read gains no field.
- [ ] **AC12 — on the page.** One scenario in `tests/e2e/features/run-lifecycle.feature`:
  1. opens a real run with `POST /api/v2/runs/start`;
  2. streams batches to it through the real route, with no `page.route` stub of the live reads;
  3. sees the running card's progress, the live drill-in's failures and the agent's `running …` line move without a reload;
  4. closes the run through `POST /api/v2/runs` and sees the settled run's card.
- [ ] **AC13 — the schema, the design record and the guards.**
  - The store migrates v20 → v21, and a project's cascade delete removes its runs' batches and live state.
  - `docs/RUNBOOK.md`'s schema figures read v21, and its limits table, `src/crucible.toml` and PRD §4.13 state
    `ingest_body_bytes`' stream bound.
  - PRD §4.13 records `LIVE_FRAME_MS`, and PRD §4.4 / §3.3 name the codec, the stream route and the close.
  - The DN names Playwright's live steps and the view-only streams as CR-CRU-201's and CR-CRU-203's.
  - `tests/docs-runbook-documents-every-limit.test.ts` and `tests/citations-cite-by-symbol.test.ts` pass, and no in-scope file
    reaches 10,000 lines.
- [ ] **AC14 — the citation floors (close-out).** `PROSE_CITATIONS`' `src` and `public` heads are re-measured and re-recorded
  once, in their own commit, by exactly the measured deltas.

## Non-goals

- **The live view itself** (CR-CRU-223).
- **The client's relay, the python runner's stream and the client's narration switch** (CR-CRU-224).
- **Other streams:**
  - any other stack's stream (CR-CRU-201 to CR-CRU-203; go with CR-CRU-195);
  - a pytest stream and a coverage stream;
  - a view-only console stream and its codecs (`bun-console`, maven's console);
  - libtest JSON and `test2json`;
  - Playwright's steps in the live state (CR-CRU-201).
- **Keeping a stream after its run is decoded** (user ruling 2026-10-30: the batches are deleted).
- **A configurable frame cadence or a stream-size limit of its own** (user ruling 2026-10-30: `ingest_body_bytes` and the named
  `LIVE_FRAME_MS`).
- **A lighter `live` frame kind** (user ruling 2026-10-30: throttled `events` frames).
- **An `incomplete` badge on the timeline card;** the run detail's header carries it.
