# CR-CRU-270 — a run can be hermetic, behind a tripwire

**Status:** PENDING · filed 2026-11-21 (todo #28; user ruling 2026-11-15: the leak-census tripwire becomes a standing
guard — Crucible's own CI got it in 0.4.0, CR-CRU-263, and a 0.5.0 CR offers it to every project as a client feature;
promised to Model B for 0.5.0 in Sandesh #1621/#1622)
**Type:** feature
**Points:** 8
**Wave:** 9 (0.5.0)
**Depends on:** CR-CRU-267, CR-CRU-268, CR-CRU-269 (the switch set it joins)
**Labels:** client, isolation, tiers
**Design reference:** CR-CRU-263 (`scripts/hermetic/`, the CI tripwire); the prototype in
`test-reports/work/leak-census/` (`board-tripwire.py`, `run-census.sh`, `stamp.py`, `py-runner.py`); the gap analysis
follows this filing

## Problem

A project's tests can depend on the operator's machine without anyone noticing: the running board, `~/.m2`, the
project's own root `crucible.toml` or `.env`, a toolchain cache, the network. The tests pass at the desk and fail
elsewhere, or quietly write to a live service.

In 0.4.0 Crucible found and removed these leaks from its own suites. It ran them in a network namespace, under an
empty `HOME`, with a tripwire on the operator board ports, and now its CI runs that way (CR-CRU-263). No other
project can do the same. The machinery is a script in Crucible's repo, not a client feature, and a leak a project's
run commits never reaches the board.

## Behaviour

- **S1 — one switch on every tier verb.** Every client's tier verbs, `test` and `regression` take the same switch
  for an isolated run. The gap analysis settles its name; it is part of the standard set CR-CRU-267 settles. The run
  then happens:
  - in a clean copy of the project at its committed state;
  - under an empty `HOME` and empty caches, beyond what the project declares it may provision;
  - with no operator configuration;
  - in its own network namespace.
- **S2 — tripwires.** Inside the namespace, listeners stand on the endpoints the project forbids. By default those are
  the operator board's ports, read from the install's configuration. Any connection to one is a hit.
- **S3 — a hit is filed.** Each hit reaches the board as a leak record on the run: the endpoint, and the test that
  made it when the runner names one. A run with a hit is not green.
- **S4 — where it runs.** It is Linux-only:
  - locally through `unshare --map-current-user`;
  - on CI through the runner's privileges, as `scripts/hermetic/` does now.

  Elsewhere the switch is refused before anything runs, naming the reason. It is never silently ignored.
- **S5 — Crucible's own CI moves onto it.** `scripts/hermetic/` is retired in favour of the switch, if the gap
  analysis confirms the switch covers what that script does.

## Acceptance criteria

To be made precise by the gap analysis. At least:

- **AC1** — a scratch project whose test connects to the default operator port, run with the switch, files a red run
  that carries a leak record naming the port and the test.
- **AC2** — the same project's clean tests, run with the switch, file green and leave the operator's `HOME`,
  caches and board untouched.
- **AC3** — where the namespace is unavailable, the switch is refused with an envelope saying why, and nothing runs.
- **AC4** — the switch is accepted by every client's tier verbs, `test` and `regression`, with the same name and
  meaning.
- **AC5** — the RUNBOOK and `CHANGELOG.md`'s `## [Unreleased]` describe the switch, its default tripwires and its
  platform limit.

## Non-goals

- macOS and Windows isolation.
- Network allow-lists beyond the tripwire endpoints, unless the gap analysis needs one for dependency fetches.
- Model B's workflow templates calling the switch. Crucible sends Model B a request for `workflows-src/` once the
  switch is specified (#1621).
