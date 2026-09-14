# CR-CRU-132 — the server stops speaking TOON

**Status:** PENDING
**Type:** fix
**Priority:** P3
**Depends on:** CR-CRU-005, CR-CRU-046
**Labels:** fix, server, subtractive, kiss
**Phase:** Wave 6 (0.2.0)
**Design reference:** PRD `§4.1` (v1 API surface), `§65`'s TOON decision of 2026-07-14, and the
2026-07-28 reversal recorded in the PRD's resolved-questions note. User ruling 2026-09-14: this is
spec creep, and the fix is a DELETION.

## Context

**The server can render every v2 GET as TOON, and nothing has ever asked it to.**

The machinery is real and well built. `reply()` (`src/v2.ts:212`) is the shared response gate that
**16** GET handlers route through. `wantsToon()` (`:163`) selects TOON when a GET carries `?fmt=toon`
or an `Accept` header containing `toon`; the body returns as `text/toon`. If the encoded payload
exceeds `TOON_MAX_BYTES = 64 * 1024` (`:160`), `truncatedToon()` (`:180`) finds the largest
top-level array, halves it until the body fits, and stamps `truncated: true` beside a
`full: GET …?fmt=json` pointer at the untruncated variant of the same URL. Writes always answer
JSON; JSON never truncates; an unshrinkable payload is emitted oversize rather than silently cut.

It was decided on 2026-07-14 for a stated reason — PRD §65, *"TOON (decided 2026-07-14):
agent-facing reads first"* — token economy for the reader, since an agent doing a `GET /api/v2`
orientation pays for every byte of JSON punctuation.

**Measured 2026-09-14, no consumer takes that path:**

- no `fmt=toon` and no `Accept: …toon` anywhere in `clients/*.py` — all five stack clients consume
  **JSON**;
- nothing in `public/` — the board's own SPA fetches JSON;
- the only exercisers are six test files: `tests/axi-negotiation.test.ts`,
  `tests/toon-conformance.test.ts`, `tests/plans-global.test.ts`, `tests/v2-brief-reshape.test.ts`,
  `tests/events-anchored.test.ts`, `tests/roadmap-registration-routes.test.ts`.

So the feature's only users are the tests that assert it exists. That is the shape of spec creep: a
capability built for a consumer that never arrived, kept alive by its own coverage.

**Two facts make the deletion worth doing rather than merely defensible.**

`@toon-format/toon` (`^4.1.0`) is the server's **only runtime dependency**. Removing the server's
TOON path makes the server dependency-free — every remaining `package.json` entry is a devDependency.

And `src/toon.ts` is imported from exactly **one** line, `src/v2.ts:32`. The blast radius is one
import, one constant, three functions and one branch of `reply()`.

**Client-side TOON is NOT in scope and does not change.** All seven files under `clients/` use
`clients/toon.py` to render their own stdout AXI envelopes — that is the TOON-AXI contract the fleet
speaks to its callers, established by CR-CRU-030 and made conformant by CR-CRU-046, and it is
untouched here. This CR removes the server's ability to SERVE TOON over HTTP, nothing else.

## Scope

### §S1 The response gate answers JSON, always

`reply()` loses its TOON branch and becomes what it already is for every write: a JSON responder.
`wantsToon`, `truncatedToon`, `jsonVariantUrl` and `TOON_MAX_BYTES` are DELETED, along with the
`toToon` import and `src/toon.ts` itself. `@toon-format/toon` leaves `package.json`.

A GET carrying `?fmt=toon` or `Accept: text/toon` is not refused — it answers JSON, like any other
GET. The parameter becomes inert rather than an error, because a 406 would be a new refusal for a
shape that used to work, and this CR is a removal rather than a new contract. `?fmt=json` likewise
stays accepted and inert, since it is the documented escape hatch the truncation pointer used to
name and callers may have it written down.

**The 64 KB truncation goes with it.** That is the one behavioural loss worth naming: a JSON response
has never truncated, so no caller loses data — but a very large GET now returns in full where the
TOON variant would have shrunk it. JSON was always the untruncated variant; this makes it the only
variant.

### §S2 The tests that targeted it are DELETED, not adapted

Six files assert the server's TOON behaviour. Each is examined and split:

- assertions whose SUBJECT is server TOON (negotiation, `text/toon`, the truncation pointer, the
  64 KB ceiling) are **deleted** — the behaviour is gone, and a test re-pinned to "it now answers
  JSON" asserts the absence of a feature rather than a requirement;
- assertions that merely USED `?fmt=toon` as a convenient way to read a payload are **retargeted**
  to the JSON read, because their subject is the payload, not the encoding;
- `tests/toon-conformance.test.ts` is the delicate one: it validates our TOON against the official
  spec. Its SERVER half goes; any part validating `clients/toon.py` stays, because the clients still
  speak TOON and must still speak it correctly.

The split is stated per file in the implementation, and a deletion names the superseded claim — the
discipline CR-CRU-130 used when it retired `release-proposal`.

### §S3 The documentation stops promising it

