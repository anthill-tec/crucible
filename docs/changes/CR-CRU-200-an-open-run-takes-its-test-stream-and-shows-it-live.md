# CR-CRU-200 — an open run takes its test stream, and the board keeps it as the run's record

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152, CR-CRU-206, CR-CRU-219, CR-CRU-220, CR-CRU-223 · **Status** PENDING
- **Filed 2026-10-20.** User ruling: live progress is designed after CR-CRU-194 and split from CR-CRU-152. The design is in
  `DN-crucible-live-test-progress.md`.
- **Re-scoped 2026-10-30 at its gap analysis.** User rulings:
  - split by layer: the live view first (CR-CRU-223), then this CR (the board), then the client (CR-CRU-224);
  - a stream's batches persist, and the run is decoded from the stored stream at close;
  - pytest keeps its JUnit record.
- **Gap analysis re-run 2026-10-30 after CR-CRU-223 merged (Rule 20).** It wrote §S1–§S4 and the ACs. User rulings:
  - a stream's batches are deleted once the run is decoded;
  - the live state reaches the screen through throttled `events` frames;
  - a stream's total is bounded by `ingest_body_bytes`, and the frame cadence is a named constant;
  - a streamed run that is aborted keeps the tests it streamed.

The file keeps its first slug.

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

  The board's `crucible-events` codec decodes it into the canonical run, under the same reading rules as JUnit.
- **The stream reaches the open run in batches** that the client sends as written. The board appends each batch at the byte
  offset it states, decodes the lines it completes, and answers how much of the stream it holds.
- **The batches persist** in a new table with a versioned migration, so a board restart loses nothing it acknowledged.
  - At close, the run is decoded from the stored stream, and then the batches are deleted. The decoded run is the record, as it
    is for a JUnit report, whose text the board doesn't keep either.
  - A stream's total size is bounded by `ingest_body_bytes`, the bound one final report body already has.
- **The stream is the record.** No final test report is read for a streamed run.
  - A run whose tests disagree with its `run-end` totals, has no `run-end`, or holds undecodable lines is stored **flagged
    incomplete**, not trusted.
  - Coverage stays a final report, sent at close.
  - A streamed run that is aborted keeps the tests it streamed, flagged incomplete, with its abort reason as today.
