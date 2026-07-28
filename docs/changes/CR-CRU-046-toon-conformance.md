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

**Wire direction (verified):** the server **encodes only** (`src/toon.ts` exports just `toToon`);
**all five clients decode** — `_toon().decode(snap)` at five sites in each of
`arduino/python/bun/mvn/rust-crucible.py`, on the live gate/status read path used mid-run.

Adopting the library on **both** ends removes the encoder/decoder capability mismatch entirely:
there is no subset to police, and the hand-written decoder is deleted rather than patched.

## Scope

### §S1 — Server: adopt `@toon-format/toon`
Replace `src/toon.ts`'s hand-written serializer with the official TypeScript library (the
first-party reference implementation). This is Crucible's **first runtime npm dependency** —
`package.json` declares none today — so CR-CRU-041's `files` whitelist and the `npx` install path
must be re-checked (dependencies are resolved on install, not vendored in the tarball).

### §S2 — Client fleet: adopt `toon` (PyPI) and DELETE `clients/toon.py`
Declare the official Python implementation as a runtime dependency of `crucible-axi` and use it
from `_crucible_axi.py`, removing the by-path loader shim. `clients/toon.py` (8.6 KB of
hand-written codec) is deleted, not maintained.

### §S3 — 🚨 Dependency resolution for path-invoked clients
**This is the item that makes §S2 actually work.** `crucible_axi/manifest.py:43` records each
client as a FILE PATH (`<install_dir>/clients/<stack>-crucible.py`), and consumers invoke them as
loose scripts with whatever `python3` is on hand. A dependency declared in `crucible-axi`'s
metadata is **not** importable from a script run outside its environment — so §S2 alone would
break every path-invoked client with `ModuleNotFoundError: toon`.

Resolve it so a client always runs under an interpreter that can import its dependencies. The
implementation choice is open — a console-script/subcommand entry point, or recording the
resolving interpreter in `crucible-clients.json` alongside each path — but the ACCEPTED OUTCOME
is fixed: invoking a client the documented way must work on a machine where `crucible-axi` is
installed and nothing else is.

Note this is a **client-surface change**, so it triggers the standing Model-B intimation
(they consume `crucible-clients.json` at pre-flight).

### §S4 — Round-trip conformance gate
With both ends on the official libraries this simplifies to a genuine interop test rather than a
subset guard: server output → client decode → deep-equals the source object, across every AXI
envelope shape the server emits. Keep it — it is what proves the two independent implementations
agree, and it is the regression test for any future library bump.

### §S5 — Retire the subset DN
`docs/research/DN-crucible-toon-subset.md` describes a pinned fleet-only subset that will no
longer exist. Replace its normative content with a short statement that Crucible speaks TOON per
the official spec, cite the spec version and the two pinned library versions, and keep the
historical note about why a subset existed. Do not delete the file — CR-005, CR-030 and the
storyboard all reference it.

## Acceptance criteria
- [ ] `clients/toon.py` is deleted; no client imports it, and `grep -rn "toon.py" clients/` finds
      no loader shim.
- [ ] `src/toon.ts`'s hand-written serializer is gone; the server encodes via the official library.
- [ ] A list array emits `- `-prefixed elements — asserted on `help[]`, the most-emitted case.
- [ ] `"42"`, `"true"`, `"null"`, `""`, `" padded "`, `"-leading"` all round-trip as STRINGS
      through encode→decode — asserted per case. **`"42"` must not become a number.**
- [ ] **Round-trip:** every AXI envelope shape the server emits decodes client-side to an object
      deep-equal to the source — asserted (§S4).
- [ ] **§S3 gate:** on an environment where `crucible-axi` is installed and `toon` is NOT
      separately installed into the ambient interpreter, invoking a client the documented way
      succeeds — asserted, since this is the failure mode §S2 would otherwise introduce.
- [ ] Both library versions are pinned with an explicit lower bound in `package.json` and
      `pyproject.toml`.
- [ ] CR-CRU-030 §S5 golden envelope fixtures regenerated and matching; no fixture deleted to
      make a test pass.
- [ ] Full bun regression green AND full Python regression green (client change → both gates, per
      the CR-CRU-045 §S3 rule).

## Non-goals
- Changing the AXI envelope's SHAPE — this is wire-encoding only, not a contract change.
- Adopting TOON libraries in any other language (the clients are all Python; only the server is TS).
- Re-litigating the subset: the spec is now the contract.

## Risk
- **§S3 is the one that bites in the field, not in CI** — a path-invoked client that cannot import
  `toon` fails at agent runtime on a consumer machine. Its AC is deliberately written as an
  environment test rather than a unit test.
- **First runtime dependency on BOTH stacks.** Re-check the npm tarball/`npx` path (CR-041 §S1) and
  the `uv tool install` path.
- **`toon-python` is community-driven**; only the TypeScript implementation is first-party. Pin a
  known-good version and let §S4's round-trip be the guard on any bump.
- **Fixture churn is wide but mechanical.** The temptation is to "fix" a failing golden fixture by
  trimming an assertion; the AC forbids deleting fixtures.
- Deleting `clients/toon.py` removes ~8.6 KB of code the fleet currently depends on — the round-trip
  gate must be green BEFORE the deletion lands, not after.