- PRD §65's TOON decision and the resolved-questions note record that the SERVER path was removed
  2026-09-14 as spec creep, with the measurement that justified it. The 2026-07-14 decision is not
  erased — it is superseded, dated, with its reason.
- `docs/research/DN-crucible-toon-subset.md` is already a RETIRED pointer document whose "Current
  contract" names two pinned implementations. It keeps the client one and records that the server no
  longer speaks TOON.
- `tests/docs-toon-conformance.test.ts` asserts what that DN says, including the pinned
  `@toon-format/toon` version. Since the dependency is being removed, those assertions move with the
  doc — the guard must end up asserting the CLIENT contract, and must not be left asserting a pinned
  version of a package the repo no longer depends on.

## Acceptance criteria

**§S1**
- [ ] `reply()` answers JSON for every GET; `wantsToon`, `truncatedToon`, `jsonVariantUrl`,
      `TOON_MAX_BYTES`, the `toToon` import and `src/toon.ts` no longer exist — asserted by
      CONSTRUCTION, a scan that fails if any of those names reappears in `src/`.
- [ ] `@toon-format/toon` is absent from `package.json`, and the server's `dependencies` object is
      EMPTY — asserted, because dependency-free is the outcome worth pinning, not an incidental.
- [ ] The server boots and serves with the dependency uninstalled: proved from a clean
      `bun install --production` (or equivalent) rather than from a tree that still has it cached.
- [ ] A GET with `?fmt=toon` answers **JSON, 200**, with `content-type: application/json` — inert,
      not refused, and not 406.
- [ ] A GET with `Accept: text/toon` does the same.
- [ ] `?fmt=json` still answers JSON, 200 — the documented escape hatch keeps working for callers
      who have it written down.
- [ ] Every one of the 16 GET handlers that routed through `reply()` returns the SAME JSON body
      byte-for-byte as before this CR — asserted against the live shape, since this CR must change
      no payload, only drop an encoding.
- [ ] `text/toon` appears nowhere in `src/`.

**§S2**
- [ ] Each of the six files is accounted for: assertions whose subject was server TOON deleted with
      the superseded claim named, assertions that merely used TOON as a reader retargeted to JSON.
      Stated per file; no file left half-converted.
- [ ] `tests/toon-conformance.test.ts`'s CLIENT-side validation survives and still passes — the
      clients' TOON must still be conformant, and this CR must not weaken that.
- [ ] No test asserts that a TOON request is REFUSED: inert is the contract, and a test pinning a
      refusal would invent one.
- [ ] The full two-stack suite is green with no net loss of coverage over anything that still
      exists — report the test-count delta and account for it entirely by the deletions.

**§S3**
- [ ] PRD §65 and the resolved-questions note record the removal, dated, with the measurement (no
      `fmt=toon` in any client, none in `public/`, six test files the only exercisers) — the
      2026-07-14 decision superseded rather than erased.
- [ ] `DN-crucible-toon-subset.md` records that the server no longer speaks TOON and that the client
      contract is unchanged.
- [ ] `tests/docs-toon-conformance.test.ts` asserts the CLIENT contract and no longer pins a version
      of a package the repo does not depend on.
- [ ] No documentation still offers `?fmt=toon` as a capability — asserted across `docs/` and
      `clients/STATUS-CONTRACT.md`.

## Estimated size

S — a deletion. One import, one constant, three functions, one branch, one file, one dependency, and
the coverage that pinned them. The care is in §S2's split and in not touching client-side TOON.

## Risk

- **Deleting the tests is the step that can hide a mistake.** A test whose subject was the payload
  and not the encoding must be RETARGETED, not deleted with the rest — otherwise the CR quietly
  removes coverage of something that still exists. The §S2 split is per-file and per-assertion for
  that reason, and the test-count delta must be fully accounted for.
- **Client-side TOON is one word away in every grep.** `toon` matches `src/toon.ts` and
  `clients/toon.py` alike; a careless sweep takes the fleet's envelope codec with it. The clients
  must be untouched, and the python suite is the check.
- **An external caller may exist that we cannot see.** Nothing in this repo asks for TOON, but the
  API is HTTP on localhost and a human may have `?fmt=toon` in a script. That is why the parameter
  becomes inert rather than a 406: the worst case is a caller receiving JSON where it expected TOON,
  which is the untruncated superset of the same payload.
- **`truncatedToon`'s halving loop is the only size defence on any read.** After this CR a very
  large GET returns in full. That was always true of JSON, and JSON was always available, so this is
  a loss of a mitigation nobody was using — but it should be a stated loss rather than a discovered
  one.

## Non-goals

- **Client-side TOON.** `clients/toon.py` and the fleet's stdout envelopes are the TOON-AXI contract
  (CR-CRU-030, CR-CRU-046) and are untouched. This CR removes only the server's HTTP rendering.
- Any change to a JSON payload. The bodies are byte-identical; only an alternative encoding of them
  goes away.
- Retiring `?fmt` as a parameter, or adding content negotiation of any other kind.
- The five limits CR-CRU-131 moves into configuration. `TOON_MAX_BYTES` is excluded there precisely
  because it is deleted here.
