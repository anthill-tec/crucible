# CR-CRU-153 — the arduino stack's compile errors are decoded

**Type** feature · **Points** 5 (3 at gap analysis 2026-10-21; raised at its pre-review for the
fallback rule, the newer linker's shape and the no-column render) · **Wave** 8 (0.4.0) ·
**Depends on** — · **Status** DONE — filed 2026-09-24; merged 2026-10-21 (plan 206, cycles 734–738, gate 8047/0)

## Problem

**Found by the codec audit the user asked for (2026-09-24).** PRD §4.5: compile ingest uses a
structured parser per format, and unknown input falls back to raw without being rejected. The
compile codecs (`src/codecs/compile.ts`) are `rustc`, `javac`, `python` and `tsc`: one per stack for
rust, maven, python and bun. **There is none for the arduino stack**, whose `arduino-cli compile`
gate (`clients/arduino-crucible.py`) reports GCC/g++ diagnostics.

**Measured at gap analysis (2026-10-21)** on real `arduino-cli` 1.5.1 failures, checked in under
`tests/fixtures/arduino-cli/` (terminal order, ANSI stripped as the client strips it, paths
neutralised; see its README). `parseCompile` today:

| Fixture | Real diagnostics | Today |
|---|---|---|
| `avr-uno-warnings-all.txt` | 2 errors, 2 warnings | `raw`, 0 diagnostics, word-scan 3 errors / 2 warnings |
| `renesas-uno-minima-default.txt` (the client's default board) | 2 errors | `raw`, 0 diagnostics, 3 errors |
| `avr-uno-missing-header.txt` | 1 error (`fatal error:`) | `raw`, 0 diagnostics, 2 errors |
| `avr-uno-undefined-reference.txt` | 1 link error | `raw`, 0 diagnostics, 2 errors |
| `esp32-undefined-reference.txt` (xtensa gcc 14) | 1 link error, newer linker shape | `raw`, 0 diagnostics |
| `platform-not-installed.txt` | none — no compiler ran | `raw`, word-scan 1 error |

The word-scan miscounts (`Error during build: …`, `collect2: error:` count as errors), and the
Compile pane shows a raw blob with no file, line or column. The real output also carries `note:`
lines with their own excerpts and fix-it lines, arduino-cli's `Used platform` table and its closing
`Error during build: …`, g++'s `compilation terminated.`, and two linker shapes: the older
`file:line: undefined reference to …` and the newer `file:line:(section+off): undefined reference to
…` with object-only lines beside it. On the wire the client sends stdout then stderr, so the
`Used platform` table comes first. The arduino client sends no `format` on its compile ingest; the
rust, python and bun clients do (`rustc`, `python`, `typescript`, all in `HINT_ALIASES`); mvn sends
none.

The Compile pane renders every diagnostic as `file:line:col`, so one without a column reads
`…:2:undefined` — python's already do today.

## Design (settled with the user, 2026-10-21)

- A `note:` belongs to the diagnostic above it, as the `In function …` context and the `^~~~`
  excerpts do: not a diagnostic, not counted.
- A link failure is decoded, in both linker shapes; the `collect2` trailer is a summary.
- A `gcc` report with no error diagnostic falls back to the raw report, so a failed build is never
  shown as clean.
- Any trailing `[-…]` flag is the diagnostic's code. A file never starts with `[` and never contains
  `: `, so other tools' prefixed lines are not read as GCC's; it may contain spaces.
- The Compile pane omits a missing column or line.
- The fixtures are real output with neutral paths.

## Scope

### §S1 — a `gcc` compile codec

- **Compiler diagnostics.** A line `FILE:LINE:COL: (fatal error|error|warning): MESSAGE` is a
  diagnostic with file, line, column, level (`fatal error` is an `error`) and message. A trailing
  ` [-…]` flag (`[-Wunused-variable]`, `[-fpermissive]`, `[-Werror=…]`) is its `code` and not part of
  its message; without one there is no `code` key.
- **Link errors.** `FILE:LINE: undefined reference to …` (older linkers) and
  `FILE:LINE:(SECTION+OFFSET): undefined reference to …` (newer) are `error` diagnostics with file and
  line, no `col` key, and the message `undefined reference to …`. An object-only line
  (`…: OBJECT:(SECTION+OFFSET): undefined reference to …`) is context when the report holds a sourced
  link error; when it holds none, each object-only line is an `error` diagnostic with that message and
  no file or line.
- **FILE** never starts with `[` and never contains `: `; it may contain spaces.
- **Not diagnostics.** `In function …` / `In file included from …` / `from …` context lines (and an
  object file's `In function …` / `in function …` lines), `note:` lines, source excerpts, `^~~~` caret
  lines and fix-it lines, `compilation terminated.`, the `collect2: error: ld returned …` trailer,
  arduino-cli's `Used platform` table and its `Error during build: …` line, and blank lines.
- **Counts** come from the diagnostics. **A `gcc` report with no `error` diagnostic falls back to the
  raw report** (format `raw`, no diagnostics, word-scan counts), hinted or not.
- **Detection.** Without a hint, input holding a compiler-diagnostic line or a sourced link-error line
  (by the shapes above — never the bare phrase `undefined reference`) is `gcc`, checked after the
  existing four formats, so none of their inputs is re-classified. Selectable by hint: `gcc`, `g++`,
  `arduino`.
- **The record.** `src/codecs/compile.ts`' header and PRD §4.4/§4.5 (the codec list, the
  `/api/ingest/compile` format list and the event's `codec` values) name `gcc`.

### §S2 — the arduino client names its format

The arduino client's compile ingest (`_ingest_compile`, which serves `check`, `compile` and
`pre-merge-gate`'s compile step) sends `"format": "gcc"`, as the rust client sends `"rustc"`. It takes
effect for a deployment when its installed client is updated (the release).

### §S3 — the Compile pane shows only what a diagnostic has

A diagnostic renders `file:line:col`, `file:line` or `file` as its fields allow, never `undefined`.

## Acceptance criteria

- [x] **The real failures decode** (hinted `gcc`, and in the client's stdout-then-stderr order — the
      `Used platform` table first). Each fixture decodes to exactly:
      - `avr-uno-warnings-all.txt` — `gcc`, 2 errors / 2 warnings: `/sketch/pump/valve.cpp` 5:21 error
        `'HIGHT' was not declared in this scope`; `/sketch/pump/pump.ino` 5:10 error `'sensr' was not
        declared in this scope`; `/sketch/pump/pump.ino` 4:7 warning `unused variable 'x'` code
        `-Wunused-variable`; `/sketch/pump/pump.ino` 15:13 warning `suggest parentheses around
        assignment used as truth value` code `-Wparentheses`.
      - `renesas-uno-minima-default.txt` — `gcc`, 2 / 0: the two errors above.
      - `avr-uno-missing-header.txt` — `gcc`, 1 / 0: `/sketch/hdr/hdr.ino` 1:10 error
        `missing.h: No such file or directory`.
      - `avr-uno-undefined-reference.txt` — `gcc`, 1 / 0: `/sketch/lnk/lnk.ino` line 2 (no `col`)
        error ``undefined reference to `pumpOn()'``.
      - `esp32-undefined-reference.txt` — `gcc`, 1 / 0: `/sketch/lnk/lnk.ino` line 2 (no `col`) error
        ``undefined reference to `_Z6pumpOnv'``.
      - `platform-not-installed.txt` — `raw`, no diagnostics, word-scan counts.
      No context, note, excerpt, caret, fix-it, trailer, table or build-status line is a diagnostic;
      a diagnostic without a code or column has no such key.
- [x] **Object-only link errors.** An input holding only object-only `undefined reference` lines
      decodes to one error per line with no file or line.
- [x] **Never clean when it failed.** Any `gcc` input with no error diagnostic (warnings only, or
      nothing recognised) falls back to `raw`, hinted or not.
- [x] **Detected and hinted.** Each of the first five fixtures is detected as `gcc` with no hint, and
      selected by each of the hints `gcc`, `g++` and `arduino`.
- [x] **Nothing else moves** (regression guard: passes today). With no hint, the existing rustc,
      javac, python and tsc inputs keep their formats, and these stay `raw`: tsc `--pretty` output
      (`src/a.ts:1:7 - error TS2322: …`), an unhinted rustc link failure (`= note: … main.c:(.text+0x5):
      undefined reference to \`foo'`), a maven-prefixed `[ERROR] /p/A.scala:10:5: error: …` and a cargo
      build-script `warning: x@0.1.0: src/c/a.c:1:1: warning: …`. Every existing compile-codec test
      passes untouched.
- [x] **The client names it.** `arduino-crucible.py`'s compile ingest sends `"format": "gcc"`, asserted
      on the request.
- [x] **The pane.** A compile diagnostic with no column renders `file:line`, one with neither renders
      `file`, and none renders `undefined`.
- [x] **Raw stays raw** (regression guard: passes today). Unknown input still falls back to `raw` and
      is never rejected (PRD §4.5).
- [x] **The record.** The codec header and the PRD's four lists name `gcc`.

## Non-goals

- Native host test builds (`make junit`) failing to compile: the arduino client ingests no compile
  report for them today.
- Updating installed clients outside a release.
- *Recorded at merge:* an unprefixed object-only link line from older binutils
  (`main.o:(.text+0x5): undefined reference to …`) is not decoded — it falls back to `raw`, and an
  arduino build's `collect2` line still counts it as failed; and CRLF input decodes as `raw`, as for
  the other codecs (the client reads text mode, so it never sends CRLF).
