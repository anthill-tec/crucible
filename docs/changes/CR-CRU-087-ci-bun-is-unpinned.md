# CR-CRU-087 — CI floats to the newest bun, so a format-parsing test flips and blocks every publish

- **Type**: bugfix
- **Wave**: 5
- **Depends on**: —
- **Status**: PENDING

## Problem

`test-bun` has been RED in CI since at least 2026-08-22 while the same suite is green locally on every
run — measured today: local `bun test` 1563 passed / 0 failed / 1 skip (125 files), CI `test-bun`
**failure** on run 32565982939 with every other job green.

Because `publish-pypi` and `publish-npm` `needs: [build, test-bun, test-python, test-e2e]`
(`.github/workflows/release.yml:201`), a red `test-bun` **skips both publish jobs by construction**.
So the current state is: 0.2.0 cannot ship, and the reason is not a product defect.

**One test fails, and it fails on an environment difference, not on behaviour.**
`tests/clients-bun-crucible.test.ts:696-701` (pre-fix line reference — the assertion was
re-specified by this CR, so the citation resolves only against the commit that filed it) asserts that
a timed-out leaf carries **no**
`failure.message`:

```
expect(timedOut?.failure?.message).toBeUndefined();
```

CI's actual value, read from the run log: `Received: "test timed out"`.

**Mechanism.** `_parse_console_failures` (`clients/bun-crucible.py:587-631`) marries bun's console
`error:` block to the **next** `(fail)` line, because bun's JUnit reporter writes a bare
`<failure type="…"/>` for every failure kind and the human detail exists only on the console stream.
The docstring states the assumption explicitly: *"Detail printed AFTER the fail line (e.g. a timeout's
`^ this test timed out after Nms.`) is structurally NOT a preceding block and stays unmatched."* That
holds on the version this repo develops on (`bun 1.3.14`) and does **not** hold on the newer bun CI
installs, which emits the timeout detail where the parser marries it.

**Root cause: the version CI resolves is an open-ended range, not a pin.** Read from
`oven-sh/setup-bun@v2`'s own documented resolution order, with no `bun-version` given it takes
(1) `package.json`'s `packageManager` field, (2) `package.json`'s `engines.bun`, (3) otherwise
`latest`. This repo has no `packageManager` field and declares `"engines": { "bun": ">=1.2" }`
(`package.json:20-22`), so all **four** steps (`release.yml:73, :130, :271, :317` — a fifth textual match at `:76` is a comment) resolve through an **open range that matches every current
release** — CI tracks the newest bun while local development sits on 1.3.14, with no commit in
between. Tests that parse bun's own console format are therefore contract-bearing against an input
that changes on bun's release schedule. This is a class defect, not one test's bad luck:
`§S1b (CR-CRU-055)` already records one such flip (an uncoloured pipe emitting a second legal wire
form), which was absorbed by widening the matchers.

**On the ordering claim, stated honestly:** that the newer bun prints the timeout detail BEFORE the
`(fail)` line is DEDUCED, not observed on that version — the parser's only path to a message is an
`error:` block preceding a fail line, and CI produced one. §S3's fixtures make the fix independent of
which bun any runner installs, so nothing rests on the deduction.

**The gating is correct and must not be "fixed".** `publish-pypi` (`:201`) and `publish-npm` (`:260`)
both `needs: [build, test-bun, test-python, test-e2e]` **by design** — CR-062 §S4 made the dependency
graph the gate so a failed suite blocks a publish by construction rather than by discipline. This CR
fixes the red suite; it must not loosen the graph.

**The assertion is also over-specified.** It defends an ABSENCE that was an artifact of one version's
line ordering. Carrying `"test timed out"` is *better* data than carrying nothing; what actually
matters is that a married message belongs to the leaf it is attached to.

## Gap analysis (2026-08-23, pre-RED) — READY (after the corrections folded in above)

Run per the `gap-analysis` skill, all six dimensions. This CR was filed hours earlier in the same
session and its own analysis corrected it twice — recorded rather than quietly rewritten.

- **D4 — the spec reinvented a mechanism that already exists.** As filed, §S1 said "every `setup-bun`
  step names an explicit `bun-version`" — four near-duplicate YAML edits. `setup-bun@v2`'s documented
  resolution order reads `package.json`'s `packageManager` FIRST, so ONE line pins all four jobs with
  no workflow change. Corrected in §S1/AC1.
- **D2 — the "no pin at all" premise was wrong.** `package.json:20-22` already declares
  `"engines": { "bun": ">=1.2" }`, which `setup-bun` consumes as step 2 of its order. So CI is not
  falling through to `latest` for lack of any declaration; it is resolving an OPEN RANGE. The
  observable outcome is the same, the mechanism is not, and the fix differs. Corrected in Problem.
- **D3 — the gating is design, not collateral.** `publish-pypi` (`:201`) and `publish-npm` (`:260`)
  gate on all three suites deliberately (CR-062 §S4: "the gate IS the dependency graph"). The spec now
  says so explicitly, so no one relaxes `needs:` to unblock a release.
- **D2 — every cited line verified:** the failing assertion at
  `tests/clients-bun-crucible.test.ts:696-701`; the parser at `clients/bun-crucible.py:587-631` with
  its boundary guard at `:576-578`; **four** `setup-bun` steps (`:73, :130, :271, :317`; the `:76` hit is a comment — a filing-time `grep -c` miscounted it as five) and zero `bun-version` occurrences in
  `.github/`; local `bun --version` = 1.3.14; CI's received value `"test timed out"` from run
  32565982939.
- **D1 — no design conflict.** `DN-release-process.md` mandates no toolchain policy, so this adds a
  rule where the DN is silent; its §4 "treat a skip as a failed gate" is consistent with AC5 refusing
  to close on a local green.
