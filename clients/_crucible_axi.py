"""CR-CRU-030 §S1 — the shared TOON-AXI envelope module for the client fleet.

Historically the five `*-crucible.py` clients did NOT share code — each
standalone client duplicated its own lifecycle/`.env`/context helpers, and the
`_emit_axi`/`_axi_context` envelope builders existed only in `bun-crucible.py`.
This module factors that envelope machinery out so every client imports it and
emits a byte-identical §S1 envelope:

    axi:
      verb: <name>
      ok: <bool>
      <verb-specific result fields>
      context: { projectKey, agentId?, cycleId?, wave, cr, track?, orchestrator? }
      warnings[]{code,detail}

Scope boundary (per the CR-CRU-030 RED escalation): `axi_context` takes an
ALREADY-RESOLVED `project_key` string, not a project dir — `.env`/project-dir
resolution stays client-specific (each client owns its filesystem layout), so
the shared module never touches the filesystem for key resolution.

The module is loaded by file path by the hyphen-named clients (which are not
importable as normal module names), so it keeps zero hard dependencies on
being on `sys.path`; it loads the sibling `clients/toon.py` codec by path the
same way the clients do.
"""

import importlib.util
import os
import sys

# Sentinel distinguishing "cycle_id not supplied" (omit the key) from an
# explicit `cycle_id=None` (emit an EXPLICIT null — the §S3 orphan signal).
AXI_UNSET = object()

_TOON_MOD = None


def _toon():
    """Lazily load the sibling `clients/toon.py` (C4) TOON codec by file path.

    `_crucible_axi.py` sits next to `toon.py` in `clients/`, but the clients
    that load this module do so by path (hyphenated filenames), so `toon.py`
    is not guaranteed to be on `sys.path` for a plain `import`."""
    global _TOON_MOD
    if _TOON_MOD is None:
        toon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "toon.py")
        spec = importlib.util.spec_from_file_location("crucible_axi_toon", toon_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load TOON codec at {toon_path}")
        _TOON_MOD = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_TOON_MOD)
    return _TOON_MOD


def axi_context(project_key, agent_id=None, cr=None, cycle_id=AXI_UNSET):
    """Build the §S1 envelope `context` from an already-resolved project_key
    plus optional agent_id/cr/cycle_id and env (WORKFLOW_WAVE, WORKFLOW_ROLE).

    Absent env keys are OMITTED; a supplied `cycle_id=None` is kept as an
    EXPLICIT null (the §S3 orphan signal), never silently dropped."""
    ctx = {"projectKey": project_key}
    if agent_id:
        ctx["agentId"] = agent_id
    if cycle_id is not AXI_UNSET:
        ctx["cycleId"] = cycle_id
    wave = os.environ.get("WORKFLOW_WAVE")
    if wave:
        ctx["wave"] = wave
    if cr:
        ctx["cr"] = cr
    role = os.environ.get("WORKFLOW_ROLE")
    if role:
        ctx["track"] = role
    return ctx


def emit_axi(verb, ok, result_fields, context, warnings, legacy_line=None):
    """Write the §S1 TOON-AXI envelope to stdout (the machine channel) and the
    optional human-readable line to stderr (interactive only)."""
    axi = {"verb": verb, "ok": ok}
    axi.update(result_fields)
    axi["context"] = context
    axi["warnings"] = warnings
    sys.stdout.write(_toon().encode({"axi": axi}) + "\n")
    if legacy_line is not None:
        print(legacy_line, file=sys.stderr)


def resolve_single_plan(plans, cr=None, open_only=False):
    """Resolve exactly ONE target plan from a `GET .../plans` payload's plans
    list (PURE — no I/O), the shared resolution the client write-verbs
    (`cycle-add`, `checkpoint`, `abort`) apply before POSTing.

    - `open_only=True` restricts candidates to `status:"open"` plans first
      (checkpoint/abort target live work); `False` considers open AND closed
      (cycle-add, mirroring plan-backfill — the SERVER is the authority on a
      closed plan's rejection, never a client-side pre-filter).
    - `cr` filters the candidates to that CR (the disambiguator).

    Returns `(plan, reason)`: exactly one is non-None. `reason` is None on a
    unique match, else `"none"` (zero candidates) or `"ambiguous"` (>1, no
    unique pick) — the caller maps each to a non-zero ok:false envelope and
    issues NO POST."""
    candidates = list(plans or [])
    if open_only:
        candidates = [p for p in candidates if p.get("status") == "open"]
    if cr:
        candidates = [p for p in candidates if p.get("cr") == cr]
    if len(candidates) == 0:
        return None, "none"
    if len(candidates) > 1:
        return None, "ambiguous"
    return candidates[0], None


