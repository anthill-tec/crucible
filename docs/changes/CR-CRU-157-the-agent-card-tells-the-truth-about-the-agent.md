# CR-CRU-157 — the agent card tells the truth about the agent

**Type** fix · **Points** 8 (planning game 2026-09-27: 5; re-estimated 2026-10-03 for the all-stack §S0) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-09-27; scope extended 2026-10-01 (live runs for every stack, Sandesh #1412). Points are
re-set at its gap analysis

## Problem

**User defect (2026-09-27):** while an agent's tests run, its card in the Project pane shows a
climbing count, but it **never shows the final state**: the count stops one short of the total or
earlier. **At other times the card shows nothing that says what the agent is doing.**

**Found 2026-09-27 (code reading, to be measured at gap analysis):**

- The bun client's in-run narrator (`_Narrator` in `clients/bun-crucible.py`) posts `running N/M`
  as a heartbeat `message`, throttled to at most one post every 2 s or 10 completions. It has **no
  final post**: when the run ends, the last message the board holds is whichever completion last
  passed the throttle. mvn's `_Narrator` (`clients/mvn-crucible.py`) has a `finish()` that bun's
  lacks. Whether python, rust and arduino narrate at all is unmeasured.
- **The python client shows nothing at all while it runs** (Sandesh request #1412, 2026-10-01, folded in
  by user ruling the same day; confirmed in code). `_run_logged` (`clients/python-crucible.py`) runs the
  suite through `subprocess.run` and echoes the captured output only after it exits; the client has no
  `_Narrator` and never calls `POST /api/v2/runs/start`, so the board draws no running card. Sandesh's
  1,786-test, ~4-minute suite looked hung for its whole run.
- Nothing updates the message after the run. The card keeps a stale `running N/M` (or the register
  message, `Starting GREEN phase`) through ingest, idle and the next phase. The row
  (`AgentRow` in `public/app.js`) renders `agent.message` as it stands.

## Scope

### §S0 — every stack's run is visibly alive (Sandesh #1412; all stacks by user ruling 2026-10-01)

Every stack client (bun, python, mvn, rust, arduino), on every verb that runs a suite: opens its run
with `POST /api/v2/runs/start` before the suite starts (so the board shows the running card,
CR-CRU-017), streams the runner's output live to stderr and `--log` as it is produced (any captured
copy a client parses afterwards stays byte-identical), and narrates `running N/M` through ONE shared
narration path in `clients/_crucible_axi.py`, each stack supplying only how it recognises a completed
test in its runner's output. Python is the measured worst case (nothing at all until the end); bun and
mvn already narrate on some verbs. Which verb of which client lacks which of the three is measured at
gap analysis, and the shared path replaces the per-client narrators.

### §S1 — the final count lands

When a narrated run ends, the client posts the final count (`ran M/M`), whatever the throttle last
allowed. Every client that narrates does it through one shared path in `clients/_crucible_axi.py`.

### §S2 — the message follows the run to its end

After the tests finish, the message follows the run: `ingesting…` while the result is posted, then
the outcome (e.g. `2936 ✓ 0 ✗ · ingested`, or the refusal if the ingest failed).

### §S3 — an idle agent says so (user ruling 2026-09-27)

Between runs, the card says the agent is idle, with its role and bound cycle, instead of repeating
the last run's message. Whether "idle" is decided by the server (from the agent's open runs and last
event) or posted by the client is this CR's gap analysis to settle; state-dependent logic belongs on
the server (user ruling 2026-09-26).

## Acceptance criteria

- [ ] For each of the five clients, every suite-running verb opens its run with `/runs/start` before the
      suite starts, and the board's `openRuns` holds it until the ingest closes it, asserted on the
      requests made.
- [ ] For each of the five clients, the runner's output reaches stderr and `--log` while the suite is
      still running (a line printed before a blocking test is visible before that test ends), asserted
      with a real subprocess and a fake runner.
- [ ] For each of the five clients, a run narrates `running N/M` while in flight and ends with
      `ran M/M`, through the one shared narration path.

- [ ] A narrated bun run whose last completion falls inside the throttle window still ends with the
      board holding `ran M/M`, asserted on the heartbeats posted.
- [ ] Every client that narrates posts the final count through the shared path.
- [ ] After the tests finish, the agent's message reads `ingesting…`, then the run's outcome, asserted
      on the board's agent read.
- [ ] Between runs, the agent's card shows idle with its role and cycle, in a real browser.
- [ ] A run that fails to ingest leaves the refusal on the card, not a stale count.
- [ ] The card's states match storyboard **F19** (drawn 2026-09-27, the visual contract), checked in a
      real browser at VERIFY.
