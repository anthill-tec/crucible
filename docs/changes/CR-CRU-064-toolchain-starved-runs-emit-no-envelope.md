# CR-CRU-064 — A toolchain-starved run emits no envelope: seven no-report fallbacks return an exit code and nothing machine-readable

**Status:** PENDING
**Type:** patch (AXI-compliance — fleet parity)
**Priority:** P0 — **0.1.0 release prerequisite (user-decided 2026-08-14): this ships BEFORE the release, not after it.** Two of the seven sites are the `pre-merge-gate` regression body (bun) and the gate's python twin, so an orchestrator whose toolchain is incomplete gets an exit code with EMPTY stdout at a merge decision point — and 0.1.0 is the release that puts these clients in users' hands, where a missing toolchain is the NORMAL first-run state, not an edge case.
**Depends on:** CR-CRU-030 (established the fleet-wide TOON-AXI contract), CR-CRU-054 (the shared module these sites must join), CR-CRU-058 (envelope parity + state-derived `help[]` — the same defect class, one branch deeper), CR-CRU-063 (measured the failure and recorded both follow-ups)
**Labels:** patch, client-fleet, axi-compliance, gate-correctness, test-determinism
**Design reference:** CR-CRU-030 §S1 — one TOON-AXI document per verb invocation on stdout; CR-CRU-058 §S1/§S2 — the run-produced-no-report envelope + state-derived `help[]`, whose rust/mvn implementations are the reference this CR generalises. The AXI manifesto's structured-output principle (https://axi.md) is the contract being violated.

## Context

CR-CRU-063 fixed CI provisioning and, in doing so, measured what a client does when its toolchain is
absent: **exit 1 with completely empty stdout.** `python-crucible.py:442` builds every
`test` / `regression` / `pre-merge-gate` run as `<python> -m xmlrunner …`; on an interpreter without
`unittest-xml-reporting` the child dies with `No module named 'xmlrunner'`, no `TEST-*.xml` is
written, and the client takes a no-report fallback that ingests the capture as a compile failure and
prints to **stderr only**. Five `test-python` failures on run 31726344668 shared that one signature.
The consumer of that stdout is an agent, and it receives nothing it can parse.

**Measured on `develop` `f7f826d` for this filing — the defect is wider than CR-CRU-063 recorded
(it named three sites; there are seven), and it is NOT uniform across the fleet:**

| Client | Site | Today |
|---|---|---|
| python | `cmd_test` `:682-685` | `_ingest_compile(…, tier="unit")` → `return result.returncode or 1` |
| python | `_regression_run` `:761-765` | stderr line + `_ingest_compile(…, tier="regression")` → return |
| python | `cmd_auto_ingest` `:787-790` | `no TEST-*.xml in <dir> — nothing to ingest` on stderr → `return 1` |
| bun | `cmd_test` `:796-803` | synthetic `TS0000` compile ingest → `return _ingest_compile(…)` |
| bun | `cmd_regression` `:852-855` | `no JUnit XML produced — nothing to ingest` on stderr → `return 1` |
| arduino | `_run_native_tests_body` `:505-507` | `sys.stderr.write(...)` + `sys.exit("[crucible] no JUnit …")` |
| arduino | `cmd_auto_ingest` `:659-662` | `sys.exit("[crucible] no JUnit (TEST-*.xml) under <dir> — nothing to ingest")` |