def build_status_rows(plans):
    """§S6 — the plan queue as uniform-table-safe rows (PURE): one dict per
    plan with the SAME scalar-only key-set, so the list round-trips as a TOON
    Construct-3 table (the subset cannot round-trip a nested-dict cell, so the
    active cycle is FLATTENED to `activeCycleId`/`activeCycleLabel` scalar
    columns). `activeCycle*` come from the plan's single `status:"active"`
    cycle (null when none — a closed/pending plan); `mergeCommit` from
    `plan.merge.commit` (null when open/unmerged)."""
    rows = []
    for p in plans or []:
        active = None
        for c in p.get("cycles", []):
            if c.get("status") == "active":
                active = c
                break
        rows.append({
            "cr": p.get("cr"),
            "wave": p.get("wave"),
            "status": p.get("status"),
            "activeCycleId": active.get("id") if active else None,
            "activeCycleLabel": active.get("label") if active else None,
            "mergeCommit": (p.get("merge") or {}).get("commit"),
        })
    return rows


# §S10 — the minimal default column set for the §S6 status/plans table: 3–4
# fields per item (`--fields` adds the rest of the full set, never replaces the
# base). Kept next to `build_status_rows` (which produces the FULL row) so the
# projection and the source rows stay in one place.
STATUS_BASE_FIELDS = ("cr", "wave", "status", "activeCycleId")


def select_status_fields(rows, extra_fields):
    """§S10 (PURE) — project the full status rows (`build_status_rows`) onto the
    minimal base column set PLUS any requested extra columns, preserving a
    uniform (TOON-table-safe) key set across every row. Requested fields ADD to
    the base set (never replace it); an unknown requested field surfaces as a
    null column (the source row simply has no such key)."""
    keys = list(STATUS_BASE_FIELDS)
    for f in extra_fields or []:
        if f not in keys:
            keys.append(f)
    return [{k: r.get(k) for k in keys} for r in rows]


# §S11 — the visible-content limit before a large text field is truncated in
# the envelope. The CR gives no number; the CR-CRU-030 C1 slice-3 RED contract
# pins 200 chars of visible content before the size-hint suffix.
TRUNCATE_LIMIT = 200


def truncate_field(value, full=False, limit=TRUNCATE_LIMIT):
    """§S11 (PURE) — truncate a large text field to `limit` visible chars with a
    `(truncated, <N> chars total — use --full)` size hint naming the TOTAL
    original length. `full=True` (the `--full` flag) returns the value verbatim;
    a value at or under the limit (or a non-str/None) is returned unchanged —
    content that was never cut never carries a fabricated hint."""
    if full or not isinstance(value, str) or len(value) <= limit:
        return value
    return value[:limit] + f" (truncated, {len(value)} chars total — use --full)"


def last_run_cr(plans):
    """§S6 — the `cr` of the plan with the LATEST `closedAt` (the last CR to
    merge), or None when no plan has closed yet — never a fabricated guess."""
    closed = [p for p in (plans or []) if p.get("closedAt") is not None]
    if not closed:
        return None
    return max(closed, key=lambda p: p.get("closedAt")).get("cr")


def resolve_active_cycle_id(plans):
    """§S9 auto-attach resolver (PURE): the single `status:"active"` cycle id
    among the OPEN plans of a `GET .../plans` payload, or None when there is
    none (all terminal / none activated) — closed plans' active cycles are
    ignored (only an OPEN plan is a live attach target)."""
    for p in plans or []:
        if p.get("status") != "open":
            continue
        for c in p.get("cycles", []):
            if c.get("status") == "active":
                return c.get("id")
    return None
