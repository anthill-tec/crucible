# CR-CRU-051 — Propagate the run-envelope `files` count to the other four clients

**Status:** PENDING
**Type:** patch (fleet parity — gate visibility)
**Priority:** P2 — an absent signal, not a wrong one; no client misreports today. Wave 4, i.e.
0.1.0, per the queue's convention (Wave 4 = 0.1.0; only Wave 5 rows carry a 0.2.0 qualifier)
**Depends on:** CR-CRU-047 (§S2 introduced `files` in the bun client), CR-CRU-050 (touches the same envelope builders — land after it to avoid a collision)
**Labels:** patch, client-fleet, gate-correctness, axi-compliance, fleet-parity
**Phase:** Wave 4
**Design reference:** CR-CRU-047 §S2, which added the distinct test-FILE count to the bun run
envelope so *"a shrinking suite is visible in the gate output itself"*. Found 2026-07-28 by a
fleet-drift audit during CR-CRU-050 C2 (user-prompted: which bun changes apply to the other
scripts?).

## Context

### Gap-analysis re-measurement, 2026-08-02 (post CR-CRU-050/054 — the line numbers below are stale)
Re-verified after the fleet DRY refactor: **CR-CRU-054 did NOT absorb this CR.** The orchestrator
predicted it might (the envelope builders were expected to lift), but the JUnit parsers are
GENUINELY PER-CLIENT in the CR-054 inventory — each runner emits a different XML shape — so they
were correctly never lifted. `grep -c '"files"'` today: bun 1, python 0, rust 0, mvn 0,
arduino 0. The parity gap stands exactly as originally specced.

Current parse-site names (CR-054 renamed/moved nothing here, but the surrounding files shrank
~21%, so every line number in the table below is obsolete — locate by symbol):
`bun-crucible.py::_parse_junit_file`, `python-crucible.py::_parse_junit_dir`,
`mvn-crucible.py::_parse_junit`, `arduino-crucible.py::_parse_junit`, and rust's inline
`ET.parse(junit_path)` sites. §S3's "rust has TWO parse sites" claim must be re-verified against
the current file rather than trusted — rust now also has `_ingest_junit_axi`, which delegates
parsing to the SERVER (`codec=junit`), and a server-parsed path has no client-side count to emit.
State that distinction explicitly rather than bolting a count onto a path that does not parse.

### Original context
CR-CRU-047 §S2 was scoped to the bun client because it was chasing a bun-specific gate break. The
`files` count it introduced is not bun-specific — it is a generic gate-integrity signal — and it
never crossed to the rest of the fleet:

| client | run envelope | `files` |
|---|---|---|
| bun `:1504` | `{passed, failed, pending, total, files}` | ✅ |
| python `:392` | `{passed, failed, total}` | ❌ |
| rust `:366` | `{passed, failed, total}` | ❌ |
| mvn `:380` | `{passed, failed, total}` | ❌ |
| arduino `:302` | `{passed, failed, total}` | ❌ |

**Why it matters.** `total` alone cannot distinguish *"fewer tests ran"* from *"the suite stopped
being discovered"*. That distinction is the entire subject of CR-CRU-039, where
`python-crucible.py regression` discovered **0** tests and the run was misreported as a compile
ingest — silently, because nothing in the envelope described collection breadth. `files` is the
second signal: a suite whose file count drops is visibly shrinking even when `total` looks
plausible. The client where that defect actually bit is one of the four still missing it.

This is an ABSENCE, not a misreport — unlike CR-CRU-050, no client states anything false today.
That is why it is filed at P2 rather than as a blocker.

## Scope

### §S1 — Compute the distinct-source count in each client's parser
Follow `bun-crucible.py:_parse_junit_file` (`:440`), which is the reference. Its fallback chain
exists precisely so the count degrades instead of collapsing to zero:

```python
source = tc.get("file") or tc.get("classname") or suite.get("name")
if source:
    files.add(source.replace("\\", "/"))
```