None of the seven reaches an emitter. Two are gate paths: `cmd_regression` in bun and
`_regression_run` in python are the bodies `pre-merge-gate` executes as its regression step
(`verb` is threaded in precisely so the document carries the GATE's verb, CR-CRU-058 §S1) — so the
verb an orchestrator reads to decide a merge is exactly the verb that goes silent when a toolchain
is missing.

**Two clients already do this correctly, and their implementations are duplicated:**
rust has `_no_junit_help(verb)` (`clients/rust-crucible.py:360`) consumed by `_emit_axi` at `:899`,
`:1396` and `:1523`; mvn inlines the same concept inside `_emit_compile_fallback_axi(verb, rc,
project_dir, agent)` (`clients/mvn-crucible.py:894`) — its `help[]` prose and its
`{"code": "no-test-reports"}` warning are literals at `:900-908`. `grep -rn '"no-test-reports"'
clients/` returns exactly ONE hit, so the code that names this condition exists in one client only.
Two local implementations of one fleet concept is the CR-CRU-054 drift class — the shared module
carries no no-report helper at all.

The second half of this CR is CR-CRU-063's other recorded follow-up:
`test_docker_e2e_gate_emits_envelope_with_run_block`
(`tests/client/test_toolchain_verb_envelopes.py`) drives `docker-e2e-gate` with no
`--min-free-g`, so it inherits `rust-crucible.py:2180`'s **80 GB** default floor (guard at `:1331`).
It failed on run 31677479804 with `disk-guard-abort` and went green later only because those runners
had the space. Its rust siblings pass `--min-free-g 1` explicitly. That test now sits inside a
`needs:`-wired, publish-blocking gate.

## Scope

### §S1 — One shared no-report envelope in `clients/_crucible_axi.py`

Add to the shared module (alongside `gate_step_abort_help` / `gate_step_abort_warning`, whose shape
this follows):

- `no_report_help(verb, artifact, remedy=None) -> list[str]` — the state-derived next step: read the
  runner's own output on stderr, then re-run. Ends with `"status"`, as every `help[]` in the fleet
  does.
- `no_report_warning(verb, artifact, exit_code, output) -> dict` — exactly `{"code":
  "no-test-reports", "detail": …}`. The code is mvn's existing string, reused verbatim: a lift, not a
  rename. **The helper COMPOSES the detail** — it does not receive a finished one. A `detail`
  parameter would push the invariant below into all seven call sites, which is the duplication this
  section exists to delete.
- The composed `detail` names the verb, the artifact and the runner's `exit_code`, then the last
  non-empty line of `output`, so `No module named 'xmlrunner'` reaches the consumer. The composed
  PREFIX (verb + artifact + exit code) is never truncated; only the output fragment is bounded, it
  keeps ITS tail (the cause), and the whole `detail` stays ≤ 500 characters. Blank/whitespace-only
  `output` still yields a non-empty, exit-code-naming detail — `/api/v2/runs/compile` 400s on empty.

rust's `_no_junit_help` is DELETED and its three emit sites call the shared helpers — a clean
cutover, no alias. mvn's `_emit_compile_fallback_axi` SURVIVES as a thin caller (it is an emitter,
not a help/warning builder): its inlined `help[]` prose and warning literal are replaced by calls.
The `artifact` parameter is what preserves each stack's wording (`junit.xml` · `surefire reports` ·
`TEST-*.xml`); `ok`, the verb and the warning code must not change for either client.

### §S2 — python: three sites emit

`cmd_test` (`:682-685`), `_regression_run` (`:761-765`) and `cmd_auto_ingest` (`:787-790`) each emit
ONE `ok:false` envelope under the verb they were invoked as — `_regression_run` under its `verb`
parameter, never the literal `"regression"`, so a `pre-merge-gate` run yields a gate document. The
compile ingest stays exactly as it is (the RED must still reach Crucible); the envelope is emitted
after it, and the process exit code is unchanged.

The existing `no-tests-discovered` branch (`:746-760`) is already compliant and is NOT touched — it
is a different, definitive error, and the two must remain distinguishable by warning code.

### §S3 — bun: two sites emit

`cmd_test` (`:796-803`) and `cmd_regression` (`:852-855`). The regression site takes `verb`, as in
§S2. bun's synthetic `TS0000` diagnostic keeps its current behaviour (`errorCount=1`, red card); the
envelope is additive.

### §S4 — arduino: two `sys.exit(<message>)` sites become envelope + return

`_run_native_tests_body` (`:505-507`) and `cmd_auto_ingest` (`:659-662`). `sys.exit("<message>")`
writes the message to stderr and exits 1; the replacement emits the envelope and returns 1 through
the normal dispatch path, so the exit code and the stderr text are preserved while stdout gains the
document. `_run_native_tests_body` is the shared workhorse behind arduino's test AND regression
verbs, so its envelope must carry the caller's `verb`.

### §S5 — Suites driven by a starved toolchain, not a happy path

Extend the EXISTING suites; introduce no new mechanism:

- `tests/client/test_toolchain_verb_envelopes.py` — one case per §S2-§S4 site, driven so no report is
  produced (an interpreter/runner that cannot write JUnit), asserting `_assert_full_envelope` plus
  §S3 stdout purity (the TOON document is the ENTIRE stdout).
- `tests/clients-python-arduino-crucible.test.ts` — the ONE existing starved-toolchain fixture
  (`:69-71`) already drives a python client whose interpreter has no `xmlrunner` and asserts the
  compile ingest carries the real captured `No module named …` text, never the placeholder
  `xmlrunner produced no JUnit XML (import/syntax failure…)`. Extend THAT fixture with the stdout
  envelope assertion rather than building a second starved harness.
- `tests/client/test_client_fleet_envelope_census.py` — the census's `drive_verb` /
  `classify_envelope` pair covers the starved variant for the seven sites, so a future client cannot
  add a bare no-report branch.
