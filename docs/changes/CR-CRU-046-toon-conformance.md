# CR-CRU-046 — Adopt the official TOON libraries on both stacks; retire our hand-written codecs

**Status:** PENDING
**Type:** patch (wire-format correctness + dependency adoption)
**Priority:** P1 — what we emit today is not valid TOON; an official parser silently mis-reads it
**Depends on:** CR-CRU-005 (the subset serializer), CR-CRU-030 (fleet TOON-AXI + golden fixtures), CR-CRU-009 (`crucible-axi` packaging + client manifest)
**Labels:** patch, toon, wire-format, axi-compliance, server, client-fleet, dependencies, 0.1.0-blocker
**Phase:** Wave 4
**Design reference:** the official TOON spec + implementations (github.com/toon-format).
`docs/research/DN-crucible-toon-subset.md` pinned our subset with an explicit revisit trigger —
*"revisit only if third-party TOON tooling arrives."* It has, in 8 languages.
**User decision 2026-07-28: adopt the official library on BOTH stacks.** Rationale: TOON is a
community spec, so a hand-rolled codec is a permanent catch-up treadmill and vendored copies rot
silently; a declared, version-pinned dependency is the time-honoured solution, and we already
ship via a package repo.

## Context
Our emitted TOON is **not conformant**. Verified by running `toToon` against the spec:

```
help[2]:
  cycle-activate <id>     spec requires "- cycle-activate <id>"
  status                  spec requires "- status"
note: 42                  value is the STRING "42"; a spec parser reads NUMBER 42
flag: true                value is the STRING "true"; a spec parser reads BOOLEAN true
dash: -x                  spec: MUST quote (leading hyphen)
pad:  y                   value is " y "; spec: MUST quote (leading/trailing whitespace)
```

Two of four constructs diverge — list arrays lack the `- ` element prefix (`src/toon.ts:80`), and
the quoting predicate (`/[\n:,{}[\]]/`) omits the spec's MUST-quote set. Two defects are **silent
type corruption**, and the list-array defect is on the hottest path: `help[]` appears in **every**
AXI envelope.

Invisible so far because both ends are ours. It stops being invisible when 0.1.0 publishes — the
AXI premise is agent-consumable output, and any agent using a standard parser gets wrong data.

**Wire direction (verified 2026-08-01):** the server **encodes** (`src/toon.ts` exports just
`toToon`; three call sites in `src/v2.ts`); the clients **encode AND decode** — every client AXI
envelope is encoded through the single `_emit` seam (`_toon().encode({"axi": ...})`,
`clients/_crucible_axi.py:84`), and each of the five clients decodes server snapshots at two
sites (interim + final gate reads) on the live gate/status path used mid-run.

Adopting the library on **both** ends removes the encoder/decoder capability mismatch entirely:
there is no subset to police, and the hand-written decoder is deleted rather than patched.

## Scope

### §S1 — Server: adopt `@toon-format/toon`
Replace `src/toon.ts`'s hand-written serializer with the official TypeScript library (the
first-party reference implementation): `@toon-format/toon` (latest 4.1.0; ESM-only, exports
`encode`/`decode` — fine under bun). This is Crucible's **first runtime npm dependency** —
`package.json` declares none today — so CR-CRU-041's `files` whitelist and the `npx` install path
must be re-checked (dependencies are resolved on install, not vendored in the tarball).

### §S2 — Client fleet: adopt `toon-format` (PyPI) and DELETE `clients/toon.py`
Declare the official Python implementation as a runtime dependency of `crucible-axi` and use it
from `_crucible_axi.py` — BOTH the `_emit` encode seam and the snapshot decode path — removing
the by-path loader shim. `clients/toon.py` (8.6 KB of hand-written codec) is deleted, not
maintained.

🚨 **The package is `toon-format`** (import `toon_format`; `from toon_format import encode,
decode`; requires-python `>=3.10`, matching ours) — **NOT PyPI `toon`**, which is an unrelated
research/hardware package the near-miss name would silently pull in. The explicit pin below is
what guards against that.

### §S3 — 🚨 Dependency resolution for path-invoked clients
**This is the item that makes §S2 actually work.** `crucible_axi/manifest.py:43` records each
client as a FILE PATH (`<install_dir>/clients/<stack>-crucible.py`), and consumers invoke them as
loose scripts with whatever `python3` is on hand. A dependency declared in `crucible-axi`'s
metadata is **not** importable from a script run outside its environment — so §S2 alone would
break every path-invoked client with `ModuleNotFoundError: toon`.

Resolve it so a client always runs under an interpreter that can import its dependencies.
**Mechanism (user-decided 2026-08-01): PEP 723 inline script metadata + `uv run`.** Each of the
five clients carries a `# /// script` block declaring `requires-python = ">=3.10"` and
`dependencies = ["toon-format>=0.1,<0.2"]`; the documented invocation becomes
`uv run <client>.py` (uv is already a hard prerequisite of the install chain). ONE mechanism
everywhere: installed machines, loose copies, AND the in-repo harness — the bun client tests
(`tests/clients-*.test.ts`) spawn bare `python3` today and migrate to the same `uv run`
invocation. The ACCEPTED OUTCOME is unchanged: invoking a client the documented way must work on
a machine where `crucible-axi` (+ uv) is installed and nothing else is.

Note this is a **client-surface change**, so it triggers the standing Model-B intimation
(they consume `crucible-clients.json` at pre-flight, and every documented client invocation
changes to `uv run`).

### §S3b — The FULL test-instrument + packaging surface (enumerated by gap-analysis 2026-08-01)
`clients/toon.py` is not just the fleet codec — it is the DECODE INSTRUMENT of the Python test
suite, loaded by path in at least eight test files, and a pinned member of the wheel. The
deletion surface:

| Surface | Files | Action |
|---|---|---|
| Subset-contract tests | `tests/toon.test.ts` (108L, server), `tests/client/test_toon.py` (305L, port parity) | retire; replaced by official-library conformance + §S4 round-trip |
| Decode-instrument tests | `test_crucible_axi_shared.py:71`, `test_cr039_regression_discovery.py:60`, `test_crucible_axi_install.py:101`, `test_arduino_crucible_axi.py:77`, `test_bun_crucible_gates.py`, `test_bun_crucible_workflow_verbs.py`, `test_help_state_derived_cycle_transitions.py:134`, `test_bun_crucible_toon_envelope.py` (727L — the CR-030 §S5 round-trip surface) | migrate the instrument from by-path `toon.py` loading to `import toon_format` |
| Wheel packaging | `pyproject.toml` force-include + `test_crucible_axi_wheel_packaging.py:69` (asserts `crucible_axi/clients/toon.py` ships) | drop `toon.py` from the wheel; assert the PEP 723 headers ship intact in the packaged clients |
| Wire fixture | `tests/fixtures/no-mistakes-axi-status.toon` (hand-written subset dialect) | regenerate in official dialect |
| Harness spawns | `tests/clients-*.test.ts` spawn helpers (`python3` → `uv run`, §S3) | migrate |

### §S4 — Round-trip conformance gate
With both ends on the official libraries this simplifies to a genuine interop test rather than a
subset guard, in BOTH directions: server output → client decode → deep-equals the source object,
across every AXI envelope shape the server emits; AND client `_emit` output → decode →
deep-equals, across the client envelope shapes (the clients encode too — §S2). Keep it — it is
what proves the two independent implementations agree, and it is the regression test for any
future library bump.

### §S5 — Retire the subset DN
`docs/research/DN-crucible-toon-subset.md` describes a pinned fleet-only subset that will no
longer exist. Replace its normative content with a short statement that Crucible speaks TOON per
the official spec, cite the spec version and the two pinned library versions, and keep the
historical note about why a subset existed. Do not delete the file — CR-005, CR-030 and the
storyboard all reference it.

### §S5b — PRD resolved-note edit (design surface — user-approved 2026-08-01)
`docs/research/PRD-crucible-v2.md:446`'s resolved-note still records the superseded decision —
*"TOON: pin the documented Crucible subset rather than vendoring the reference serializer —
both producer and consumers are our own fleet."* Rewrite that clause to record the 2026-07-28
reversal (official TOON libraries on both stacks; the spec is the contract), preserving the
surrounding resolved-note entries untouched.

## Acceptance criteria
- [ ] `clients/toon.py` is deleted; no client imports it, and `grep -rn "toon.py" clients/` finds
      no loader shim.
- [ ] `src/toon.ts`'s hand-written serializer is gone; the server encodes via the official library.
- [ ] A list array emits `- `-prefixed elements — asserted on `help[]`, the most-emitted case.
- [ ] `"42"`, `"true"`, `"null"`, `""`, `" padded "`, `"-leading"` all round-trip as STRINGS
      through encode→decode — asserted per case. **`"42"` must not become a number.**
- [ ] **Round-trip:** every AXI envelope shape the server emits decodes client-side to an object
      deep-equal to the source, and every client-emitted envelope round-trips likewise — asserted
      (§S4, both directions).
- [ ] **§S3 gate:** on an environment where `crucible-axi` (+ uv) is installed and `toon-format`
      is NOT separately installed into the ambient interpreter, `uv run <client>.py` (the
      documented way) succeeds — asserted, since this is the failure mode §S2 would otherwise
      introduce.
- [ ] Both library versions are pinned with an explicit lower bound: `@toon-format/toon` in
      `package.json`, `toon-format` in `pyproject.toml`.
- [ ] The wheel no longer ships `clients/toon.py`; the packaged clients carry their PEP 723
      metadata intact (`test_crucible_axi_wheel_packaging.py` updated, not weakened).
- [ ] The bun client-test harness spawns clients via the documented `uv run` invocation and
      stays green (§S3b).
- [ ] CR-CRU-030 §S5 golden envelope fixtures regenerated and matching; no fixture deleted to
      make a test pass.
- [ ] Full bun regression green AND full Python regression green (client change → both gates, per
      the CR-CRU-045 §S3 rule).

## Non-goals
- Changing the AXI envelope's SHAPE — this is wire-encoding only, not a contract change.
- Adopting TOON libraries in any other language (the clients are all Python; only the server is TS).
- Re-litigating the subset: the spec is now the contract.

## Risk
- **§S3 bites in CI FIRST, then the field** — the bun harness spawns bare `python3` and the repo
  environment does not carry the dependency, so without §S3 both gates fail on
  `ModuleNotFoundError` before any consumer machine does. Its AC is deliberately written as an
  environment test rather than a unit test.
- **First runtime dependency on BOTH stacks.** Re-check the npm tarball/`npx` path (CR-041 §S1) and
  the `uv tool install` path.
- **`toon-format` (PyPI) is 0.1.0** — same author as the TS reference but pre-1.0; pin
  `>=0.1,<0.2` and let §S4's round-trip be the guard on any bump.
- **Fixture churn is wide but mechanical.** The temptation is to "fix" a failing golden fixture by
  trimming an assertion; the AC forbids deleting fixtures.
- Deleting `clients/toon.py` removes ~8.6 KB of code the fleet currently depends on — the round-trip
  gate must be green BEFORE the deletion lands, not after.