Per format: **surefire** stamps `classname` only (per-CLASS granularity — the format's contract,
not a defect, exactly as CR-CRU-049 §"Non-goals" records for narration); nextest and the arduino
native harness should be checked for a `file` attribute first. **State the resolved granularity
per client** — "files" that is really "classes" must be labelled honestly rather than implying
per-file precision the format cannot give.

🚨 **CORRECTION (measured at C1 GREEN, 2026-08-02): this section's xmlrunner claim was WRONG.**
The spec asserted xmlrunner stamps `classname` and therefore yields per-CLASS granularity. Run
against the version this repo actually uses — `unittest-xml-reporting 4.0.0` — each `<testcase>`
carries **both** `classname` AND a real `file="tests/client/….py"` (plus `line=`). Rung 1 of the
fallback chain therefore hits, and the python client's count is genuinely **per-FILE**. Caught by
the GREEN agent measuring a live run (`files=1` across 4 TestCase classes) instead of trusting
this document, then verifying against the raw XML. Resolved granularity, per client:
- **python** — per-FILE on xmlrunner 4.0.0; degrades to per-CLASS on a runner that omits `file`.
- **mvn** — per-CLASS, genuinely; surefire/failsafe emit no `file`. Java's one-public-class-per-file
  convention usually makes the two coincide, but nested/inner test classes push the count above the
  file count, so "classes" is the accurate word.
- **arduino** — per-FILE when the native g++ harness stamps `file=`, degrading to per-class then
  per-suite; only as precise as the harness that produced the XML.

### §S2 — Surface it in the envelope and the plain count lines
Add `files` to each client's `run:` block alongside `passed`/`failed`/`pending`/`total`, and to the
human-readable count lines CR-CRU-050 §S2 swept. Keep the key name `files` — fleet parity with bun
is the whole point of this CR.

### §S3 — Rust: THREE count sites, only TWO of them parseable (corrected at C2 RED, 2026-08-02)
The original text ("TWO parse sites at `:762` and `:1306`") was directionally right about the two
client-parsed sites but missed a third, and its line numbers are stale. Measured:

| Site | Verb(s) | Classification | Gets `files`? |
|---|---|---|---|
| `_regression_ingest_run` (inline `ET.parse`) | `regression-ingest` | CLIENT-PARSED | ✅ |
| `_workspace_regression_run` (its own separate parse loop — rust has no shared `_parse_junit`) | `workspace-regression` (the pre-merge-gate path) | CLIENT-PARSED | ✅ |
| `_ingest_junit_axi` | `test`, `auto-ingest` | **SERVER-PARSED** (`codec=junit`, `dataPath` — the client never sees a `<testcase>`) | ❌ **never** — a count here would be fabricated, not measured. Pinned by test. |

🚨 **§S2 does not apply to rust as written.** Measured against the current source, rust's two
CLIENT-PARSED sites print a bare `print(f"regression: ok=…")` / `print(f"workspace regression:
ok=…")` and **never go through `_emit_axi`/`_emit_ingest_axi` — they have no TOON `run:` envelope
at all.** The only rust site WITH a `run:` envelope is `_emit_ingest_axi`, i.e. the SERVER-PARSED
one that cannot honestly carry the key. So for rust, §S2 resolves to: **human-count-line only on
the two parsed sites, and a permanent no-`files` pin on the envelope site.** The AC below is
amended accordingly — the alternative would be inventing an envelope (scope growth) or inventing
a number (dishonest).

**Granularity, measured** (`cargo-nextest 0.9.130`, real crate, not assumed): nextest stamps
`classname` on every `<testcase>` and **never** a `file` attribute. `classname` is the test-binary
id (`crate::test-file-stem`), which coincides with per-FILE for the common `tests/*.rs` layout
(one binary per file) but coarsens to **per-BINARY** when several `src/`-embedded unit-test
modules share one lib binary.

## Acceptance criteria
- [ ] python, mvn and arduino compute a distinct-source count and emit `files` in the `run:`
      envelope AND the human count line — asserted per client.
