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

### §S2 — Client fleet: `clients/toon.py` becomes OUR spec-conformant codec (REVISED — user decision 2026-08-01, Option A)
The official Python story collapsed on inspection: PyPI **`toon-format` 0.1.0** (the only
release ever published) is a name-reservation STUB — `encode` and `decode` each
`raise NotImplementedError` (verified by unpacking the wheel, independently twice) — and the
org's `toon-python` repo is dormant with no implementation module. There is nothing to adopt.
(PyPI `toon` remains an unrelated research/hardware package — the near-miss trap stands.)

**Decision:** the server still adopts the first-party TS library (§S1). The Python side
REWRITES `clients/toon.py` into a full official-spec-conformant codec — a faithful port of the
TS reference — permanently validated by the §S4 oracle: every client envelope must decode via
`@toon-format/toon`, and official-encoded output must decode via ours. The by-path `_toon()`
loader, the `_emit` seam call-shape, and the wheel packaging of `toon.py` are UNCHANGED;
deletion is RESCINDED. The eight decode-instrument test files need NO migration — they load
`toon.py` by path and inherit conformance.

**Revisit pin:** adopt PyPI `toon-format` the day upstream ships a working release; the §S4
round-trip gate is the ready-made acceptance test for that swap.

### §S3 — 🚨 Dependency resolution for path-invoked clients
**This is the item that makes §S2 actually work.** `crucible_axi/manifest.py:43` records each
client as a FILE PATH (`<install_dir>/clients/<stack>-crucible.py`), and consumers invoke them as
loose scripts with whatever `python3` is on hand. A dependency declared in `crucible-axi`'s
metadata is **not** importable from a script run outside its environment — so §S2 alone would
break every path-invoked client with `ModuleNotFoundError: toon`.

Resolve it so a client always runs under an interpreter that can import its dependencies.
**Mechanism (user-decided 2026-08-01): PEP 723 inline script metadata + `uv run`.** Each of the
five clients carries a `# /// script` block; the documented invocation becomes
`uv run <client>.py` (uv is already a hard prerequisite of the install chain). ONE mechanism
everywhere: installed machines, loose copies, AND the in-repo harness (`tests/clients-*.test.ts`
spawn via `uv run` — landed in C1).

**REVISED after the §S2 stub finding:** with no adoptable Python library, the blocks declare
`requires-python = ">=3.10"` and an EMPTY `dependencies = []` — the C1 `toon-format` pin is
REVERTED everywhere it landed (the five headers AND `pyproject.toml`'s runtime dependency),
because pinning the stub would install a landmine that shadows any future real module. The
mechanism itself stays: it is proven, harmless while the list is empty, and makes the §S2
revisit-pin swap a one-line re-add per file.

Note this is a **client-surface change**, so it triggers the standing Model-B intimation
(they consume `crucible-clients.json` at pre-flight, and every documented client invocation
changes to `uv run`).

### §S3b — The FULL test-instrument + packaging surface (enumerated by gap-analysis 2026-08-01)
`clients/toon.py` is not just the fleet codec — it is the DECODE INSTRUMENT of the Python test
suite, loaded by path in at least eight test files, and a pinned member of the wheel. The
deletion surface:

| Surface | Files | Action (REVISED per §S2 Option A) |
|---|---|---|
| Subset-contract tests | `tests/toon.test.ts` (108L, server) | retire; replaced by `tests/toon-conformance.test.ts` (official-library wire gate) |
| Port-parity tests | `tests/client/test_toon.py` (305L — pinned construct-for-construct to the SUBSET) | retire; replaced by the new codec's spec-conformance suite + §S4 |
| Decode-instrument tests | `test_crucible_axi_shared.py:71`, `test_cr039_regression_discovery.py:60`, `test_crucible_axi_install.py:101`, `test_arduino_crucible_axi.py:77`, `test_bun_crucible_gates.py`, `test_bun_crucible_workflow_verbs.py`, `test_help_state_derived_cycle_transitions.py:134`, `test_bun_crucible_toon_envelope.py` (727L) | **NO migration** — they load `toon.py` by path and inherit conformance when it is rewritten |
| C1 contract tests | `tests/client/test_cr046_pep723_metadata.py` (22 tests pinning the `toon-format` dependency) | re-point: blocks carry `requires-python` + EMPTY `dependencies`; the stub pin is asserted ABSENT |
| Wheel packaging | `pyproject.toml` force-include + `test_crucible_axi_wheel_packaging.py:69` | UNCHANGED — `toon.py` stays in the wheel; runtime dep on `toon-format` reverted |
| Wire fixture | `tests/fixtures/no-mistakes-axi-status.toon` (hand-written subset dialect) | regenerate in official dialect |
| Harness spawns | `tests/clients-*.test.ts` spawn helpers (`python3` → `uv run`, §S3) | DONE in C1 |

### §S4 — Round-trip conformance gate
The first-party TS implementation is the SOLE conformance oracle, in BOTH directions:
server output (official encode) → OUR codec's decode → deep-equals the source object, across
every AXI envelope shape the server emits; AND client `_emit` output (our codec's encode) →
`@toon-format/toon` decode → deep-equals, across the client envelope shapes. The cross-stack
direction lives in the BUN suite (it spawns a real client and decodes its stdout with the
official library); the Python suite carries the codec's own spec-conformance and
self-round-trip cases. This gate is what proves our port and the reference agree — and it is
the ready-made acceptance test for the §S2 revisit-pin swap on any future library arrival or
bump.

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
- [ ] `clients/toon.py` implements the FULL official spec (no subset dialect remains in its
      output) — proven by the §S4 oracle, not by self-asserted unit cases alone.
- [ ] `src/toon.ts`'s hand-written serializer is gone; the server encodes via the official library.
- [ ] A list array emits `- `-prefixed elements — asserted on `help[]`, the most-emitted case.
- [ ] `"42"`, `"true"`, `"null"`, `""`, `" padded "`, `"-leading"` all round-trip as STRINGS
      through encode→decode — asserted per case. **`"42"` must not become a number.**
- [ ] **Round-trip:** every AXI envelope shape the server emits decodes client-side to an object
      deep-equal to the source, and every client-emitted envelope round-trips likewise — asserted
      (§S4, both directions).
- [ ] **§S3 gate:** on an environment where only `crucible-axi` + uv are installed,
      `uv run <client>.py` (the documented way) succeeds — asserted.
- [ ] `@toon-format/toon` is pinned with an explicit lower bound in `package.json`;
      `pyproject.toml` carries NO `toon-format` runtime dependency and all five PEP 723 blocks
      declare EMPTY `dependencies` (the stub-landmine guard) — asserted by the re-pointed C1
      contract tests.
- [ ] The wheel STILL ships `clients/toon.py`, and the packaged clients carry their PEP 723
      metadata intact (`test_crucible_axi_wheel_packaging.py` unchanged in intent, not
      weakened).
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
- **There is no working Python TOON implementation upstream** (PyPI 0.1.0 = NotImplementedError
  stubs; `toon-python` repo dormant). Our port carries fidelity risk — mitigated by the §S4
  oracle, which fails the gate the moment our codec and the TS reference disagree on any real
  envelope. The §S2 revisit pin governs eventual adoption; never re-add the dependency without
  opening the wheel first — registry metadata proved nothing.
- **Fixture churn is wide but mechanical.** The temptation is to "fix" a failing golden fixture by
  trimming an assertion; the AC forbids deleting fixtures.
- Deleting `clients/toon.py` removes ~8.6 KB of code the fleet currently depends on — the round-trip
  gate must be green BEFORE the deletion lands, not after.
