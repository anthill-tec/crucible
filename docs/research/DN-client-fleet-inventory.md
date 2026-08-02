# DN — Client Fleet Function Inventory (CR-CRU-054 §S1)

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-08-02
**Status:** ACTIVE — the §S1 classification deliverable; normative input to CR-CRU-054 §S2 (lift)
and §S3 (drift guard). No production code moved to produce this document (§S1 is analysis-only).

## Method

The 42 function names CR-CRU-054 names as defined in all five `clients/*-crucible.py` were
extracted from each client via `ast.parse` (one occurrence per name confirmed in each of the
five files — no duplicate top-level defs). Each function's five bodies were diffed
programmatically (not eyeballed): the `def ...:` signature line was stripped, the remaining body
text was compared pairwise against `bun-crucible.py` as the baseline, and every non-identical
pair was inspected in full. A body that differs ONLY in docstring wording, comment wording, or a
purely internal loader-cache label (never observable outside the function) is still classified
SHARED — the classification tracks OBSERVABLE BEHAVIOUR, not prose.

## Category counts

| Category | Count | Names |
|---|---|---|
| **SHARED** | 27 | see §1 |
| **PARAMETERISED** | 1 | see §2 |
| **GENUINELY PER-CLIENT** | 6 | see §3 |
| **DRIFTED** 🚨 | 8 | see §4 — read this section first |

