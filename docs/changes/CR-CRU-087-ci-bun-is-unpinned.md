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
`tests/clients-bun-crucible.test.ts:696-701` asserts that a timed-out leaf carries **no**
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

**Root cause: the toolchain is unpinned.** All five `oven-sh/setup-bun@v2` steps in `release.yml` name
no `bun-version` (`grep -rn bun-version .github/` → nothing), so CI silently tracks the newest bun
while local development sits on 1.3.14. Tests that parse bun's own console format are therefore
contract-bearing against an input that changes without a commit. This is a class defect, not one
test's bad luck: `§S1b (CR-CRU-055)` already records one such flip (an uncoloured pipe emitting a
second legal wire form), which was absorbed by widening the matchers.

**The assertion is also over-specified.** It defends an ABSENCE that was an artifact of one version's
line ordering. Carrying `"test timed out"` is *better* data than carrying nothing; what actually
matters is that a married message belongs to the leaf it is attached to.

## Scope

### §S1 Pin the toolchain

Every `setup-bun` step in `.github/workflows/**` names an explicit `bun-version` equal to the version
the repo develops on. A bun upgrade then becomes a deliberate, reviewable commit that re-runs the
format-parsing suites, instead of an invisible input change that reds the gate overnight.

### §S2 Assert attribution, not absence

The §S2c timeout case is re-specified: a timed-out leaf **may** carry bun's own detail, and what is
pinned is that any married message is **that leaf's own** — never a neighbour's, and never a block
that crossed a completed test. The existing cross-leaf boundary guarantee
(`_RESULT_BOUNDARY_LINE`, `clients/bun-crucible.py:576-578`) is the invariant worth defending.

### §S3 Both orderings are known shapes, tested as fixtures

The parser's accepted wire forms are already enumerated in its header (`:540-564`). The
timeout-detail-BEFORE-fail ordering is added as a third known shape, and both orderings are exercised
as **fixtures** — so version-robustness is proven without depending on which bun the runner installed.

## Acceptance criteria

- **AC1** — every `setup-bun` step in `.github/workflows/**` pins `bun-version`; the pinned value
  equals the locally developed version (`1.3.14` at filing). No step is left floating.
- **AC2** — the §S2c timeout assertion no longer asserts `toBeUndefined()`. It asserts attribution:
  when a message is present it is the timed-out leaf's own, and no other leaf gains a message it did
  not produce.
- **AC3** — `_parse_console_failures` is exercised against BOTH orderings as fixtures — detail before
  the `(fail)` line and detail after it — and the leaf-attribution assertions hold in both, so the
  suite's verdict does not depend on the runner's bun.
- **AC4** — the cross-leaf guarantee is unchanged: a detail block never marries onto a later leaf
  (the existing §S2c matched-failure tests stay green, unmodified).
- **AC5** — `test-bun` is GREEN in CI on a push to `develop`, and `publish-pypi`/`publish-npm` are no
  longer skipped for this reason. This is the observable gate; a local green does not close this CR.
- **AC6** — the pin is documented where an operator will meet it (the workflow comment and
  `RELEASING.md`): bumping bun is a deliberate change that must re-run the client-format suites.

## Estimated size

S — a pin in five workflow steps, one re-specified assertion, and a second fixture ordering.

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
