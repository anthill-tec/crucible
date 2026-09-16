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

The machinery is real and well built. `reply()` (`src/v2.ts:213`) is the shared response gate that
**16** `reply()` call sites, across 13 GET handlers, route through it. `wantsToon()` (`:164`) selects TOON when a GET carries `?fmt=toon`
or an `Accept` header containing `toon`; the body returns as `text/toon`. If the encoded payload
exceeds `TOON_MAX_BYTES = 64 * 1024` (`:161`), `truncatedToon()` (`:181`) finds the largest
top-level array, halves it until the body fits, and stamps `truncated: true` beside a
`full: GET …?fmt=json` pointer at the untruncated variant of the same URL. Writes always answer
JSON; JSON never truncates; an unshrinkable payload is emitted oversize rather than silently cut.

It was decided on 2026-07-14 for a stated reason — PRD §65, *"TOON (decided 2026-07-14):
agent-facing reads first"* — token economy for the reader, since an agent doing a `GET /api/v2`
orientation pays for every byte of JSON punctuation.

**Measured 2026-09-14, no consumer takes that path — with one correction found during
implementation.** The original measurement was:

- no `fmt=toon` and no `Accept: …toon` anywhere in `clients/*.py` — all five stack clients consume
  **JSON**;
- nothing in `public/` — the board's own SPA fetches JSON;
- the only exercisers are six test files: `tests/axi-negotiation.test.ts`,
  `tests/toon-conformance.test.ts`, `tests/plans-global.test.ts`, `tests/v2-brief-reshape.test.ts`,
  `tests/events-anchored.test.ts`, `tests/roadmap-registration-routes.test.ts`.

**That measurement never checked `cli/`, and it was wrong to skip it.** Found by GREEN during
implementation, 2026-09-15: `cli/crucible-axi.ts` sends `Accept: text/toon` and pipes the body
straight to stdout for four commands (`dashboard`, `project list`, `events`, `status`), regressing
4 of `tests/cli-axi.test.ts`'s 18 tests the instant §S1 lands. §S4 traces what this file actually
is and rules on it; the finding does not change §S1's premise about the SIX enumerated test files
or about `clients/*.py`/`public/` — it adds exactly one more artifact to the count, and that
artifact turns out to belong to the same defect class this whole CR removes.

So the feature's only users are the tests that assert it exists, plus one more piece of dead-end
code that turns out to be the same shape of problem. That is the shape of spec creep: a capability
built for a consumer that never arrived, kept alive by its own coverage.

**Two facts make the deletion worth doing rather than merely defensible.**

`@toon-format/toon` (`^4.1.0`) is the server's **only runtime dependency**. Removing the server's
TOON path makes the server dependency-free at RUNTIME — but the library MOVES to `devDependencies`
rather than leaving the repo, because it is the REFERENCE DECODER for the client-emit oracle that
survives this CR (`tests/toon-conformance.test.ts:25`, `tests/roadmap-registration-routes.test.ts:46`
both `import { decode } from "@toon-format/toon"`). Deleting it outright would remove the only
independent check that `clients/toon.py` is conformant — the very contract §S2 preserves.

And `src/toon.ts` is imported from exactly **one** line, `src/v2.ts:33`. The blast radius is one
import, one constant, three functions and one branch of `reply()`.

**Client-side TOON is NOT in scope and does not change.** All seven files under `clients/` use
`clients/toon.py` to render their own stdout AXI envelopes — that is the TOON-AXI contract the fleet
speaks to its callers, established by CR-CRU-030 and made conformant by CR-CRU-046, and it is
untouched here. This CR removes the server's ability to SERVE TOON over HTTP, nothing else.

## Scope

### §S1 The response gate answers JSON, always

`reply()` loses its TOON branch and becomes what it already is for every write: a JSON responder.
`wantsToon`, `truncatedToon`, `jsonVariantUrl` and `TOON_MAX_BYTES` are DELETED, along with the
`toToon` import and `src/toon.ts` itself (a 12-line adapter over the library). `@toon-format/toon`
MOVES from `dependencies` to `devDependencies` — the server's runtime dependency set becomes empty,
and the test oracle keeps its reference implementation.

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
The split is ENUMERATED here rather than left to judgement, because two of these files hold
assertions that have nothing to do with server TOON and would be lost with a wholesale deletion:

- **`tests/axi-negotiation.test.ts` — the hazard.** Its own header says it covers CR-CRU-005
  "§S2 (content negotiation) + §S3 (help[] hints module) + §S4 (TOON truncation)". Only §S2 and §S4
  go: the SIX negotiation tests (`:121`, `:132`, `:145`, `:156`, `:167`, `:203`) and the ONE
  truncation test (`:296`). The FIVE `help[]` hints tests (`:226`, `:232`, `:239`, `:257`, `:276`)
  STAY — those are the AXI next-step hints the whole API emits. So does `:353`, which asserts
  `src/v2.ts` contains ZERO `Response.json(` so every response routes through the shared gate; that
  guard is MORE valuable after this CR, not less. The file survives, smaller.