- `tests/client/test_cr054_drift_guard.py` — the guard is TWO assertions, because a name-only check
  misses mvn (which never had a named helper): (a) `_no_junit_help` is absent from every
  `clients/*.py`, and (b) the `"no-test-reports"` literal and the no-report help prose appear ONLY in
  `clients/_crucible_axi.py`. (b) is what catches an inlined re-introduction.

### §S6 — `docker-e2e-gate`'s envelope test must not depend on ambient free disk

`test_docker_e2e_gate_emits_envelope_with_run_block` drives with an explicit `--min-free-g 1`,
matching its siblings (`test_rust_pre_merge_gate_help_differs_…`,
`test_rust_workspace_regression_help_differs_…`). If the class's `_drive` helper cannot pass extra
argv, it gains a passthrough parameter — the same mechanism `_drive_with_bin_dir(..., extra_argv=…)`
already uses.

**CORRECTED at C3 RED — this section DOES need a small production change; the original text
asserted otherwise and measurement disproved it.** `--min-free-g` is registered on exactly two
subparsers (`clients/rust-crucible.py:2182` and `:2287`) and `docker-e2e-gate`'s is not one of them,
so the drive dies at argparse with `unrecognized arguments: --min-free-g 1` before any assertion is
reachable. Nor would passing it help on its own: `cmd_pre_merge_gate` threads `min_free_g` into its
`smoke_args` (`:1748`) while `cmd_docker_e2e_gate` (`:1770-1782`) does not, so `_smoke_test`'s
`getattr(args, "min_free_g", 80)` (`:1327`) always falls back to 80 for this verb. Two lines are
therefore in scope: register `--min-free-g` (`type=int, default=80`) on the `docker-e2e-gate`
subparser exactly as its siblings declare it, and add `min_free_g=getattr(args, "min_free_g", 80)`
to `cmd_docker_e2e_gate`'s `smoke_args`.

The 80 GB DEFAULT is unchanged and stays correct for a real docker e2e run — this makes the
existing flag reachable on a verb that was silently missing it, which is a latent gap in its own
right: before this, no caller of `docker-e2e-gate` could lower the floor at all.

## Acceptance criteria

1. `clients/_crucible_axi.py` exports `no_report_help(verb, artifact, remedy=None)` returning a
   `list[str]` whose final element is `"status"`, and `no_report_warning(verb, artifact, exit_code,
   output)` returning a dict whose `code` is exactly `"no-test-reports"`. Both are PURE (no I/O), as
   their `gate_step_abort_*` siblings are.
2. `no_report_warning` COMPOSES the `detail`: it names the verb, the artifact and `exit_code`, then
   the last non-empty line of `output`. For a 5,000-character `output` whose tail is
   `ModuleNotFoundError: No module named 'xmlrunner'`: `len(detail) <= 500`, the prefix and exit code
   are intact, and `No module named 'xmlrunner'` is present. For `output` that is empty or
   whitespace-only, `detail` is non-empty and still names `exit_code`.
3. `grep -rn "_no_junit_help" clients/` returns **zero** matches, and `grep -rn '"no-test-reports"'
   clients/` matches **only** `clients/_crucible_axi.py`. rust's `:899`, `:1396`, `:1523` and mvn's
   `_emit_compile_fallback_axi` (which survives as a thin caller) all source `help[]` and
   `warnings[]` from the shared helpers; the "produced no junit.xml" / "produced no surefire reports"
   prose exists only in the shared module, differentiated by the `artifact` argument.
4. Each of the seven sites in the Context table emits exactly ONE document on stdout that decodes as
   TOON to `{axi: {verb, ok:false, help[], context, warnings[]}}` with a `no-test-reports` warning.
   `classify_envelope(stdout, toon)` is True for all seven.
5. For every one of the seven, stdout decodes as a single document with nothing ahead of it (§S3
   purity), and the process exit code is byte-identical to the pre-CR behaviour (python: the runner's
   code or 1; bun `cmd_regression`: 1; arduino: 1).
6. A `pre-merge-gate` invocation whose regression step produces no report emits its document under
   `verb: pre-merge-gate` — in both python and bun — never `verb: regression`.
7. The `no-tests-discovered` branch (`python-crucible.py:746-760`) still emits its own warning code;
   a zero-discovery run and a no-report run are distinguishable by `warnings[].code` alone.
8. `docker-e2e-gate` ACCEPTS `--min-free-g` (it did not before — see §S6) and threads it into the
   shared smoke body, so `_smoke_test`'s floor for this verb is the caller's value rather than an
   unconditional 80. `test_docker_e2e_gate_emits_envelope_with_run_block` passes `--min-free-g 1`;
   running it on a filesystem with less than 80 GB free still passes, and the `disk-guard-abort`
   warning code does not appear in its captured envelope. The DEFAULT stays 80.
