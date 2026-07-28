# CR-CRU-046 — TOON conformance: adopt the official library server-side, conform the Python codec

**Status:** PENDING
**Type:** patch (wire-format correctness)
**Priority:** P1 — what we emit today is not valid TOON; an official parser silently mis-reads it
**Depends on:** CR-CRU-005 (the subset serializer), CR-CRU-030 (fleet TOON-AXI + golden fixtures)
**Labels:** patch, toon, wire-format, axi-compliance, server, client-fleet, 0.1.0-blocker
**Phase:** Wave 4
**Design reference:** the official TOON spec (github.com/toon-format/spec) and its 8 language
implementations. `docs/research/DN-crucible-toon-subset.md` pinned our subset with an explicit
revisit trigger: *"revisit only if third-party TOON tooling arrives."* It has. Split decided by
the user 2026-07-28: **official library on the bun server; conformance-only on the Python side.**

## Context
Our emitted TOON is **not conformant**. Verified by running `toToon` and comparing to the spec:

```
help[2]:
  cycle-activate <id>     spec requires "- cycle-activate <id>"
  status                  spec requires "- status"
note: 42                  value is the STRING "42"; a spec parser reads NUMBER 42
flag: true                value is the STRING "true"; a spec parser reads BOOLEAN true
dash: -x                  spec: MUST quote (leading hyphen)
pad:  y                   value is " y "; spec: MUST quote (leading/trailing whitespace)
```

Two of the four constructs diverge:

| Construct | Ours | Spec |
|---|---|---|
| Scalar line / nested object | `key: value`, 2-space indent | conformant |
| Uniform table | `items[2]{sku,qty}:` + comma rows | conformant |
| **List array** | bare indented lines (`src/toon.ts:80`) | **`- ` prefix per element** |
| **Quoting** | `SCALAR_SPECIALS = /[\n:,{}[\]]/` | **also empty, leading/trailing whitespace, `true`/`false`/`null`-lookalikes, numeric-lookalikes, backslash, leading `-`/`#`** |

Two of these are **silent type corruption** (`"42"` → number, `"true"` → boolean), and the
list-array defect is on the hottest path — `help[]` appears in **every** AXI envelope.

This has been invisible because both ends are ours. It stops being invisible the moment 0.1.0
is published: the AXI manifesto's whole premise is agent-consumable output, and any agent using
a standard TOON parser gets wrong data.

**Wire direction (verified):** the server **encodes only** (`src/toon.ts` exports just
`toToon`), and **all five Python clients decode** — `_toon().decode(snap)` appears at five call
sites in each of `arduino/python/bun/mvn/rust-crucible.py`, on the live gate/status read path
agents use mid-run.

## Scope

### §S1 — Server: adopt the official TypeScript library
Replace `src/toon.ts`'s hand-written serializer with `@toon-format/toon`. This is Crucible's
**first runtime npm dependency** — `package.json` currently declares none — so the CR-CRU-041
`files` whitelist and the npx install story must be re-checked (deps are installed, not
vendored in the tarball).

### §S2 — 🚨 The server's output MUST stay inside the Python decoder's subset
The official encoder supports constructs our hand-written Python decoder cannot parse: key-path
folding, delimiter variants, and the inline primitive-array short form. Emitting any of them
would break every client's `decode(snap)` on the live read path.

Configure/constrain the server encoder so its output remains within the four documented
constructs. This is the CR's integration gate, not a nicety.

### §S3 — Python: conformance, not adoption
Fix `clients/toon.py` to emit conformant TOON, keeping it **dependency-free and vendored**:
`clients/*-crucible.py` are copied into arbitrary consumer repos and load `toon.py` *by file
path* precisely so they need no install. A pip dependency would regress that portability.
- `encode`: prefix list-array elements with `- `; tighten the quoting predicate to the spec's
  MUST-quote set.
- `decode`: accept the `- ` prefix and the widened quoting, so round-tripping still holds.

### §S4 — Cross-stack conformance gate (the durable guarantee)
A test that **round-trips through the official parser**, so subset-conformance cannot silently
rot again:
- server output (official encoder) → `clients/toon.py` `decode` → deep-equals the source object
  (proves §S2: the server never outgrows the client decoder);
- `clients/toon.py` `encode` → the **official TS parser** → deep-equals the source object
  (proves §S3 without a Python dependency — the library adopted in §S1 is the oracle).

### §S5 — Update the DN
`docs/research/DN-crucible-toon-subset.md` currently states the subset is pinned "producer and
consumers are both our fleet". Re-frame it as a **strict subset of the official TOON spec**,
cite the spec version, and record that conformance is enforced by §S4 rather than by convention.

## Acceptance criteria
- [ ] A list array emits `- `-prefixed elements — asserted on `help[]`, the most-emitted case.
- [ ] Strings that look like numbers/booleans/null (`"42"`, `"true"`, `"null"`), are empty, have
      leading/trailing whitespace, or begin with `-`/`#` are quoted — asserted per case, both
      stacks. **`"42"` must decode back as the STRING `"42"`.**
- [ ] **Server → client:** every AXI envelope shape the server emits decodes via
      `clients/toon.py` to an object deep-equal to the source — asserted (§S2's gate).
- [ ] **Client → official:** `clients/toon.py` `encode` output parses with the official TS
      parser to a deep-equal object — asserted (§S4).
- [ ] `clients/toon.py` has **no new third-party import** and is still loadable by file path
      with nothing installed — asserted.
- [ ] The CR-CRU-030 §S5 golden envelope fixtures are regenerated and match the new output;
      no fixture is deleted to make a test pass.
- [ ] Full bun regression green AND full Python regression green (client change → both gates,
      per the CR-045 §S3 rule).

## Non-goals
- Adopting a TOON library on the Python side, or in any vendored client.
- Supporting the full grammar in `clients/toon.py`'s decoder beyond what §S2 requires.
- Changing the AXI envelope's *shape* — this is wire-encoding only, not a contract change.

## Risk
- **The encoder outgrowing the decoder (§S2) is the main hazard** — it would break agents mid-run
  on the read path, not at build time. The §S4 round-trip is what catches it.
- **First runtime dependency** — re-check the npm tarball, the `npx` path, and CR-041's `files`
  whitelist.
- **Fixture churn is wide but mechanical.** The temptation will be to "fix" a failing golden
  fixture by trimming an assertion; the AC forbids deleting fixtures.
- Community implementations vary in maturity; only the TypeScript one is first-party, which is
  a further argument for not taking a Python dependency.
