# CR-CRU-163 — a project declares which gate steps it never runs

**Type** feature · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-10-01

## Problem

**Request from Sandesh (#1412, 2026-10-01).** no-mistakes' `pr` and `ci` steps opened a GitHub pull
request for a git-flow release branch, which must never happen in a git-flow project. Sandesh now
remembers to pass `gate-run --skip pr,ci` on every call; forgetting it once repeats the mistake.

**Measured 2026-10-01:** `gate-run --skip` is a pure passthrough (`cmd_gate_run` in
`clients/_crucible_axi.py`, CR-CRU-061 §S5); there is no project-level default.

## Scope

### §S1 — a declared default

A project declares the gate steps it never runs in its `crucible.toml` (`[gate] skip = ["pr", "ci"]`).
`gate-run` passes them to no-mistakes on every call. An explicit `--skip` on the command line replaces
the declared list for that call, and the envelope says which list was used and where it came from.

## Acceptance criteria

- [ ] With `[gate] skip = ["pr", "ci"]` declared and no `--skip`, `gate-run` passes `--skip pr,ci`.
- [ ] An explicit `--skip` replaces the declared list, and the envelope names the source.
- [ ] With nothing declared and no `--skip`, the argv carries no `--skip` (today's behaviour).
- [ ] An unknown step name in the declaration is refused with the valid names.
