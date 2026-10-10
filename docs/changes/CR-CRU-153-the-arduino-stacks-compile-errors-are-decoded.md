# CR-CRU-153 — the arduino stack's compile errors are decoded

**Type** feature · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-09-24

## Problem

**Found by the codec audit the user asked for (2026-09-24).** PRD §4.5: compile ingest uses a
structured parser per format, and unknown input falls back to raw without being rejected. The
compile codecs (`src/codecs/compile.ts`) are `rustc`, `javac`, `python` and `tsc`: one per stack for
rust, maven, python and bun. **There is none for the arduino stack**, whose `arduino-cli compile`
gate (`clients/arduino-crucible.py`) reports GCC/g++ diagnostics:

```
/path/src/pump.cpp:42:5: error: 'sensr' was not declared in this scope
/path/src/pump.cpp:57:12: warning: unused variable 'x' [-Wunused-variable]
```

**Measured 2026-09-24** by running `parseCompile` on exactly that sample: format **`raw`**,
**0 diagnostics**. The counts come from a fallback word-scan, so the Compile pane shows a raw blob
with no file, no line and no column for the arduino stack.

## Scope

### §S1 — a `gcc` compile codec

GCC-style `file:line:col: error|warning: message` lines, including g++'s `In function …` context
lines and the `^~~~` caret excerpts, which belong to the diagnostic above them and are not
diagnostics of their own. Detected by content and selectable by hint (`gcc`, `g++`, `arduino`).

### §S2 — the arduino client names its format

The arduino client's compile ingest sends the format hint, as the rust client does (`"format":
"rustc"`), so detection is not left to guess.

## Acceptance criteria

- [ ] A real `arduino-cli compile` failure, checked in as a fixture, decodes to diagnostics with file,
      line, column, level and message. Context and caret lines are not counted as diagnostics.
- [ ] `detectFormat` recognises GCC output without a hint and never re-classifies the existing
      rustc, javac, python or tsc fixtures. Every existing compile-codec test passes untouched.
- [ ] `arduino-crucible.py`'s compile ingest sends the `gcc` hint, asserted on the request.
- [ ] Unknown input still falls back to `raw` and is never rejected (PRD §4.5).
