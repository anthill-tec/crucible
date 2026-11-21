# CR-CRU-258 — a gate drive never stalls on the tool's own output

**Status:** COMPLETED — 2026-11-22 · filed 2026-11-15 (found by the 0.4.0 release's own no-mistakes run; user ruling: planned into
0.5.0, so 0.4.0 ships with it) · spec pre-review 2026-11-21 (`test-reports/work/prereview258-report.md`, CHANGES,
F1–F12 folded)
**Type:** fix
**Points:** 2
**Wave:** 9 (0.5.0)
**Depends on:** CR-CRU-255 (its `## [Unreleased]` section and the shared modules' line budgets)
**Labels:** client, gate, release
**Design reference:** `test-reports/work/cr258-gap-analysis.md` (D1–D8, approved 2026-11-15; AC6 supersedes D6/D8's
changelog placement, and D4's headroom premise is stale — see S3); CR-CRU-221 (the core's headroom)

## Problem

`gate-run` and `gate-respond` launch no-mistakes (`axi run`, `axi respond`) with its stdout and stderr on pipes. While
the run is in flight they poll `axi status` and post interim gates, but they read neither pipe until the tool has
exited. A pipe holds 64 KiB. When the tool prints more than that, it blocks on the write and never exits, and the
client never reads, so both wait for ever.

On `release/0.4.0` the run `01M7E2AA` stopped at its review gate with a 65,672-byte snapshot, because a rebase finding
listed 484 commits. The run itself went on to pass, but `bun-crucible.py gate-run` stayed blocked for 63 minutes,
until the pipe was drained by hand. It then reported "`axi run` produced no parseable final snapshot" and sealed
nothing.

Every client shares this drive (`drive_axi_run` in the core), and it has shipped since 0.3.0. Any run whose snapshot
passes 64 KiB, such as a long-lived branch or a review with many or long findings, hangs its caller.

## Behaviour

- **S1 — the tool's output is never left to fill.** A drive launches no-mistakes so that nothing it writes can block
  it.
  - **stdout** goes to a sink with no fixed capacity: an unnamed temporary file (`tempfile.TemporaryFile`). The drive
    reads it once, after the tool has exited, from offset 0. It reads it as text, with the same decoding
    `Popen(text=True)` applies today: the locale encoding, strict errors, and universal newlines.
  - **stderr** goes to `DEVNULL`. Its content is already discarded on every path today.
- **S2 — everything else is unchanged.**
  - These keep working as they do now:
    - the poll loop, its cadence and the ladder dedup;
    - the interim gates and the final seal;
    - the relay of the tool's snapshot to the caller's stdout, once, after exit, verbatim;
    - the held report;
    - the envelope;
    - the SIGINT/SIGTERM trap and the run identity.
  - A final snapshot of any size is decoded and sealed exactly as a small one is now.
  - The sink is closed on every exit, interrupts included.
  - The tool keeps today's process group and session. On an interrupt, the drive never signals, kills or waits for it.
  - One consequence: once the client has exited, an orphaned tool writes into the unlinked file instead of failing
    on a broken pipe.
- **S3 — where it lives.** The launch and the read after exit are one context manager in `_crucible_run.py`, the module
  that owns runner launches. It:
  - launches the tool with stdout to the temporary file and stderr to `DEVNULL`;
  - yields the process and a reader that reads the file once from offset 0;
  - closes the file on every exit.

  `drive_axi_run` uses it. The ladder stream (`stream_axi_ladder`) stays in the core, called between the launch and
  the read, because tests patch it on the core. If launching the tool or creating the sink raises `OSError`, the user
  still gets today's message, ``could not launch `no-mistakes <verb>` ``, and exit 1.

  The move keeps the launches together and frees core headroom. It is no longer forced: the core has 38 lines to
  spare after CR-CRU-255.

## Acceptance criteria

- **AC1 — `gate-run` with a large final snapshot.** `axi run` prints a well-formed final snapshot of at least 256 KiB,
  then exits. `gate-run`:
  - returns on its own within the bound;
  - seals the outcome that snapshot states;
  - relays the snapshot to its stdout verbatim, exactly once;
  - exits 0.
- **AC1b — a held run's large snapshot.** `axi run` prints a held snapshot of at least 256 KiB (a step awaiting
  approval, with no outcome), then exits. `gate-run`:
  - returns within the bound;
  - seals nothing;
  - prints the held report;
  - posts the interim it saw;
  - exits 1.
