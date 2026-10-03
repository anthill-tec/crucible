# CR-CRU-163 — a project declares which gate steps it never runs

**Type** feature · **Points** 3 (planning game 2026-10-03: 2; re-set at gap analysis 2026-10-03) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-10-01

## Problem

**Request from Sandesh (#1412, 2026-10-01).** no-mistakes' `pr` and `ci` steps opened a GitHub pull
request for a git-flow release branch, which must never happen in a git-flow project. Sandesh now
remembers to pass `gate-run --skip pr,ci` on every call; forgetting it once repeats the mistake.

**Measured 2026-10-01:** `gate-run --skip` is a pure passthrough (`cmd_gate_run` in
`clients/_crucible_axi.py`, CR-CRU-061 §S5); there is no project-level default.

## Gap analysis (2026-10-03)

**Baseline, measured 2026-10-03 14:20–14:21 on develop `1d58f1c`:** the gate-run, `--skip`
passthrough, ladder/seal, configuration-chain, envelope-census and arduino AXI python suites, 10
files, **275/0** (filed project-scoped under `vidushi`).

- **G1 — no existing mechanism covers this.** no-mistakes v1.84.0 takes `--skip` on `axi run` only;
  its repo config has no skip key (only `step_quiet_warning`). Crucible's own config chain is the
  natural home.
- **G2 — the chain already exists; reuse it, one walk.** `_read_project_config(table)` resolves the
  PROJECT's `crucible.toml`, then the INSTALL's, at the point of use, and `[client] url` is read
  through it (`resolve_base_url`). `[gate] skip` is read through the same walk, never a second resolver.
  The shipped `clients/crucible.toml` declares no skip (today's behaviour) and documents the
  `[gate]` table in its own comment style.
- **G3 — one place, five clients.** All five clients' `gate-run` delegate to the shared
  `cmd_gate_run`, so the change is made once; parity is asserted, not re-implemented.
- **G4 — clearing the list.** "An explicit `--skip` replaces the declared list" needs a way to skip
  nothing on one call: `--skip ""` sends no `--skip` token.
- **G5 — the step names are no-mistakes', not Crucible's (changes AC4).** Crucible holds no step
  vocabulary, and CR-CRU-061 §S5 ruled `--skip` a pure passthrough, never validated. A vocabulary
  copied into the client would drift with every no-mistakes release (v1.84.0's steps are rebase,
  review, test, document, lint, push, pr, ci). The no-mistakes binary carries an `unknown step %q`
  refusal, so name validation stays with no-mistakes and its refusal is relayed. Crucible refuses
  only a malformed declaration (not a list of non-empty strings, or an entry containing a comma),
  naming the file.
- **G6 — the envelope.** `gate_run_result_fields` gains `skip` (the list passed, or none) and
  `skipSource` (`flag`, `declared` with the file's path, or `none`), on both the sealed and the
  unsealed exit. `tests/client/test_client_fleet_envelope_census.py` pins envelope fields and
  follows.
- **Cost.** 3 points, not 2: the shape refusal, the envelope fields on both exits, the census
  update and the five-client parity test. No server or UI change.

## Scope

### §S1 — a declared default

A project declares the gate steps it never runs in its `crucible.toml` (`[gate] skip = ["pr", "ci"]`),
read through the same project → install chain as `[client] url` (G2). `gate-run` passes them to
no-mistakes on every call. An explicit `--skip` on the command line replaces the declared list for
that call, and `--skip ""` skips nothing (G4). The envelope says which list was used and where it
came from (G6). Step names pass through unvalidated, and a refusal by no-mistakes is relayed (G5).

## Acceptance criteria

- [ ] **AC1** — With `[gate] skip = ["pr", "ci"]` in the project's file and no `--skip`, `gate-run`
      passes `--skip pr,ci`; with it only in the install's file, the same.
- [ ] **AC2** — An explicit `--skip` replaces the declared list, and `--skip ""` passes no `--skip`.
- [ ] **AC3** — With nothing declared and no `--skip`, the argv carries no `--skip` (today's
      behaviour).
- [ ] **AC4** — The envelope carries `skip` and `skipSource` (`flag`, `declared` with its path, or
      `none`) on both the sealed and the unsealed exit.
- [ ] **AC5** — A malformed declaration (not a list of non-empty strings, or an entry containing a
      comma) is refused before no-mistakes is launched, naming the file; step names are not
      validated by Crucible.
- [ ] **AC6** — All five clients' `gate-run` show the same behaviour (parity asserted).
