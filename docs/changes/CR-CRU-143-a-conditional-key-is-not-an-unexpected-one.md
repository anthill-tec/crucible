# CR-CRU-143 — a conditional key is not an unexpected one

**Type** hotfix · **Wave** 7 (0.2.2) · **Depends on** CR-CRU-138 · **Status** PENDING

## Problem

The pre-merge gate for CR-CRU-137 failed on this branch with two python failures and 2539/0 on the
bun side. Neither failure belongs to CR-CRU-137, and neither is a defect in shipped code:

```
FAIL test_cr090_fleet_stage.ManifestPublishedPathsResolveTest
       .test_the_manifest_shape_is_unchanged_by_this_cr            (:810)
FAIL test_crucible_axi_install.InstallIdempotencyTest
       .test_running_install_twice_does_not_duplicate_the_manifest_file  (:606)
pre-merge-gate: ok=False suites=4 passed=4485 failed=2 total=4488
```

Both assert **exact set equality** between the install manifest's top-level keys and
`tests/client/manifest_contract.py`'s `EXPECTED_MANIFEST_KEYS`:

```python
self.assertEqual(EXPECTED_MANIFEST_KEYS, set(self.document))        # :810
self.assertEqual(set(reparsed.keys()), set(EXPECTED_MANIFEST_KEYS)) # :606
```

That constant documents the **unconditional** keys, and says so in its own words
(`manifest_contract.py:36-41`):

> `server_config` (CR-CRU-138 §S2) is deliberately NOT here. It is CONDITIONAL — published only
> when the server was really provisioned locally… Listing it unconditionally would require
> publishing a path that does not exist, which is the dangling-path defect CR-CRU-090 closed.

So the constant is right and CR-CRU-138's conditional key is right. The defect is the **assertion
shape**: exact equality against a set that is explicitly only the unconditional half means the test
fails the moment the conditional key legitimately appears.

**It is environment-dependent, which is why it shipped.** `crucible_axi.install.server_config_plan()`
publishes `server_config` only when a server is provisioned on the machine. On a CI runner nothing
is provisioned, the key is absent, and exact equality holds — `test-python` is **green** in CI run
`35192142593`. On a workstation that has run `crucible-axi install`, the key is present and both
tests fail. Measured: red on this branch, red at CR-CRU-139's branch point (`8b9291a`), and
`origin/master`'s own copy of `test_cr090_fleet_stage.py` contains no `server_config` expectation
either — so **master's gate is red today** and has been since 0.2.1 shipped. Nothing caught it
because the gate had not been run on a provisioned machine since.

This is exactly the failure class CR-CRU-131 §S1c named for the SERVER's configuration — *"green
here, red there, surfacing at gate time wearing an unrelated face"* — and that CR-CRU-138 §S2's own
guard (`no python suite may resolve the checkout's configuration`) was written to prevent for the
clients. The same hazard walked back in through an assertion's shape rather than through a path.

## Scope

### §S1 — the manifest's unconditional keys are asserted as a floor, its conditional key by its own condition

The two assertions stop demanding exact equality against the unconditional set. The invariant they
exist to hold — CR-CRU-090's "nothing was silently ADDED" — is kept, but expressed so a key that is
conditional **by contract** is judged against its condition rather than counted as an intruder:

- every key in `EXPECTED_MANIFEST_KEYS` is present (the floor CR-CRU-090 established);
- no key outside `EXPECTED_MANIFEST_KEYS ∪ {the documented conditional keys}` appears — so a genuinely
  unexpected addition still fails, which is the whole point of the original assertion;
- `server_config` is asserted **by its condition**: present exactly when the install provisioned a
  server locally, absent when it did not, with the reason reported rather than the key invented.

The conditional set lives beside `EXPECTED_MANIFEST_KEYS` in `tests/client/manifest_contract.py`, so
the two halves of the contract are declared in one place and a future conditional key is added once,
not per assertion site.

### §S2 — the suite states which shape it is running in

A test whose outcome depends on whether the host has a provisioned server must say so, or the next
person to see it fail will re-diagnose this from scratch. Both tests make the provisioned-ness they
assume explicit — either by controlling it in the fixture (preferred: the install sandbox these
tests already build) or by reading it and asserting the matching branch. A test that silently means
two different things on two machines is the defect, not the environment.

## Acceptance criteria

**§S1**
- [ ] `tests/client/manifest_contract.py` declares the conditional key(s) beside
      `EXPECTED_MANIFEST_KEYS`, with the condition stated, and nothing duplicates that list at an
      assertion site.
- [ ] `test_cr090_fleet_stage.py`'s `test_the_manifest_shape_is_unchanged_by_this_cr` passes on a
      machine WITH a provisioned server and on one WITHOUT, and still fails if a key outside the
      unconditional ∪ conditional sets appears — proven by a probe that adds such a key.
- [ ] `test_crucible_axi_install.py`'s `test_running_install_twice_does_not_duplicate_the_manifest_file`
      likewise, keeping its own contract intact: a second install rewrites the SAME manifest and the
      content stays a single parseable JSON document.
- [ ] `server_config` is asserted by its CONDITION in at least one of the two: present when the
      install provisioned a server, absent with a stated reason when it did not.

**§S2**
- [ ] Each of the two tests states, in the test or its fixture, which provisioned-ness it runs under,
      and does not depend on ambient machine state to decide its meaning.
- [ ] `pre-merge-gate` reaches `ok=True` on this branch — evidenced by the gate's own envelope, on
      the machine where it currently fails.

## Estimated size

Small. Two assertions and one shared declaration; no production code changes — `build_manifest`'s
conditional publication (CR-CRU-138 §S2) is correct and is not touched.

## Risk

- **Loosening the assertion could hide a real addition.** The original exact-equality check was
  guarding CR-CRU-090's dangling-path defect. That is why the replacement keeps a closed upper
  bound (unconditional ∪ conditional) rather than becoming a bare subset check, and why an
  out-of-contract key must be proven to still fail.

## Non-goals

- Any change to `build_manifest` or `server_config_plan()`. The conditional publication is the
  designed behaviour (CR-CRU-138 §S2) and the dangling-path alternative was already refused.
- Making `server_config` unconditional. That is the defect CR-CRU-090 closed.
