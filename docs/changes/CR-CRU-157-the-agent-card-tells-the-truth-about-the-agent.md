# CR-CRU-157 — the agent card tells the truth about the agent

**Type** fix · **Points** 13 (planning game 2026-09-27: 5; 8 on 2026-10-03; re-set at gap analysis 2026-10-05) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-09-27; scope extended 2026-10-01 (live runs for every stack, Sandesh #1412)

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

## Gap analysis (2026-10-05)

**Baseline, measured 2026-10-05 20:34–20:35 on develop `54ac978`:** the agent lifecycle, runtime
pane, role, narration, run lifecycle and bun client bun suites, **107/0**; the bun lifecycle,
run-lifecycle and five per-client AXI python suites, **243/0** (both filed project-scoped under
`vidushi`).

**G1 — what each client does today (census of the suite-running verbs, by code reading):**

| Client | START (`/runs/start`) | LIVE (stream while running) | NARRATE (`running N/M`) | FINAL |
|---|---|---|---|---|
| bun | yes (`_start_run`) | yes (`_run_logged`, Popen) | yes (`_Narrator`, per test, 2 s / 10) | **no** |
| python | **no** | **no** (`subprocess.run`, echo after exit) | **no** | **no** |
| mvn | **no** | yes (Popen) | yes (`_Narrator`, per test CLASS) | yes, `finish()`, **after** ingest |
| rust | **no** | **no** (`subprocess.run`) | **no** | **no** |
| arduino | **no** | **no** (`subprocess.run`) | **no** | **no** |

No narration code is shared; the two `_Narrator` classes differ (per test vs per class; mvn's
final message is posted after the ingest, so it overwrites the outcome rather than preceding it).

- **G2 — "a suite-running verb".** The test-tier verbs (test, unit, module, integration,
  regression, e2e, bdd, workspace-regression and the declared-tier verbs) — not `check`/`compile`
  (no tests run) and not the gates (they invoke the tier verbs, which narrate).
- **G3 — how each stack sees a completed test, and its total.** bun: its ✓/✗ lines, total from
  `_prescan_test_total` (a hint). mvn: `[INFO] Running <class>` lines (class-scoped). python:
  unittest prints one line per test only in verbose mode (`-v`); the total is unknown until the
  end. rust: nextest prints its total at the start and one line per test. arduino: Unity prints
  one line per test; the total is unknown until the end. **Where the total is unknown, the
  narration reads `running N` and the final `ran N/N`.**
- **G4 — the message after the run is the server's to write.** The agent's message is only ever
  the client's (`touchAgent` keeps the old message on every ingest and heartbeat), which is why it
  goes stale. The client posts `ingesting…`; the server, which records the ingest or refuses it,
  writes the outcome (`2936 ✓ 0 ✗ · ingested`) or the refusal onto the agent.
- **G5 — idle is derived on the server (F19 card c). Ruling needed (R1).** With no open run, the
  card reads `idle · <role> · <cycle or plan> · last run <outcome>, <age>`, composed by the server
  at read time from the agent's open runs, binding and last event. That folds F19's state 4
  (`2936 ✓ 0 ✗ · ingested`) into state 5′ the moment the run closes.
  **R1 (user, 2026-10-05): the server derives idle and composes the line.**
- **G6 — cost. Ruling needed (R2).** One shared narrator and run-opening path in
  `_crucible_axi.py`, streaming in three clients that capture today (python, rust, arduino, keeping
  their parsed copy byte-identical), a completion recogniser per stack, the start call in four
  clients, the server writing outcome and idle, and the card. That is 13 points, not 8.
  **R2 (user, 2026-10-05): one CR, 13 points.**

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

After the tests finish, the message follows the run: the client posts `ingesting…` while the result
is posted; the server, which records or refuses the ingest, writes the outcome (`2936 ✓ 0 ✗ ·
ingested`) or the refusal onto the agent (G4), which the idle line then carries (§S3).

### §S3 — an idle agent says so (user ruling 2026-09-27)

Between runs, the card says the agent is idle, with its role, its bound cycle or plan, and the last
run's result, instead of repeating the last run's message. The server decides it (R1): an agent with
no open run reads `idle · <role> · <cycle or plan> · last run <outcome or refusal>, <age>`, composed
at read time from its open runs, binding and last event; with an open run, it reads the client's
running message.

## Acceptance criteria

- [x] For each of the five clients, every suite-running verb opens its run with `/runs/start` before the
      suite starts, and the board's `openRuns` holds it until the ingest closes it, asserted on the
      requests made.
- [x] For each of the five clients, the runner's output reaches stderr and `--log` while the suite is
      still running (a line printed before a blocking test is visible before that test ends), asserted
      with a real subprocess and a fake runner.
- [x] For each of the five clients, a run narrates `running N/M` while in flight and ends with
      `ran M/M`, through the one shared narration path.

- [x] A narrated bun run whose last completion falls inside the throttle window still ends with the
      board holding `ran M/M`, asserted on the heartbeats posted.
- [x] Every client that narrates posts the final count through the shared path.
- [x] After the tests finish, the agent's message reads `ingesting…`, then the run's outcome, asserted
      on the board's agent read.
- [x] Between runs, the agent's card shows idle with its role and cycle, in a real browser.
- [x] A run that fails to ingest leaves the refusal on the card, not a stale count.
- [x] The card's states match storyboard **F19** (drawn 2026-09-27, the visual contract), checked in a
      real browser at VERIFY.

## Cycles

C1 shared run path: the narrator, run opening, live streaming and the final count in
`_crucible_axi.py`, with bun and mvn moved onto it (AC1–AC5 for bun and mvn). RED + GREEN.
C2 the three capturing clients: python, rust, arduino on the shared path, each with its completion
recogniser (AC1–AC3, AC5 for those three). RED + GREEN.
C3 server and card: the outcome and refusal written on ingest, idle derived at read time, the card
(AC6–AC8). RED + GREEN.
C4 VERIFY, including F19 in a real browser (AC9).