- **`tests/toon-conformance.test.ts` — split ~11/3.** The server-wire round-trips (`:139`–`:282`,
  seven envelope shapes), the server-direction type-preservation cases (`:319`) and the two
  server-fetched `help[]` decode tests (`:351`, `:369`) go. The CLIENT-EMIT ORACLE stays — `:469`,
  `:517`, `:542` — because it is this CR's proof that removing the server's TOON did not touch the
  fleet's. The file survives, substantially smaller.
- **`tests/roadmap-registration-routes.test.ts` — 49 tests, 2 TOON sites, not incidental.**
  Measured 2026-09-14 (an earlier draft of this section said "10 TOON sites… every one
  RETARGETS" — wrong on both the count and the treatment): the file's entire TOON footprint is one
  `toonReply()` helper and the two tests it feeds, `:1937` and `:1960`, and BOTH are
  CR-CRU-108 §S1/AC3's deliberate independence check — "the `?fmt=toon` reply carries `tracks`
  under the SAME name, asserted by reading the TOON text… not by trusting `reply()`." Their subject
  IS server TOON (a `content-type: text/toon` assertion, a TOON-grammar regex, `decode()` from the
  reference library), not a convenient payload read, so they are **deleted**, not retargeted —
  retargeting is either impossible (no TOON reply is left to read) or a vacuous restatement of the
  JSON-only test immediately above them in the same `describe` block (`:1912`–`:1935`), which
  already proves the same fact (`tracks` published under a stable name) without TOON. The other 47
  tests never touch TOON and are untouched by this CR.
- `tests/plans-global.test.ts`, `tests/v2-brief-reshape.test.ts`, `tests/events-anchored.test.ts` —
  examined per assertion by the same rule: subject-is-TOON deletes, TOON-as-reader retargets.

The split is stated per file in the implementation, and a deletion names the superseded claim — the
discipline CR-CRU-130 used when it retired `release-proposal`.

### §S3 The documentation stops promising it

- PRD §65's TOON decision and the resolved-questions note record that the SERVER path was removed
  2026-09-14 as spec creep, with the measurement that justified it. The 2026-07-14 decision is not
  erased — it is superseded, dated, with its reason.
- `docs/research/DN-crucible-toon-subset.md` is already a RETIRED pointer document whose "Current
  contract" names two pinned implementations — but its FIRST bullet, "Server (TypeScript):
  `@toon-format/toon` `^4.1.0` (the first-party reference implementation), pinned in `package.json`",
  is what a reader hits first, and after this CR it is misleading: the pin is still real but the
  server no longer SPEAKS TOON on the wire, only carries the library as the reference decoder for
  the client-emit oracle. That bullet is reworded to say so; it keeps the client bullet unchanged
  and records that the server no longer speaks TOON.
- **Measured 2026-09-14, a live DN this CR's own sweep missed the first time:**
  `docs/research/DN-crucible-analytics.md:124` — a LOCKED design note for CR-CRU-022 (wave 7,
  PENDING, `queue_snapshots` not yet built) — states "TOON forms follow the standard `?fmt=toon`
  rules" as forward guidance for a feature that does not exist yet. Left alone, it tells CR-CRU-022's
  future implementer to build against a rule this CR retires. Corrected to state that TOON
  negotiation is not a server capability by the time that CR is built, and that the analytics reads
  follow the same JSON-only contract as every other v2 GET.
- `tests/docs-toon-conformance.test.ts` reads the pinned version from `pkg.dependencies` (`:78`) and
  asserts the DN names it (`:82`). With the library MOVED rather than removed, that guard is
  RETARGETED to `devDependencies` — not deleted. It keeps asserting a real pin of a real dependency,
  now scoped to the client contract it actually protects.

### §S4 The orphaned CLI is retired, not converted

`cli/crucible-axi.ts` — CR-CRU-008's (2026-07-18) TypeScript "fleet CLI for the Crucible server" —
is deleted in full: the file, `cli/package.json`, and both its test files
(`tests/cli-axi.test.ts`, `tests/cli-axi-role-flag.test.ts`, 20 tests total).

**Why retirement and not a JSON conversion.** Three questions, each answered by measurement rather
than inference, 2026-09-15:

1. **Was it ever reachable from outside this repo?** No. `cli/package.json` declares
   `"name": "crucible-axi", "bin": {"crucible-axi": "./crucible-axi.ts"}` — CR-CRU-008's AC said
   `npx crucible-axi` — but that publish step was never taken: the npm registry returns `Not found`
   for `crucible-axi`, the root `package.json`'s `bin` carries only `crucible-server`, and `files`
   does not include `cli/`. `cli/package.json`'s version has been touched exactly once, in the
   commit that created it, in the ~2 months since. The name `crucible-axi` was separately claimed
   by the PYTHON console script (`pyproject.toml`: `crucible-axi = "crucible_axi.cli:main"`,
   published to PyPI at `0.1.3`) — the one `docs/RUNBOOK.md` documents (`install`/`serve`/
   `uninstall`) and the one operators actually run. `tests/cli-axi.test.ts`'s own CR-CRU-066
   comment already names this collision explicitly: "this file's `describe` above exercises the
   BUN fleet CLI (`cli/crucible-axi.ts`)... NOT... the shipped `crucible-axi`."
2. **Does anything invoke it today?** No — exhaustively checked. No `package.json` script, no
   `.github/` workflow, no `scripts/` file, no git hook. Its only callers are its own two test
   files and three historical CR specs (008 which created it, 044/059 which touched its `--role`
   flag) — provenance, not consumption.
3. **Would retiring it lose a capability nothing else provides?** No, verb by verb:
   `register`/`heartbeat`/`unregister` and JUnit ingestion are duplicated verbatim by the
   `*-crucible.py` fleet (`register` doubles as heartbeat; `auto-ingest` reads a reports directory).
   `project add` is the one command with no fleet-client equivalent — but `public/app.js`'s
   "+ Add project" form already does the identical `POST /api/v2/projects` operation from the SPA,
   and nothing has ever invoked the CLI's copy. `project list`/`events`/`status`/`dashboard`
   (the four TOON consumers) surface data already reachable via the fleet's `status`/`plans`/`queue`
   verbs, just not through this exact no-flag shape.

**A converted-to-JSON version would not be free of cost, either.** `ROLE_ENUM`
(`cli/crucible-axi.ts:170`) is a hand-typed literal copy of `src/types.ts`'s `AGENT_ROLES` — not
imported, not cross-checked by any test. Keeping the file alive keeps that drift risk alive with
it, for a tool nothing calls. This is the same cost argument §S1 makes for the server's TOON path,
applied one file over: the machinery is real, but nothing that matters depends on it, and the
correct fix is deletion, not repair.

## Acceptance criteria

**§S1**
- [ ] `reply()` answers JSON for every GET; `wantsToon`, `truncatedToon`, `jsonVariantUrl`,
      `TOON_MAX_BYTES`, the `toToon` import and `src/toon.ts` no longer exist — asserted by
      CONSTRUCTION, a scan that fails if any of those names reappears in `src/`.
- [ ] The server's `dependencies` object is EMPTY — asserted, because runtime-dependency-free is the
      outcome worth pinning, not an incidental.
- [ ] `@toon-format/toon` is present in `devDependencies` at its pinned version, and the client-emit
      oracle still imports and uses it. A CR that deleted it would take the surviving client
      conformance check with it.
- [ ] The server boots and serves with the dependency uninstalled: proved from a clean
      `bun install --production` (or equivalent) rather than from a tree that still has it cached.
- [ ] A GET with `?fmt=toon` answers **JSON, 200**, with `content-type: application/json` — inert,
      not refused, and not 406.
- [ ] A GET with `Accept: text/toon` does the same.
- [ ] `?fmt=json` still answers JSON, 200 — the documented escape hatch keeps working for callers
      who have it written down.
- [ ] Every one of the 16 `reply()` call sites (across 13 GET handlers — `handleEventsList` and
      `handleEventGet` each route through it more than once) returns the SAME JSON body
      byte-for-byte as before this CR — asserted against the live shape, since this CR must change
      no payload, only drop an encoding.
- [ ] `text/toon` appears nowhere in `src/`.

**§S2**
- [ ] Each of the six files is accounted for: assertions whose subject was server TOON deleted with
      the superseded claim named, assertions that merely used TOON as a reader retargeted to JSON.
      Stated per file; no file left half-converted.
- [ ] `tests/axi-negotiation.test.ts` KEEPS its five `help[]` hints tests (`:226`, `:232`, `:239`,
      `:257`, `:276`) and the zero-`Response.json(` guard at `:353`. Asserted by name — this file is
      the one a wholesale deletion would gut.
- [ ] `tests/toon-conformance.test.ts` KEEPS its client-emit oracle (`:469`, `:517`, `:542`) and it
      still passes — the clients' TOON must still be proved conformant by the official library, and
      this CR must not weaken that.
- [ ] `tests/roadmap-registration-routes.test.ts`'s 47 non-TOON tests are untouched, and the 2
      CR-CRU-108 §S1/AC3 TOON tests (`:1937`, `:1960`) are DELETED with the superseded claim named
      — their subject is the TOON encoding itself, and the fact they proved (`tracks` published
      under a stable name) stays proven by the JSON-only test immediately above them.
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
- [ ] `tests/docs-toon-conformance.test.ts` reads the pinned version from `devDependencies` and
      still asserts the DN names it — retargeted, not deleted, because the pin is still real.
- [ ] `DN-crucible-analytics.md:124` no longer tells CR-CRU-022's future implementer that TOON
      negotiation is the standard rule for a new route.
- [ ] No LIVE documentation still offers `?fmt=toon` as a capability — measured 2026-09-15 across
      `docs/research/`, `docs/RUNBOOK.md` and `clients/STATUS-CONTRACT.md`, with no permanent scan
      performing this check (unlike §S1/1's construction scan, this is a one-time sweep — a future
      edit could reintroduce a live promise with nothing going RED; recorded as a residual rather
      than built out, since the capability itself is gone from the code and there is no ongoing
      surface for the claim to drift from). **`docs/changes/*.md` is OUT OF SCOPE for this scan**,
      deliberately: it is the shipped-CR archive, never retro-edited, and CR-005/006/026/108
      correctly record `?fmt=toon` as true when they shipped. This CR's own spec file is likewise
      exempt — it necessarily names `?fmt=toon` throughout as the subject of the deletion it
      specifies. (An earlier draft of this AC said "asserted across `docs/`" with no exclusion,
      which a literal scan would have failed against this very sentence.)

**§S4**
- [ ] `cli/crucible-axi.ts` and `cli/package.json` no longer exist.
- [ ] `tests/cli-axi.test.ts` and `tests/cli-axi-role-flag.test.ts` no longer exist — 20 tests total
      (measured 2026-09-15; the spec's own earlier "~24" was an estimate, corrected here), deleted
      whole, not partially retargeted, since the retirement is of the artifact itself, not one
      behaviour inside it.
- [ ] **The carve-out §S2 already established applies here too.** `tests/cli-axi.test.ts` holds
      TWO subjects, not one: 15 tests on the retired Bun fleet CLI, and 3 (CR-CRU-066 §S4/AC6) on
      the SHIPPED PYTHON `crucible_axi` console script — a live drift guard asserting README/RUNBOOK
      document every verb `_COMMANDS` actually dispatches. That guard's subject survives; only its
      file is retired for an unrelated reason. The 3 tests are RELOCATED, verbatim, to
      `tests/docs-cli-surface.test.ts`, not deleted with the rest — found by RED during
      implementation; an earlier draft of this AC said the two files "no longer exist" with no
      exception, which would have silently dropped a live guard.
- [ ] The evidence for retirement is recorded in the Context, not merely asserted: the npm-registry
      absence, the PyPI/npm naming-collision identification, and the verb-by-verb redundancy check
      against the `*-crucible.py` fleet and `public/app.js`'s Add-project form.
- [ ] No other file references `cli/crucible-axi.ts`, `runCli`, or `cli/package.json` after the
      deletion — measured 2026-09-15 by a repo-wide scan, with the same one-time-sweep caveat as
      §S3's documentation check above (no permanent guard performs it); `clients/STATUS-CONTRACT.md`'s
      fleet-listing mention is updated to drop the sixth entry.


**Close-out**
- [ ] ONE re-record after the last content edit. The baseline is the tree AS THIS CR FINDS IT, not
      the post-CR-130 figures an earlier draft of this section recorded (`src` "710", symbols
      `LANDED_STATUSES`/`canonical_track`) — CR-CRU-131 landed since and moved all three: measured
      2026-09-15, `src` head is **725**, `public` **477**, `clients` **848**, and the two `src/store.ts`
      citations this section must confirm are `deriveQueueStatus` (`src/store.ts:5801`) and
      `normalizeTrack` (`:381-384`) — the names `LANDED_STATUSES`/`canonical_track` no longer exist
      in that file. RE-MEASURE `src` after this CR's edits — it will move DOWN as `src/v2.ts` loses
      its TOON block and `src/toon.ts` goes entirely, and the guard asserts a head is never BELOW its
      develop baseline of 512, so a falling head is the case to check rather than assume.
      `src/store.ts` is untouched by this CR, so `deriveQueueStatus` and `normalizeTrack` should hold
      at their CURRENT lines; confirm rather than assume.

## Estimated size

S/M — a deletion, in two parts. §S1–§S3 are the originally-scoped "S": one import, one constant,
three functions, one branch, one file, one dependency, and the coverage that pinned them. §S4 adds
a second, larger deletion found during implementation (a Dimension 6 miss in the original
gap-analysis, corrected 2026-09-15): a whole orphaned CLI, its package manifest, and 20 tests. The
care is in §S2's split, in not touching client-side TOON, and in §S4's evidence being measured
rather than assumed before a second artifact goes.

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
