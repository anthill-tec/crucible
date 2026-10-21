# CR-CRU-153 — the arduino stack's compile errors are decoded

**Type** feature · **Points** 3 (scored at gap analysis 2026-10-21) · **Wave** 8 (0.4.0) ·
**Depends on** — · **Status** PENDING — filed 2026-09-24

## Problem

**Found by the codec audit the user asked for (2026-09-24).** PRD §4.5: compile ingest uses a
structured parser per format, and unknown input falls back to raw without being rejected. The
compile codecs (`src/codecs/compile.ts`) are `rustc`, `javac`, `python` and `tsc`: one per stack for
rust, maven, python and bun. **There is none for the arduino stack**, whose `arduino-cli compile`
gate (`clients/arduino-crucible.py`) reports GCC/g++ diagnostics.

**Measured at gap analysis (2026-10-21)** on real `arduino-cli` 1.5.1 failures, now checked in under
`tests/fixtures/arduino-cli/` (paths neutralised; see its README). `parseCompile` today:

| Fixture | Real diagnostics | Today |
|---|---|---|
| `avr-uno-warnings-all.txt` | 2 errors, 2 warnings | `raw`, 0 diagnostics, word-scan 3 errors / 2 warnings |
| `renesas-uno-minima-default.txt` (the client's default board) | 2 errors | `raw`, 0 diagnostics, 3 errors |
| `avr-uno-missing-header.txt` | 1 error (`fatal error:`) | `raw`, 0 diagnostics, 2 errors |
| `avr-uno-undefined-reference.txt` | 1 link error | `raw`, 0 diagnostics, 2 errors |

The word-scan miscounts (`Error during build: exit status 1`, `collect2: error:` and the like count
as errors), and the Compile pane shows a raw blob with no file, line or column. The real output also
carries what the filing did not name: `note:` lines with their own excerpts after a diagnostic,
arduino-cli's `Used platform` table and its closing `Error during build: exit status 1`, g++'s
`compilation terminated.`, and the linker's `undefined reference to` lines with a `collect2`
trailer. The arduino client sends no `format` on its compile ingest; the rust, python and bun
clients do.

## Design (settled with the user, 2026-10-21)

- A `note:` belongs to the diagnostic above it, as the `In function …` context and the `^~~~`
  excerpts do: not a diagnostic, not counted.
- A link failure is decoded: each `file:line: undefined reference to …` is an error diagnostic; the
  `collect2: error: ld returned …` trailer is a summary, not a diagnostic.
- The fixtures are real output with neutral paths.

## Scope

### §S1 — a `gcc` compile codec

- **Diagnostics.** A line `file:line:col: (fatal error|error|warning): message` is a diagnostic with
  file, line, column, level (`fatal error` is an `error`) and message. A trailing ` [-W…]` flag is the
  diagnostic's `code`, not part of its message. A line `file:line: undefined reference to …` is an
  `error` diagnostic with file and line (no column) and the message `undefined reference to …`.
- **Not diagnostics.** `In function …` / `In file included from …` context lines, `note:` lines,
  source excerpts and `^~~~` caret lines, `compilation terminated.`, the `collect2: error: ld
  returned …` trailer, an object-file `In function` line, and arduino-cli's `Used platform` table and
  `Error during build: …` line.
- **Counts** come from the diagnostics, as for the other codecs.
- **Detection.** Recognised by content without a hint — a diagnostic line or an `undefined reference
  to` line — checked after the existing four formats, so none of their inputs is re-classified.
  Selectable by hint: `gcc`, `g++`, `arduino`.

### §S2 — the arduino client names its format

The arduino client's compile ingest sends `"format": "gcc"`, as the rust client sends `"rustc"`, so
detection is not left to guess.

## Acceptance criteria

- [ ] **The real failures decode.** Each fixture in `tests/fixtures/arduino-cli/` decodes as `gcc`
      to exactly its diagnostics — `avr-uno-warnings-all.txt`: `valve.cpp` 5:21 error, `pump.ino`
      5:10 error, `pump.ino` 4:7 warning (code `-Wunused-variable`), `pump.ino` 15:13 warning (code
      `-Wparentheses`); `renesas-uno-minima-default.txt`: the two errors; `avr-uno-missing-header.txt`:
      `hdr.ino` 1:10 error `missing.h: No such file or directory`; `avr-uno-undefined-reference.txt`:
      `lnk.ino` line 2 error ``undefined reference to `pumpOn()'`` — with the counts equal to the
      diagnostics. No context, note, excerpt, caret, trailer or table line is a diagnostic.
- [ ] **Detected and hinted.** Each fixture is detected as `gcc` with no hint, and selected by each of
      the hints `gcc`, `g++` and `arduino`.
- [ ] **Nothing else moves.** `detectFormat` never re-classifies the existing rustc, javac, python or
      tsc inputs; every existing compile-codec test passes untouched.
- [ ] **The client names it.** `arduino-crucible.py`'s compile ingest sends `"format": "gcc"`,
      asserted on the request.
- [ ] **Raw stays raw** (regression guard: passes today). Unknown input still falls back to `raw` and
      is never rejected (PRD §4.5).

## Non-goals

- Rendering changes to the Compile pane: it already renders diagnostics with file, line and column.
- Native host test builds (`make junit`) failing to compile: the arduino client ingests no compile
  report for them today.