9. `test_cr054_drift_guard.py` fails on EITHER a re-introduced named helper or an inlined
   `"no-test-reports"` / no-report help literal in any client — the name check alone would not have
   caught mvn's inlined version.
10. Both gates green before close-out (CR-CRU-045 §S3 cross-stack rule: these are Python clients
    whose observable contract is asserted by bun tests) — the Python suite AND the bun suite.

## Estimated size

Small-to-medium. One shared helper + seven call sites + two deletions; the suite work (starved-drive
fixtures) is the larger half. Three cycles: C1 shared helper + rust/mvn re-point, C2 the seven sites
(python → bun → arduino), C3 the census/drift guard + §S6, then VERIFY.

## Risk

- **A starved-toolchain fixture is easy to fake.** A test that simply asserts on a hand-built
  envelope proves nothing. The drive must run the real client against a real interpreter/runner that
  genuinely cannot produce a report — the census's subprocess idiom, never an in-process call.
- **Exit-code drift.** These branches carry RED signal; an envelope that changes an exit code from
  non-zero to zero would make a failing gate look green. AC5 is the guard.
- **rust/mvn wording churn — measured LOW, not zero.** No test asserts `_no_junit_help`,
  `_emit_compile_fallback_axi`, the `no-test-reports` code, or their help text (`grep` over `tests/`
  returns nothing for any of them), so the re-point is unlikely to move a green suite. That also
  means those two implementations are currently UNGUARDED: the shared helper must arrive with the
  assertions they never had, or this CR trades duplication for silence.

## Non-goals

- No change to `_ingest_compile` payloads, the compile codec, or the server. The defect is the
  missing client-side document.
- No change to `rust-crucible.py`'s 80 GB `--min-free-g` default, nor to the docker e2e gate's real
  behaviour.
- No new CI provisioning. CR-CRU-063 delivered that; two of these tests would have gone green from
  this fix for the wrong reason (measured in its Implementation notes), which is why it is a separate
  CR.

## Implementation notes

### C1 — where a `detail` can actually carry a cause, measured per site

`no_report_warning` composes the cause from a captured stream, so its value depends on whether the
site HAS one. Measured while re-pointing rust and mvn:

| Site | Capture | Resulting `detail` |
|---|---|---|
| rust `regression-ingest` | `capture_output=True` | full: prefix + real cause (`error: no such command: \`llvm-cov\``) |
| rust `smoke-test`, `workspace-regression` | child streams INHERITED to stderr — nothing is captured | prefix + the blank-capture branch. Inherent, not a gap: the output the consumer needs already went to its terminal, and capturing it would change those verbs' streaming behaviour. |
| mvn `_emit_compile_fallback_axi` | `_compile_fallback` returns only an `rc`; the build output stays inside it | prefix only. **This one IS a gap** — the capture exists one frame down. |

**C3 threads mvn's capture out of `_compile_fallback` so the mvn detail carries its cause too.** It
is recorded here rather than absorbed into C1 because it changes `_compile_fallback`'s return
shape and its call sites, which C1's target did not include. AC2 is not considered met at the
mvn site until that lands.

### C3 — two corrections this CR's own prose got wrong, both found by measurement

1. **`_compile_fallback` has FIVE call sites, not three** (the count above said three). `_run_surefire_tier`, `cmd_e2e` and `_regression_run` emit an envelope and pass the capture on; `cmd_test` and `cmd_auto_ingest` do not emit, but had to be updated anyway or they would have returned a `(rc, output)` tuple as a process exit code.
2. **§S6 was not production-free** — see the correction inside that section.

### C3 — measured follow-up, deliberately NOT taken in this CR

`no_report_warning` composes its cause from the **last non-empty line** of the capture (AC2's literal
wording, C1's drift-guarded contract). That serves python and node well — `ModuleNotFoundError: No
module named 'xmlrunner'` and `Cannot find module …` genuinely terminate those streams. **It serves
maven worse:** real maven emits the actionable `cannot find symbol` line ABOVE its `symbol:` detail
lines, and a full build tail typically ends in boilerplate (`[ERROR] -> [Help 1]`), so mvn's detail
can carry a true but uninformative last line. This surfaced when C3's own fixture asserted on
`cannot find symbol` and could not reach it.

Changing the selection rule is a CROSS-FLEET change to a shared, drift-guarded helper affecting all
seven sites plus rust and mvn — out of scope here, and it would invalidate C1's committed tests.
Recorded for a future CR: a per-artifact or first-error-line selection, or a bounded multi-line
cause, would fit maven better without hurting the others.
