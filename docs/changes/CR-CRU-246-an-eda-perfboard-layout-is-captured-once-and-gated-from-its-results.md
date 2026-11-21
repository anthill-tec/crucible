# CR-CRU-246 — an EDA project's Perfboard Studio layout is captured once and gated from its committed results

**Status:** PENDING · Pre-review: due — 8 points, user rulings, another project's surface
**Type:** feature
**Priority:** high. P1's CR-PFC-010 gates its layout through it.
**Depends on:** CR-CRU-244
**Labels:** clients, eda, packaging
**Phase:** design
**Design reference:** CR-CRU-244 (the `crucible-gate` package and the `crucible-events` stream); CR-CRU-242 (the
interpreter, headless children, verdicts and the gate's suites)

## Context

P1 lays out its board in Perfboard Studio 0.23.0, through the Perfboard Studio MCP server
(`perfboard-studio-mcp`). There is no layout script: the board designer places parts through MCP calls
and commits the `.perf`.

The layout's checks are Perfboard Studio's own tools:

- `run_lvs` (layout versus schematic);
- `run_drc`;
- `run_erc`;
- `check_heights`.

Nothing turns their results into board-visible test results today.

**Two constraints shape the design.**

- **A gate must be reproducible from the committed files.** It cannot depend on a session open on a desk.
- **An agent cannot write a tool's JSON exactly.** An MCP response comes back into the agent's context,
  and copying it to a file means re-typing it.

**Measured on 0.23.0, headless with no Qt import** (`measured-by-mainline.md`):

- `run_lvs` returns `{ok, matches_schematic, matched_nets, schematic_nets, opens, shorts, physical_nets,
  issues[]}`, where a floating conductor is an `issues[]` entry with `kind: "floating-conductor"`.
- `run_drc` returns `{ok, errors, warnings, violations[{rule, severity, message, holes, conductor_ids}]}`.
- `run_erc` returns `{ok, errors, warnings, findings[]}`.
- `check_heights` returns `{height_limit_mm, tallest_mm, tallest_ref, over_limit[], parts[],
  unknown_footprints}`, with no pass/fail field of its own.
- `ok: true` means only that the call ran.

## Scope

- **One capture command writes the results; the gate only reads them.**
  - The capture is a step an agent runs: the board designer (GREEN) and FIX run it after any layout
    change, and commit the results with the change.
  - The ingest is a gate entry. RED declares it.
  - VERIFY only re-ingests, and never re-captures.
- **The capture runs the MCP itself.** It starts `perfboard-studio-mcp` over stdio, headless, with the
  `mcp` SDK that `perfboard-studio[mcp]` installs in the project venv. It writes each tool's response
  verbatim. The capture is the only writer of committed results, and agents never re-type a tool's JSON.
- **The results are committed beside the `.perf`,** so a gate on a clean checkout has them.
- **The ingest runs no MCP client.** It reads the result files and emits one `crucible-events` check per
  rule, through CR-CRU-244's package.
- **Freshness is strict on a declared entry.**
  - A result whose document hash differs from the committed `.perf` fails.
  - A missing results dir, or a missing file among the four, also fails.
  - Each failure names the capture command. A declared layout that was never captured can run; it is
    undone, not unrunnable, so it is never SKIP.
- **Design work is not this CR's.** The agents use the Perfboard MCP's tools interactively, as Model B's
  stack text says. Project-specific checks stay in the project's own gate scripts, for example P1's stock
  board, refs placed, bus-wire power nets and the 14 mm keep-out zone.
- **No board field is added.** The verdicts and counts live in each check's result and failure message.

### §S1 — the result file

- **Path:** `<results dir>/<tool>.json`, where `<tool>` is one of `open_document`, `run_lvs`, `run_drc`,
  `run_erc` and `check_heights`.
- **Shape:** a JSON object with these keys:
  - `format`: `"crucible-perfboard-result/1"`;
  - `tool`;
  - `arguments`: the call's arguments, for example `{"path": …}` or the height limit;
  - `perfboard_studio_version`: from the server's `open_document` status;
  - `document`: the `.perf`, relative to the project dir;
  - `document_sha256`: the hex digest of the `.perf`'s bytes, read once before the calls;
  - `captured_at`: ISO-8601 UTC;
  - `captured_by`: `--agent`, or `$CRUCIBLE_AGENT_ID`, or `null`;
  - `result`: the tool's response, verbatim.
- **Formatting:** the file is written with sorted keys and a trailing newline, so a re-capture of an
  unchanged board differs only in `captured_at` and `captured_by`.

### §S2 — the capture command

`python -m crucible_gate.perfboard capture <document> <results dir> [--height-limit-mm N] [--agent ID]`
runs in the project venv. In order, it:

1. hashes `<document>`. A missing or unreadable file exits 2, naming it;
2. starts `perfboard-studio-mcp` (resolved beside the venv interpreter, then on `PATH`) over stdio. Its
   environment is headless: `QT_QPA_PLATFORM=offscreen`, with `DISPLAY` and `WAYLAND_DISPLAY` removed;
3. calls `open_document(path)`. A response with `ok` not true exits 3, naming its message, and writes
   no file;
4. calls `run_lvs`, `run_drc` and `run_erc`, then `check_heights` with the height limit when one is
   given;
5. writes all five files. It writes to a temporary directory, then replaces `<results dir>`, so a
   failed capture never leaves a mixed set;
6. prints one line per tool, then the results dir, and exits 0.

**What makes it exit non-zero:**

- an MCP SDK that cannot be imported: exit 4, naming `pip install 'perfboard-studio[mcp]'`;
- a server that cannot start, or a tool call that errors: exit 5, naming the tool.

### §S3 — the declaration

- **The entry:** `[targets."<tier>"]` or `[targets."<tier>/<label>"]`, with `framework =
  "eda-perfboard"`. It holds:
  - `document`: a `.perf` path relative to the project dir, which is required and must exist;
  - `results`: a directory path relative to the project dir, which is required (it may not exist yet);
  - `height_limit_mm`: an optional positive number, per board.
- **Refused:** a missing `document` or `results`, a non-positive `height_limit_mm`, and any `junit`,
  `console`, `coverage` or `script` field. Each is refused with `DeclarationRefused`, naming the table and
  the field.
- **The schema:** `eda-perfboard` joins `stacks.eda`'s frameworks and `reserved_frameworks.eda`, and the
  schema's `version` goes up by one.
- **The other stacks:** `eda-perfboard` joins the other-stack skip sets (rust, arduino and maven), as
  `eda-gate` does in CR-CRU-244.

### §S4 — the ingest and its checks

For an `eda-perfboard` entry, the client runs `<interpreter> -m crucible_gate.perfboard ingest
--document <document> --results <results> [--height-limit-mm N]` through CR-CRU-244 §S4's run path:

- the version check;
- the stream codec check;
- one run under the entry's tier, with framework `eda-perfboard`;
- `CRUCIBLE_STREAM` set;
- a headless child.

The ingest reads the four check files and emits these checks, in this order:

| Check | Source | Passes when | The failure names |
|---|---|---|---|
| `lvs-matches-schematic` | `run_lvs` | `matches_schematic` is true | `matched_nets`/`schematic_nets`, and the first 10 `issues[]` |
| `lvs-no-opens` | `run_lvs` | `opens == 0` | the count, and the open `issues[]` |
| `lvs-no-shorts` | `run_lvs` | `shorts == 0` | the count, and the short `issues[]` |
| `lvs-no-floating-copper` | `run_lvs` | no `issues[].kind == "floating-conductor"` | each floating conductor |
| `drc-no-errors` | `run_drc` | `errors == 0` | each error violation's rule, message and holes |
| `erc-no-errors` | `run_erc` | `errors == 0` | each error finding |
| `heights-under-limit` | `check_heights` | `over_limit` is empty, and `tallest_mm` ≤ the declared `height_limit_mm` when one is declared | each over-limit ref and its height |

**DRC warnings** never fail. They are listed in `drc-no-errors`' detail on a pass, and in its steps.

**Freshness is checked before any check**, and each fault fails every check that reads the file:

- **No results dir:** every check fails with "no captured results; run `python -m crucible_gate.perfboard
  capture <document> <results>`".
- **A missing `<tool>.json`:** the checks that read it fail, naming the file and the same command.
- **A `document_sha256` that differs from the committed `.perf`:** that file's checks fail with "stale:
  captured for sha256 `<captured>`, the document is `<current>`; re-capture with …".
- **A `format` other than `crucible-perfboard-result/1`,** or a file that does not parse: that file's
  checks fail, naming the file.
- **A `height_limit_mm` that differs** from the one in `check_heights`' `arguments`: `heights-under-limit`
  fails, naming both values.

A declared entry never yields SKIP. The ingest's exit and envelope follow CR-CRU-244: `verdict`, `skipped[]`
and the `tier-skipped` warning, as CR-CRU-242 §S5 defines them.

### §S5 — tiers, `regression` and the gate

- **The tier verbs, `--entry` and the gate's per-entry suites** take `eda-perfboard` entries as they take
  the other eda frameworks. Each entry is one run and one gate row.
- **`regression`** files one run per `eda-perfboard` entry under `regression`, alongside CR-CRU-244's runs.
- **Nothing in this CR captures.** No verb of the client runs the capture.

## Acceptance criteria

The fixture is the upstream example `ne555-astable.perf` (0.23.0), committed under the test fixtures,
with its five result files captured once by the capture command, plus a stub `perfboard-studio-mcp`
where a test needs one.

- [ ] **AC1 — capture writes five exact files.**
  - **Setup:** a stub server on `PATH` answers each tool with a fixed JSON.
  - `capture <fixture.perf> <dir> --height-limit-mm 21.6 --agent A` writes five files.
  - Each file's `result` equals the stub's response, byte-for-byte after JSON load.
  - `document_sha256` equals the fixture's digest.
  - `arguments` of `check_heights` holds 21.6.
  - `captured_by` is `A`.
  - The stub records the call order `open_document`, `run_lvs`, `run_drc`, `run_erc`, `check_heights`.
- [ ] **AC2 — capture is headless and all-or-nothing.**
  - The stub records its environment: `QT_QPA_PLATFORM=offscreen`, with no `DISPLAY` and no
    `WAYLAND_DISPLAY`.
  - With `run_drc` made to error, the exit is 5, it names `run_drc`, and an earlier results dir is left
    unchanged.
  - With `open_document` returning `ok: false`, the exit is 3 and no file is written.
  - Without the `mcp` package, the exit is 4, naming the install command.
- [ ] **AC3 — the real server.** Against the installed `perfboard-studio-mcp` 0.23.0, where present and
  otherwise skipped with that reason, capture on the fixture gives `matches_schematic: true`,
  `opens: 0` and `shorts: 0`, and the process opens no window (the headless environment of AC2).
- [ ] **AC4 — a clean board passes every check.** `module --agent <id>` on `[targets."module/layout"]`
  over the fixture and its committed results:
  - opens one run under `module` with framework `eda-perfboard`;
  - files 7 checks, all passing;
  - exits 0 with `verdict: pass`;
  - lists `drc-no-errors`' warning in the detail (the fixture has one).
- [ ] **AC5 — each check fails on its own fault.** For each check, a results copy is edited to break only
  that check. For example: `matches_schematic: false`; `opens: 2`; `shorts: 1`; an issue of kind
  `floating-conductor`; DRC `errors: 1`; ERC `errors: 1`; an `over_limit` entry or `tallest_mm` above the
  declared limit. For each copy:
  - that check alone fails;
  - its message names the offender of §S4;
  - the run's `verdict` is `fail`, with exit 1.
- [ ] **AC6 — stale and missing results fail, never SKIP.**
  - A one-byte change to the `.perf` fails all 7 checks, as stale, naming both digests and the capture
    command.
  - Deleting the results dir fails all 7, naming the command.
  - Deleting `run_drc.json` fails only `drc-no-errors`.
  - A wrong `format`, and a file that does not parse, fail that file's checks.
  - A declared limit of 20 against a captured limit of 21.6 fails `heights-under-limit`, naming both.
  - In none of these is a test `pending`.
- [ ] **AC7 — the declaration.**
  - Each refusal of §S3 is refused before anything is posted, naming the table and the field.
  - The schema lists `eda-perfboard` under `stacks.eda`, and its version is up by one.
  - The rust, arduino and maven readers skip an `eda-perfboard` entry.
- [ ] **AC8 — tiers, `regression` and the gate.**
  - With `module/layout` and CR-CRU-244's `module/board-check` declared, `module` opens two runs.
  - `regression` files one run per entry.
  - `pre-merge-gate` has one row per entry, each with `client: eda-crucible.py`.
  - A stale result fails only the `module/layout` row.
- [ ] **AC9 — no MCP in the ingest.** On the fixture, the ingest runs with no `perfboard-studio-mcp`
  reachable and no `mcp` package importable, and passes. An AST check of the ingest's code path finds no
  import of `mcp` and no spawn of a server.
- [ ] **AC10 — docs and invariants.**
  - The README, RUNBOOK and CHANGELOG `[Unreleased]` name the capture command, who runs it (GREEN and
    FIX, never VERIFY), the result format, the entry, the 7 checks, and that a declared entry with
    missing or stale results fails.
  - `_crucible_axi.py` and `_crucible_run.py` keep their pinned sizes.
  - The code and tests carry no CR id literal.

## Estimated size

8 points. The new parts are:

- the capture command, with its MCP client, headless spawn and atomic write;
- the result format;
- the ingest's 7 checks and its freshness rules;
- one declaration framework.

The run, the stream, the version check, the tiers and the gate come from CR-CRU-242 and CR-CRU-244.

## Risk

- **The 0.23.0 result shapes may change upstream.** The ingest reads only the keys above, and a missing
  key fails its check, naming the key. `perfboard_studio_version` in each file shows what a capture ran.
- **The stdio server's start-up time.** A capture is an agent step, not a gate step, so it does not slow
  the gate.

## Non-goals

- A standard keep-out-zone check (P1 keeps its 14 mm zone as a project check).
- A live or attach mode against an open Perfboard Studio session.
- KiCad (CR-CRU-248).
- Capturing from any client verb.
- Rendering (`render_*` tools).
- Any new board field.