- **D5/D6 — nothing retired, no public symbol removed.** The parser's algorithm is untouched; only a
  test's version-specific assumption changes.
- **Adjacent, deliberately out of scope:** `astral-sh/setup-uv@v6` is unpinned in the same workflow —
  the identical class. The python suite is green, so folding it in would be scope growth; noted for the
  next SCRUM.

## Scope

### §S1 One declaration, consumed by every job

The version lives in **one** place: `package.json`'s `packageManager` field, pinned to the exact
version the repo develops on (`bun@1.3.14`). `setup-bun` reads that field FIRST, so all four steps
inherit it with **no workflow edit and nothing duplicated** — a pin repeated in four steps is four
places to drift.

`engines.bun` keeps its own, different meaning: the compatibility FLOOR consumers must satisfy
(`>=1.2`). The two are complementary — "what we support" vs "what we build and test with" — and only
the latter may be exact. A bun upgrade then becomes a one-line reviewable commit that re-runs the
format-parsing suites, instead of an invisible input change that reds the gate overnight.

### §S2 Assert attribution, not absence

The §S2c timeout case is re-specified: a timed-out leaf **may** carry bun's own detail, and what is
pinned is that any married message is **that leaf's own** — never a neighbour's, and never a block
that crossed a completed test. The existing cross-leaf boundary guarantee
(`_RESULT_BOUNDARY_LINE`, `clients/bun-crucible.py:576-578`) is the invariant worth defending.

### §S3 Both orderings are known shapes, tested as fixtures

The parser's accepted wire forms are already enumerated in its header (`:544-564`). The
timeout-detail-BEFORE-fail ordering is added as a third known shape, and both orderings are exercised
as **fixtures** — so version-robustness is proven without depending on which bun the runner installed.

## Acceptance criteria

- **AC1** — `package.json` declares `"packageManager": "bun@<exact>"` at the version the repo develops
  on (`1.3.14` at filing), and `engines.bun` is left as the compatibility floor. No `bun-version` is
  added to any workflow step: the single declaration is what all four `setup-bun` steps resolve, which
  a test asserts (`tests/suite-integrity.test.ts`) rather than a reviewer eyeballing YAML blocks.
- **AC1b** — the resolved version is observable in CI: the `setup-bun` step's `bun-version` output (or
  a `bun --version` line in the job log) reads `1.3.14`, proving the declaration is what the runner
  actually installed and not merely what the file says.
- **AC2** — the §S2c timeout assertion no longer asserts `toBeUndefined()`. It asserts attribution:
  when a message is present it is the timed-out leaf's own, and no other leaf gains a message it did
  not produce.
- **AC3** — `_parse_console_failures` is exercised against BOTH orderings as fixtures — detail before
  the `(fail)` line and detail after it — and the leaf-attribution assertions hold in both, so the
  suite's verdict does not depend on the runner's bun.
- **AC4** — the cross-leaf guarantee is asserted for the shapes the parser handles correctly today: a
  pending detail block is ended by a `(pass)`/`(skip)`/`(todo)` boundary and never marries backwards.
  The existing §S2c matched-failure tests stay green, unmodified.
  **AC4 as filed was wrong and is corrected here.** It claimed the cross-leaf guarantee "is
  unchanged", i.e. that it held. C2 measured that it does **not**: an `error:` block printed AFTER its
  own leaf's `(fail)` line and BEFORE the next leaf's marries onto that **later** leaf. Not
  hypothetical — reproduced on bun 1.3.14, where a leaked async throw prints
  `error: leaked boom` between the two fail lines and the ingested tree reports it as the NEXT test's
  failure message. Fixing it needs a way to tell "alpha's aftermath" from "beta's prelude", which are
  positionally identical in bun's stream — a design question, not a wording fix. It is therefore
  **out of scope here and recorded in the deferred register** (`docs/changes/README.md`,
  *Deferred — post-0.2.0*) as a **candidate CR to raise at the next SCRUM**; this CR does not pretend
  the invariant holds, and no forward-marrying guard is committed red. What DOES ship is a
  **characterisation** test pinning the current defective attribution on the real captured bytes
  (`tests/client/test_cr087_console_failure_attribution.py`,
  `test_characterisation_leaked_async_throw_bleeds_forward_onto_next_leaf`), so the fix has a
  tripwire.
- **AC5** — `test-bun` is GREEN in CI on a push to `develop`, and `publish-pypi`/`publish-npm` are no
  longer skipped for this reason. This is the observable gate; a local green does not close this CR.
- **AC6** — the pin is documented where an operator will meet it: `RELEASING.md` carries the bump
  procedure, and the invariant test's own header comment carries the mechanism. (`package.json` is
  JSON and cannot hold a comment — the filed wording asked for an impossible one.) `engines.bun` vs
  `packageManager` — floor vs build version — is stated so a future reader does not "tidy" one into
  the other.

## Estimated size

S — one `packageManager` line, one re-specified assertion, a second fixture ordering, and a check that
the declaration is what CI resolves.

## Risk

Pinning can mask a genuine incompatibility with a newer bun. Mitigated by design: the pin is a
decision point, not a freeze, and AC3 makes the parser prove itself against both orderings — so a
future bump is a one-line change plus a suite run, not an investigation.

The opposite risk is worse and is what filing this CR avoids: leaving CI floating means the release
gate can turn red between two runs with no commit in between, and the first symptom is a skipped
publish on release day.

## Non-goals

- Redesigning the failure-marrying algorithm — the boundary logic is correct; only the timeout
  assumption baked into a test is wrong.
- Upgrading bun as such, or chasing the newest version.
- The other client stacks' parsers (python/mvn/rust/arduino) — none of them parses bun's console form.
- The deferred provenance-repair shrink item (queue register, separate candidate CR).