- **The live state** that CR-CRU-223 defines (`openRunBrief`'s `live`, `GET /api/v2/runs/<runId>/live`):
  - it is filled from each batch as it arrives;
  - it moves the screen through the existing `events` frame, throttled per run to one frame per `LIVE_FRAME_MS` (2 seconds,
    the cadence the client narrator already posts at) while the run is open;
  - for a streamed run, the agent's row reads the live count in place of the narration.

## Steps

### §S1 — the event shape and the `crucible-events` codec

**The shape.** A stream is UTF-8 text, one JSON object per line, each with an `event` key.

| `event` | Keys | Required |
|---|---|---|
| `run-start` | `total` (integer ≥ 0, the runner's own count) | `event`; `total` optional |
| `test-end` | `id`, `name`, `suite`, `file`, `status` (`pass` \| `fail` \| `pending`), `duration_ms` (number ≥ 0), `failure` (`{message?, type?, trace?}`) | `event`, `name`, `status`; the rest optional |
| `run-end` | `total`, `passed`, `failed`, `pending` (integers ≥ 0), `duration_ms` (number ≥ 0) | `event`, `total`, `passed`, `failed`, `pending` |

Reading rules:
- **Unknown values:** a line whose `event` names no known kind is skipped silently, so the format can grow forward.
- **Undecodable lines:** a line that isn't JSON, or a known event missing a required key or holding a wrong type, is
  undecodable. It is skipped and counted.
- **Blank lines** are ignored.
- **A missing newline:** the last line of a stream without a trailing newline is read at close as a complete line.

**The codec.** `crucible-events` is registered in `src/codecs/index.ts`, beside `junit` and `playwright`. Its `parse(text)`
decodes a whole stream into a `DecodedRun`:
- **Tree:** one `SuiteNode` per distinct `suite`, in first-seen order. A test with no `suite` joins the node `?`, the name JUnit
  gives a blank suite. Each `test-end` becomes one `TestLeaf` in its suite, in stream order.
- **Leaves:** a `TestLeaf`'s `name` is the test's `name`, `?` when blank. Its `status` and `duration_ms` are the test's own,
  `duration_ms` rounded as JUnit rounds it. Its `failure` is cut to JUnit's `MESSAGE_LIMIT` / `TRACE_LIMIT`, with the message
  falling back to the trace's first non-blank line, as JUnit's `toFailure` reads it.
- **Shared rules:** the suite status and the cut limits are JUnit's own, exported from `src/codecs/junit.ts` and called. They
  are never copied.
- **Summary:** counts from the leaves. `duration_ms` is the `run-end`'s when it has one, else the leaves' sum.
- **`files`:** the distinct non-blank `file` values, with `\` read as `/`, else the suite name. This is JUnit's file rule.
- **The completeness check:** `parse` also answers why the stream is incomplete, absent when it is complete. The reasons, in
  this order:
  1. no `run-end`;
  2. `run-end` totals that differ from the leaves' counts (stating both);
  3. N undecodable lines.

  Several apply → all are stated, joined by `; `.

`health`'s `codecs.test` lists `crucible-events`.

### §S2 — the stream route and where the stream is held

**`POST /api/v2/runs/<runId>/stream`** takes `{projectKey, agentId, codec, from, data, final?, …}`.

Caller rules, the same as every ingest:
- the body is read by `readIngestBody`, so a body over `ingest_body_bytes` is a 413;
- `requireProject`: an unknown project is a 404, an archived one is a 404 with its hint;
- `requireRegisteredCaller`: an unregistered caller is refused, and nothing is stored.

Run rules, the same refusals as `resolveRunClose`:
- unknown run, another project's, or another agent's → 400;
- a settled run → 409.

Each refusal states that nothing was stored.

**The batch:**
- **`codec`** must be a stream codec. Today only `crucible-events` is one; any other is a 400. The first batch fixes the run's
  stream codec, and a later batch naming another is a 400.
- **`from`** is the byte offset in the stream at which `data` starts (an integer ≥ 0), and `data` is a string.
  - The board appends only the bytes past what it already holds: a resent batch, with `from` below the held length, appends
    just its new tail.
  - `from` above the held length is a gap. It is answered 409 with `held`, and nothing is appended.
  - A batch that would take the stream past `ingest_body_bytes` in total is answered 413, naming the limit, and nothing is
    appended.
- **The answer:** `200 {ok: true, runId, held}`, `held` being the bytes the board now holds. Byte offsets are counted in
  UTF-8 bytes of `data`.

**The store:**
- **Migration v21** adds a table holding a run's batches. Each row records the run id, its start offset and its text, so
  appending never rewrites earlier rows.
- **Lifetime:** the rows are deleted when the run settles, ended or aborted. They are also deleted wherever the run itself is
  removed: a project's cascade delete removes them, as it removes run-detail rows.
- **The schema** goes from v20 to v21, and `docs/RUNBOOK.md`'s schema figures follow it.

### §S3 — the record at close

**The close is the stream route's last batch.** A batch with `final: true` may carry:
- a last `data` tail;
- `coverage` (`{codec, data}`, as on `POST /api/v2/runs`);
- `raw` (the runner's console);
- `runnerExit`;
- `stack` / `tier`, refused as `resolveRunClose` refuses a changed one.

It closes the run in this order:
1. Append the tail, under §S2's rules.
2. Decode the whole held stream with `crucible-events`.
3. Store it through `Store#recordTestEvent` with codec `crucible-events`, the run's lifecycle stamp, the attach context, the
   role, the release, the coverage (dropped on a failing run, as today) and the raw output (capped by `raw_output_chars`).
4. `endRun`.
5. Delete the batches.

The answer is the one `POST /api/v2/runs` gives: `runResponse`, with `files`, `verdict` and `help`. When the stream is
incomplete, the answer also carries the warning `stream-incomplete`, stating the reason.

**A streamed run that holds no test is refused at close.** That is a 400, the run is left open, and nothing is stored, so a
run that streamed nothing is still settled by the sweep or the client's abort, as today.

**The completeness flag** is stored on the run's event as `incomplete` (the reason text), and is absent on a complete run. Read
back:
- `GET /api/v2/events/<id>` and the event brief carry it;
- the run detail's header states `incomplete — <reason>` in the fail colour.

**A streamed run that is aborted keeps what it streamed.** This applies to the sweep (`agent died` / `abandoned`) and to the
client's `POST /api/v2/runs/<runId>/abort`:
- `Store#abortRun` decodes the held stream when the run holds one;
- the aborted event carries that tree and its counts, with `incomplete` stating the reason, plus `status: "aborted"` and
  `abortReason` as today;
- then the batches are deleted.

An aborted run that streamed nothing is stored exactly as today.

### §S4 — the live state

**The live state is held in its own table** (migration v21, beside the batches):
- one row per open run that has streamed: `completed`, `total?`, `passed`, `failed`, `pending`, `currentFile?`, and the
  trailing partial line not yet decoded;
- its failures in their own rows, in order.

It is deleted when the run settles.

**Each batch fills it.**
- The board decodes only the lines the batch completes, prefixed with the held partial line:
  - a `run-start` sets `total`, with a `total` of 0 stored as none;
  - each `test-end` adds one to `completed` and to its status count, sets `currentFile` to its non-blank `file`, and on `fail`
    appends a failure `{id, name, suite, file, message?, type?}`.
- **Failure fields:**
  - `id` is the test's `id`, else `<suite>::<name>`;
  - `message` is the first line of the failure's message, else of its trace;
  - `type` is the failure's type;
  - each is cut to JUnit's `MESSAGE_LIMIT`.

**The reads:**
- **`Store#runLive(runId)`** answers the open run's `RunLive` (CR-CRU-223 §S1), or `null` when the run holds no live state.
- **`handleRunLive` and `openRunBrief`** stay CR-CRU-223's, unchanged.

**The frames.** A batch that changes the live state emits the store's `events` change for its project, at most once per run
per `LIVE_FRAME_MS`:
- a change inside the window is deferred to the window's end, so the last batch is always shown;
- the run's settling emits as it does today.

`LIVE_FRAME_MS` is one named constant (2000) in `src/store.ts`. It is not a server limit.

**The agent's row.**
- **The agents read:** `GET /api/v2/agents` serves `runningLine` for an agent whose open run holds a live state:
  - `running <completed>/<total> · <currentFile>`;
  - `running <completed> done · <currentFile>` without a total;
  - the file part is absent without one.
- **The row:** `AgentRow` (`public/app.js`) reads `runningLine` before the agent's own `message`. So for a streamed run the row
  shows the board's count, and the client's narration doesn't reach it. The client stops narrating a streamed run in
  CR-CRU-224.

### §S5 — the close-out

- The provenance floors `PROSE_CITATIONS` pins for `src` and `public` (`tests/project-namespace-tripwire.test.ts`) are
  re-measured at the close-out. They are re-recorded once, in their own commit, by exactly the measured delta.
- `tests/health-names-the-codecs-it-decodes.test.ts`'s codec list and `docs/RUNBOOK.md`'s schema figures follow §S1 and §S2.

## Acceptance criteria

- [ ] **AC1 — the codec reads the shape.**
  - `crucible-events` decodes a stream into one `SuiteNode` per suite (first-seen order, blank → `?`), and one `TestLeaf` per
    `test-end` in stream order.
  - Leaf names, statuses, durations and failures are read by JUnit's own exported rules (suite status, `MESSAGE_LIMIT`,
    `TRACE_LIMIT`, the message falling back to the trace's first line).
  - Unknown `event` kinds and blank lines are skipped silently. An undecodable line (not JSON, a missing required key, a wrong
    type) is skipped and counted.
  - A final line with no newline is read.
  - `files` counts distinct files by JUnit's rule.
  - `GET /api/health` lists `crucible-events` under `codecs.test`.
- [ ] **AC2 — the stream equals the JUnit record.** For each fixture in `tests/fixtures/reports/<stack>/`:
  - its tests are re-expressed in the test as a `crucible-events` stream, with suites, names, statuses, durations and failures
    taken from the fixture's JUnit-decoded run;
  - that stream is sent in several batches to an open run and closed;
  - the stored run's summary and tree equal the run `POST /api/v2/runs` stores from the fixture's JUnit report.

  No new fixture file is added.
- [ ] **AC3 — the route takes batches.** Sending a stream in batches to `POST /api/v2/runs/<runId>/stream` answers `held`
  after each one. In addition:
  - a resent batch (with `from` below `held`) appends only its new tail;
  - a gap (`from` above `held`) is a 409 carrying `held`, with nothing appended;
  - a non-stream codec, or a codec differing from the run's first batch, is a 400;
  - a batch taking the stream past `ingest_body_bytes` is a 413 naming the limit, with nothing appended;
  - an unregistered caller, an unknown run, another project's or agent's run, or a settled run is refused as `resolveRunClose`
    refuses it, and the refusal states nothing was stored.
- [ ] **AC4 — the stream survives a restart.** A stream whose batches were acknowledged before the board's store is closed and
  reopened decodes at close to the same run as one sent without a restart.
- [ ] **AC5 — the close.** A `final: true` batch closes the run in one step: it stores one event, codec `crucible-events`,
  decoded from the whole held stream, and the run reads `ended`. The event carries:
  - the coverage sent at close (none on a failing run, as today);
  - the raw output, capped by `raw_output_chars`;
  - the lifecycle stamp, attach context, role and release.

  After the close:
  - the run's batches and live state are deleted;
  - the answer is `POST /api/v2/runs`' answer;
  - a close holding no test is a 400, with the run left open and nothing stored.
- [ ] **AC6 — completeness.** A stream with no `run-end`, with `run-end` totals differing from its tests, or with undecodable
  lines stores a run whose `incomplete` states each reason. That reason is:
  - answered as the `stream-incomplete` warning at close;
  - served on `GET /api/v2/events/<id>` and on the event brief;
  - shown in the run detail's header as `incomplete — <reason>`.

  A complete stream's run carries no `incomplete` key.
- [ ] **AC7 — an aborted streamed run.**
  - A streamed run aborted by `POST /api/v2/runs/<runId>/abort`, or by the sweep (`agent died`, `abandoned`), stores its
    aborted event with the tree and counts decoded from the held stream, `incomplete` stating why, and `status: "aborted"` and
    `abortReason` as today. Its batches and live state are then deleted.
  - A run that streamed nothing is aborted exactly as today, with no tree and no `incomplete`.
- [ ] **AC8 — the live state.** While a streamed run is open:
  - `Store#runLive` answers its counts, `total` (absent for none or 0), `currentFile` and every failure in order, with the
    failure fields as §S4 states;
  - `GET /api/v2/runs/<runId>/live` and the open-run brief's `live` serve them through CR-CRU-223's unchanged
    `handleRunLive` / `openRunBrief`;
  - a test line split across two batches is counted once, when it completes.

  A run that has not streamed answers `null` and 404, as CR-CRU-223 left it.
- [ ] **AC9 — the frames are throttled.** Many batches inside one `LIVE_FRAME_MS` window emit at most one `events` change for
  that run in the window, plus one at the window's end when a batch changed the live state after the last emission. The run's
  settling emits as today. `LIVE_FRAME_MS` is one named constant, and no server limit is added: the server's limits stay five.
- [ ] **AC10 — the agent's row.** For an agent whose open run holds a live state:
  - `GET /api/v2/agents` serves `runningLine` as §S4 states it;
  - `AgentRow` shows it in place of the agent's `message`;
  - an agent with no streamed open run is served no `runningLine` and its row is unchanged.
- [ ] **AC11 — on the page.** One scenario in `tests/e2e/features/run-lifecycle.feature`:
  1. opens a real run with `POST /api/v2/runs/start`;
  2. streams batches to it through the real route, with no `page.route` stub of the live reads;
  3. sees the running card's progress, the live drill-in's failures and the agent's `runningLine` move without a reload;
  4. closes the run with a `final` batch and sees the settled run's card.
- [ ] **AC12 — the schema and the guards.** The store migrates v20 → v21, and `docs/RUNBOOK.md`'s schema figures read v21. A
  project's cascade delete removes its runs' batches and live state. `tests/citations-cite-by-symbol.test.ts` passes, and no
  in-scope file reaches 10,000 lines.
- [ ] **AC13 — the citation floors (close-out).** `PROSE_CITATIONS`' `src` and `public` heads are re-measured and re-recorded
  once, in their own commit, by exactly the measured deltas.

## Non-goals

- **The live view itself** (CR-CRU-223).
- **The client's relay, the python runner's stream and the client's narration switch** (CR-CRU-224).
- **Other streams:** any other stack's stream (CR-CRU-201 to CR-CRU-203; go with CR-CRU-195), a pytest stream, a coverage
  stream, and a native stream codec (`bun-console`, libtest JSON, `test2json`).
- **Keeping a stream after its run is decoded** (user ruling 2026-10-30: the batches are deleted).
- **A configurable frame cadence or a stream-size limit of its own** (user ruling 2026-10-30: `ingest_body_bytes` and the named
  `LIVE_FRAME_MS`).
- **A lighter `live` frame kind** (user ruling 2026-10-30: throttled `events` frames).