- **AC2 — `gate-respond` with a large final snapshot.** `axi respond` prints a final snapshot of at least 256 KiB.
  `gate-respond`:
  - records the decision (the envelope's `decision` is an id);
  - seals;
  - exits 0.
- **AC3 — a large stderr does not stall either drive.** The tool writes at least 256 KiB to stderr before a small
  final snapshot. Both drives return and seal as AC1 and AC2 say. None of those stderr bytes appear in the client's
  stderr.
- **AC4 — the existing suites pass unchanged.** These are the suites for gate-run, gate-respond, the skip declaration,
  the interrupts and the run identity, all listed in the pre-review report's AC4 section.
- **AC5 — the budgets.**
  - The core stays at most `CORE_LINE_LIMIT − CORE_HEADROOM_LINES` lines.
  - Every `SHARED_MODULE_LINE_BUDGETS` copy records the core's and the run module's new counts, measured on develop
    after CR-CRU-255.
  - `project-namespace-tripwire.test.ts`'s `PROSE_CITATIONS.clients` count is re-recorded, with its dated note, if
    it moves.
- **AC6 — the changelog.** `CHANGELOG.md`'s `## [Unreleased]` section gains a `### Fixed` entry: `gate-run` and
  `gate-respond` no longer hang when no-mistakes prints more than 64 KiB. This supersedes the gap analysis's D6/D8,
  because the 0.4.0 section has shipped.

The new tests go in `tests/client/integration/test_a_gate_drive_never_stalls_on_the_tools_output.py`. That is
integration tier: they spawn the installed client, through `scrubbed_env` and `drive_verb`, with a fake
`no-mistakes` in a scratch `bin_dir`, and never the real one. One client is enough, because the drive is shared.
Each spawn runs under a 60 s `subprocess` timeout, so on today's code a test fails on that timeout and never hangs the
suite.

## Non-goals

- Relaying no-mistakes' stderr to the caller. Today it is captured and then dropped, and that does not change.
- Changing the poll cadence, the interim throttle or the envelope.
- A hung `axi status`. `poll_axi_snapshot` has no timeout, and that is out of scope.

## Close-out (2026-11-22)

- **AC1, AC1b, AC2, AC3:** `tests/client/integration/test_a_gate_drive_never_stalls_on_the_tools_output.py`. It drives
  the python client against a fake `no-mistakes` that prints at least 256 KiB, and a `RecordingBoard`.
  - **AC1:** a final snapshot is sealed and relayed verbatim, once.
  - **AC1b:** a held snapshot is reported and its interim posted, with no seal.
  - **AC2:** `gate-respond` records the decision and seals.
  - **AC3:** 256 KiB on stderr stalls neither drive and none of it is relayed.
  - All four fail on today's code at the 60 s spawn bound, and pass in about 8 s.
- **Read-back parity:** `tests/client/integration/test_the_gate_drives_sink_reads_back_what_the_pipe_did.py` (from
  VERIFY 994's suggestion).
  - CRLF reads back as the pipe read it.
  - Undecodable bytes raise what the pipe raised.
  - An interrupt closes the sink and leaves the tool running.
- **AC4:** the existing gate-run/gate-respond suites pass unchanged: 498/0 and 64/0.
- **AC5:** the core is 9080 lines, 40 under its headroom line, and `_crucible_run.py` is 2024 lines. All three budget
  copies record both, with a growth note. `PROSE_CITATIONS.clients` is unchanged.
- **AC6:** a `### Fixed` entry under `## [Unreleased]`.
- **The change:** `launched_axi_tool` in `_crucible_run.py`.
  - stdout goes to `tempfile.TemporaryFile` and stderr to `DEVNULL`.
  - The output is read once, after exit, and the sink is closed on every exit.
  - `_drive_axi_run` enters it through an `ExitStack`, which keeps the launch-error message, and the ladder stays in
    the core.
- **Gate:** `pre-merge-gate` cycle 995 ran 5 suites, 14830 passed, 0 failed.
- **Cycles:**
  - 993: RED + GREEN.
  - 994: VERIFY, READY, with four suggestions.
  - 995: FIX, by user ruling — the docstring wording, and the read-back parity module. Sug3 (the read ends at the
    tool's exit) and Sug4 (stderr no longer decoded) were noted only.