27 + 1 + 6 + 8 = 42. Every name partitions into exactly one category (asserted by
`tests/client/test_cr054_fleet_inventory.py`). `cmd_register` sits in DRIFTED, not
PARAMETERISED — it has a real behavioral inconsistency (§4 finding #3), and the
source-label question (§4 finding #5) is a second, related issue on the SAME function,
not grounds for a second bucket.

## §4 — DRIFTED (read first: these are latent defects, not classification noise)

Eight names (seven findings — #3 covers two names, `cmd_unregister` and `cmd_register`) are cases
the CR's own two-category scheme (SHARED / PARAMETERISED) has no name for: bodies that **should**
behave identically but do not, discovered only because this cycle diffed them programmatically
instead of trusting the "it's obviously the same helper" assumption. Each is named below with the
**exact per-client difference** and a **correctness verdict** — this is the finding CR-CRU-054's
own Context section predicts ("mvn was right, four were wrong").

### 1. `cmd_milestone` — bun writes its legacy line to STDOUT, not stderr

```python
# bun-crucible.py (WRONG)
print(f"milestone: ok={ok} type={args.type}" + ... )                 # no file= -> stdout

# rust / mvn / python / arduino (CORRECT)
print(f"milestone: ok={ok} type={args.type}" + ... , file=sys.stderr)
```
Every other verb in every client (including bun's own `cmd_register`, `cmd_status`, etc.) keeps
the human-readable "legacy" line off stdout so stdout stays a clean machine channel (TOON /
future JSON). `cmd_milestone` never calls `_emit_axi` at all (bare `print`), and bun is the only
client that leaves that bare print on stdout. **Verdict: rust/mvn/python/arduino are correct; bun
is the drift.** A caller parsing bun's `milestone` stdout as machine output gets a corrupted
stream mixed with a prose line.

### 2. `cmd_plan_file` — `context.cr` populated inconsistently across all five

The §S1 envelope context schema (`_crucible_axi.axi_context`) documents `cr` as a first-class
context field. `cmd_plan_file`'s two `_emit_axi(...)` call sites (the "no resolvable wave/title"
failure-adjacent path is unaffected; this is the **plan-resolution failure** path and the
**success** path) populate it differently per client:

| Client | Failure-path `context.cr` | Success-path `context.cr` |
|---|---|---|
| bun | ❌ omitted | ❌ omitted |
| rust | ❌ omitted | ✅ `resp.get("cr") or args.cr` |
| python | ❌ omitted | ✅ `resp.get("cr") or args.cr` |
| mvn | ✅ `args.cr` | ✅ `resp.get("cr") or args.cr` |
| arduino | ✅ `args.cr` | ✅ `resp.get("cr") or args.cr` |

**Verdict: mvn and arduino are fully correct (both paths carry `cr`); rust and python are half
right (success only); bun never carries it.** This is a five-way split on ONE line of behavior —
exactly the drift class CR-CRU-054's Context section warns about (cf. CR-CRU-044 §S3's `--phase`
drift). When lifted, the shared `cmd_plan_file` must carry `cr` in **every** emitted envelope for
this verb, on both paths.

### 3. `cmd_unregister` and `cmd_register` (2 names) — the missing-`--agent` case bypasses the AXI envelope in 4 of 5 clients

bun, rust, mvn and python declare `--agent` as `required=True` at the **argparse** level on both
the `register` and `unregister` subparsers. arduino instead leaves `--agent` optional there and
resolves it at runtime through the fleet's own `_agent_id(args)` → `_crucible_axi.require_agent_id`
— the SAME hard-stop path CR-CRU-044 §S5 / CR-CRU-056 §S2b established for every OTHER mutating
verb (`stop`, `checkpoint`, `abort`, `cr-close`, the gate verbs, …), which converts a missing
identity into a proper `ok:false` §S1 envelope + non-zero exit.

Consequence: on `bun-crucible.py register` (no `--agent`), the caller gets argparse's bare usage
error on stderr and **no TOON envelope on stdout at all** — a different failure shape than every
other hard-stopped verb in the same client. On `arduino-crucible.py register` (no `--agent`), the
caller gets the SAME uniform `ok:false` envelope as a missing-agent `stop` or `checkpoint`.

**Verdict: arduino's runtime-resolved pattern is the one consistent with the fleet's own §S5
convention; bun/rust/mvn/python's argparse `required=True` shortcut for register/unregister
specifically is the drift** — it functionally prevents the missing-agent case but produces a
non-AXI failure shape unlike every other verb in those same four clients.

### 4. `_open_gate_identity` (a DIFFERENT function from `cmd_register`) — the gated-run identity `source` label: mvn is the lone client that sets it explicitly

`GatedRunIdentity.open_payload(project_key, message=..., source="claude-md")` (the shared
module, CR-CRU-030) defaults `source` to `"claude-md"`. Every client calls
`identity.open_payload(_project_key(project_dir), message=message)` — taking that default —
**except mvn**, which passes `source="openclaw"` explicitly.

This matters because **three of the five clients' own `cmd_register`** (rust, mvn, arduino;
below) hardcode `"identity": {"displayName": ..., "source": "openclaw"}}` for a **plain**
register/heartbeat — i.e. mvn's gated-run identity source (`"openclaw"`) matches its OWN plain
registration convention, while bun's, rust's, python's and arduino's gated-run identity
(`"claude-md"`, the shared default) does **not** match rust's and arduino's own plain
registration convention (`"openclaw"`). A gated `test`/`regression`/`pre-merge-gate` run on rust
or arduino shows up on the dashboard with a DIFFERENT source label than a plain `register` run
from the same client.

**Verdict: mvn is internally consistent (matches CR-050's precedent shape — one client quietly
correct while the rest drifted); the other four should decide ONE canonical source label for
gated-run identities and apply it uniformly** rather than inherit the shared module's generic
default by omission. Flagged for the orchestrator's decision at lift time, not fixed here.

### 5. `cmd_register` (second, related issue on the same name as finding #3) — two different `source` strategies, not just two values

Beyond finding #4's identity-source split (a different function, `_open_gate_identity`),
`cmd_register` itself has TWO shapes:
- **bun, python** delegate to a private `_register_agent(...)` helper and expose a
  `--source` CLI flag, `default="claude-md"` (configurable per invocation).
- **rust, mvn, arduino** build the register payload inline and hardcode
  `"identity": {"displayName": args.agent, "source": "openclaw"}` (fixed, no flag, no override).

Neither is "wrong" in isolation (both are legitimate registration strategies), but they cannot
both survive a lift unmodified: `_crucible_axi.py` must pick ONE (a configurable `--source` with
a fleet-wide default, or a fixed value) for the shared `cmd_register`, and whichever loses its
current behavior needs a call-out in CR-CRU-054 §S2/§S4's compatibility check — this is a
**PARAMETERISED-shaped difference wearing a GENUINELY-PER-CLIENT structural disguise** (two call
patterns, not two constants), which is exactly why §S1 insists on diffing bodies instead of
eyeballing them.

### 6. `_remove_agent_silent` / `_close_gate_identity` — a paired defect: robustness vs. honest reporting

`_remove_agent_silent`:
```python
# bun (no exception handling)
return _post("/api/v2/agents/unregister", {...})

# rust / mvn / python / arduino (defensive)
try:
    _post("/api/v2/agents/unregister", {...})
except Exception:
    pass
```
rust/mvn/python/arduino's docstrings say "Best-effort: never raises... **Mirrors
clients/bun-crucible.py's `_remove_agent_silent`**" — but bun's actual body has NO try/except, so
that claim is false today: bun can raise out of a gated run's cleanup step (a real, if rare, crash
risk the other four already fixed).