- [ ] rust computes it at BOTH client-parsed sites and emits it in the human count line (it has no
      `run:` envelope on those verbs — §S3); its SERVER-PARSED site emits NO `files` key, pinned by
      a test so a later change cannot fabricate one.
- [ ] The resolved granularity per client (file vs class) is recorded in a comment beside each
      implementation and stated in the CR's Implementation Notes.
- [ ] A report whose testcases carry no `file` attribute still yields a NON-ZERO `files` count via
      the `classname` → suite-name fallback — asserted. Degrading to zero would make a shrinking
      suite look identical to a healthy one, inverting the CR's purpose.
- [ ] `bun-crucible.py` is unchanged (already correct) — confirmed, not assumed.
- [ ] No change to `src/` or `public/`: `files` rides the printed envelope only, never the ingest
      payload (CR-CRU-047 §S2's explicit contract).
- [ ] Full bun regression green AND full Python regression green (client change → both gates, per
      CR-CRU-045 §S3).

## Implementation Notes

**Resolved granularity per client — measured, not assumed.** Two of the four contradicted this
spec's original §S1 text; both were corrected by running the real tooling rather than trusting
the document.

| client | granularity | why, and where it degrades |
|---|---|---|
| **python** | **per-FILE** | `unittest-xml-reporting 4.0.0` stamps BOTH `classname` and a real `file="…"`, so rung 1 of the fallback hits. ⚠️ Version-dependent — on a runner that omits `file` it degrades to per-CLASS. The original spec asserted per-CLASS; that was **wrong for the version this repo runs** and was caught by measuring a live run (`files=1` across 4 TestCase classes). |
| **mvn** | **per-CLASS** | surefire/failsafe emit no `file` attribute at all. Java's one-public-class-per-file convention usually makes class-count and file-count coincide, but nested/inner test classes push the count ABOVE the file count — "classes" is the accurate word. |
| **arduino** | **per-FILE when the harness cooperates** | the native g++ harness may stamp `file=`, which is checked first; otherwise per-class, then per-suite. Only as precise as the XML its harness produces. |
| **rust** | **per-BINARY** | `cargo-nextest 0.9.130` stamps `classname` (the test-binary id) and **never** `file`. Coincides with per-FILE for the common `tests/*.rs` layout (one binary per file) but coarsens when several `src/`-embedded unit-test modules share one lib binary. |

**The three-rung fallback is uniform across all five sites** (`file` → `classname` → suite name),
copied from `bun-crucible.py::_parse_junit_file`. Its purpose is that the count degrades in
precision rather than collapsing to zero: a constant `files: 0` would read as a signal while
conveying nothing, and would make a vanishing suite indistinguishable from a healthy one — the
inverse of this CR's purpose.

**Rust is deliberately asymmetric** (§S3): `files` appears in the human count line at both
client-parsed sites and in NO envelope, because those verbs emit no envelope at all — a gap now
filed as CR-CRU-058. Its third site (`_ingest_junit_axi`) is server-parsed and carries no count by
design; a test pins that absence so a later change cannot fabricate one.

## Non-goals
- Sending `files` to the server or modelling it on `RunEvent`. CR-CRU-047 §S2 deliberately kept it
  in the printed gate output only; this CR propagates that design, it does not revisit it.
- Per-file granularity where the report format only carries per-class (surefire, xmlrunner).
- The narration defect class — that is CR-CRU-049, and it applies only to mvn (bun and mvn are the
  only clients with narrators; python, rust and arduino have none — verified).

## Risk
- Landing this concurrently with CR-CRU-050 would collide — both edit the same envelope builders
  and the same parse loops in all four clients. Sequence after 050 merges.
- The `classname` fallback is what keeps the count meaningful for surefire/xmlrunner. Dropping it
  because "there is no `file` attribute" would emit `files: 0` everywhere, which is worse than
  omitting the key: a constant zero reads as a signal and conveys nothing.
