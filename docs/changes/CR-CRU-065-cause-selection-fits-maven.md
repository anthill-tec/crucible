# CR-CRU-065 — The no-report cause is selected by "last non-empty line", which fits python and node but not maven

**Status:** PENDING
**Type:** patch (AXI-compliance — envelope fidelity)
**Priority:** P2 — proposed for **0.2.0**. The mvn envelope is CORRECT today (right code, right exit code, a true line); it is merely UNINFORMATIVE, so this is fidelity work, not a shipping defect. Release membership is the user's to confirm.
**Depends on:** CR-CRU-064 (shipped the shared helper and its drift guard — this changes that contract additively)
**Labels:** patch, client-fleet, axi-compliance, maven, envelope-fidelity
**Design reference:** CR-CRU-030 §S1 (one TOON-AXI document per verb, `warnings[]` carries the machine-readable cause) and CR-CRU-064 §S1 (the `no_report_help` / `no_report_warning` pair this CR extends). The limit was measured and recorded in CR-CRU-064's Implementation notes, C3 section.

## Context

`no_report_warning(verb, artifact, exit_code, output)` (`clients/_crucible_axi.py`) composes its
`detail` from the **last non-empty line** of the captured runner output. CR-CRU-064 chose that rule
because it is exactly right for two of the three capture-bearing stacks:

| Stack | Tail of a starved capture | Last-line rule |
|---|---|---|
| python | `ModuleNotFoundError: No module named 'xmlrunner'` | ✅ the cause IS the last line |
| bun / node | `Cannot find module 'node:nonexistent'` | ✅ same |
| maven | `[ERROR] -> [Help 1]` / `[ERROR] Re-run Maven using the -X switch…` | ❌ boilerplate |

Maven inverts the shape. Its actionable line — `[ERROR] /path/Foo.java:[12,5] cannot find symbol` —
appears ABOVE its own continuation lines (`symbol:`, `location:`), and the stream then ends in
several lines of Maven epilogue. So mvn's `detail` currently carries a line that is true and useless.
This surfaced inside CR-CRU-064 C3, when that cycle's own fixture asserted on `cannot find symbol`
and could not reach it through the last-line rule.

CR-CRU-064 deliberately did not fix it: changing the selection rule in the shared helper is a
cross-fleet behaviour change to a drift-guarded function used by all seven no-report sites plus rust
and mvn, and it would have invalidated that CR's own committed C1 tests. It is recorded there as a
future CR, which is this one.

## Scope

### §S1 — Selection becomes overridable; composition stays shared

`no_report_warning` gains ONE additive keyword argument:

```python
def no_report_warning(verb, artifact, exit_code, output, cause=None) -> dict
```

- `cause=None` (every existing caller) → **behaviour is byte-identical to today**: the last non-empty
  line of `output`, bounded keeping ITS tail. CR-CRU-064's C1 tests must pass unchanged, untouched.
- `cause="…"` → the caller has already selected the informative fragment using knowledge only that
  stack has. The helper still owns everything that made it shared: the untruncated prefix (verb +
  artifact + exit code), the 500-character bound, and the never-empty guarantee.
- **Bounding direction differs by origin, and this is deliberate:** a helper-derived last line is
  bounded keeping its TAIL (the cause sits at the end of a python/node stream); a caller-supplied
  `cause` is bounded keeping its HEAD, because the caller ordered it by importance — truncating a
  maven `cannot find symbol` + `symbol:` + `location:` fragment from the front would discard the
  very line the override existed to surface.

Why an override rather than a smarter shared rule: a heuristic that recognises maven's shape inside
the shared helper would be per-stack knowledge living in the one place that must stay stack-agnostic,
and every future stack would push another branch into it. The composition invariant is universal; the
selection is not.

### §S2 — mvn selects its own cause

`clients/mvn-crucible.py` gains a small pure selector and passes its result as `cause`:

- Prefer the FIRST `[ERROR]` line that names a source location (`[ERROR] <path>:[line,col] <message>`),
  followed by its immediate continuation lines while they are indented or begin `symbol:` /
  `location:` / `required:` / `found:`.
- Cap the fragment at 3 lines joined by ` · ` so a 200-error build cannot flood a bounded field.
- Ignore Maven's epilogue explicitly: lines matching `-> \[Help \d\]`, `Re-run Maven`, `For more
  information about the errors`, `BUILD FAILURE`, and bare `[ERROR]` separators are never a cause.
- No location-bearing `[ERROR]` line present (e.g. a plugin failure, not a compile failure) → return
  `None` and let the shared last-line rule stand. The fallback must never be a crash or an empty
  string.

`_emit_compile_fallback_axi` is the only call site that changes.

### §S3 — The guard extends, it does not fork

`tests/client/test_cr054_drift_guard.py` already asserts the `no-test-reports` literal and the
no-report help prose live only in `clients/_crucible_axi.py`. That stays true: this CR adds a
SELECTOR to mvn, not a warning or a help builder. Add one assertion that no client re-implements the
composition (`exit_code`/bounding/joining) — the selector may live in a client; the envelope prose
may not.

## Acceptance criteria

1. `no_report_warning(verb, artifact, exit_code, output)` called with FOUR arguments returns a dict
   byte-identical to CR-CRU-064's behaviour, and every C1 test in
   `tests/client/test_crucible_axi_shared.py` passes with its assertions unmodified.
2. `no_report_warning(..., cause="X")` produces a `detail` containing `X` and NOT the last non-empty
   line of `output` when the two differ.
3. A caller-supplied `cause` longer than the remaining room is truncated keeping its HEAD: given a
   600-character `cause` beginning `cannot find symbol`, `detail` contains `cannot find symbol`,
   `len(detail) <= 500`, and the fragment's final characters are absent.
4. A helper-derived cause longer than the remaining room is still truncated keeping its TAIL (the
   CR-CRU-064 behaviour), proven by the existing 5,009-character fixture.
5. mvn's selector, driven with a real captured maven failure whose tail is `[ERROR] -> [Help 1]`,
   yields a `detail` containing `cannot find symbol` and NOT `[Help 1]`.
6. The selector joins at most 3 lines with ` · `, and returns `None` for a capture holding no
   location-bearing `[ERROR]` line — in which case the emitted `detail` equals what CR-CRU-064 would
   have produced.
7. `grep -rn '"no-test-reports"' clients/` still matches only `clients/_crucible_axi.py`, and the
   drift guard fails if any client re-implements the prefix/bounding composition.
8. Both gates green before close-out (CR-CRU-045 §S3: these are Python clients whose observable
   contract is asserted by bun tests) — the Python suite AND the bun suite.

## Estimated size

Small. One keyword argument, one pure selector, one call site, three test additions. Two cycles: C1
the helper argument + bounding-direction split, C2 mvn's selector + the drift-guard extension, then
VERIFY.

## Risk

- **The override is a door to per-stack drift.** If a second client starts passing `cause`, the fleet
  regains the divergence CR-CRU-064 removed. §S3's assertion is the guard: selection may be local,
  composition may not.
- **Head-vs-tail truncation is easy to get backwards**, and getting it backwards silently discards
  the cause. ACs 3 and 4 assert both directions explicitly.
- **A maven fixture is easy to fake.** The selector must be driven with a REAL captured maven
  failure shape (surefire/javac epilogue included), not a hand-trimmed two-line string.

## Non-goals

- No change to the seven python/bun/arduino sites — their last-line rule is correct for their
  streams and stays untouched.
- No change to rust: its `cargo`/`nextest` diagnostics also terminate their streams.
- No change to the `no-test-reports` code, the help prose, the exit codes, or `no_report_help`.