That fix has a cost, visible in `_close_gate_identity`:
```python
# bun — reports the ACTUAL outcome
cleanup_resp = _remove_agent_silent(project_dir, identity.agent_id)
print(f"cleanup: ok={cleanup_resp.get('ok', False)} agent={identity.agent_id}", file=sys.stderr)

# rust / mvn / python / arduino — reports a FIXED, possibly false, message
_remove_agent_silent(project_dir, identity.agent_id)   # return value now discarded
print(f"cleanup: agent={identity.agent_id} removed (created by this run)", file=sys.stderr)
```
Because the four wrap the POST in a swallowing `except Exception: pass`, `_remove_agent_silent`
returns `None` to them, so `_close_gate_identity` can no longer report the real result — it prints
"removed" **unconditionally**, even when the swallowed exception means nothing was removed.
bun's version is the only one that reports what actually happened, but it is also the only one
that can crash the closing bracket if `_post` raises something other than `HTTPError`/`URLError`.

**Verdict: no single client has this fully right.** The correct shared behavior (for §S2) combines
both: catch the exception (rust/mvn/python/arduino's fix) AND still capture and report whether the
call actually succeeded before any exception occurred (bun's honesty) — e.g. a per-call try/except
that captures `ok=` from the response when reachable and reports "attempted, outcome unknown" only
on a genuine transport failure, never a blanket "removed."

### 7. `_request` — arduino tolerates an empty response body; the other four do not

```python
# bun / rust / mvn / python
return json.loads(urllib.request.urlopen(req, timeout=timeout).read())

# arduino
with urllib.request.urlopen(req, timeout=timeout) as r:
    body = r.read().decode()
return json.loads(body) if body else {"ok": True}
```
A 200 response with an empty body (unusual, but not excluded by the HTTP contract in
DN-crucible-api-reconstruction.md §1) makes `json.loads(b"")` raise `json.JSONDecodeError` in
bun/rust/mvn/python — an UNCAUGHT exception (neither `except` clause here catches a decode error),
which would propagate out of `_request` and crash the calling verb. arduino's body-presence check
avoids this entirely.

**Verdict: arduino's handling is the more defensive/correct one; the other four share a latent
crash-on-empty-body bug.** Low probability (the Crucible server always returns a JSON body today)
but a real inconsistency between five otherwise-identical HTTP helpers, and the same class of
finding as CR-050's `mvn-crucible.py:641` `<skipped/>` precedent — the CORRECT behavior sat in the
client everyone assumed was just "the odd one out."

## §1 — SHARED (27) — lifts as-is, cosmetic differences only

All of these are byte-equivalent in observable behavior; differences found are limited to
docstring/comment wording, a per-client `_HELP_STEPS`/`_gate_from_axi` local-alias spelling vs.
calling `_axi().HELP_STEPS`/`_axi().gate_from_axi()` directly (bun keeps its own **duplicate**
module-level `_HELP_STEPS`/`_PREFER_GATE_RUN_WARNING` dict — see the note below), and (for several
functions) arduino's `_project_dir(args)` vs. the other four's `_resolve_project_dir(args.project_dir)`
— a naming difference in a helper OUTSIDE the 42 (not itself in scope), noted here because several
SHARED functions call it and the shared lift must accept an already-resolved `project_dir` (the
`_axi_context`/`axi_context` scope-boundary pattern already established by CR-CRU-030) rather than
depend on either name.

`_abbrev_home`, `_add_gate_cycle_arg`, `_agent_id`, `_axi`, `_axi_context`, `cmd_abort`,
`cmd_checkpoint`, `cmd_cr_close`, `cmd_cycle_activate`, `cmd_cycle_add`, `cmd_cycle_done`,
`cmd_gate_report`, `cmd_gate_run`, `cmd_status`, `cmd_stop`, `_cycle_transition`, `_emit_axi`,
`_get`, `_open_plans`, `_patch`, `_plans_path`, `_post`, `_post_gate`, `_post_milestone`,
`_resolve_plan_or_emit`, `_run_context`, `_toon`

Notable per-name specifics:
- `_axi` / `_toon`: the ONLY per-client-varying token is the `importlib.util.spec_from_file_location`
  cache-key STRING (e.g. `"bun_crucible_axi_shared"` vs `"rust_crucible_axi_shared"`) — an internal
  loader label never observed outside the function. Lift with a label derived from `__name__`, not
  a hardcoded per-client string, so this stops being even a cosmetic difference.
- **Residual un-lifted constants (not in the 42, but load-bearing for several SHARED functions
  above):** `bun-crucible.py` defines its OWN full-literal `_HELP_STEPS` (line 1530) and
  `_PREFER_GATE_RUN_WARNING` (line 1682) dicts, byte-identical TODAY to `_crucible_axi.HELP_STEPS`
  / `.PREFER_GATE_RUN_WARNING` but never delegated to them — the other four clients call
  `_axi().HELP_STEPS` / `_axi().PREFER_GATE_RUN_WARNING` directly. This is exactly the kind of
  un-deduplicated constant CR-CRU-054 exists to remove; it is not one of the 42 named functions,
  but §S2 should retire bun's private copies onto the same shared constants while it is in the
  neighborhood.

## §2 — PARAMETERISED (1) — same shape, named per-client constants

| Function | What varies | Per-client values |
|---|---|---|
| `cmd_dashboard` | the `argparse.Namespace(...)` fields it hand-builds to call `cmd_status` | mvn passes `project_dir=None, maven_dir=None, fields=None` (mvn's own `cmd_status` takes an extra `maven_dir` field for its module-dir convention); bun/rust/python/arduino pass `project_dir=None, fields=None` |

(`cmd_register`'s `source` strategy is a second, related issue on a function already
classified DRIFTED for a more serious reason — see §4 findings #3 and #5 — so it is not
double-counted here.)

## §3 — GENUINELY PER-CLIENT (6) — real runner differences, justified

| Function | Why it must stay per-client |
|---|---|
| `cmd_auto_ingest` | 13–38 lines across the fleet: junit-if-present vs. `cargo check` stderr vs. coverage-tool invocation — the exact per-toolchain fallback chain named in the CR's own Non-goals |
| `cmd_check` | Compile/lint-gate invocation is 100% toolchain-specific (`tsc`, `py_compile`, `cargo check`, mvn compile, arduino-cli compile via arduino's own `_compile_gate` tier helper — arduino's `cmd_check` is a 4-line delegator to it) |
| `cmd_pre_merge_gate` | Confirmed by full-body read: mvn runs a docker-up/regression/docker-down bracket; rust runs a workspace clippy gate then `cmd_workspace_regression`; bun/python/arduino run a check-then-regression pair, each with a `Namespace` shaped by that stack's OWN `cmd_check`/`cmd_regression` signature. No shared shape survives past "run a fail-fast pre-step, then run regression." |
| `cmd_test` | 4–75 lines: `bun test` vs. pytest/unittest+xmlrunner vs. cargo-nextest vs. maven surefire vs. arduino's native-tier delegator (`_run_native_tests(args, "test", "unit", False)`) |
| `main` | 183–452 lines: argparse subcommand wiring is inherently per-toolchain (different flag sets per verb per stack) |
| `_project_key` | arduino delegates to its own `_load_env(pd)` — which ALSO reads `CRUCIBLE_PROJECT_NAME` (needed for arduino's unique `_ensure_project`/`POST /api/projects/add` self-registration, per DN-crucible-api-reconstruction.md §4) and additionally falls back to the ambient environment when the `.env` file lacks a key. bun/rust/mvn/python's `_project_key` is a strict single-key `.env`-only read with `sys.exit` on absence. Real, justified divergence tied to arduino's unique bootstrap responsibility — not a candidate for a shared PARAMETERISED lift without also lifting `_load_env`/`_ensure_project`, which is out of this CR's 42. |

## Functions I could not confidently classify

None. All 42 were found in exactly one occurrence in all five clients, and every occurrence was
either read in full or confirmed byte-identical to `bun-crucible.py`'s body after signature
normalization.

## Consequence for §S2 (informational — no code moved here)

Every DRIFTED entry above is a decision point for whoever writes §S2, not a defect this cycle
fixes: §S1's job is the classification, and the Scope section is explicit that §S2 is a separate
step. The eight DRIFTED names should be resolved (which behavior wins) **before** or **as part
of** the lift, never silently — lifting the "obviously correct" one without recording the decision
would repeat exactly the failure mode CR-CRU-054 exists to stop.
