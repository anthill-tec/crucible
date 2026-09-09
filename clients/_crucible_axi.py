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

import argparse
import collections
import contextlib
import datetime
import importlib.util
import io
import json
import os
import re
import resource
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

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


# ── CR-CRU-054 §S2 — the fleet's HTTP core, lifted to ONE locus of truth ────
#
# Every client used to carry its OWN byte-identical `_request` (plus the
# `_post`/`_get`/`_patch` wrappers over it) and its OWN `_abbrev_home`. Five
# copies of a transport is five places for a fix to land in four of them —
# exactly the failure `docs/research/DN-client-fleet-inventory.md` §4 found.
# The clients keep the local names (their internal call sites and every client
# test harness address `_post`/`_get`/`_patch`/`_request` unqualified) but the
# LOGIC lives here only, reached through the same thin-delegator pattern
# CR-CRU-030 established for `_axi_context`/`_emit_axi`.


def http_request(base_url, method, path, payload=None, timeout=None):
    """The fleet's ONE JSON-over-HTTP call to Crucible. Returns the parsed JSON
    response, or a structured `{ok: False, error}` on an HTTP/connection error.

    `base_url` is passed in rather than read from the environment here: each
    client owns its own base-URL constant (four spell it `CRUCIBLE_URL`,
    arduino `CRUCIBLE`), and resolving it stays client-side under this module's
    scope boundary — the shared module reads no config of its own.

    CR-CRU-035 §S1 — `timeout=None` (the default) is UNBOUNDED: ingest POSTs
    (`/api/v2/runs/parsed`) for a large regression/coverage run can legitimately
    take the server >10s, and a short bound there is a false-negative. The short
    hook-safe bound is applied ONLY on the status/plans read path via `_get`.
    The bound is passed as a `timeout=` KEYWORD, which the fleet's hook-safety
    tests assert on directly.

    CR-CRU-054 §S2b (DRIFTED, DN §4 finding #7) — an EMPTY 200 response body
    yields `{"ok": True}` rather than the uncaught `json.JSONDecodeError` that
    `json.loads(b"")` raised in bun/rust/mvn/python. arduino was the lone client
    with the body-presence guard and its version is the one that survives the
    lift; the other four inherit the fix. A NON-empty body that is not valid
    JSON still raises, unchanged — only the empty case was ever a defect.
    """
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        # Deliberately NOT a `with` block: the client test harnesses stub
        # `urllib.request.urlopen` with a plain response double, and a
        # context-managed read would consume that double's `__enter__` result
        # instead of the double itself. The explicit close keeps the
        # connection from leaking all the same.
        response = urllib.request.urlopen(req, timeout=timeout)
        try:
            body = response.read()
        finally:
            response.close()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        return {"ok": False, "error": f"HTTP {e.code}: {detail}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"connection failed: {e.reason} "
                                      f"(is Crucible running at {base_url}?)"}
    return json.loads(body) if body else {"ok": True}


def abbrev_home(path):
    """Render an absolute path with `~` for the home dir (§S14). A path outside
    the home directory is returned unchanged."""
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home) else path


def run_context():
    """CR-CRU-008 §S2 — env + git → the run context for declared cycle linkage.

    Reads WORKFLOW_CYCLE, WORKFLOW_WAVE and WORKFLOW_ROLE (no cycle-id env
    read — a bound agent's cycle attachment is stamped SERVER-side from its
    registered binding, CR-CRU-056 §S3). When at least one is set, attaches
    git {branch, commit} from a cheap `git rev-parse` (tolerant of a non-repo
    cwd → the key is OMITTED, never an error). Returns the context dict, or
    None when no workflow env is set at all (never a bare `{}`).

    CR-CRU-054 §S2 — lifted here from all five clients, which each carried a
    byte-identical copy; they now keep only the thin `_run_context` delegator.
    """
    context = {}
    cycle = os.environ.get("WORKFLOW_CYCLE")
    if cycle:
        context["cycle"] = cycle
    wave = os.environ.get("WORKFLOW_WAVE")
    if wave:
        context["wave"] = wave
    role = os.environ.get("WORKFLOW_ROLE")
    if role:
        context["orchestrator"] = role
    if not context:
        return None
    try:
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        if branch and commit:
            context["git"] = {"branch": branch, "commit": commit}
    except (OSError, subprocess.CalledProcessError):
        # A non-repo cwd / absent git is not an ingest failure — the run
        # context simply carries no git provenance.
        pass
    return context


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


def echoed_cycle_id(resp):
    """CR-CRU-056 §S3 (C5) — read the cycle the SERVER reports it attached an
    ingest to, out of the ingest response's `context.cycleId` echo.

    This is a PURE READ of the server's own answer — emphatically NOT a
    revival of the client-side cycle RESOLUTION deleted in C2: no plans fetch,
    no active-cycle picking, no env var. The server owns the binding and
    stamps the attachment; the client only repeats what came back, so an agent
    reading stdout sees where its run landed without a second
    `GET /api/v2/events`.

    Returns the echoed integer id, or `AXI_UNSET` when the server reported no
    attachment (a cycle-less ingest) so `axi_context` OMITS the key rather
    than fabricating a null."""
    context = resp.get("context") if isinstance(resp, dict) else None
    if not isinstance(context, dict):
        return AXI_UNSET
    cycle_id = context.get("cycleId")
    # `bool` is an int subclass — exclude it so a stray True can never pose
    # as a cycle id.
    if isinstance(cycle_id, int) and not isinstance(cycle_id, bool):
        return cycle_id
    return AXI_UNSET


def emit_axi(verb, ok, result_fields, context, warnings, legacy_line=None):
    """Write the §S1 TOON-AXI envelope to stdout (the machine channel) and the
    optional human-readable line to stderr (interactive only).

    CR-CRU-111 §S5/AC7 — the envelope names the tier of the run this exit
    ingested, beside `verb`/`ok` and on EVERY exit path, so an orchestrator
    reading it knows what was covered without inspecting the board. The
    statement is ASSEMBLED HERE, once for the fleet, from what the ingest seam
    recorded (`ingested_tier`, and the closed vocabulary beside
    `TIER_MEANINGS`): a client that ingested nothing on this exit says so
    rather than claiming coverage it never obtained."""
    axi = {"verb": verb, "ok": ok, "tier": ingested_tier()}
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


# ── CR-CRU-054 §S2 — the fleet's plan-access layer, lifted to ONE locus ─────
#
# `_plans_path`, `_open_plans` and `_resolve_plan_or_emit`'s prelude were
# byte-identical in all five clients. The plan SELECTION itself
# (`resolve_single_plan`, above) was already shared; what follows is the
# surrounding URL/GET/emit orchestration that was not. The clients keep their
# local names as thin delegators — their internal call sites and every client
# test harness address them unqualified — and inject the two genuinely
# per-client pieces: the resolved plans path (built from the client-owned
# `.env` project key) and the client's own `_get`/`_emit_axi`.


def plans_path(project_key):
    """The plans-collection URL for an ALREADY-RESOLVED project key. Key
    resolution stays client-side (each client owns its `.env`/project-dir
    layout — the same scope boundary `axi_context` observes)."""
    return f"/api/v2/projects/{project_key}/plans"


class PlansFetchFailed(SystemExit):
    """CR-CRU-058 §S1 — the plans GET inside `open_plans` failed.

    A `SystemExit` SUBCLASS deliberately: `open_plans`'s hard-stop contract
    (a failed GET is NEVER an empty list) is preserved unchanged for every
    caller, while the verbs that own an envelope catch THIS type narrowly and
    report the failure the way `resolve_plan_or_emit` already does — an
    ok:false envelope on stdout — before returning the same non-zero rc the
    bare `sys.exit` produced. Carries the server `error` separately so the
    envelope can name the real condition rather than re-parse the message."""

    def __init__(self, message, error=None):
        super().__init__(message)
        self.error = error


def plans_fetch_failed_help(base_url):
    """CR-CRU-058 §S2 (PURE) — the state-derived `help[]` for a verb that could
    not READ the plan board at all.

    Distinct from the verb's canned `HELP_STEPS` entry by design (CR-CRU-048's
    rule): the state actually reached is "the board is unreadable", so the
    concrete next action is to restore the server, and only then re-read the
    board — pointing at the verb's normal successor here would walk the
    orchestrator straight back into the same failure."""
    return [f"check the Crucible server is running / reachable at {base_url}",
            "status"]


def plans_unavailable_warning(verb, error):
    """CR-CRU-058 §S1 — the structured warning naming the ACTUAL condition
    behind a plans-fetch failure, so a machine caller reading the envelope
    alone (the human line is stderr-only) learns why the verb could not run.
    Mirrors `cmd_status`'s `status-unavailable` shape."""
    return {
        "code": "plans-unavailable",
        "detail": (f"could not read the plan board to {verb}: {error} — "
                   f"nothing was posted"),
    }


def open_plans(get_fn, path):
    """GET the plans collection at `path` via the client's own `get_fn` and
    return ONLY the `status:"open"` plans, in server order.

    A failed GET is a hard stop (`PlansFetchFailed`, a `SystemExit` naming the
    server error), not an empty list: silently reporting "no open plans" when
    the server is unreachable is the false-negative this shared copy exists to
    prevent. CR-CRU-058 §S1 only makes the stop TYPED — the envelope-owning
    callers (`cmd_cr_close` / `cycle_transition`) catch it and emit the
    ok:false envelope the bare exit never produced."""
    resp = get_fn(path)
    if not resp.get("ok"):
        error = resp.get("error")
        raise PlansFetchFailed(
            f"[crucible] ERROR: could not list plans: {error}", error=error)
    return [p for p in resp.get("plans", []) if p.get("status") == "open"]


def emit_plans_fetch_failure(verb, exc, project_dir, ops, result_fields, cr=None):
    """CR-CRU-058 §S1 — report a `PlansFetchFailed` as the fleet's standard
    ok:false envelope (the shape `resolve_plan_or_emit` already produces for
    the IDENTICAL failure on `cycle-add`/`checkpoint`/`abort`) and return the
    non-zero rc the bare `sys.exit` used to produce. The human line stays the
    exit's own message, on stderr, via the emitter's legacy channel."""
    fields = dict(result_fields)
    fields["help"] = plans_fetch_failed_help(ops.base_url)
    ops.emit(verb, False, fields, ops.context(project_dir, cr=cr),
             [plans_unavailable_warning(verb, exc.error)], str(exc))
    return 1


def resolve_plan_or_emit(verb, cr, result_fields, open_only,
                         get_fn, path, emit_fn, context_fn):
    """The shared prelude for the plan-targeting write verbs (`cycle-add` /
    `checkpoint` / `abort`): GET the plans at `path`, resolve exactly ONE
    target via `resolve_single_plan`, and on ANY failure (GET error, zero
    candidates, or ambiguity) emit the ok:false envelope through `emit_fn` and
    return `(None, 1)`. On success returns `(plan, None)` and emits nothing.

    `context_fn` is a zero-arg callable so the envelope context (which costs a
    client-side `.env` read) is built ONLY on the failure paths, exactly as the
    per-client copies did."""
    resp = get_fn(path)
    if not resp.get("ok"):
        legacy = f"[crucible] ERROR: could not list plans: {resp.get('error')}"
        emit_fn(verb, False, result_fields, context_fn(), [], legacy)
        return None, 1
    plans = resp.get("plans", [])
    plan, reason = resolve_single_plan(plans, cr=cr, open_only=open_only)
    if reason is not None:
        scope = "open plan" if open_only else "plan"
        if reason == "none":
            legacy = (f"[crucible] ERROR: no {scope} to {verb}"
                      + (f" for cr={cr}" if cr else ""))
        else:
            candidates = [p for p in plans
                          if (not open_only or p.get("status") == "open")]
            names = ", ".join(f"{p.get('cr')} (plan {p.get('planId')})" for p in candidates)
            legacy = (f"[crucible] ERROR: {len(candidates)} {scope}s — ambiguous {verb}. "
                      f"Pass --cr to pick one of: {names}")
        emit_fn(verb, False, result_fields, context_fn(), [], legacy)
        return None, 1
    return plan, None


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


def last_closed_cr(plans):
    """§S6 — the `cr` of the plan with the LATEST `closedAt` (the last CR to
    close), or None when no plan has closed yet — never a fabricated guess."""
    closed = [p for p in (plans or []) if p.get("closedAt") is not None]
    if not closed:
        return None
    return max(closed, key=lambda p: p.get("closedAt")).get("cr")


# CR-CRU-056 §S3 — the CR-CRU-036-era client-side attach resolver
# (`resolve_attach_cycle` / `resolve_active_cycle_id`) and its warn+withhold
# flow are DELETED. Ingest attachment is the SERVER's job: a bound agent's run
# is stamped from its registered cycle binding (`register --cycle`); an unbound
# agent attaches only via an explicit `context.cycleId`. The client resolves
# nothing.


# ── CR-CRU-056 §S1/§S3 — the gated-run identity bracket owns what it CREATED ─
#
# CR-CRU-021 §S5's anti-ghost cleanup exists so a gate/close-out agent never
# lingers as an online ghost: after the final ingest the gated run SILENTLY
# removes the agent row (no lifecycle event — a journaled 'unregistered' would
# bury the run just ingested; see each client's `_remove_agent_silent`).
#
# Under the pre-CR model that row was ALWAYS the run's own — the ingest
# implicitly created it — so "remove the row" and "remove what I created" were
# the same statement. CR-CRU-056 broke that identity: §S1 stores the cycle
# binding ON the agent row, and §S3b retired implicit creation. An unconditional
# cleanup therefore DELETES a caller-owned registration together with its
# binding, and the next gated run under the same identity ingests unattached.
# Observed live 2026-08-01 on the :3849 board: `vidushi` registered bound to
# cycle 152; `python-crucible.py regression --agent vidushi` ingested stamped
# 152 and then ran its cleanup; the immediately following
# `bun-crucible.py regression --agent vidushi` landed with NO cycle.
#
# The anti-ghost PURPOSE is preserved exactly; only its REACH is corrected —
# the bracket removes an identity it created and never one that pre-existed.
# Ownership is not guessed and needs no probe: the server already answers it.
# `POST /api/v2/agents/register` and `/api/v2/agents/heartbeat` both return
# `changed: true` iff that call CREATED the row (`src/v2.ts` handleAgentTouch:
# `changed: !existed`), so the run's OWN opening lifecycle call reports whether
# the identity is its to clean up.


class GatedRunIdentity:
    """The identity half of a gated run's lifecycle bracket, shared by all five
    clients so the fleet cannot drift apart again.

    Two jobs, both tiny:

    1. OPEN the run's identity — `open_payload()` builds the body for a
       role-OPTIONAL heartbeat (`PATH`). The heartbeat route, never
       `/register`, is deliberate: the gated verbs take no `--role`, and
       CR-CRU-044 §S1(a) makes the heartbeat the one touch that never
       re-declares — nor blanks — the role a pre-registered caller declared.
       A `cycle_id` (the gated verbs' `--cycle`, same flag and semantics as
       `register --cycle`) rides the body as `cycleId` for the
       register-inside-the-run case: an agent that never registered separately
       still binds, and the SERVER validates that binding. Nothing here
       RESOLVES a cycle — no plans fetch, no active-cycle picking; the id is
       whatever the caller typed, or the key is absent.

    2. TRACK ownership — `observe()` reads the server's `changed` flag off
       every register/heartbeat response the run makes (the opening call plus
       any narration ticks). Ownership is STICKY: once a call of this run's
       created the row, this run cleans it up, even if later ticks report
       `changed: false`. A row that pre-existed (`changed: false` throughout)
       is the CALLER's, and `should_remove` stays False — the caller's
       registration, and with it their cycle binding, survives the run.

    A refused opening call (409 on an invalid binding, a connection failure)
    carries no `changed: true`, so it never claims ownership: the bracket
    cleans up nothing it did not demonstrably create.
    """

    PATH = "/api/v2/agents/heartbeat"

    def __init__(self, agent_id, cycle_id=None):
        self.agent_id = agent_id
        self.cycle_id = cycle_id
        self.created_here = False
        self.confirmed = False

    def open_payload(self, project_key, message="gated run starting",
                     source="claude-md"):
        """The opening heartbeat body. `cycleId` is present ONLY when the
        caller supplied `--cycle` — an absent key leaves any stored binding
        untouched (the server's touch-never-blanks contract, §S1)."""
        payload = {
            "agentId": self.agent_id,
            "projectKey": project_key,
            "status": "online",
            "message": message,
            "identity": {"displayName": self.agent_id, "source": source},
        }
        if self.cycle_id is not None:
            payload["cycleId"] = self.cycle_id
        return payload

    def observe(self, resp):
        """Record one register/heartbeat response and return it unchanged (so
        it drops straight into a narration lambda). `changed: true` means THIS
        call created the agent row; `ok: true` means the server ACCEPTED the
        touch at all, which is what separates "the row is the caller's" from
        "this run never established an identity"."""
        if isinstance(resp, dict):
            if resp.get("ok") is True:
                self.confirmed = True
            if resp.get("changed") is True:
                self.created_here = True
        return resp

    @property
    def should_remove(self):
        """True only when this run created the identity — the single question
        the anti-ghost cleanup is allowed to act on."""
        return self.created_here


# CR-CRU-056 — the ONE `--cycle` help text for the GATED verbs, so all five
# clients document the flag identically. Same flag name and semantics as
# `register --cycle`; the difference is only WHEN it applies.
GATE_CYCLE_HELP = (
    "Cycle id to BIND this run's agent to, for a run whose agent did NOT "
    "register separately (an ACTIVE cycle of an OPEN plan; the SERVER "
    "validates it — nothing is resolved client-side). Same semantics as "
    "`register --cycle`. An agent that ALREADY registered bound needs no "
    "--cycle here: the gated run leaves its registration and binding intact.")

# The ONE `--release` help text for the GATE verbs, so all five clients
# document the flag identically. OPTIONAL, because a gate on a feature branch
# gates no release.
GATE_RELEASE_HELP = (
    "Label of the release this gate gates (e.g. 0.2.0), posted VERBATIM as "
    "the event's top-level `version` — the client never invents, normalises "
    "or derives it from a branch name. OMIT IT unless the gate really gates a "
    "release: a gate naming one is exempt from pruning until that release "
    "records, and is retired the moment it does.")


def gate_identity_skipped_line(agent_id, confirmed=True):
    """The stderr line a gated run prints INSTEAD of the cleanup, so an
    operator can see WHY nothing was removed rather than being told nothing.

    `confirmed` distinguishes the two no-removal cases, which must never be
    reported as each other: the server ACCEPTED the opening touch and reported
    the row already existed (it is the caller's, left standing), versus the
    opening touch was REFUSED so this run never established an identity at
    all."""
    if not confirmed:
        return (f"cleanup: nothing to remove for agent={agent_id} — this run "
                f"never established an identity (its opening lifecycle call "
                f"was refused); no agent row was created and none is removed")
    return (f"cleanup: skipped agent={agent_id} — the identity pre-existed this "
            f"run (registered by its caller); its registration and cycle "
            f"binding are left intact")


def gate_identity_open_failed_line(agent_id, error):
    """The stderr line for a REFUSED opening call — a 409 on an invalid
    `--cycle`, or an unreachable server. Without it the only symptom would be
    the ingest's own downstream refusal, which names the registration but not
    the binding that was actually rejected."""
    return (f"[crucible] WARN: could not open the gated run's identity for "
            f"agent={agent_id}: {error}. The run continues, but its ingest "
            f"will be refused unless this id is already registered — and any "
            f"--cycle binding was NOT applied.")


# ── §S15 next-step templates + §S7/§S8 gate constants + gate helpers ────────
#
# These are the TOOLCHAIN-AGNOSTIC verb helpers shared by every client (they
# historically lived only in bun-crucible.py). Lifting them here (CR-CRU-030
# §S2) lets python-crucible.py and rust-crucible.py drive the same plan/cycle/
# gate verbs from ONE source of truth rather than re-implementing the logic.

# §S15 — per-verb next-step command TEMPLATES: every envelope names the sane
# next move (fixed disambiguating flags carried forward, runtime values as
# `<placeholders>`), so the orchestrator never loses the process thread.
HELP_STEPS = {
    "register": ["test --agent <agentId>"],
    "unregister": ["status"],
    "test": ["cycle-done <id>", "status"],
    "regression": ["cycle-done <id>", "status"],
    "auto-ingest": ["cycle-done <id>", "status"],
    "check": ["test --agent <agentId>"],
    "cycle-add": ["cycle-activate <id>"],
    "checkpoint": ["status"],
    "stop": ["status"],
    "abort": ["status"],
    "status": ["cycle-activate <id>"],
    "cr-close": ["status"],
}

# Valid server-side gate outcomes (CR-CRU-013 §S1). An interim (in-flight)
# snapshot has no resolved outcome of its own, so gate-run synthesises one from
# the current step set — it must still be a member of this set (server 400s
# otherwise).
GATE_OUTCOMES = ("checks-passed", "passed", "failed", "cancelled")

# §S3 — the PASS FAMILY: every resolved `axi run` outcome this fleet reads as a
# pass, each NAMED beside the legal gate outcome it seals as.
#
# The sealing path used to take the run's outcome only when it was already one
# of the four legal values and otherwise fall back to "failed if any step
# failed, else passed". That fallback is structurally biased green: `pending`,
# `running`, `fixing` and `awaiting_approval` are none of them `failed`, so a
# run still going sealed `passed`. This table replaces the green half of it.
#
# `passed-with-skips` is what a real release run resolves today, and it is in
# NO vocabulary the fleet has — not the server's `GATE_OUTCOMES` (which 400s
# anything outside them), not the renderer's gating rule. It seals `passed` by
# an explicit decision recorded HERE, and the skips it names are not lost: the
# `pr,skipped`/`ci,skipped` rows already travel in `steps[]`, and the envelope
# carries the raw string beside the mapped one. An outcome this table does not
# name is never inferred green from the mere absence of a failure.
GATE_PASS_FAMILY = {
    "passed": "passed",
    "passed-with-skips": "passed",
    "checks-passed": "checks-passed",
}

# §S4 — WHICH gate an exit posted, stated as a value. A seal is `final`; a run
# whose poll loop put an in-flight ladder on the board and then HELD is
# `interim`; the no-gate case reuses the envelope's own stated-absence word
# (ENVELOPE_TIER_NONE — this exit did the thing zero times) rather than
# inventing a third vocabulary.
#
# `interim` was first thought unproducible until the in-flight POST's guard is
# repaired. That was measured and found false: the guard withholds the post
# only on a NINE-row ladder, so any shorter snapshot — the shape the fleet's
# own fixtures produce — posts one and may then still hold. So the field
# reports what the LOOP really did rather than what the sealing decision alone
# can see: a `none` while a gate sits on the board is a machine-readable lie.
GATE_POSTED_FINAL = "final"
GATE_POSTED_INTERIM = "interim"

# §S3 — the move a HELD caller is told to make, in the TOOL's own words:
# `axi run --help` says an elapsed wait "is not a failed run: inspect with axi
# status and reattach". A hold that names no next move strands its caller, and
# naming a command the tool does not have would strand it further.
AXI_REATTACH_HELP = "inspect with `axi status` and reattach"

# §S8 — gate-run is the AXI streaming standard; gate-report is discouraged.
# EVERY gate-report invocation emits this warning (envelope warnings[] + stderr)
# regardless of the POST outcome (the discouragement is a property of using
# gate-report at all).
PREFER_GATE_RUN_WARNING = {
    "code": "prefer-gate-run",
    "detail": ("gate-run is the AXI streaming standard (it posts throttled "
               "interim snapshots while the run is in flight then a final sealed "
               "gate); gate-report posts a single one-shot gate and is "
               "discouraged wherever an axi proxy exists"),
}

# §S3 — wave resolution is `--wave` > $WORKFLOW_WAVE. A plan-file that resolves
# NEITHER files un-waved (no hard block; the flag/env is the prevention lever),
# but must carry this `no-wave` warning (envelope warnings[] + stderr) NAMING the
# CR so an orchestrator can backfill the wave (plan-backfill --wave) rather than
# silently losing the wave attribution. One source of truth for all five clients.


def no_wave_warning(cr):
    """Build the §S3 `no-wave` warning for a plan-file that resolved no wave.
    The detail NAMES the CR being filed so the omission is actionable."""
    return {
        "code": "no-wave",
        "detail": (f"plan filed for {cr} with no wave — neither --wave nor "
                   f"$WORKFLOW_WAVE resolved; backfill it with "
                   f"`plan-backfill --cr {cr} --wave <n>`"),
    }


def no_title_warning(cr):
    """Build the §S2 `no-title` warning for a plan-file filed with no title.
    The title is optional (the plan still files), but the detail NAMES the CR
    being filed so the omission is actionable — mirroring `no_wave_warning`."""
    return {
        "code": "no-title",
        "detail": (f"plan filed for {cr} with no title — --title was unset; "
                   f"the plan is title-less until one is supplied"),
    }


# ── CR-CRU-094 §S3 — the PRE-FLIGHT attribution check, for all five clients ─
#
# A run whose agent is bound to no cycle is stored with no cycle attribution,
# and NOTHING backfills a stored run's cycle (`plan-backfill` backfills a
# plan's wave). The warning therefore fires when the run STARTS, while
# `--cycle` can still be supplied — the same voice as `no_wave_warning`/
# `no_title_warning`: name the omission, then name the lever that fixes it.
#
# The binding is READ from the board (`GET /api/v2/agents?project=<key>` →
# `boundCycleId`, absent when unbound), never inferred from the absence of a
# local `--cycle` flag: a caller that registered bound in an EARLIER process
# passes no flag now and has nothing missing.

MISSING_CYCLE_CODE = "no-cycle"

# The lookup is a courtesy on the way to the run, so it is bounded far tighter
# than the hook-safe read timeout: a slow board must cost a test run a moment,
# never its start.
PREFLIGHT_TIMEOUT_S = 3


def no_cycle_warning():
    """Build the §S3 `no-cycle` warning for a run with no cycle attribution."""
    return {
        "code": MISSING_CYCLE_CODE,
        "detail": ("this run has no cycle attribution — its agent is bound to "
                   "no cycle and no --cycle was supplied, so the stored run "
                   "cannot be traced to the cycle it belongs to; supply "
                   "`--cycle <id>` now (nothing backfills a stored run's "
                   "cycle) or leave it project-scoped deliberately"),
    }


def no_cycle_line():
    """The stderr half of the §S3 warning — the shape
    `gate_identity_skipped_line` uses to tell an operator, at the moment it
    matters, why something did not happen."""
    w = no_cycle_warning()
    return f"[crucible] WARN: {w['code']} — {w['detail']}"


def _bound_cycle_id(resp, agent_id):
    """`(known, bound_cycle_id)` for `agent_id` in a `GET /api/v2/agents`
    response. `known` is False whenever the board did not actually answer for
    this agent — an error envelope, a malformed body, or an id the board does
    not hold — because an UNANSWERED lookup is not evidence of a missing
    binding."""
    if not isinstance(resp, dict) or not resp.get("ok"):
        return (False, None)
    agents = resp.get("agents")
    if not isinstance(agents, list):
        return (False, None)
    for agent in agents:
        if isinstance(agent, dict) and agent.get("agentId") == agent_id:
            return (True, agent.get("boundCycleId"))
    return (False, None)


def preflight_cycle_warnings(get, project_key, agent_id, cycle_id=None,
                             context=None, stream=None):
    """§S3 — the pre-flight attribution check every ingesting run makes BEFORE
    it spawns its runner. Returns the envelope `warnings[]` fragment (`[]` or
    one `{code, detail}`) and prints the same warning's stderr line, so both
    channels are fed from ONE decision.

    Best-effort and NEVER blocking, per AC5: an unreachable board, a timeout,
    a malformed answer or ANY raised exception yields no warning and the run
    proceeds. `get` is the calling client's own `_get` (its test harnesses
    patch that name), called with the short `PREFLIGHT_TIMEOUT_S` bound.
    """
    try:
        if not agent_id or not project_key:
            return []
        # `--cycle` supplied, or an explicit `context.cycleId`: the run WILL be
        # attributed, so there is nothing to warn about and nothing to ask.
        if cycle_id is not None:
            return []
        if isinstance(context, dict) and context.get("cycleId") is not None:
            return []
        resp = get(f"/api/v2/agents?project={project_key}",
                   timeout=PREFLIGHT_TIMEOUT_S)
        known, bound = _bound_cycle_id(resp, agent_id)
        if not known or bound is not None:
            return []
        print(no_cycle_line(), file=stream if stream is not None else sys.stderr)
        return [no_cycle_warning()]
    except Exception:
        # Attribution is a courtesy; a suite must never become unrunnable
        # because it could not be computed.
        return []


# ── CR-CRU-058 §S1/§S2 — the toolchain-gate help/warning vocabulary ────────
#
# The verbs C3 gives envelopes to (`unit`/`module`/`compile`/`e2e`/`docker-*`/
# `pre-merge-gate`) exist in four clients with the SAME two states to describe:
# a run that happened but could not be recorded, and a fail-fast step that
# aborted the gate before the suite ran. Both live HERE rather than as four
# per-client copies — the CR-CRU-054 consolidation dividend. They are PURE
# (no I/O, no globals): the caller passes its own resolved `base_url`.


def server_unreachable_help(verb, base_url):
    """CR-CRU-058 §S2 — the state-derived `help[]` for a run that produced real
    results but could not record them: pointing at the verb's normal successor
    would walk the orchestrator past a run that was never ingested."""
    return [f"check the Crucible server is running / reachable at {base_url}, "
            f"then re-run {verb} --agent <agentId>",
            "status"]


def ingest_failed_warning(verb, base_url):
    """CR-CRU-058 §S1 — the structured warning naming the condition behind a
    completed run whose evidence never reached the board, so a machine caller
    reading the envelope alone (the human line is stderr-only) learns that the
    run happened but is NOT recorded. Mirrors `plans_unavailable_warning`."""
    return {
        "code": "ingest-failed",
        "detail": (f"the {verb} run completed but its ingest to {base_url} "
                   f"did not succeed — the evidence is NOT on the board"),
    }


def run_help(verb, ok, failed, base_url):
    """CR-CRU-058 §S2 (CR-CRU-048's rule, PURE) — the next step for a
    test-running verb, derived from the run state ACTUALLY reached: an
    unrecorded run points at the server, a red run at its failures, a green one
    at the next workflow move. Never a canned per-verb string."""
    if not ok and not failed:
        return server_unreachable_help(verb, base_url)
    if failed:
        return [f"fix the {failed} failing test(s), then re-run "
                f"{verb} --agent <agentId>",
                "status"]
    return ["cycle-done <id>", "status"]


def gate_step_abort_help(verb, remedy):
    """CR-CRU-058 §S2 — the `help[]` for a gate that stopped at its fail-fast
    step: the concrete next action is the step's OWN remedy, then re-running
    the gate — never the gate's successor, which would skip a suite that never
    ran."""
    return [remedy, f"re-run {verb} --agent <agentId>", "status"]


def gate_step_abort_warning(verb, step, detail):
    """CR-CRU-058 §S1 — the structured warning for a gate aborted at `step`,
    naming what consequently did NOT happen: an ok:false envelope alone would
    not tell a machine caller that the regression never ran, so the gate says
    NOTHING about the test suite."""
    return {
        "code": "gate-step-abort",
        "detail": (f"{verb} stopped at its fail-fast {step} step — {detail}; "
                   f"the regression never ran, so this gate says NOTHING "
                   f"about the test suite"),
    }


NO_REPORT_DETAIL_MAX = 500


def _last_non_empty_line(output):
    """The last line of a captured runner stream that carries anything — the
    CAUSE line of a starved run (`ModuleNotFoundError: No module named
    'xmlrunner'`), which trailing blank/whitespace lines would otherwise hide.
    Empty string when the capture holds nothing at all."""
    for line in reversed((output or "").splitlines()):
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def no_report_help(verb, artifact, remedy=None):
    """CR-CRU-064 §S1/AC1 (PURE) — the `help[]` for a run that produced NO
    report at all: read the runner's OWN output (the report that would explain
    the failure was never written), then re-run. `artifact` carries each
    stack's wording (`junit.xml` · `surefire reports` · `TEST-*.xml`), so this
    one sentence replaces the per-client hand-written renderings.

    An explicit `remedy` — the step's own concrete fix, the shape
    `gate_step_abort_help` established — is ordered AHEAD of the re-run:
    re-running before applying it just reproduces the starved run."""
    steps = [f"the {verb} run produced no {artifact} — read the {verb} runner "
             f"output on stderr (it died before writing a report)"]
    if remedy:
        steps.append(remedy)
    steps.append(f"re-run {verb} --agent <agentId>")
    steps.append("status")
    return steps


def no_report_warning(verb, artifact, exit_code, output, cause=None):
    """CR-CRU-064 §S1/AC1+AC2 (PURE) — the structured warning for a run that
    wrote no report: `{"code": "no-test-reports", ...}` (mvn's existing string,
    lifted verbatim). The helper COMPOSES the detail — a caller-supplied one
    would push this invariant into every call site, which is the duplication
    §S1 deletes.

    The detail names the verb, the artifact and the runner's `exit_code`, then
    the last non-empty line of `output`, so the cause reaches the consumer
    instead of an exit code and empty stdout. The composed PREFIX is never
    truncated; only the output fragment is bounded, and it keeps ITS tail (the
    cause is at the END of a capture, so a head-keeping bound would bound away
    the only fact the warning exists to carry). A blank/whitespace-only
    capture still yields a non-empty, exit-code-naming detail —
    `/api/v2/runs/compile` 400s on an empty string.

    CR-CRU-065 §S1 — an OPTIONAL `cause` keyword lets a caller REPLACE the
    derived last line with a fragment it ordered by importance (maven's
    actionable `cannot find symbol` sits ABOVE its epilogue, so the last line
    is the wrong pick). A supplied cause is bounded keeping its HEAD, the
    mirror of the derived path's tail-keeping bound. `cause=None` or a
    blank/whitespace-only cause is NOT an override: it falls back to the
    derived rule, so every existing caller is byte-identical to CR-CRU-064."""
    prefix = (f"{verb} produced no {artifact} — the runner exited "
              f"{exit_code} before writing a report")
    joiner = "; last output line: "
    if cause is not None and cause.strip():
        room = NO_REPORT_DETAIL_MAX - len(prefix) - len(joiner)
        if room <= 0:
            return {"code": "no-test-reports", "detail": prefix}
        fragment = cause
        if len(fragment) > room:
            fragment = fragment[:room - 1] + "…"
        return {"code": "no-test-reports", "detail": prefix + joiner + fragment}
    cause = _last_non_empty_line(output)
    if not cause:
        return {"code": "no-test-reports",
                "detail": (f"{prefix}; no runner output reached this envelope, "
                           f"so the runner's own stream is the only evidence "
                           f"left")}
    room = NO_REPORT_DETAIL_MAX - len(prefix) - len(joiner)
    if room <= 0:
        return {"code": "no-test-reports", "detail": prefix}
    if len(cause) > room:
        cause = "…" + cause[-(room - 1):]
    return {"code": "no-test-reports", "detail": prefix + joiner + cause}


def next_pending_cycle_id(plan, exclude_cycle_id=None):
    """CR-CRU-048 §S1 (PURE) — the id of the NEXT cycle still awaiting work in
    `plan` (a plan dict from a `GET .../plans` payload), or None when none
    remains.

    "Next" is the FIRST `status:"pending"` cycle in the plan's OWN
    `cycles[]` order — the order the plan was filed in IS the execution order,
    so no sorting or id-arithmetic is invented here. `exclude_cycle_id` drops
    the cycle currently being transitioned (its server-side status in the
    already-fetched payload is stale by the time the hint is built). When
    several cycles are pending the FIRST in plan order wins — the one the
    orchestrator should activate now; the rest surface on the next transition.
    A missing/None plan yields None (no plan → nothing to derive)."""
    if not plan:
        return None
    for cycle in plan.get("cycles", []) or []:
        if exclude_cycle_id is not None and cycle.get("id") == exclude_cycle_id:
            continue
        if cycle.get("status") == "pending":
            return cycle.get("id")
    return None


def cycle_transition_help(status, plan, cycle_id=None):
    """CR-CRU-048 §S1/§S3 (PURE) — the `help[]` next-step hint for a
    cycle-activate/cycle-done transition, DERIVED from the owning plan's state
    instead of the hardcoded ternary each client used to carry.

    - `status == "active"` (cycle-activate) → the literal `cycle-done <id>`
      placeholder template (UNCHANGED — the cycle just activated is the work
      to finish).
    - `status == "done"` (cycle-done) with a cycle still PENDING in the plan →
      `cycle-activate <that concrete id>`: the plan itself names the next move,
      so the orchestrator is never walked toward closing a CR with cycles unrun.
    - `status == "done"` with nothing pending left (or no resolved plan) →
      `cr-close --commit <sha>`."""
    if status == "active":
        return ["cycle-done <id>", "status"]
    next_id = next_pending_cycle_id(plan, exclude_cycle_id=cycle_id)
    if next_id is not None:
        return [f"cycle-activate {next_id}", "status"]
    return ["cr-close --commit <sha>", "status"]


# ── CR-CRU-044 §S5 — the agent identity is DECLARED or the verb FAILS ───────
#
# Historically each client carried its OWN `_agent_id()` with a filename-derived
# fallback — the script's own filename (`"bun-crucible"`, `"rust-crucible"`,
# `"python-crucible"` and friends). That fabricated an identity for any verb run
# without `--agent` and planted a phantom row on the dashboard's agent rail — an
# entity that is not an agent, with no role, no lifecycle and no owner. The
# fallback is GONE and the resolver lives here ONCE so the fleet cannot drift
# apart again.
#
# CR-CRU-056 §S2b extends the hard stop to EVERY mutating workflow verb:
# plan-file, plan-backfill, cycle-activate, cycle-done, cycle-add, cr-close,
# checkpoint, stop, abort, milestone and the gate verbs all resolve the
# identity through `require_agent_id` BEFORE any POST/PATCH and send it on the
# wire as `agentId` — the server refuses an unregistered caller (409). The
# plan verbs' free-text `--orchestrator` label (and its $WORKFLOW_ORCHESTRATOR
# fallback) is retired: the registered `--agent` id is the caller AND the
# plan's stored orchestrator.
#
# `$WORKFLOW_ROLE` is deliberately NOT part of the chain: it carries the TRACK
# LANE (`mainline` | `track-n`; PRD-crucible-v2.md:291, DN-model-b-language.md:53)
# and is read into `ctx["track"]` by `axi_context`/`fleet_context` — registering
# an agent named after a lane is the same category error as `bun-crucible`,
# merely with a tidier-looking value.

AGENT_IDENTITY_REQUIRED_CODE = "agent-identity-required"
AGENT_IDENTITY_REQUIRED_DETAIL = (
    "no agent identity was declared — supply it with `--agent <agentId>`. There "
    "is no fallback and no default: $WORKFLOW_ROLE carries the track lane "
    "(mainline | track-n), not an identity, and a filename-derived default "
    "would plant a phantom row on the agent rail. Nothing was posted.")


class AgentIdentityRequired(Exception):
    """§S5 — raised by `require_agent_id` when no `--agent` was declared.

    Carries no fallback value by design: the caller MUST convert it into an
    `ok:false` envelope + non-zero exit (see `run_verb` /
    `emit_agent_identity_hard_stop`) and issue NO POST."""

    def __init__(self, detail=AGENT_IDENTITY_REQUIRED_DETAIL):
        super().__init__(detail)
        self.detail = detail


def agent_identity_warning():
    """The §S5 warning dict for a hard-stopped verb (fresh copy per call, so a
    caller mutating its warnings[] can never corrupt the constant)."""
    return {"code": AGENT_IDENTITY_REQUIRED_CODE,
            "detail": AGENT_IDENTITY_REQUIRED_DETAIL}


def require_agent_id(args):
    """§S5 — the ONE fleet-wide agent-identity resolver. Returns the explicit
    `--agent` value; raises `AgentIdentityRequired` when there is none.

    No fallback, no default, no `$WORKFLOW_ROLE` — an agent that cannot say who
    it is has no business appearing on the board."""
    explicit = getattr(args, "agent", None)
    if explicit:
        return explicit
    raise AgentIdentityRequired()


def optional_agent_id(args):
    """§S5 companion for the paths that DECORATE an envelope with an agentId but
    POST nothing under it (e.g. a no-ingest local test run): the explicit
    `--agent` value, else None so the key is simply OMITTED.

    Still no fabrication — the difference from `require_agent_id` is only that
    an absent identity is legal here, because nothing reaches the agent rail."""
    return getattr(args, "agent", None) or None


def emit_agent_identity_hard_stop(verb, context=None):
    """§S5 — emit the `ok:false` hard-stop envelope (stdout) plus the human
    error line (stderr) for an undeclared identity, and return the NON-ZERO exit
    code the client's `main` must exit with. Nothing is posted from this path."""
    warning = agent_identity_warning()
    emit_axi(verb or "unknown", False, {}, context or {}, [warning],
             legacy_line=(f"error: {AGENT_IDENTITY_REQUIRED_CODE} — "
                          f"{AGENT_IDENTITY_REQUIRED_DETAIL}"))
    return 2


# ── CR-CRU-107 §S2 — the second hard stop: `plan-file` cannot resolve WHICH ──
#
# cycles to file. Same route as the identity stop above (a typed exception from
# the shared verb, converted by `run_verb`, an `ok:false` envelope on stdout,
# exit 2, nothing posted), so all five clients inherit it without a line of
# per-client code. The three refusals share that shape and NOTHING else: a
# caller who passed both flags, one who passed neither, and one whose `--cycles`
# split to nothing each need a different next move, and one canned `help[]`
# reused across them would name none of them (AXI principle 6).

CYCLE_FLAGS_CONFLICT_CODE = "cycle-flags-conflict"
CYCLE_SELECTION_REQUIRED_CODE = "cycle-selection-required"
CYCLE_LIST_EMPTY_CODE = "cycle-list-empty"

# The corrected call every refusal hands back: one label per flag, so there is
# no delimiter left to collide with the label's own punctuation (§S1). The two
# occurrences carry DISTINCT placeholders (`<c1>`/`<c2>`, the form AC8 pins on
# `_next_start_help`): one identical token repeated reads as a duplicated
# argument to anyone copying it out of a refusal envelope, which is the
# opposite of the repetition the template exists to teach.
CYCLE_FLAG_TEMPLATE = ('plan-file --cr <CR-id> --title "<brief>" '
                       '--cycle "<c1>" --cycle "<c2>" --agent <agentId>')


def cycle_list_empty_help():
    """§S2 — the `cycle-list-empty` remedy, shared by BOTH halves of the same
    defect: a `--cycle` occurrence that names no cycle and a `--cycles` value
    that splits to nothing. One list, so the two cannot drift into telling the
    caller different things about the same refusal."""
    return [f"{CYCLE_FLAG_TEMPLATE} — one label per flag, so a label carrying "
            f"commas or semicolons files as ONE cycle",
            'or give --cycles a comma-separated list with at least one '
            'non-empty label, e.g. --cycles "c1,c2"']


class CycleSelectionRefused(Exception):
    """§S2 — raised by `plan_file_cycle_labels` when the cycle list a
    `plan-file` call asks for cannot be resolved unambiguously.

    Like `AgentIdentityRequired` it carries no fallback, because every fallback
    here files a plan the caller did not ask for — which is the defect this CR
    exists to end. Carries the AXI `code`, the `error` detail and the `help[]`
    steps for THIS refusal; the caller MUST convert it into an `ok:false`
    envelope + non-zero exit (see `run_verb` /
    `emit_cycle_selection_hard_stop`) and issue NO POST."""

    def __init__(self, code, detail, help_steps):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.help = list(help_steps)


def emit_cycle_selection_hard_stop(verb, refusal, context=None):
    """§S2 — emit the `ok:false` refusal envelope (stdout) plus the human error
    line (stderr) for an unresolvable cycle list, and return the NON-ZERO exit
    code the client's `main` must exit with (the same 2 the identity hard stop
    returns). Nothing is posted from this path."""
    emit_axi(verb or "unknown", False,
             {"error": refusal.detail, "help": refusal.help},
             context or {}, [],
             legacy_line=f"error: {refusal.code} — {refusal.detail}")
    return 2


# ── CR-CRU-111 §S1 — the third hard stop: a tier verb with no declared run ─
#
# The vocabulary and the project's targets are two different facts, and
# conflating them is what let a targeted run claim `unit` for everything. A
# tier the vocabulary does not contain is argparse's own `invalid choice`; a
# tier it DOES contain, registered on this client with no target declared for
# it, is THIS refusal — it names the missing declaration rather than falling
# back to another target, because a run that silently widened to the whole
# suite would report a tier it did not perform.
#
# Same route as the two hard stops above (a typed exception, converted by
# `run_verb`, an `ok:false` envelope on stdout, nothing run and nothing
# posted), so all five clients inherit it without a line of per-client code.
# The exit code is 1 rather than the 2 those two return: this is a
# declaration the PROJECT has not made, not a malformed call the caller can
# retype.

TIER_RUN_UNDECLARED_CODE = "tier-run-undeclared"


def tier_run_undeclared_help(tier, declared, surface):
    """§S1/§S3 — the next moves for a tier with no declared target: declare one
    ON THIS STACK'S OWN SURFACE, or run a tier this client DOES run. The second
    step names those tiers by reading what the client actually wired, so a
    caller is never sent to a target that does not exist here either.

    CR-CRU-111 §S3/AC6a — `surface` is the caller client's one-line naming of
    WHERE the declaration goes (a `package.json` script, a discovery start-dir,
    a profile in `pom.xml`, a profile in `.config/nextest.toml`, a native `make`
    target). It is a REQUIRED argument, never a defaulted one: a refusal that
    prints the same sentence in all five clients tells a caller the tier is
    unwired and never where to wire it, which is a refusal that cannot be acted
    on. The SHAPE of the sentence is fleet-wide and lives here; the surface it
    names is that stack's own fact and is stated by that client, exactly as
    `TierVerb.runs` already is."""
    runnable = ", ".join(declared) if declared else "none yet"
    return [f"declare this stack's {tier} target — {surface} — then re-run "
            f"`{tier}`",
            f"tier verbs this client runs today: {runnable}",
            f"`{tier}` never falls back to another target: a run that widened "
            f"to the whole suite would report a tier it did not perform"]


class TierRunUndeclared(Exception):
    """§S1 — raised by a tier verb that is REGISTERED on this client and has
    no target declared for it, so there is nothing to run.

    Like the two refusals above it carries no fallback, because every fallback
    here runs something the caller did not ask for and reports it under the
    tier they did. Carries the AXI `detail` and the `help[]` for this refusal;
    `run_verb` converts it into the `ok:false` envelope and the non-zero exit,
    and NO test is run and NO ingest is posted from this path."""

    def __init__(self, tier, declared, surface):
        self.tier = tier
        self.declared = sorted(declared)
        self.surface = surface
        self.detail = (f"no {tier} target is declared for this stack, so the "
                       f"{tier} verb has nothing to run")
        self.help = tier_run_undeclared_help(tier, self.declared, surface)
        super().__init__(self.detail)


def emit_tier_run_undeclared_hard_stop(verb, refusal, context=None):
    """§S1 — emit the `ok:false` refusal envelope (stdout) plus the human error
    line (stderr) for a tier with no declared target, and return the NON-ZERO
    exit code the client's `main` must exit with. Nothing is run, nothing is
    posted from this path."""
    emit_axi(verb or refusal.tier, False,
             {"error": refusal.detail, "help": refusal.help},
             context or {}, [],
             legacy_line=f"error: {TIER_RUN_UNDECLARED_CODE} — {refusal.detail}")
    return 1


def _hard_stop_context(args, project_key_fn):
    """The best-effort `context` a hard-stopped verb's envelope carries.

    `project_key_fn(args)` is the client's own `.env` key resolver (project-dir
    resolution stays client-specific per this module's scope boundary); it is
    best-effort only — a project whose key cannot be resolved still hard-stops,
    just with a bare context, because the refusal matters more than the
    decoration."""
    if project_key_fn is None:
        return {}
    try:
        return axi_context(project_key_fn(args))
    except Exception:
        return {}


def run_verb(func, args, project_key_fn=None):
    """Fleet-uniform subcommand dispatch: run the resolved verb and convert a
    typed hard stop — an undeclared agent identity (§S5), an unresolvable
    cycle list (CR-CRU-107 §S2) or a tier with no declared target
    (CR-CRU-111 §S1) — into the `ok:false` envelope and a non-zero exit code
    instead of an unhandled traceback.

    CR-CRU-111 §S5 — a dispatch has ingested nothing YET, so the envelope's
    tier statement starts from `none` here: an invocation may never inherit
    what an earlier one in the same process put on the board."""
    forget_ingested_run()
    try:
        return func(args)
    except AgentIdentityRequired:
        return emit_agent_identity_hard_stop(
            getattr(args, "cmd", None), _hard_stop_context(args, project_key_fn))
    except CycleSelectionRefused as refusal:
        return emit_cycle_selection_hard_stop(
            getattr(args, "cmd", None), refusal,
            _hard_stop_context(args, project_key_fn))
    except TierRunUndeclared as refusal:
        return emit_tier_run_undeclared_hard_stop(
            getattr(args, "cmd", None), refusal,
            _hard_stop_context(args, project_key_fn))


def fleet_context(cr=None):
    """Env auto-context shared by gates + milestones: `cr` (when supplied),
    `wave` from $WORKFLOW_WAVE, `track` from $WORKFLOW_ROLE. Absent env keys are
    OMITTED (never fabricated) so an unset WORKFLOW_WAVE yields no `wave` key."""
    ctx = {}
    if cr:
        ctx["cr"] = cr
    wave = os.environ.get("WORKFLOW_WAVE")
    if wave:
        ctx["wave"] = wave
    role = os.environ.get("WORKFLOW_ROLE")
    if role:
        ctx["track"] = role
    return ctx


def parse_steps_flag(steps_raw):
    """Parse a `--steps "name:status,name:status"` flag into gate step dicts.
    A malformed entry (no colon, or an empty name/status) raises ValueError —
    the caller must surface it as a non-zero exit WITHOUT posting garbage."""
    steps = []
    for entry in steps_raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if ":" not in entry:
            raise ValueError(
                f"malformed --steps entry (expected name:status): {entry!r}")
        name, status = entry.split(":", 1)
        name, status = name.strip(), status.strip()
        if not name or not status:
            raise ValueError(
                f"malformed --steps entry (empty name or status): {entry!r}")
        steps.append({"name": name, "status": status})
    return steps


def map_axi_step_status(status):
    """Map a no-mistakes axi step status onto a gate step status."""
    return {
        "completed": "passed",
        "skipped": "skipped",
        "failed": "failed",
        "running": "running",
    }.get(status, status or "passed")


def sealed_outcome(raw, any_failed):
    """§S3 — resolve a SEALING gate's outcome, or None when the run reached no
    terminus this client understands.

    Two termini, and nothing else counts as one. A FAILED step is a resolved
    fact in its own right, so it seals `failed` whether or not the snapshot
    carries a top-level outcome — the defect being fixed is the green bias, not
    verdicts derived from steps. Otherwise the verdict is the run's OWN
    resolved outcome, mapped through the named `GATE_PASS_FAMILY` or taken
    verbatim when it is already one the server accepts.

    Everything left over answers None: no outcome at all (a bounded `--wait`
    elapsed while the run was still going), or an outcome in no family the
    fleet knows. A value nobody understands must not become green, and the
    absence of a failure is not a verdict."""
    if isinstance(raw, str) and raw:
        mapped = GATE_PASS_FAMILY.get(raw)
        if mapped:
            return mapped
        if raw in GATE_OUTCOMES:
            return raw
    return "failed" if any_failed else None


def gate_from_axi(decoded, intent, final):
    """Build a `gate` object from a decoded `no-mistakes axi` TOON snapshot.

    An in-flight snapshot (`final=False`) synthesises a valid interim outcome
    from its steps; the sealing snapshot (`final=True`) resolves the run's own
    terminus through `sealed_outcome`. Returns (gate_dict, step_count).

    §S3 — a sealing gate whose run reached NO terminus carries no `outcome` key
    at all: there is no honest value to put there, and its absence is the one
    fact the caller branches on before posting. Returning a gate rather than
    raising keeps the step ladder (the evidence of WHERE the run stopped)
    available to a caller that must report the hold."""
    run = decoded.get("run") if isinstance(decoded, dict) else None
    run = run or {}
    axi_steps = run.get("steps") or []
    steps = []
    any_failed = False
    for s in axi_steps:
        st = s.get("status")
        if st == "failed":
            any_failed = True
        steps.append({"name": s.get("step"), "status": map_axi_step_status(st)})
    if final:
        outcome = sealed_outcome(decoded.get("outcome"), any_failed)
    else:
        outcome = "failed" if any_failed else "checks-passed"
    gate = {"intent": intent}
    if outcome:
        gate["outcome"] = outcome
    gate["steps"] = steps
    head = run.get("head")
    if final and head:
        gate["push"] = {"commit": head}
    return gate, len(steps)


# ── CR-CRU-054 §S2 — the VERB SURFACE, lifted to ONE locus of truth ─────────
#
# `cmd_status`, `cmd_stop`, `cmd_checkpoint`, `cmd_abort`, `cmd_cycle_add`,
# `cmd_cr_close`, `cmd_gate_report`, `cmd_gate_run`, `_cycle_transition`,
# `_post_gate`, `_post_milestone` and `_add_gate_cycle_arg` each carried their
# FULL logic five times over (DN §1's NEEDS-LIFT set). The clients keep their
# local `def cmd_*` names — internal call sites and every client test harness
# address them unqualified — but each is now a thin wrapper over the
# implementation below, exactly the pattern CR-CRU-030 established for
# `_axi_context`/`_emit_axi` and C2/C3 extended to the HTTP and plan layers.
#
# Three things stay genuinely PER-CLIENT and are injected rather than flattened
# (flattening a parameterised value into one shared constant is the silent
# fleet-wide regression this CR exists to prevent):
#   * the base URL (four clients spell it `CRUCIBLE_URL`, arduino `CRUCIBLE`);
#   * the project-dir convention (arduino's `_project_dir(args)` vs the other
#     four's `_resolve_project_dir(args.project_dir)`) — resolved by the wrapper
#     and passed in ALREADY-RESOLVED, per this module's scope boundary;
#   * mvn's extra `maven_dir` field on the dashboard's status Namespace.


class ClientOps:
    """The client-side callables a lifted verb needs, gathered in one object.

    Every client builds a FRESH `ClientOps` per call from its own module
    globals, so the shared implementation observes a test that patches
    `module._post` / `module._emit_axi` / `module._agent_id` — the fleet's
    established harness idiom — instead of holding a stale reference captured
    at import time.
    """

    __slots__ = ("get", "post", "patch", "emit", "context", "agent_id",
                 "project_key", "plans_path", "open_plans", "resolve_plan",
                 "post_gate", "post_milestone", "base_url")

    def __init__(self, *, get, post, patch, emit, context, agent_id,
                 project_key, plans_path, open_plans, resolve_plan,
                 post_gate, post_milestone, base_url):
        self.get = get
        self.post = post
        self.patch = patch
        self.emit = emit
        self.context = context
        self.agent_id = agent_id
        self.project_key = project_key
        self.plans_path = plans_path
        self.open_plans = open_plans
        self.resolve_plan = resolve_plan
        self.post_gate = post_gate
        self.post_milestone = post_milestone
        self.base_url = base_url


def cmd_status(args, project_dir, ops):
    """§S6 — the plan/status READ verb (alias `plans`, no --agent). GET …/plans
    and return the queue as a uniform-table §S1 envelope plus a top-level
    `lastClosedCr` — the `cr` of the plan with the latest `closedAt`."""
    resp = ops.get(ops.plans_path(project_dir))
    if not resp.get("ok"):
        # CR-CRU-035 §S1 — hook-safe tolerant degrade: a plans-fetch failure
        # (server unreachable / non-ok) is a DEFINITIVE unavailable data-state
        # (AXI principle 5), NOT a command error. Emit ok:true + a structured
        # status-unavailable warning + an empty board + a concrete help[]
        # next-step, and exit 0 so a session-start hook can never hang or fail.
        # This state is DISTINCT from the no-plan empty state below (that one
        # carries NO warning) — the status-unavailable warning is the signal.
        detail = (f"could not reach the Crucible server to read the board: "
                  f"{resp.get('error')}")
        legacy = f"[crucible] status: board unavailable — {resp.get('error')}"
        ops.emit("status", True,
                 {"plans": [], "lastClosedCr": None, "count": 0,
                  "help": [f"check the Crucible server is running / reachable "
                           f"at {ops.base_url}"]},
                 ops.context(project_dir),
                 [{"code": "status-unavailable", "detail": detail}],
                 legacy)
        return 0
    plans = resp.get("plans", [])
    full_rows = build_status_rows(plans)
    last = last_closed_cr(plans)
    # §S10 — the DEFAULT projection is the minimal base column set
    # (cr,wave,status,activeCycleId); `--fields a,b,c` ADDS the requested extras
    # to that base, never replaces it.
    fields = getattr(args, "fields", None)
    requested = [f.strip() for f in fields.split(",") if f.strip()] if fields else []
    rows = select_status_fields(full_rows, requested)
    # §S12 — the pre-computed `count` is the TOTAL plans available (unaffected
    # by the --fields column projection), emitted even on an empty queue.
    count = len(plans)
    if not rows:
        legacy = "status: ok=True — no plans filed for this project"
        ops.emit("status", True,
                 {"plans": [], "lastClosedCr": None, "count": 0,
                  "help": HELP_STEPS["status"]},
                 ops.context(project_dir), [], legacy)
        return 0
    legacy = f"status: ok=True plans={len(rows)} lastClosedCr={last}"
    ops.emit("status", True,
             {"plans": rows, "lastClosedCr": last, "count": count,
              "help": HELP_STEPS["status"]},
             ops.context(project_dir), [], legacy)
    return 0


# ── CR-CRU-081 §S2 — the `queue` READ verb (the landing-record sources) ─────

# The whole feed depth the cr-merged scan reads. The events collection has no
# type filter, so the milestone source is a bounded scan of the newest N events
# rather than a query; N is deliberately far above any real project's milestone
# count so a `cr-merged` marker is not missed by truncation.
QUEUE_EVENTS_LIMIT = 5000


def build_queue_rows(entries):
    """CR-CRU-081 §S2 (PURE) — the project's registered CR queue as
    uniform-table-safe rows: one dict per entry with the SAME scalar-only
    key-set, so the list round-trips as a TOON Construct-3 table (the same
    rule `build_status_rows` follows). `planId` is null when the queue entry
    has no plan at all — which IS the fact the release ceremony needs."""
    return [{"cr": e.get("cr"), "wave": e.get("wave"),
             "status": e.get("status"), "planId": e.get("planId")}
            for e in entries or []]


def cr_merged_crs(events):
    """CR-CRU-081 §S2 (PURE) — the CR ids carrying a `cr-merged` milestone: the
    project's SECOND landing source, beside the closed plan record. A CR absent
    from BOTH has no landing record at any source, which is exactly the class
    the release ceremony must name rather than drop in silence."""
    return sorted({e.get("label") for e in events or []
                   if e.get("kind") == "milestone"
                   and e.get("type") == "cr-merged" and e.get("label")})


def cmd_queue(args, project_dir, ops):
    """CR-CRU-081 §S2 — the queue READ verb (no --agent): the two DB-side
    landing sources the release ceremony's provenance needs, in ONE read — the
    registered CR queue (GET …/queue) and the CR ids a `cr-merged` milestone
    covers (GET /api/v2/events). A pure carrier: every set operation over these
    ids stays in the ceremony, which is the only actor that also has git.

    Tolerant like `cmd_status`: an unreachable or non-ok source yields the empty
    set plus a structured warning, never an error — a release is PUBLISHED
    before it is reported and must never fail on its own provenance."""
    key = ops.project_key(project_dir)
    warnings = []

    resp = ops.get(f"/api/v2/projects/{key}/queue")
    if resp.get("ok"):
        rows = build_queue_rows(resp.get("entries"))
    else:
        rows = []
        warnings.append({
            "code": "queue-unavailable",
            "detail": (f"could not read the registered CR queue: "
                       f"{resp.get('error')}"),
        })

    events = ops.get(f"/api/v2/events?project={key}"
                     f"&limit={QUEUE_EVENTS_LIMIT}")
    if events.get("ok"):
        merged = cr_merged_crs(events.get("events"))
    else:
        merged = []
        warnings.append({
            "code": "milestones-unavailable",
            "detail": (f"could not read the cr-merged milestones: "
                       f"{events.get('error')}"),
        })

    ops.emit("queue", True,
             {"queue": rows, "crMerged": merged, "count": len(rows),
              "help": ["status"]},
             ops.context(project_dir), warnings,
             f"queue: ok=True entries={len(rows)} crMerged={len(merged)}")
    return 0


# ── CR-CRU-092 §S2–§S6 — `next`: the roadmap's decision oracle ─────────────
#
# ONE read (`GET …/queue`) in, ONE decision out: `NEXT`, `HOLD` or `DRAINED`.
# All three are ANSWERS (§S1), so all three exit 0 — the harness's 0/2/3 split
# is deliberately NOT adopted (the fleet's terminal-state rule,
# `clients/STATUS-CONTRACT.md:65-68`). The only non-answer is §S3's usage
# refusal, which exits 2.
#
# An ORACLE, not a scheduler (§S4): read-only, no `--agent`, no POST/PATCH,
# and it never scans past a blocked entry to something startable — that would
# be Crucible substituting a sequence of its own.
#
# §S5 is absolute, and AC11 enforces it by grep: nothing on this path opens,
# reads, imports or shells out to the HARNESS lane-plan database or its CLI.
# The two answers come from different datasets over different questions, and a
# disagreement between them is a real signal, left visible. No fallback, no
# cross-check, no merge — which is why this comment does not even name the
# harness's files.

# §S2 axis 1 — a CR has LANDED iff its SERVER-DERIVED status is one of these
# (`deriveQueueStatus`, src/store.ts:4256). Anything else — PENDING,
# IN_PROGRESS — is unmerged.
LANDED_STATUSES = ("COMPLETED", "COMPLETED_UNTRACKED")

# §S2 — the three DRAINED reasons and the four HOLD trigger kinds, as the
# vocabulary the DN fixes ("Reading the lane during execution"). Named here so
# the enum is one list rather than four string literals scattered downstream.
DRAINED_REASONS = ("wave-complete", "awaiting-assignment", "no-roadmap")
HOLD_TRIGGER_KINDS = ("in-flight", "dead-dependency", "dependency",
                      "unknown-dependency")

_TRACK_LANE_RE = re.compile(r"\d+")


def canonical_track(value):
    """§S3/AC18 (PURE) — the fleet's READ-side track canonicaliser: the exact
    mirror of `normalizeTrack` (src/store.ts:349-352). The first run of digits
    anywhere in the value, rendered as the PRD's locked wire format
    `track-<n>`; `None` when the value names no lane.

    Why a client-side copy of a server-side rule is NOT a second
    decision-maker: CR-CRU-091 §S9 puts ARGUMENT PARSING in the client half and
    the WRITE rule on the server. `next` writes nothing, so no round-trip
    exists to normalise its `--track`, and a naive by-value match would refuse
    `next --track 2` while `wave-sequence --track 2` succeeds — one flag, one
    project, two answers. The two implementations are held to one rule by
    assertion (AC18), not by comment."""
    if not value:
        return None
    lane = _TRACK_LANE_RE.search(value)
    return None if lane is None else f"track-{int(lane.group(0))}"


class QueueTrackFactUnpublished(Exception):
    """CR-CRU-108 §S2 — raised when a queue READ states no track fact.

    A typed hard stop in the shape `AgentIdentityRequired` and
    `CycleSelectionRefused` already establish: it carries the AXI `code`, the
    `error` detail and this refusal's `help[]`, and it carries NO fallback
    value by design. Deriving one from the entries beside it is precisely the
    second copy of the rule CR-CRU-108 deleted, and a read that omits the fact
    must fail LOUDLY rather than let a multi-track project read as
    single-track — that would be `next` picking a lane design §11 forbids it
    to pick. The caller MUST convert it into an `ok:false` envelope + non-zero
    exit (`cmd_next`), never a raw traceback."""

    def __init__(self, code, detail, help_steps):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.help = list(help_steps)


def queue_tracks(queue):
    """§S2/AC4 (PURE) — the lanes the queue READ PUBLISHED, read rather than
    re-derived: `GET …/queue` answers `{ok, entries, tracks}` and `tracks` is
    the whole track fact (`declaredTracks`, src/store.ts — sorted, distinct,
    non-blank, trimmed, echoed as stored).

    `len() > 1` is still the whole definition of multi-track and the values
    are still echoed to the caller unchanged. What changed is WHOSE answer it
    is: the server owns the normalisation, so it is the one surface that may
    say how many lanes a project declares. A client that recomputed the list
    answered FOUR lanes where the server answered TWO — a whitespace-only
    value and a padded duplicate — and `next` refused a queue it owed an
    answer.

    A payload carrying no `tracks` list is not "no tracks": it is a read that
    did not state the fact, and it raises rather than degrading."""
    tracks = (queue or {}).get("tracks")
    if not isinstance(tracks, list):
        raise QueueTrackFactUnpublished(
            "queue-track-fact-unpublished",
            "the queue read published no `tracks` list, so the project's "
            "declared lanes are unknown — next will not guess one",
            ["upgrade the Crucible server: GET /api/v2/projects/<key>/queue "
             "publishes `tracks` beside `entries`",
             "then re-run next"])
    return list(tracks)


def _entry_seq(entry):
    """The DECLARED position, or None. `bool` is an `int` subclass — excluded
    so a stray `True` can never pose as a position (the same guard
    `echoed_cycle_id` applies)."""
    seq = entry.get("seq")
    if isinstance(seq, int) and not isinstance(seq, bool):
        return seq
    return None


def _is_actionable(entry):
    """§S2 — the TWO axes. A CR is actionable iff it is `PENDING` on the
    server-derived status axis AND carries no `lifecycle` disposition.

    The second half is load-bearing: `deriveQueueStatus(projectKey, cr,
    shipped)` cannot see `lifecycle`, by signature, so a VOID cr with no plan
    reads `status: "PENDING"`. Keyed on `status` alone this verb would offer,
    as the next thing to build, work whose author explicitly recorded that it
    is not happening."""
    return entry.get("status") == "PENDING" and "lifecycle" not in entry


def _dead_entries(entries):
    """The lane's declared-dead rows, as `(cr, lifecycle)`. A dead entry is not
    blocked work — it is not work — which is why it leaves the candidate set
    exactly as a landed one does, and why §S4's no-scanning-past rule is not
    engaged by it."""
    return [(e.get("cr"), e["lifecycle"]) for e in entries
            if isinstance(e.get("lifecycle"), dict)]


def _dead_phrase(cr, lifecycle):
    state = lifecycle.get("state")
    by = lifecycle.get("by")
    return f"{cr} ({state} by {by})" if by else f"{cr} ({state})"


def _next_start_help(entry):
    """§S6/AC2 — `NEXT`'s state-derived `help[]`: the concrete call that STARTS
    this cr, carrying its own wave (flags per `clients/python-crucible.py:1552-1568`).
    `next` has no `HELP_STEPS` entry precisely so this cannot be canned."""
    step = (f'plan-file --cr {entry.get("cr")} --title "<brief>" '
            f'--cycle "<c1>" --cycle "<c2>" --agent <agentId>')
    wave = entry.get("wave")
    if wave:
        step += f" --wave {wave}"
    return [step, "status"]


def _hold_help(trigger):
    """§S6 — the move that clears the NAMED trigger, then `next` again. Each
    kind demands a different response, which is the whole point of splitting
    the vocabulary rather than emitting one "blocked" state."""
    kind = trigger["kind"]
    if kind == "in-flight":
        cr = trigger["cr"]
        steps = [f"cr-close --cr {cr} --commit <sha> --agent <agentId> — "
                 f"{cr} occupies the lane and holds everything behind it"]
    elif kind == "dead-dependency":
        cr, state, by = trigger["cr"], trigger["state"], trigger.get("by")
        target = f"at {by}" if by else "off it"
        steps = [f"re-point the dependsOn {target} in docs/changes/README.md "
                 f"and re-run queue-file — {cr} is {state}, so waiting will "
                 f"never clear this"]
    elif kind == "unknown-dependency":
        cr = trigger["cr"]
        steps = [f"cr-plan --cr {cr} --release <v> --wave <n> "
                 f"--title <brief> --agent <agentId> — the queue does not "
                 f"hold {cr}"]
    else:
        steps = [f"cr-close --cr {row['cr']} --commit <sha> --agent <agentId>"
                 for row in trigger["blockedBy"]]
    steps.append("next")
    return steps


def _drained_help(reason, lane, next_wave=None):
    """§S6 — `DRAINED`'s state-derived `help[]`: the move that would REFILL the
    lane. `wave-complete` additionally names the lane's corpses, so a lane that
    drained because its remaining work was declared dead reads as legible
    rather than mysterious (AC16).

    §S2 — on a finished wave the move that OPENS the next one carries that
    wave's LABEL as data, taken verbatim from the published order, so the
    caller is not left to re-derive it off the board; a wave with nothing
    published after it keeps the placeholder, because there is no label to
    name."""
    sequence = ("wave-sequence --release <v> --wave <n> --crs <a,b,c> "
                "--agent <agentId>")
    if reason == "no-roadmap":
        return ["release-propose --label <v> --agent <agentId>",
                "cr-plan --cr <id> --release <v> --wave <n> --title <brief> "
                "--agent <agentId>",
                sequence]
    if reason == "awaiting-assignment":
        return [f"{sequence} --track <n>"]
    steps = []
    dead = _dead_entries(lane)
    if dead:
        steps.append("the lane's remaining entries are declared dead: "
                     + ", ".join(_dead_phrase(cr, lc) for cr, lc in dead))
    steps.append("cr-plan --cr <id> --release <v> --wave <n> --title <brief> "
                 "--agent <agentId>")
    opens = next_wave or "<n>"
    steps.append(f"wave-sequence --release <v> --wave {opens} "
                 f"--crs <a,b,c> --agent <agentId>")
    return steps


def _next_trigger(target, lane, entries):
    """§S2 (PURE) — the ONE cause holding `target`, or `(None, warnings)` when
    nothing does. Returns `(trigger, warnings)`.

    Evaluated in the order the DN fixes: `in-flight` first (an occupied lane
    holds everything behind it), then `dead-dependency` (waiting NEVER clears
    it, so it outranks a blocker that waiting does clear), then `dependency`,
    then `unknown-dependency`.

    Occupancy is scoped to the LANE; dependency resolution is scoped to the
    WHOLE queue, because a `dependsOn` legitimately crosses tracks."""
    for entry in lane:
        if entry.get("status") == "IN_PROGRESS":
            return {"kind": "in-flight", "cr": entry.get("cr")}, []

    by_cr = {e.get("cr"): e for e in entries if e.get("cr")}
    dead, blocked_by, unknown = [], [], []
    for dep in target.get("dependsOn") or []:
        entry = by_cr.get(dep)
        if entry is None:
            unknown.append(dep)
            continue
        # The status axis decides LANDED first: a dep that COMPLETED did the
        # work, whatever lifecycle note was filed over it afterwards.
        if entry.get("status") in LANDED_STATUSES:
            continue
        lifecycle = entry.get("lifecycle")
        if isinstance(lifecycle, dict):
            dead.append((dep, lifecycle))
        else:
            blocked_by.append({"cr": dep, "status": entry.get("status")})

    warnings = []
    if unknown:
        # §12 — reported, never rejected, and it rides a STRUCTURED warning
        # alongside whichever trigger wins.
        warnings.append({
            "code": "unknown-dependency",
            "detail": (f"{target.get('cr')} declares a dependsOn the queue "
                       f"does not hold: {', '.join(unknown)} — a roadmap "
                       f"authored forwards reads back this way until the dep "
                       f"is filed with cr-plan"),
        })

    if dead:
        dep, lifecycle = dead[0]
        trigger = {"kind": "dead-dependency", "cr": dep,
                   "state": lifecycle.get("state")}
        if lifecycle.get("by"):
            trigger["by"] = lifecycle["by"]
        return trigger, warnings
    if blocked_by:
        return {"kind": "dependency", "blockedBy": blocked_by}, warnings
    if unknown:
        return {"kind": "unknown-dependency", "cr": unknown[0]}, warnings
    return None, warnings


def _lane_fields(release, wave, track, entry=None):
    """The CONTAINER an answer is ABOUT — its release when one is in scope, its
    wave, and its track only when the project declares more than one lane.

    A reader can then tell WHICH container an answer covers instead of
    inferring it from the cr that came back, which a HOLD or a DRAINED does not
    even name.

    `entry` is the answer's own row where it has one. An explicit `--release`
    IS the scope; with no flag a row's own declared release still rides its
    answer verbatim, and a row declaring none carries none — never a
    neighbour's.

    The track is the RESOLVED lane rather than the row's stored value: one
    declared lane is no lane to choose between, and echoing a stored track
    there would tell a reader a lane was resolved when none was."""
    fields = {}
    declared = release or (entry.get("release") if entry else None)
    if declared:
        fields["release"] = declared
    if wave:
        fields["wave"] = wave
    if track:
        fields["track"] = track
    return fields


def _announced_fields(fields, announced):
    """§S2 — the boundary statement, carried ALONGSIDE the decision on every
    answer: the crossing is a fact about the resolved WAVE, not about which
    decision that wave produced.

    It is ABSENT rather than empty or null when there is nothing to announce,
    so a reader tells "no crossing" from "a crossing of an unnamed wave" by key
    presence alone, and an expired announcement leaves no residue behind."""
    if announced:
        fields["waveCompleted"] = announced
    return fields


def _next_answer(entry, lane_fields, announced=None):
    """§S2/AC14 — `NEXT`'s result fields. Every declared value is CONSUMED
    verbatim and an undeclared `release` is OMITTED, never defaulted, never
    index-derived. The container rides every answer through `_lane_fields`, so
    one rule spells it for all three decisions."""
    fields = {"decision": "NEXT", "cr": entry.get("cr")}
    seq = _entry_seq(entry)
    if seq is not None:
        fields["seq"] = seq
    fields.update(lane_fields)
    _announced_fields(fields, announced)
    fields["help"] = _next_start_help(entry)
    return fields


def _drained_answer(reason, rows, lane_fields, announced=None,
                    next_wave=None):
    """§S2 — the empty answer, and the container it is empty FOR. `rows` is the
    set the reason is a claim about: the WAVE when the wave itself finished,
    the lane when only the lane did — which is what `help[]` reads to name the
    corpses that emptied it."""
    fields = {"decision": "DRAINED", "reason": reason}
    fields.update(lane_fields)
    _announced_fields(fields, announced)
    fields["help"] = _drained_help(reason, rows, next_wave)
    return fields


def _wave_of_the_lane(scope, wave):
    """§S2 (PURE) — the ONE wave an answer is about.

    An explicit `--wave` IS the answer. Otherwise it is the wave the first
    ACTIONABLE row declares, taken in the order the server PUBLISHED and never
    re-derived from the `seq` value; with nothing actionable anywhere, the last
    wave published. One pass, because the answer is the first row that
    qualifies and the fallback is the last row seen.

    A row whose `wave` is the empty string is in NO wave and resolves none —
    the row the write-side scope guard skips when it derives the wave it
    permits. A reader that adopted it would offer work the server refuses."""
    if wave is not None:
        return wave
    published = None
    for entry in scope:
        declared = entry.get("wave")
        if not declared:
            continue
        if _is_actionable(entry):
            return declared
        published = declared
    return published


def _previous_published_wave(scope, wave):
    """§S2 (PURE) — the PREDECESSOR: the previous DISTINCT wave label in the
    order the server PUBLISHED, or `None` when the resolved wave is the
    earliest published and has crossed nothing.

    Waves are strings on the wire, so the label standing immediately before the
    resolved wave's FIRST row is taken verbatim — never parsed as a number,
    never sorted, never re-derived from the `seq` value, which is the same
    published-order rule `_wave_of_the_lane` reads the resolved wave by. Every
    label before that first row differs from the resolved one by construction,
    so the nearest of them IS the previous distinct label.

    A row whose `wave` is the empty string is in NO wave and can be neither a
    predecessor nor a step towards one — skipped exactly as the resolution
    skips it."""
    if wave is None:
        return None
    previous = None
    for entry in scope:
        declared = entry.get("wave")
        if not declared:
            continue
        if declared == wave:
            return previous
        previous = declared
    return None


def _next_published_wave(scope, wave):
    """§S2 (PURE) — the wave the lane moves INTO once this one is finished: the
    next distinct label published after the resolved wave's rows, or `None`
    when nothing follows it. Read the same verbatim way as the predecessor, so
    a zero-padded or non-numeric label is reachable without a case of its
    own."""
    if wave is None:
        return None
    reached = False
    for entry in scope:
        declared = entry.get("wave")
        if not declared:
            continue
        if declared == wave:
            reached = True
        elif reached:
            return declared
    return None


def _boundary_announcement(scope, container, wave):
    """§S2 (PURE) — the predecessor wave this read PROVES has completed, or
    `None` when there is nothing to announce.

    The crossing has just happened when the predecessor holds no actionable
    entry left — a landed CR and a declared-dead one are both finished for this
    predicate, which `_is_actionable` already spells — AND the resolved wave
    has landed nothing yet. It therefore EXPIRES by itself the moment the new
    wave's first cr merges, and needs no state on either side.

    A resolved wave nothing precedes announces nothing: "the predecessor
    completed" is a claim about a predecessor that EXISTS, and a container that
    selects no row has no first row to stand behind.

    THE STATEMENT IS SCOPED TO THE CONTAINER ASKED ABOUT, deliberately (ruled
    at cycle 401). Both the predecessor and its completeness are read over
    `scope` — the caller's release narrowing — so a release-scoped question is
    answered about that release and NOTHING else: the answer announces that the
    predecessor completed within it even while that wave still holds an
    actionable entry declaring no release. That is the same narrowing
    membership already gets, and the envelope names the release beside the
    statement; the unscoped reading would report on work the caller explicitly
    excluded."""
    predecessor = _previous_published_wave(scope, wave)
    if predecessor is None:
        return None
    if any(_is_actionable(e) for e in scope
           if e.get("wave") == predecessor):
        return None
    if any(e.get("status") in LANDED_STATUSES for e in container):
        return None
    return predecessor


def resolve_next(entries, track=None, tracks=None, release=None, wave=None):
    """§S2/§S3 (PURE) — the decision resolver: the lane's declared sequence
    plus live state in, exactly one decision out.

    A lane is three dimensions and each does its own job. `release` and `wave`
    are CONTAINERS, matched VERBATIM against the entry's own strings: nothing
    is coerced on the way in, so `6` and `06` are two waves and `0.2.0` and
    `v0.2.0` two releases. Membership is declared, never inferred, so a row
    with no release is in none. `track` is SCHEDULING — which cr comes next,
    in what order — and keeps `canonical_track`'s digit rule, a mirror of the
    server's own write rule.

    The wave predicate therefore reads `wave` and NOTHING else: a wave is a
    container of CRs, so a track-filtered set can never answer whether one is
    finished — not as a filter, not as a union of per-track slices, not as a
    special case for one lane or many. A lane holding no actionable cr inside
    a wave that still holds some is `awaiting-assignment`; `wave-complete` is
    reserved for the wave itself, independent of how many tracks it was
    scheduled across.

    `tracks` is the list the queue read PUBLISHED (CR-CRU-108 §S2), handed in
    rather than derived here: the refusal names the SERVER's lanes or it names
    none. There is deliberately no default answer — `None` means no read
    stated the fact, and that raises `QueueTrackFactUnpublished` rather than
    resolving over a lane set nobody published.

    Returns `(ok, code, fields, warnings)` — a tuple, like the module's
    existing `resolve_single_plan`. `code` is the process exit code, so the
    three DECISIONS (all answers, all `0`) and §S3's usage refusal (`2`) come
    out of one function rather than being re-derived by the caller."""
    if tracks is None:
        raise QueueTrackFactUnpublished(
            "queue-track-fact-unpublished",
            "the decision was asked for without the `tracks` list the queue "
            "read publishes, so the project's declared lanes are unknown — "
            "next will not guess one",
            ["pass the `tracks` the queue read published"])
    entries = list(entries or [])
    tracks = list(tracks)
    wanted = canonical_track(track)

    # §S3 — track scoping is required only when the DATA justifies it. With one
    # track or none the flag is never prompted for and `tracks` never rides the
    # envelope; with more than one the verb refuses to guess and names the live
    # lanes. It never picks a lane.
    if len(tracks) > 1 and (
            wanted is None
            or wanted not in {canonical_track(t) for t in tracks}):
        return (False, EXIT_USAGE,
                {"needs": ["track"], "tracks": tracks,
                 "totalCount": len(tracks),
                 "help": [f"next --track <n> — the live lanes are "
                          f"{', '.join(tracks)}"]},
                [])

    # The CONTAINER, resolved BEFORE any lane is chosen and never from the
    # lane: the release scope narrows to DECLARED membership, and the wave
    # follows from that scope's own `wave` values alone.
    scope = entries if release is None else [
        e for e in entries if e.get("release") == release]
    resolved_wave = _wave_of_the_lane(scope, wave)
    container = scope if resolved_wave is None else [
        e for e in scope if e.get("wave") == resolved_wave]

    # CR-CRU-095 §S1 — the lane is consumed in the order the server PUBLISHED
    # (the canonical key lives in `listQueue`); a reader re-sorting it by the
    # seq VALUE is what CR-091 AC18 outlawed.
    lane = container if wanted is None else [
        e for e in container if canonical_track(e.get("track")) == wanted]
    resolved_track = wanted if len(tracks) > 1 else None
    lane_fields = _lane_fields(release, resolved_wave, resolved_track)
    # §S2 — the boundary this ONE read already proves, resolved before any
    # decision so the same statement rides whichever answer the lane produces.
    announced = _boundary_announcement(scope, container, resolved_wave)

    warnings = []
    unpositioned = [e.get("cr") for e in lane if _entry_seq(e) is None]
    if unpositioned:
        # CR-CRU-091 §S2 — the roadmap publishes `seq` on EVERY entry, so an
        # entry without one is a defect to surface, not a hole to fill with a
        # position. THE DETAIL NAMES NO CR (CR-CRU-097 AC3a): this module is
        # SHARED, so all five clients emit this string on any project's
        # board, and it states the contract it checks rather than the id of
        # the CR that wrote it. The lineage stays here.
        warnings.append({
            "code": "missing-seq",
            "detail": (f"the queue published no seq for "
                       f"{', '.join(unpositioned)} — the roadmap declares "
                       f"one on every entry, so this is a roadmap defect; "
                       f"re-run wave-sequence for its wave"),
        })

    if not entries:
        return (True, 0,
                _drained_answer("no-roadmap", lane, lane_fields, announced),
                warnings)
    if not container:
        # The declared container holds no row at all, so nothing is SCHEDULED
        # here — which is not the claim that a wave finished.
        return (True, 0,
                _drained_answer("awaiting-assignment", lane, lane_fields,
                                announced),
                warnings)

    if not [e for e in container if _is_actionable(e)]:
        # A MEMBERSHIP claim, read off the container and nothing else, so it
        # is the same claim from every lane and from no lane at all. The wave
        # is finished, so its help[] names the wave the lane moves into.
        return (True, 0,
                _drained_answer("wave-complete", container, lane_fields,
                                announced,
                                _next_published_wave(scope, resolved_wave)),
                warnings)

    actionable = [e for e in lane if _is_actionable(e)]
    if not actionable:
        # The wave still holds actionable work — a sibling lane's, or work
        # this lane was never scheduled — so this answer makes no claim about
        # the wave.
        return (True, 0,
                _drained_answer("awaiting-assignment", lane, lane_fields,
                                announced),
                warnings)

    target = actionable[0]
    target_fields = _lane_fields(release, resolved_wave, resolved_track,
                                 target)
    trigger, trigger_warnings = _next_trigger(target, lane, entries)
    warnings.extend(trigger_warnings)
    if trigger is None:
        return (True, 0, _next_answer(target, target_fields, announced),
                warnings)

    fields = {"decision": "HOLD", "cr": target.get("cr")}
    seq = _entry_seq(target)
    if seq is not None:
        fields["seq"] = seq
    fields.update(target_fields)
    _announced_fields(fields, announced)
    fields["trigger"] = trigger
    fields["help"] = _hold_help(trigger)
    return (True, 0, fields, warnings)


def _next_legacy_line(ok, fields):
    """The human line (stderr only) — one sentence per outcome, never the
    envelope in prose.

    Every decision STATES its wave. This is the channel an orchestrator reads
    when it is not parsing the envelope, and a line that names no container is
    how a wave boundary gets crossed silently."""
    if not ok:
        return (f"next: ok=False needs=track — {len(fields['tracks'])} live "
                f"track(s): {', '.join(fields['tracks'])}")
    decision = fields["decision"]
    wave = f" wave={fields['wave']}" if fields.get("wave") else ""
    if decision == "NEXT":
        return (f"next: decision=NEXT cr={fields['cr']} "
                f"seq={fields.get('seq')}{wave}")
    if decision == "HOLD":
        return (f"next: decision=HOLD cr={fields['cr']} "
                f"trigger={fields['trigger']['kind']}{wave}")
    return f"next: decision=DRAINED reason={fields['reason']}{wave}"


def next_context(context, ok, track):
    """§S6 P7 — this verb's `context` block: the lane the answer is ABOUT.

    `axi_context` fills `track` from `$WORKFLOW_ROLE`, which is the lane the
    session DECLARED. When `--track` scoped the answer, that flag —
    canonicalised, so one rule spells the lane on the read side too (AC18) —
    IS the resolved lane, and it overrides the declaration: an answer about
    track-2 emitted from a session that declared track-1 must not stamp itself
    track-1, or an agent reading `context.track` is misled by its own
    envelope.

    Nothing is overridden when nothing was resolved. A bare invocation scoped
    no lane — the answer covers the queue as published — and §S3's refusal
    scoped none BY DEFINITION, because refusing is precisely not picking a
    lane. In both the declaration stands as the only track fact available.

    Adjusts the block `ops.context` built FRESH for this call and hands it
    back, so the change is scoped to `next`: `emit_axi` is untouched and no
    other verb's context moves."""
    resolved = canonical_track(track) if ok else None
    if resolved:
        context["track"] = resolved
    return context


def next_projection(ok, fields, args):
    """§S6 P2 (C2) — `--fields` NARROWS the one decision, through the SAME
    `select_row_fields` a roadmap row is narrowed by, so one flag means one
    thing across the fleet.

    A projection narrows a RECORD, and `ok=False` carries none: §S3's refusal
    is scaffolding — `needs`, the live `tracks[]`, its `totalCount` and the
    state-derived `help[]` — so narrowing THAT to a decision key empties the
    body outright and hands an agent that habitually passes `--fields` a
    refusal naming no reason, no candidate lane and no next step, defeating
    P4, P9 and §S3's whole point. The exemption is therefore STRUCTURAL — it
    keys on the ABSENCE of a record, never on the flag's value — exactly as
    `emit_cr_plan_ask` narrows only its `releases` rows and leaves
    `needs`/`totalCount`/`help` whole, and as `roadmap_scalar_list` leaves a
    list of bare ids alone because a scalar has no columns to narrow.

    The default (no flag) is the WHOLE decision: there is no truncation to
    defeat on a single-record answer, which is exactly why P3's `--full` is
    absent by shape rather than added as a no-op. The transport-failure
    envelope never arrives here at all — `cmd_next` emits and returns before
    the resolver runs — matching `roadmap_failure_fields`, which `--fields`
    also leaves alone."""
    if not ok:
        return fields
    return select_row_fields([fields], getattr(args, "fields", None))[0]


def cmd_next(args, project_dir, ops):
    """§S2/§S6 — the `next` READ verb (no `--agent`, §S4): one
    `GET …/queue`, one decision, one envelope.

    The read failure is NOT tolerantly degraded the way `cmd_status`/`cmd_queue`
    degrade theirs: an unreadable roadmap and an empty one are DIFFERENT FACTS
    (AC13), so a failed read exits 1 with no `decision` key rather than
    reporting `DRAINED` and walking the orchestrator past a lane it never
    actually read."""
    key = ops.project_key(project_dir)
    resp = ops.get(f"/api/v2/projects/{key}/queue")
    if not resp.get("ok"):
        error = resp.get("error")
        ops.emit("next", False,
                 {"help": [f"check the Crucible server is running / reachable "
                           f"at {ops.base_url}, then re-run next"]},
                 ops.context(project_dir),
                 [{"code": "queue-unavailable",
                   "detail": (f"could not read the registered CR queue: "
                              f"{error}")}],
                 f"next: ok=False — the roadmap could not be read: {error}")
        return 1

    track = getattr(args, "track", None)
    try:
        tracks = queue_tracks(resp)
    except QueueTrackFactUnpublished as refusal:
        # The SAME shape the failed read above emits, for the same reason: a
        # read that never stated the track fact is a read this verb cannot act
        # on, and answering anyway would pick a lane out of a set nobody
        # published.
        ops.emit("next", False,
                 {"error": refusal.detail, "help": refusal.help},
                 ops.context(project_dir),
                 [{"code": refusal.code, "detail": refusal.detail}],
                 f"next: ok=False — {refusal.detail}")
        return 1
    # All three dimensions ride the ONE read already made: narrowing the lane
    # is a question about the payload in hand, never a second round-trip.
    ok, code, fields, warnings = resolve_next(
        resp.get("entries"), track=track, tracks=tracks,
        release=getattr(args, "release", None),
        wave=getattr(args, "wave", None))
    # The legacy line reads the UNprojected decision: the human channel is not
    # narrowed by a machine-channel projection flag.
    ops.emit("next", ok, next_projection(ok, fields, args),
             next_context(ops.context(project_dir), ok, track),
             warnings, _next_legacy_line(ok, fields))
    return code


def status_namespace(**extra_fields):
    """§S14 (PARAMETERISED, DN §2) — the `cmd_status` args Namespace the no-arg
    dashboard forwards.

    `project_dir`/`fields` are the fleet-wide base; `extra_fields` carries the
    per-client additions (mvn's own `cmd_status` reads an extra `maven_dir`,
    its module-dir convention). The extras stay a PARAMETER rather than being
    flattened into the base set: adding mvn's field to the other four would be
    precisely the silent fleet-wide regression §S1's classification exists to
    prevent."""
    return argparse.Namespace(project_dir=None, fields=None, **extra_fields)


def cmd_stop(args, project_dir, ops):
    """§S7 — project-level stop (POST …/projects/<key>/stop). No plan
    targeting; checkpoints every open plan server-side and reports the count.

    CR-CRU-056 §S2b — requires a live registered caller (`--agent`), resolved
    FIRST so the hard stop precedes any request."""
    agent_id = ops.agent_id(args)
    resp = ops.post(f"/api/v2/projects/{ops.project_key(project_dir)}/stop",
                    {"agentId": agent_id})
    ok = resp.get("ok", False)
    legacy = (f"stop: ok={ok} checkpointed={resp.get('checkpointed')}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    ops.emit("stop", bool(ok),
             {"checkpointed": resp.get("checkpointed"), "help": HELP_STEPS["stop"]},
             ops.context(project_dir), [], legacy)
    return 0 if ok else 1


def cmd_checkpoint(args, project_dir, ops):
    """§S7 — checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint).
    Resolves the single open plan, or --cr among several — the /shutdown
    emergency flow checkpoints the CURRENTLY open work, never a numeric id the
    caller doesn't have.

    CR-CRU-056 §S2b — requires a live registered caller (`--agent`), resolved
    FIRST so the hard stop precedes any request."""
    agent_id = ops.agent_id(args)
    plan, rc = ops.resolve_plan("checkpoint", project_dir, args.cr,
                                {"help": HELP_STEPS["checkpoint"]}, open_only=True)
    if plan is None:
        return rc
    resp = ops.post(f"{ops.plans_path(project_dir)}/{plan['planId']}/checkpoint",
                    {"agentId": agent_id})
    ok = resp.get("ok", False)
    legacy = (f"checkpoint: ok={ok} plan={plan['planId']}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    ops.emit("checkpoint", bool(ok),
             {"plan": plan["planId"], "changed": resp.get("changed"),
              "help": HELP_STEPS["checkpoint"]},
             ops.context(project_dir, cr=plan.get("cr")), [], legacy)
    return 0 if ok else 1


def cmd_abort(args, project_dir, ops):
    """§S7 — abort the resolved OPEN plan (POST …/plans/<id>/abort). WITHOUT
    --user-approved the body's `userApproved` is false, so the server's
    discouraging 409 refusal stays reachable (surfaced as ok:false +
    non-zero, never a silent no-op).

    CR-CRU-056 §S2b — requires a live registered caller (`--agent`), resolved
    FIRST so the hard stop precedes any request."""
    agent_id = ops.agent_id(args)
    plan, rc = ops.resolve_plan("abort", project_dir, args.cr,
                                {"help": HELP_STEPS["abort"]}, open_only=True)
    if plan is None:
        return rc
    resp = ops.post(f"{ops.plans_path(project_dir)}/{plan['planId']}/abort",
                    {"userApproved": bool(args.user_approved), "agentId": agent_id})
    ok = resp.get("ok", False)
    legacy = (f"abort: ok={ok} plan={plan['planId']} "
              f"userApproved={bool(args.user_approved)}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    ops.emit("abort", bool(ok),
             {"plan": plan["planId"], "help": HELP_STEPS["abort"]},
             ops.context(project_dir, cr=plan.get("cr")), [], legacy)
    return 0 if ok else 1


def cmd_cycle_add(args, project_dir, ops):
    """§S4 — append a cycle to a plan. Resolve the target plan exactly like
    plan-backfill (ALL plans, optional --cr), POST …/plans/<planId>/cycles with
    ONLY the label, and let the SERVER reject a CLOSED/absent plan — never a
    client-side pre-filter. The assigned numeric id stays machine-readable.

    CR-CRU-056 §S2b — requires a live registered caller (`--agent`), resolved
    FIRST so the hard stop precedes any request."""
    agent_id = ops.agent_id(args)
    # §S15 — the next step after appending a cycle is to activate it; help[]
    # rides both the resolve-failure envelope and the success envelope.
    result_fields = {"label": args.label, "help": HELP_STEPS["cycle-add"]}
    plan, rc = ops.resolve_plan("cycle-add", project_dir, args.cr,
                                result_fields, open_only=False)
    if plan is None:
        return rc
    resp = ops.post(f"{ops.plans_path(project_dir)}/{plan['planId']}/cycles",
                    {"label": args.label, "agentId": agent_id})
    ok = resp.get("ok", False)
    cr_label = plan.get("cr")
    legacy = (f"cycle-add: ok={ok} plan={plan['planId']} cr={cr_label} "
              f"label={args.label} id={resp.get('id')}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    ops.emit("cycle-add", bool(ok),
             {"plan": plan["planId"], "id": resp.get("id"), "label": args.label,
              "help": HELP_STEPS["cycle-add"]},
             ops.context(project_dir, cr=cr_label), [], legacy)
    return 0 if ok else 1


def cmd_cr_close(args, project_dir, ops):
    """§S4c — PATCH the resolved OPEN plan closed, then post the `cr-merged`
    milestone.

    CR-CRU-044 §S5 + CR-CRU-056 §S2b — both the PATCH and the milestone require
    the registered caller identity, resolved FIRST: a hard stop must happen
    before the plan GET/PATCH, never after the CR has already been closed."""
    agent_id = ops.agent_id(args)
    try:
        open_plans = ops.open_plans(project_dir)
    except PlansFetchFailed as exc:
        # CR-CRU-058 §S1 — an unreadable plan board used to leave cr-close with
        # NOTHING on stdout; it now reports the failure in the same ok:false
        # envelope its sibling verbs already emit.
        return emit_plans_fetch_failure("cr-close", exc, project_dir, ops,
                                        {"commit": args.commit}, cr=args.cr)
    if args.cr:
        open_plans = [p for p in open_plans if p.get("cr") == args.cr]
    if len(open_plans) == 0:
        legacy = ("[crucible] ERROR: no OPEN plan to close"
                  + (f" for cr={args.cr}" if args.cr else ""))
        ops.emit("cr-close", False,
                 {"commit": args.commit, "help": HELP_STEPS["cr-close"]},
                 ops.context(project_dir, cr=args.cr), [], legacy)
        return 1
    if len(open_plans) > 1:
        names = ", ".join(f"{p.get('cr')} (plan {p.get('planId')})" for p in open_plans)
        legacy = (f"[crucible] ERROR: {len(open_plans)} open plans — ambiguous cr-close. "
                  f"Pass --cr to pick one of: {names}")
        ops.emit("cr-close", False,
                 {"commit": args.commit, "help": HELP_STEPS["cr-close"]},
                 ops.context(project_dir), [], legacy)
        return 1
    plan = open_plans[0]
    resp = ops.patch(f"{ops.plans_path(project_dir)}/{plan['planId']}",
                     {"status": "closed", "merge": {"commit": args.commit},
                      "agentId": agent_id})
    ok = resp.get("ok", False)
    cr_label = plan.get("cr")
    legacy = (f"cr-close: ok={ok} plan={plan['planId']} cr={cr_label} "
              f"commit={args.commit}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    ops.emit("cr-close", bool(ok),
             {"plan": plan["planId"], "cr": cr_label, "commit": args.commit,
              "help": HELP_STEPS["cr-close"]},
             ops.context(project_dir, cr=cr_label), [], legacy)
    if not ok:
        return 1
    # §S4c / AC 141 — a SUCCESSFUL close emits a cr-merged milestone marker
    # (label=CR id, the merge commit, env auto-context). Withheld on a failed
    # close: the CR is not actually merged, so no marker fires.
    ms_resp = ops.post_milestone(
        project_dir, agent_id, "cr-merged",
        label=cr_label, commit=args.commit,
        context=fleet_context(cr=cr_label) or None,
    )
    print(f"cr-merged: ok={ms_resp.get('ok', False)} cr={cr_label} commit={args.commit}"
          + (f" error={ms_resp.get('error')}" if ms_resp.get("error") else ""),
          file=sys.stderr)
    return 0


def cycle_transition(args, project_dir, ops, status):
    """§S4 — cycle ids are unique per PROJECT, so resolve the owning OPEN plan
    by scanning GET …/plans, then PATCH that plan's cycle sub-resource.

    CR-CRU-056 §S2b — the cycle PATCH requires a live registered caller;
    resolve the identity FIRST so the hard stop precedes any request."""
    agent_id = ops.agent_id(args)
    cycle_id = args.cycle_id
    verb = "cycle-activate" if status == "active" else "cycle-done"
    try:
        open_plans = ops.open_plans(project_dir)
    except PlansFetchFailed as exc:
        # CR-CRU-058 §S1 — same correction as cr-close: the transition reports
        # an unreadable plan board as an envelope, not a bare process exit.
        return emit_plans_fetch_failure(verb, exc, project_dir, ops,
                                        {"cycle": cycle_id})
    target = next(
        (p for p in open_plans
         if any(c.get("id") == cycle_id for c in p.get("cycles", []))),
        None,
    )
    # §S13/§S15 + CR-CRU-048 §S1/§S3 — every cycle-transition envelope carries a
    # `help[]` of concrete next-step commands, DERIVED from the resolved plan's
    # own cycle state (the hardcoded per-client ternary is exactly how that
    # defect reached five clients).
    help_steps = cycle_transition_help(status, target, cycle_id)
    if target is None:
        known = "; ".join(
            f"plan {p.get('planId')} ({p.get('cr')}): "
            + ", ".join(str(c.get("id")) for c in p.get("cycles", []))
            for p in open_plans
        ) or "none"
        legacy = (f"[crucible] ERROR: cycle {cycle_id} is not in any OPEN plan. "
                  f"Open plans' cycle ids: {known}")
        ops.emit(verb, False, {"cycle": cycle_id, "help": help_steps},
                 ops.context(project_dir), [], legacy)
        return 1
    resp = ops.patch(f"{ops.plans_path(project_dir)}/{target['planId']}/cycles/{cycle_id}",
                     {"status": status, "agentId": agent_id})
    ok = resp.get("ok", False)
    legacy = (f"{verb}: ok={ok} cycle={cycle_id} plan={target['planId']}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    ops.emit(verb, bool(ok),
             {"cycle": cycle_id, "plan": target["planId"], "help": help_steps},
             ops.context(project_dir), [], legacy)
    return 0 if ok else 1


# ── CR-CRU-054 §S2b — the DRIFTED lifecycle/plan verbs, lifted to ONE locus ──
#
# These six (plus `_request`, lifted in C2) are the §S2b DRIFTED set: bodies
# that should have been identical but had diverged, several of them into latent
# DEFECTS. C4 corrected the behaviour in place across all five clients; this is
# the lift that makes the corrected version the ONLY version. Every §S2b
# correction is preserved verbatim here — the correction table lives in
# docs/changes/CR-CRU-054-client-fleet-dry.md §S2b.
#
# What stays a per-client PARAMETER (never flattened into a shared constant —
# doing so is precisely the silent fleet-wide regression §S1's classification
# exists to prevent):
#   * project-dir resolution (each client owns its own .env/layout convention),
#     passed in ALREADY-RESOLVED per this module's scope boundary;
#   * the legacy interactive line's wording, where a client has its own
#     (`legacy_format`);
#   * a client's own register/unregister payload helper (`register_fn` /
#     `unregister_fn`) — bun/python send an `identity.repoPath` and expose
#     `--display-name`, and bun's helper also serves its gate-run brackets;
#   * arduino's unique self-registration bootstrap (`pre_register`), its
#     `report` role floor (`role_default`) and its message convention
#     (`message_fn`).

AGENT_REGISTER_PATH = "/api/v2/agents/register"
AGENT_UNREGISTER_PATH = "/api/v2/agents/unregister"

# CR-CRU-054 §S2b — the fleet's identity `source` default. It MUST be a member
# of the clients' own documented enum {claude-md, package-json, git-repo,
# manual}; the historical "openclaw" was outside it and only survived because
# the server never validated the field.
DEFAULT_IDENTITY_SOURCE = "claude-md"


def cmd_register(args, project_dir, ops, *, register_fn=None, pre_register=None,
                 role_default=None, message_fn=None, legacy_format=None):
    """Register / heartbeat. CR-CRU-056 §S1/§S2 — `--cycle` binds the agent to
    an ACTIVE cycle of an OPEN plan; the server validates the binding and
    REQUIRES it for TDD roles (RED/GREEN/FIX/VERIFY) — a refused registration
    surfaces the server's 409 envelope (error + help) and exits non-zero.
    ORCHESTRATOR/report may register unbound.

    CR-CRU-054 §S2b (DN §4 finding #3) — the identity is resolved through the
    fleet's §S5 runtime hard stop, so a missing --agent produces the SAME
    ok:false AXI envelope every other mutating verb emits, not argparse's bare
    usage error. Resolved FIRST: nothing is posted (and no per-client
    `pre_register` bootstrap runs) without it.

    CR-CRU-054 §S2b (DN §4 finding #5) — ONE `source` strategy for the fleet:
    the configurable `--source` with a fleet-wide `claude-md` default, never a
    hardcoded value."""
    agent_id = ops.agent_id(args)
    if pre_register is not None:
        pre_register(project_dir)
    declared_role = getattr(args, "role", None)
    role = declared_role or role_default
    message = (message_fn(args, declared_role) if message_fn is not None
               else (getattr(args, "message", None) or f"Starting {role} phase"))
    source = getattr(args, "source", None) or DEFAULT_IDENTITY_SOURCE
    cycle_id = getattr(args, "cycle", None)
    if register_fn is not None:
        resp = register_fn(project_dir, agent_id, message,
                           display_name=getattr(args, "display_name", None),
                           source=source, role=role, cycle_id=cycle_id)
    else:
        payload = {
            "agentId": agent_id,
            "projectKey": ops.project_key(project_dir),
            "status": "online",
            "message": message,
            # CR-CRU-044 §S1 — the declared role is part of the registration
            # wire contract (the server rejects a registration carrying none).
            "role": role,
            # displayName MUST go inside `identity` — top-level is ignored by v2.
            "identity": {"displayName": agent_id, "source": source},
        }
        if cycle_id is not None:
            payload["cycleId"] = cycle_id
        resp = ops.post(AGENT_REGISTER_PATH, payload)
    ok = bool(resp.get("ok", False))
    legacy = (legacy_format.format(agent_id=agent_id, ok=ok, role=role,
                                   source=source, message=message,
                                   resp_ok=resp.get("ok", False))
              if legacy_format else
              f"register: ok={resp.get('ok', False)} agent={agent_id} "
              f"role={role} source={source}")
    result_fields = {"agent": agent_id, "help": HELP_STEPS["register"]}
    err = resp.get("error")
    if err is not None:
        # Faithful pass-through of the server's 409 envelope (error + help[]).
        result_fields["error"] = err
    ops.emit("register", ok, result_fields,
             ops.context(project_dir, agent_id=agent_id), [], legacy)
    return 0 if ok else 1


def cmd_unregister(args, project_dir, ops, *, unregister_fn=None,
                   legacy_format=None):
    """Remove the agent row (the v2 unregister VERB — journals an
    'unregistered' lifecycle event, CR-CRU-011 §S1).

    CR-CRU-054 §S2b (DN §4 finding #3) — identity through the §S5 runtime hard
    stop, resolved FIRST so nothing is posted without it."""
    agent_id = ops.agent_id(args)
    if unregister_fn is not None:
        resp = unregister_fn(project_dir, agent_id)
    else:
        resp = ops.post(AGENT_UNREGISTER_PATH,
                        {"agentId": agent_id,
                         "projectKey": ops.project_key(project_dir)})
    ok = bool(resp.get("ok", False))
    legacy = (legacy_format.format(agent_id=agent_id, ok=ok,
                                   resp_ok=resp.get("ok", False))
              if legacy_format else
              f"unregister: ok={resp.get('ok', False)} agent={agent_id}")
    ops.emit("unregister", ok,
             {"agent": agent_id, "help": HELP_STEPS["unregister"]},
             ops.context(project_dir, agent_id=agent_id), [], legacy)
    return 0 if ok else 1


def plan_file_cycle_labels(args):
    """CR-CRU-107 §S1 — the ONE rule that resolves a plan's cycle labels, so
    five clients cannot drift apart on it.

    `--cycle` is repeatable: one occurrence per cycle, in the order given, and
    the value is NEVER split — a label may carry commas, semicolons or any other
    character, because there is no delimiter left to get wrong. `--cycles` keeps
    the legacy comma split, deliberately UNPOLICED (measured over this board's
    416 cycles, no character rule separates the four mis-filed labels from the
    ten that use a semicolon as ordinary punctuation).

    Exactly one source. Both flags, neither flag, a `--cycle` occurrence that
    is empty or whitespace-only, or a `--cycles` that splits to nothing raises
    `CycleSelectionRefused` — the caller posts NOTHING."""
    repeated = list(getattr(args, "cycle", None) or ())
    legacy = getattr(args, "cycles", None)
    if repeated and legacy is not None:
        raise CycleSelectionRefused(
            CYCLE_FLAGS_CONFLICT_CODE,
            "--cycle and --cycles were both given, so the cycle list this plan "
            "asks for is ambiguous — pass one form or the other. Nothing was "
            "posted.",
            [f"{CYCLE_FLAG_TEMPLATE} — one label per flag, filed in the order "
             f"given",
             'or keep the legacy form alone: plan-file --cr <CR-id> --cycles '
             '"<c1,c2>" --agent <agentId>'])
    if repeated:
        # §S2 — an occurrence that names no cycle is the same defect as an
        # empty `--cycles`, and gets the same `cycle-list-empty` refusal rather
        # than the server's bare `label is required` (which carries no help[]).
        # The realistic trigger is an unset shell variable: --cycle "$LABEL".
        # The emptiness TEST strips; the values that are KEPT never do — the
        # strip below decides only whether a value is blank, and `repeated` is
        # returned untouched, so AC2's byte-for-byte pass-through still files
        # `--cycle " a "` as the label ' a '.
        blank = [label for label in repeated if not label.strip()]
        if blank:
            raise CycleSelectionRefused(
                CYCLE_LIST_EMPTY_CODE,
                f"--cycle was given as {blank[0]!r}, which names no cycle — "
                f"usually an unset shell variable in --cycle \"$LABEL\". "
                f"Nothing was posted.",
                cycle_list_empty_help())
        return repeated
    if legacy is None:
        raise CycleSelectionRefused(
            CYCLE_SELECTION_REQUIRED_CODE,
            "no cycle list was declared — a plan needs at least one cycle, "
            "supplied per-label with --cycle or as the legacy comma-separated "
            "--cycles. Nothing was posted.",
            [f"{CYCLE_FLAG_TEMPLATE} — repeat --cycle once per cycle",
             'the legacy comma-split form --cycles "<c1,c2>" also still files '
             'a plan, but splits its value on every comma'])
    labels = [label.strip() for label in legacy.split(",") if label.strip()]
    if not labels:
        raise CycleSelectionRefused(
            CYCLE_LIST_EMPTY_CODE,
            f"--cycles was given as {legacy!r}, which names no cycle once split "
            f"on commas. Nothing was posted.",
            cycle_list_empty_help())
    return labels


def cmd_plan_file(args, project_dir, ops):
    """§S4 — file a workflow plan (CR + its cycles) for this project.

    CR-CRU-056 §S2b — plan-file mutates workflow state, so the registered
    caller identity is REQUIRED and rides the wire as `agentId`. The same
    registered id IS the plan's stored orchestrator (the free-text
    --orchestrator label and its $WORKFLOW_ORCHESTRATOR fallback are retired).
    Resolve it FIRST: the hard stop must happen before any POST."""
    agent_id = ops.agent_id(args)
    # CR-CRU-107 §S1/§S2 — the cycle list comes from exactly one flag, and an
    # unresolvable one raises rather than exiting on a bare string: `run_verb`
    # converts it into the ok:false envelope, on the same seam as the identity
    # hard stop above, and this stays BEFORE the POST for the same reason.
    labels = plan_file_cycle_labels(args)
    payload = {"cr": args.cr, "agentId": agent_id,
               "cycles": [{"label": label} for label in labels]}
    if args.title:
        payload["title"] = args.title
    wave = args.wave if getattr(args, "wave", None) is not None else os.environ.get("WORKFLOW_WAVE")
    warnings = []
    if wave:
        payload["wave"] = wave
    else:
        w = no_wave_warning(args.cr)
        warnings.append(w)
        print(f"warning: {w['code']} — {w['detail']}", file=sys.stderr)
    if not args.title:
        wt = no_title_warning(args.cr)
        warnings.append(wt)
        print(f"warning: {wt['code']} — {wt['detail']}", file=sys.stderr)
    track = os.environ.get("WORKFLOW_ROLE")
    if track:
        payload["track"] = track
    # §S2b — the registered caller is the plan's orchestrator; no free text.
    payload["orchestrator"] = agent_id
    resp = ops.post(ops.plans_path(project_dir), payload)
    if not resp.get("ok"):
        legacy = f"plan-file: ok=False error={resp.get('error')}"
        # CR-CRU-054 §S2b (DN §4 finding #2) — context.cr rides the FAILURE
        # envelope too: a plan-file that could not be filed is exactly when the
        # caller needs to know which CR it was for.
        #
        # CR-CRU-116 §S3 — and so do the two fields that make the refusal
        # ACTIONABLE. The wave scope answers `already-active` / `out-of-order`
        # with a `help[]` naming the move that clears it, and this client is
        # how an orchestrator files a plan; emitting only `cr` left both
        # surviving in the legacy stderr line alone, which is the one channel
        # a machine caller does not read. `code` rides only when the server
        # declared one — see `server_failure_code`.
        fields = {"cr": args.cr,
                  "help": (server_failure_help(resp)
                           or server_unreachable_help("plan-file", ops.base_url))}
        refusal_code = server_failure_code(resp)
        if refusal_code:
            fields["code"] = refusal_code
        ops.emit("plan-file", False, fields,
                 ops.context(project_dir, agent_id=agent_id, cr=args.cr),
                 warnings, legacy)
        return 1
    cycles = resp.get("cycles", [])
    ids = " ".join(f"{c.get('label')}={c.get('id')}" for c in cycles)
    legacy = (f"plan-file: ok=True planId={resp.get('planId')} cr={resp.get('cr')} "
              f"cycles: {ids}")
    ops.emit("plan-file", True,
             {"planId": resp.get("planId"), "cr": resp.get("cr"), "cycles": cycles,
              "help": ["cycle-activate <id>"]},
             ops.context(project_dir, agent_id=agent_id, cr=resp.get("cr") or args.cr),
             warnings, legacy)
    return 0


def milestone_help(ok, mtype, base_url):
    """CR-CRU-058 §S2 (PURE) — the state-derived `help[]` for `milestone`.

    A posted marker's next move is to read the board it now shows on; a
    REFUSED post has not recorded anything, so the next move is to restore the
    server and re-post the SAME marker type (named, so the retry is concrete)
    — per CR-CRU-048, the two states must not share one canned string."""
    if ok:
        return ["status"]
    return [f"check the Crucible server is running / reachable at {base_url}",
            f"milestone --type {mtype} --agent <agentId>"]


def release_crs(raw, project_dir, ops):
    """CR-CRU-080 §S4 (PURE-ish: one GET) — the CR ids a release actually
    shipped, from the ceremony's comma-separated tag-range scan INTERSECTED
    with the project's REGISTERED QUEUE.

    The two halves of the answer live in different places and neither may move:
    only the ceremony can scan a tag range (it stands in the repo, git in
    reach), and only the project's queue says which CR ids the project ever
    registered. The intersection therefore happens HERE, on the ceremony's own
    side of the wire, so the server never has to run git and never has to
    guess whether a posted id is real.

    Returns `None` when nothing was scanned (no §S4 data to record at all),
    and a possibly EMPTY list otherwise: a queue that is unregistered,
    unreachable or simply knows none of the scanned ids yields the truthful
    empty set, NEVER a fall back to the raw scan — a release must not claim
    CRs the project never registered."""
    scanned = [cr.strip() for cr in (raw or "").split(",") if cr.strip()]
    if not scanned:
        return None
    resp = ops.get(f"/api/v2/projects/{ops.project_key(project_dir)}/queue")
    queued = {entry.get("cr") for entry in (resp.get("entries") or [])} \
        if resp.get("ok") else set()
    return [cr for cr in dict.fromkeys(scanned) if cr in queued]


def release_packages(raw):
    """CR-CRU-084 §S1 — the artifacts a release DELIVERED, parsed out of the
    ceremony's one delimited flag into one entry per artifact.

    The format is `registry:name:version`, entries separated by `,` — the same
    single-flag shape `--crs` already uses for a computed multi-value
    provenance field, and lossless for the real coordinates:
    `@anthill-tec/crucible-server` carries an `@` and a `/`, both ordinary
    characters here, while no registry id, package name or SemVer version may
    contain a `:` or a `,`, so a split can never straddle a field.

    Parsed HERE rather than by a `type=` callable in five duplicated
    subparsers — that would be exactly the drift CR-CRU-075 exists to fix — so
    the clients carry the flag and the shared module owns its meaning.

    Three states, identical to `crs`': `None` when the flag was never given
    (the key never reaches the wire), an EMPTY list when it was given empty
    (§S3/AC4 — "this release delivered nothing" is a recordable fact), and one
    dict per entry otherwise, in declaration order.

    A malformed entry is DROPPED — never raised, never carried. Never raised
    because a release is published before it is reported, so its report must
    not explode over a typo. Never carried because the route keeps only
    entries whose three fields are all non-empty strings (src/v2.ts
    `isPackageRef`) while the §S1 envelope echoes THIS value: carrying a
    partial entry the wire discards would show the operator a package the
    server never stored. The drop is instead STATED on the interactive
    channel, the one `crs=(none registered)` already speaks on, so a mistyped
    `--packages` is not silent; an all-malformed value still yields `[]`,
    which on a recording remains the §S3 "declared none" fact.
    """
    if raw is None:
        return None
    entries, dropped = [], []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        registry, _, rest = entry.partition(":")
        name, _, version = rest.rpartition(":")
        if registry and name and version:
            entries.append({"registry": registry, "name": name,
                            "version": version})
        else:
            dropped.append(entry)
    if dropped:
        print(f"milestone: packages=(dropped {len(dropped)} malformed: "
              f"{', '.join(dropped)} — each entry must spell "
              f"registry:name:version)", file=sys.stderr)
    return entries


# CR-CRU-086 §S2 — the exit status a REFUSED repair leaves: not 0 (nothing was
# recorded, so a caller must never tally it as recorded) and not 1 (nothing
# failed either — the refusal is the correct outcome, per-release and
# non-fatal). The ceremony reads it to say "refused" rather than "recorded".
EXIT_REPAIR_REFUSED = 3


def repair_refusal_reason(project_dir, ops):
    """CR-CRU-086 §S2 (one GET) — WHY a repair's CR derivation came back empty,
    named rather than left as a bare "skipped".

    Three distinguishable states, all of them the QUEUE (the intersection's
    right-hand side is the only half that can empty a non-empty scan):
    UNREACHABLE (the read itself failed), holds NO CR ids at all (never
    registered, or the roadmap was cleared — the wire cannot separate those
    two: `GET …/queue` answers `entries: []` for both), or registered and
    simply disjoint from what this tag range landed."""
    resp = ops.get(f"/api/v2/projects/{ops.project_key(project_dir)}/queue")
    if not resp.get("ok"):
        return ("the registered CR queue is UNREACHABLE "
                f"({resp.get('error')})")
    if not (resp.get("entries") or []):
        return ("the registered CR queue holds NO CR ids — it was never "
                "registered, or the roadmap was cleared")
    return ("the registered CR queue knows NONE of the CRs this tag range "
            "landed")


def repair_refusal_detail(crs, packages, project_dir, ops):
    """CR-CRU-086 §S2 + CR-CRU-084 §S4 — WHAT a refused repair offered and why
    none of it is derivable, named per OFFERED set (`None` = never offered).

    Symmetric across the two provenance fields, because the refusal is: a
    packages-only refusal whose detail blamed the registered CR queue would be
    a false statement about which read came back empty — and the queue GET
    `repair_refusal_reason` makes is not worth making when no `--crs` was
    offered at all."""
    clauses = []
    if crs is not None:
        clauses.append("the re-derived CR set came back EMPTY "
                       f"({repair_refusal_reason(project_dir, ops)})")
    if packages is not None:
        clauses.append("the declared package set came back EMPTY (no entry "
                       "spelled a registry, a name and a version)")
    return (f"{'; '.join(clauses)}, and an empty derivation is NO ANSWER "
            f"rather than an answer of nothing. Nothing was written; the "
            f"stored provenance stands.")


def refuse_repair(args, project_dir, ops, crs=None, packages=None):
    """CR-CRU-086 §S2 — refuse ONE release's repair, loudly, having posted
    nothing.

    Silence is what made the defect destructive: the run that wiped 0.1.0
    printed `crs=(none registered)` and then wrote the empty set over 58 good
    CRs. So the refusal is stated on the interactive channel — named release,
    named reason — and carried as a structured warning for a machine caller,
    and the post never happens.

    CR-CRU-084 §S4 — `crs`/`packages` are the DERIVED sets this repair
    offered, so the reason names the ones that actually came back empty
    instead of always speaking about `crs`."""
    detail = repair_refusal_detail(crs, packages, project_dir, ops)
    print(f"milestone: REFUSED to repair type={args.type}"
          + (f" label={args.label}" if args.label else "")
          + f" — {detail}", file=sys.stderr)
    ops.emit("milestone", True,
             {"type": args.type, "label": args.label,
              "commit": getattr(args, "commit", None),
              "refused": True, "recorded": False,
              "help": ["queue-file", "status"]},
             ops.context(project_dir, cr=args.cr),
             [{"code": "repair-refused", "detail": detail}], None)
    return EXIT_REPAIR_REFUSED


def shrink_report(label, shrink):
    """CR-CRU-086 §S3 (PURE) — a repair that REDUCED a stored `crs`, as the
    ceremony says it: the count before, the count after, and the ids dropped.

    A legitimate shrink stays possible (the measured 58→51 case, where nine
    CRs have no landing record at any source) — it is simply never silent."""
    return (f"milestone: {label} provenance SHRANK — "
            f"{shrink.get('before')} CR(s) before, {shrink.get('after')} "
            f"after; removed: {', '.join(shrink.get('removed') or [])}")


def cmd_milestone(args, project_dir, ops):
    """POST a workflow milestone. §S4b.

    CR-CRU-054 §S2b (DN §4 finding #1) — the legacy line is the INTERACTIVE
    channel and belongs on stderr; on stdout it corrupts the §S1 envelope
    stream a machine caller parses.

    CR-CRU-058 §S1 — the verb reached NO emitter at all: the stderr line was
    its only output, so a machine caller saw nothing on stdout. It now emits
    the fleet's standard envelope like every other write verb, in the shared
    module, for all five clients at once.

    CR-CRU-080 §S4 — a `release` milestone also carries its PROVENANCE:
    `--released-at` (the tag's own commit date, epoch seconds — when the
    release SHIPPED, as opposed to when it was recorded) and `--crs` (the CR
    ids its tag range merged, kept only where the registered queue agrees).
    Both are computed by the ceremony, which is the only actor that can.

    CR-CRU-081 §S3 — `--repair-provenance` turns the post from a REPLAY of an
    already-recorded release into a CORRECTION of it: the server re-derives
    that release's `releasedAt`/`crs` from what this post carries, and changes
    nothing else about it. Explicit and non-default: an ordinary post never
    sets it, so a release record cannot be rewritten by accident.

    CR-CRU-086 §S1/§S2/§S3 — a repair whose derivation is EMPTY never reaches
    the wire: it is REFUSED here, per-release and non-fatally, because an
    empty set posted as a correction erases the stored one. A repair that
    goes through and SHRINKS a stored set says what it dropped.

    CR-CRU-084 §S1/§S4 — a `release` also declares the PACKAGES it delivered,
    parsed from `--packages` by `release_packages` and handed on unchanged.
    The CR-086 refusal narrows accordingly: the server's repair applies
    `crs` and `packages` INDEPENDENTLY (`repairReleaseProvenance`), so a
    packages-only correction — §S4's real shape for 0.1.0 — has something to
    write and must travel. Only a repair with NOTHING to write is refused."""
    context = fleet_context(cr=args.cr)
    released_at = getattr(args, "released_at", None)
    crs = release_crs(getattr(args, "crs", None), project_dir, ops)
    packages = release_packages(getattr(args, "packages", None))
    repair = bool(getattr(args, "repair_provenance", False))
    # CR-CRU-086 §S2 + CR-CRU-084 §S4 — refuse a repair with NOTHING to write,
    # symmetrically across the two provenance fields: at least one set was
    # OFFERED and nothing is derivable from ANY offered set. Each set carries
    # three states and only the middle one is a refusal input — `None` = never
    # offered, `[]` = offered and derived nothing, non-empty = something to
    # write. A repair that offers NEITHER set is not refused (it corrects
    # `releasedAt` alone). A repair that offers one and derives nothing from it
    # would otherwise post the empty set that erased 0.1.0's 58 CRs, or — once
    # the server's `offeredNothing` declines to write it — exit 0, which
    # `cmd_backfill_releases` tallies as a recorded release that never was.
    offered = crs is not None or packages is not None
    if repair and offered and not crs and not packages:
        return refuse_repair(args, project_dir, ops, crs, packages)
    resp = ops.post_milestone(project_dir, ops.agent_id(args), args.type,
                              label=args.label, commit=getattr(args, "commit", None),
                              context=context or None,
                              released_at=released_at, crs=crs,
                              packages=packages, repair_provenance=repair)
    ok = resp.get("ok", False)
    # The interactive line stays an EXPLICIT stderr print (CR-CRU-054 §S2b's
    # single locus for it) rather than riding the emitter's legacy channel —
    # the envelope below is an ADDITION to that line, not a replacement.
    print(f"milestone: ok={ok} type={args.type}"
          + (f" label={args.label}" if args.label else "")
          + (f" releasedAt={released_at}" if released_at else "")
          + (" repair=provenance" if repair else "")
          + (f" crs={','.join(crs) if crs else '(none registered)'}"
             if crs is not None else "")
          + (f" error={resp.get('error')}" if resp.get("error") else ""),
          file=sys.stderr)
    shrink = resp.get("shrink") if ok else None
    if shrink:
        print(shrink_report(args.label, shrink), file=sys.stderr)
    ops.emit("milestone", bool(ok),
             {"type": args.type, "label": args.label,
              "commit": getattr(args, "commit", None),
              **({"releasedAt": released_at} if released_at else {}),
              **({"crs": crs} if crs is not None else {}),
              **({"packages": packages} if packages is not None else {}),
              **({"shrink": shrink} if shrink else {}),
              "help": milestone_help(bool(ok), args.type, ops.base_url)},
             ops.context(project_dir, cr=args.cr), [], None)
    return 0 if ok else 1


# ── CR-CRU-014 §S2 — the `queue-file` client verb ───────────────────────────

class QueueParseError(ValueError):
    """A queue-table row could not be parsed. Carries a message NAMING the
    offending CR so the loud failure is actionable (§S2 Risk: the API is the
    contract, the parser is a convenience — it must fail loudly, never
    silently mis-register)."""


# A queue-table data row opens with a Markdown link cell `[CR-XXX-NNN](…)`.
_QUEUE_ROW_RE = re.compile(r"^\|\s*\[([A-Za-z]+-[A-Za-z]+-\d+)\]\([^)]*\)\s*\|")


def _split_md_row(line):
    """Split a Markdown table row into stripped cell strings."""
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _find_col(header_cells, *keywords):
    """Index of the first header cell whose lowercased text contains any of
    `keywords`; None when absent."""
    for i, cell in enumerate(header_cells):
        low = cell.lower()
        if any(k in low for k in keywords):
            return i
    return None


def parse_queue_table(text):
    """Parse a `docs/changes/README.md`-style queue table into §S1 entries.

    Returns a list of `{cr, title, wave, dependsOn}` dicts, one per CR row, in
    file order. `cr` is the full link id; `title` the Title cell; `wave` the
    LEADING integer of the Wave cell (cells read like `4 (after 011)`);
    `dependsOn` the comma list of the Depends-on cell, each bare number
    normalized to a full CR id from THIS row's namespace (`007` → `CR-CRU-007`)
    so the server's `unknownDependencies` join matches the `cr` set.

    Raises QueueParseError (naming the CR) for a row whose column count differs
    from the header's or whose Wave cell has no leading integer."""
    header = None
    idx = {}
    entries = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        # separator row (|---|---|): skip
        if set(stripped) <= set("|-: "):
            continue
        cells = _split_md_row(stripped)
        if header is None:
            low = [c.lower() for c in cells]
            if "wave" in low and any(c == "cr" or c.startswith("cr ") for c in low):
                header = cells
                idx = {
                    "cr": _find_col(cells, "cr"),
                    "title": _find_col(cells, "title"),
                    "depends": _find_col(cells, "depend"),
                    "wave": _find_col(cells, "wave"),
                }
            continue
        m = _QUEUE_ROW_RE.match(line)
        if not m:
            continue
        cr = m.group(1)
        if len(cells) != len(header):
            raise QueueParseError(
                f"malformed queue row for {cr}: expected {len(header)} columns, "
                f"got {len(cells)} ({stripped!r})")
        wave_cell = cells[idx["wave"]]
        wave_m = re.match(r"\s*(\d+)", wave_cell)
        if wave_m is None:
            raise QueueParseError(
                f"malformed queue row for {cr}: Wave cell has no leading integer "
                f"({wave_cell!r})")
        wave = wave_m.group(1)
        title = cells[idx["title"]]
        depends_cell = cells[idx["depends"]]
        prefix_m = re.match(r"(.*-)\d+$", cr)
        prefix = prefix_m.group(1) if prefix_m else ""
        deps = []
        if depends_cell and depends_cell != "—":
            for tok in depends_cell.split(","):
                tok = tok.strip()
                if not tok:
                    continue
                deps.append(prefix + tok if re.fullmatch(r"\d+", tok) else tok)
        entries.append({"cr": cr, "title": title, "wave": wave, "dependsOn": deps})
    return entries


def cmd_queue_file(args, project_dir, ops):
    """§S2 — parse the project's `docs/changes/README.md` queue table (or the
    `--from-file` override) and POST the WHOLE set once to the §S1 full-replace
    endpoint `/api/v2/projects/<key>/queue`. A malformed row fails LOUDLY
    (non-zero exit, nothing POSTed)."""
    from_file = getattr(args, "from_file", None)
    path = from_file or os.path.join(project_dir, "docs", "changes", "README.md")
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        msg = f"could not read queue file {path}: {e}"
        print(f"[crucible] ERROR: {msg}", file=sys.stderr)
        # CR-CRU-075 §S1/AC2 — AXI principle 6: an ok:false envelope carries the
        # next step for THIS failure. Nothing was read, so the step is the
        # source itself: the path tried, and the flag that overrides it.
        ops.emit("queue-file", False,
                 {"error": msg,
                  "help": [f"create the queue table at {path}, or read it from "
                           f"elsewhere: queue-file --from-file <path>"]},
                 ops.context(project_dir),
                 [], f"queue-file: ok=False error={msg}")
        return 1
    try:
        entries = parse_queue_table(text)
    except QueueParseError as e:
        print(f"[crucible] ERROR: {e}", file=sys.stderr)
        # CR-CRU-075 §S1/AC2 — the parse named the offending CR in `error`;
        # the step is that row. Nothing was POSTed, so re-running after the fix
        # registers the whole set (the endpoint is a full replace).
        ops.emit("queue-file", False,
                 {"error": str(e),
                  "help": [f"fix the row this error names in {path} — a row "
                           f"carries the header's column count and a Wave cell "
                           f"starting with an integer",
                           "queue-file"]},
                 ops.context(project_dir),
                 [], f"queue-file: ok=False error={e}")
        return 1
    queue_path = f"/api/v2/projects/{ops.project_key(project_dir)}/queue"
    resp = ops.post(queue_path, {"entries": entries})
    resp = resp or {}
    ok = resp.get("ok", False)
    unknown = resp.get("unknownDependencies", [])
    print(f"queue-file: ok={ok} entries={len(entries)}"
          + (f" unknownDependencies={unknown}" if unknown else "")
          + (f" error={resp.get('error')}" if resp.get("error") else ""),
          file=sys.stderr)
    ops.emit("queue-file", bool(ok),
             {"entries": entries, "unknownDependencies": unknown,
              "help": ["status"]},
             ops.context(project_dir), [], None)
    return 0 if ok else 1


# ── CR-CRU-091 §S3/§S6/§S7/§S8/§S10 — roadmap registration: the five verbs ──
#
# `release-propose`, `cr-plan`, `wave-sequence`, `cr-supersede` and `cr-void`
# land HERE, once (the CR-CRU-054 DRY rule); each of the five clients wires a
# subparser and delegates, exactly as `queue-file` does. §S9 fixes the split:
# this half owns argument parsing, §S6's asking, exit codes and the envelope,
# and holds NO business rule — it never decides an order, never infers a
# release, never validates a dependency, and never normalises `--track` (§S2
# puts that on the server so five clients cannot produce two lanes for one
# track). It POSTs and renders what came back.

# §S3 — the role every roadmap route requires. Carried in the refusal envelope
# as DISCLOSURE, never as enforcement: the client checks no role and refuses
# no caller. It is named because the shared caller-auth seam's own 409 (an
# UNREGISTERED caller) does not mention a role at all, and AC16 requires both
# refusals to tell the caller what the verb needs.
ROADMAP_ROLE = "ORCHESTRATOR"

# §S6/P6 — the fleet's USAGE exit: a call the CLIENT resolved as incomplete
# before anything reached the wire. A refusal that came back FROM the server
# is a transport-class outcome and keeps the fleet's `0 if ok else 1`.
EXIT_USAGE = 2

# §S10 P3 — a roadmap list truncates by default; `--full` emits it whole.
# `totalCount` (P4) always carries the true total, so a truncated list can
# never be mistaken for the whole one.
ROADMAP_LIST_LIMIT = 20

# §S6/P6 — the two fields `cr-plan` will not guess, in the order `needs`
# reports them.
CR_PLAN_DECLARED_FIELDS = ("release", "wave")


def release_proposals_path(project_key):
    """§S8 — `…/projects/<key>/release-proposals`: the POST that records or
    revises a proposal, and the GET §S6's candidate list is read from."""
    return f"/api/v2/projects/{project_key}/release-proposals"


def queue_plan_path(project_key):
    """§S8 — `…/projects/<key>/queue/plan`. The verb NAME is never a path
    segment (`queue/plan`, not `queue/cr-plan`), so a guessed shape 404s."""
    return f"/api/v2/projects/{project_key}/queue/plan"


def queue_sequence_path(project_key):
    """§S8 — `…/projects/<key>/queue/sequence`."""
    return f"/api/v2/projects/{project_key}/queue/sequence"


def queue_depends_path(project_key):
    """CR-CRU-106 §S1 — `…/projects/<key>/queue/depends`, under the same rule:
    `queue/depends`, never `queue/cr-depends`."""
    return f"/api/v2/projects/{project_key}/queue/depends"


def queue_lifecycle_path(project_key, cr, verb):
    """§S8 — `…/projects/<key>/queue/<cr>/supersede` | `/void`."""
    return f"/api/v2/projects/{project_key}/queue/{cr}/{verb}"


def server_failure_body(resp):
    """The SERVER's structured refusal, parsed back out of the `http_request`
    error string (PURE) — or None when the failure carried none (a transport
    failure, or a body that is not the fleet's JSON refusal).

    `http_request` flattens an HTTP error to `"HTTP <code>: <body>"`, so every
    field the server derived — its `help[]`, its `code` — survives only as
    text. ONE parse serves both readers below: CR-CRU-116 §S3 needed the
    `code` beside the `help[]` that was already lifted here, and a second
    partition-and-`json.loads` differing by one key is the duplication this
    module exists to prevent.

    Lifting rather than re-deriving is what keeps CR-CRU-091 §S9's division
    honest: the refusal's wording and its next move are the SERVER's own
    derivations, and a client that rebuilt either would be a second
    decision-maker for the same rule."""
    error = (resp or {}).get("error")
    if not isinstance(error, str):
        return None
    _, _, detail = error.partition(": ")
    try:
        parsed = json.loads(detail)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def server_failure_help(resp):
    """The `help[]` the SERVER derived for a refusal (PURE) — the state-derived
    steps `roadmapHints` (`src/hints.ts:358`) and `waveHints` build. AC6's "a
    `help[]` entry `release-propose --label 9.9.9`" is the server's answer,
    read back verbatim.

    Returns the parsed list, or None when the failure carried none."""
    parsed = server_failure_body(resp)
    steps = parsed.get("help") if parsed else None
    return [str(s) for s in steps] if isinstance(steps, list) and steps else None


def server_failure_code(resp):
    """CR-CRU-116 §S3 — the machine-readable `code` the SERVER put on a
    refusal (PURE), so a caller can BRANCH on which rule refused instead of
    matching the error sentence.

    Returns None when the failure declared none, and nothing is invented in
    that case: a transport failure has no server-side code, and a client that
    synthesised one would be answering a question the server did not."""
    parsed = server_failure_body(resp)
    code = parsed.get("code") if parsed else None
    return code if isinstance(code, str) and code else None


def roadmap_failure_fields(verb, resp, ops, full=False):
    """§S10 P6/P9 — the result fields of a roadmap FAILURE envelope: the error
    verbatim, the required role (AC16), the server's own state-derived
    `help[]` when it sent one, and the fleet's reachability next-step when the
    call never landed. `converged` is false because a call that wrote nothing
    converged on nothing, and `totalCount` is 0 because it answered with no
    record — both ride EVERY envelope (§S7, P4)."""
    error = (resp or {}).get("error")
    return {
        "converged": False,
        "error": truncate_field(str(error), full=full) if error else None,
        "requiredRole": ROADMAP_ROLE,
        "totalCount": 0,
        "help": (server_failure_help(resp)
                 or server_unreachable_help(verb, ops.base_url)),
    }


def parse_target_at(raw):
    """§S1/§S3 — `--target <date>` → `targetAt` in epoch SECONDS, the unit
    `releasedAt` uses (PURE).

    Accepts an ISO-8601 date (`2026-09-01`, read as midnight UTC so the value
    is deterministic wherever the orchestrator runs) or datetime, and a bare
    epoch-seconds integer for a caller that already holds one. Anything else
    raises ValueError NAMING the value — a target that silently vanished
    would read back as "no target was ever declared", which is the same
    failure the server refuses a malformed `targetAt` for.

    NOTE: the CR fixes the WIRE unit (§S1) but names no client-side input
    format for `--target`; these two are this client half's reading of
    `<date>`, reported as a spec silence rather than smuggled in.
    """
    text = str(raw).strip()
    if re.fullmatch(r"\d+", text):
        return int(text)
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(
            f"--target {raw!r} is not a date: declare an ISO-8601 date "
            f"(2026-09-01), an ISO-8601 datetime, or epoch SECONDS") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return int(parsed.timestamp())


def parse_crs(raw):
    """§S4 — `--crs A,B,C` → the ORDERED list; array position becomes `seq`
    server-side, so the order is preserved exactly as typed and no entry is
    de-duplicated here (a repeat is the server's refusal to make, by name and
    index)."""
    return [tok.strip() for tok in str(raw or "").split(",") if tok.strip()]


def select_row_fields(rows, fields):
    """§S10 P2 (PURE) — narrow each row to the requested columns.

    Deliberately NARROWING rather than `select_status_fields`' ADDITIVE shape:
    `status`' rows carry a wide set behind a 4-column base, so its flag adds;
    a roadmap row is already the minimal record the write produced, so the
    only useful control is asking for less. AC19 words it exactly that way —
    "`--fields` narrows the envelope". A key the row does not hold is dropped
    rather than emitted as null, so the list stays uniform-table safe."""
    if not fields:
        return rows
    keys = [f.strip() for f in str(fields).split(",") if f.strip()]
    return [{k: row[k] for k in keys if k in row} for row in rows]


def truncate_rows(rows, full=False, limit=ROADMAP_LIST_LIMIT):
    """§S10 P3 (PURE) — the visible head of a roadmap list; `--full` defeats
    it. The caller emits `totalCount` from the UNtruncated list."""
    rows = list(rows or [])
    return rows if full or len(rows) <= limit else rows[:limit]


def roadmap_rows(resp, key, args):
    """The list answer of a roadmap response, projected (P2) and truncated
    (P3) for the envelope. Returns `(visible_rows, total)` so the caller can
    emit the TRUE total beside a possibly-shortened list (P4)."""
    rows = [r for r in (resp or {}).get(key) or [] if isinstance(r, dict)]
    total = len(rows)
    return (truncate_rows(select_row_fields(rows, getattr(args, "fields", None)),
                          full=bool(getattr(args, "full", False))), total)


def roadmap_scalar_list(resp, key):
    """A roadmap response's list of bare CR ids (`resolvedDependants` /
    `brokenDependants` / `unknownDependencies`) — never projected, because a
    scalar has no columns to narrow."""
    return [str(v) for v in (resp or {}).get(key) or []]


def roadmap_entry(resp, args):
    """The single-record answer (`entry`), projected by `--fields` exactly as
    a row of a list answer is, so one flag means one thing across the five
    verbs."""
    entry = (resp or {}).get("entry")
    if not isinstance(entry, dict):
        return None
    return select_row_fields([entry], getattr(args, "fields", None))[0]


# ── §S6 — the client ASKS (AXI P5/P6/P7/P9) ────────────────────────────────
#
# The whole of the asking lives here, in the shared module, for the reason
# §S6 gives out loud: "no business rule lives in a client and no two clients
# can decide differently". It NEVER guesses — not even when exactly one
# release and exactly one wave are open, because silent inference is the
# failure class this design removes.


def undeclared_cr_plan_fields(args):
    """P6 — EXACTLY the fields the caller left undeclared, in §S6's order."""
    return [field for field in CR_PLAN_DECLARED_FIELDS
            if not getattr(args, field, None)]


def proposal_candidates(resp):
    """P7 (PURE) — the live candidate proposals and the waves already planned
    against each, from `GET …/release-proposals`.

    §S8 settles that the server emits NO `status` field: every proposal it
    returns is live by construction, so reading one off the wire would be
    reading a field that is not there. The CLIENT labels them, which is
    presentation rather than a rule — the fact ("this proposal is live") is
    the server's, carried by the route's own contract."""
    return [{"label": str(p.get("label")),
             "status": "live",
             "waves": [str(w) for w in p.get("waves") or []]}
            for p in (resp or {}).get("proposals") or []
            if isinstance(p, dict)]


def cr_plan_ask_help(candidates, cr, title):
    """P9 (PURE) — the pre-filled next-step templates: one `cr-plan` line per
    candidate release/wave with the caller's OWN `--cr` and `--title` already
    substituted, plus the `release-propose` line for the case where the
    intended release does not exist yet. With NO proposal recorded at all that
    last line is the ONLY entry — the definitive empty state (P5/AC11)."""
    steps = []
    for candidate in candidates:
        waves = candidate.get("waves") or ["<n>"]
        for wave in waves:
            steps.append(f'cr-plan --cr {cr} --release {candidate["label"]} '
                         f'--wave {wave} --title "{title}"')
    steps.append("release-propose --label <v>")
    return steps


def emit_cr_plan_ask(args, project_dir, ops, needs, agent_id):
    """§S6 — resolve the undeclared `cr-plan` BEFORE posting: read the live
    candidates, emit the `ok:false` envelope on stdout, exit 2, POST nothing.

    A candidate read that FAILS is not "zero proposals": reporting an
    unreachable roadmap as an empty one would turn a transport fault into a
    fact. It degrades the fleet's way (`cmd_status`/`cmd_queue`) — an empty
    candidate list plus a STRUCTURED warning naming the condition — and still
    refuses to guess, because the caller's own declaration is what is
    missing either way."""
    resp = ops.get(release_proposals_path(ops.project_key(project_dir)))
    warnings = []
    if resp.get("ok"):
        candidates = proposal_candidates(resp)
    else:
        candidates = []
        warnings.append({
            "code": "release-proposals-unavailable",
            "detail": (f"could not read the live release proposals: "
                       f"{resp.get('error')}"),
        })
    full = bool(getattr(args, "full", False))
    visible = truncate_rows(
        select_row_fields(candidates, getattr(args, "fields", None)), full=full)
    ops.emit("cr-plan", False,
             {"converged": False,
              "needs": needs,
              "releases": visible,
              "totalCount": len(candidates),
              "requiredRole": ROADMAP_ROLE,
              "help": cr_plan_ask_help(candidates, args.cr, args.title)},
             ops.context(project_dir, agent_id=agent_id, cr=args.cr),
             warnings,
             f"cr-plan: ok=False needs={','.join(needs)} — nothing was posted; "
             f"{len(candidates)} live release proposal(s) to choose from")
    return EXIT_USAGE


# ── §S3 — the five verbs ───────────────────────────────────────────────────


def cmd_release_propose(args, project_dir, ops):
    """§S3 — record or REVISE the `release-proposal` milestone for one label.
    The super container must exist before a CR can target it."""
    agent_id = ops.agent_id(args)
    full = bool(getattr(args, "full", False))
    body = {"label": args.label, "agentId": agent_id}
    if getattr(args, "target", None):
        try:
            body["targetAt"] = parse_target_at(args.target)
        except ValueError as exc:
            ops.emit("release-propose", False,
                     {"converged": False, "error": str(exc),
                      "requiredRole": ROADMAP_ROLE, "totalCount": 0,
                      "help": [f"release-propose --label {args.label} "
                               f"--target <YYYY-MM-DD>"]},
                     ops.context(project_dir, agent_id=agent_id), [],
                     f"release-propose: ok=False error={exc}")
            return EXIT_USAGE
    resp = ops.post(release_proposals_path(ops.project_key(project_dir)), body)
    resp = resp or {}
    ok = bool(resp.get("ok", False))
    if not ok:
        ops.emit("release-propose", False,
                 roadmap_failure_fields("release-propose", resp, ops, full),
                 ops.context(project_dir, agent_id=agent_id), [],
                 f"release-propose: ok=False error={resp.get('error')}")
        return 1
    proposal = resp.get("proposal") if isinstance(resp.get("proposal"), dict) else {}
    converged = bool(resp.get("converged", False))
    ops.emit("release-propose", True,
             {"converged": converged,
              "proposal": select_row_fields(
                  [proposal], getattr(args, "fields", None))[0],
              "totalCount": 1,
              "help": [f"cr-plan --cr <id> --release {args.label} --wave <n> "
                       f"--title <brief>", "queue"]},
             ops.context(project_dir, agent_id=agent_id),
             resp.get("warnings") or [],
             f"release-propose: ok=True label={args.label} "
             f"converged={converged}")
    return 0


def cmd_cr_plan(args, project_dir, ops):
    """§S3 — the per-CR upsert of `release`, `wave` and `title`. Re-running
    with different values is a legitimate re-plan, not an error (§S3), and
    re-running with the same values writes nothing (§S7).

    §S6 — a call missing `--release` or `--wave` is resolved HERE and never
    reaches the server."""
    agent_id = ops.agent_id(args)
    needs = undeclared_cr_plan_fields(args)
    if needs:
        return emit_cr_plan_ask(args, project_dir, ops, needs, agent_id)
    full = bool(getattr(args, "full", False))
    resp = ops.post(queue_plan_path(ops.project_key(project_dir)),
                    {"cr": args.cr, "release": args.release,
                     "wave": str(args.wave), "title": args.title,
                     "agentId": agent_id}) or {}
    ok = bool(resp.get("ok", False))
    context = ops.context(project_dir, agent_id=agent_id, cr=args.cr)
    if not ok:
        ops.emit("cr-plan", False,
                 roadmap_failure_fields("cr-plan", resp, ops, full),
                 context, [], f"cr-plan: ok=False error={resp.get('error')}")
        return 1
    converged = bool(resp.get("converged", False))
    ops.emit("cr-plan", True,
             {"converged": converged,
              "entry": roadmap_entry(resp, args),
              "unknownDependencies": roadmap_scalar_list(
                  resp, "unknownDependencies"),
              "totalCount": 1,
              "help": [f"wave-sequence --release {args.release} "
                       f"--wave {args.wave} --crs <a,b,c>", "queue"]},
             context, resp.get("warnings") or [],
             f"cr-plan: ok=True cr={args.cr} release={args.release} "
             f"wave={args.wave} converged={converged}")
    return 0


def cmd_wave_sequence(args, project_dir, ops):
    """§S4 — ONE call carrying the WHOLE ordered list: the array position of
    `--crs` becomes `seq`, because the order IS the payload. Insert and
    reorder are the same call — re-send the list.

    `--track` is forwarded VERBATIM: §S2 normalises to `track-<n>` on the
    server so two clients cannot write `2` and `track-2` and draw two lanes
    for one track."""
    agent_id = ops.agent_id(args)
    full = bool(getattr(args, "full", False))
    body = {"release": args.release, "wave": str(args.wave),
            "crs": parse_crs(args.crs), "agentId": agent_id}
    if getattr(args, "track", None):
        body["track"] = args.track
    resp = ops.post(queue_sequence_path(ops.project_key(project_dir)), body) or {}
    ok = bool(resp.get("ok", False))
    context = ops.context(project_dir, agent_id=agent_id)
    if not ok:
        ops.emit("wave-sequence", False,
                 roadmap_failure_fields("wave-sequence", resp, ops, full),
                 context, [],
                 f"wave-sequence: ok=False error={resp.get('error')}")
        return 1
    entries, total = roadmap_rows(resp, "entries", args)
    converged = bool(resp.get("converged", False))
    ops.emit("wave-sequence", True,
             {"converged": converged, "entries": entries,
              "unknownDependencies": roadmap_scalar_list(
                  resp, "unknownDependencies"),
              "totalCount": total, "help": ["queue", "status"]},
             context, resp.get("warnings") or [],
             f"wave-sequence: ok=True release={args.release} "
             f"wave={args.wave} entries={total} converged={converged}")
    return 0


def cmd_cr_supersede(args, project_dir, ops):
    """§S3 — lifecycle `SUPERSEDED` with `by`. The work still happens,
    elsewhere: AC15 requires the dependants to be reported RESOLVING through
    the successor, never collapsed into one "removed" answer with `cr-void`'s.
    The row is not deleted; the CR stays visible carrying its declaration."""
    return _cr_lifecycle(args, project_dir, ops, "supersede",
                         {"by": args.by}, "resolvedDependants")


def cmd_cr_void(args, project_dir, ops):
    """§S3 — lifecycle `VOID` with `reason`. The work is not happening, so
    AC15 requires the dependants to be reported BROKEN — the report is why
    the write still lands (§S8's warn-and-write rung), not a refusal."""
    return _cr_lifecycle(args, project_dir, ops, "void",
                         {"reason": args.reason}, "brokenDependants")


def _cr_lifecycle(args, project_dir, ops, verb, body, dependants_key):
    """The shared body of the two lifecycle verbs. They differ ONLY in the
    path segment, the one declared field and the name their dependant list
    answers to — which is exactly AC15's point, so the difference is a
    parameter and the identical half is written once."""
    agent_id = ops.agent_id(args)
    full = bool(getattr(args, "full", False))
    cli_verb = f"cr-{verb}"
    resp = ops.post(
        queue_lifecycle_path(ops.project_key(project_dir), args.cr, verb),
        {**body, "agentId": agent_id}) or {}
    ok = bool(resp.get("ok", False))
    context = ops.context(project_dir, agent_id=agent_id, cr=args.cr)
    if not ok:
        ops.emit(cli_verb, False,
                 roadmap_failure_fields(cli_verb, resp, ops, full),
                 context, [], f"{cli_verb}: ok=False error={resp.get('error')}")
        return 1
    dependants = roadmap_scalar_list(resp, dependants_key)
    converged = bool(resp.get("converged", False))
    ops.emit(cli_verb, True,
             {"converged": converged,
              "entry": roadmap_entry(resp, args),
              dependants_key: truncate_rows(dependants, full=full),
              "totalCount": len(dependants),
              "help": lifecycle_help(verb, args, dependants)},
             context, resp.get("warnings") or [],
             f"{cli_verb}: ok=True cr={args.cr} "
             f"{dependants_key}={len(dependants)} converged={converged}")
    return 0


def lifecycle_help(verb, args, dependants):
    """§S10 P9 (PURE) — the STATE-DERIVED next step after a lifecycle write:
    supersede points at planning the successor the caller just named, void
    names the dependants that now point at a VOID cr — which is the fact
    AC15 exists to surface and the only actionable thing left to do."""
    if verb == "supersede":
        return [f"cr-plan --cr {args.by} --release <v> --wave <n> "
                f"--title <brief> — the work moves to {args.by}", "queue"]
    if dependants:
        return [f"cr-plan --cr <dependant> --release <v> --wave <n> "
                f"--title <brief> — {', '.join(dependants)} still depend on "
                f"the now-VOID {args.cr}", "queue"]
    return ["queue"]


# ── CR-CRU-106 §S1/§S2a — `cr-depends`: the dependency axis ────────────────
#
# Lands HERE, once, for the same CR-CRU-054 DRY reason the five roadmap verbs
# do, and holds NO business rule: it never validates a target, never decides
# whether a set closes a cycle and never infers a set. It POSTs the WHOLE set
# and renders what came back.
#
# §S6/P6 — the ONE field this verb will not guess. `--cr` is argparse-required
# exactly as `cr-plan`'s, `cr-supersede`'s and `cr-void`'s are: the SUBJECT is
# the thing the caller is naming, and the asking is for what the declaration
# TARGETS, which is the case §S1 points at ("exactly as `cr-plan` does for
# `--release`/`--wave`").
CR_DEPENDS_DECLARED_FIELDS = ("on",)


def undeclared_cr_depends_fields(args):
    """P6 — the fields the caller left undeclared.

    `is None` and not falsiness, and the distinction is load-bearing: §S1
    makes an EMPTY set a legitimate declaration that a cr depends on nothing,
    so `--on ""` is an answer while an ABSENT `--on` is the question. A
    truthiness test would collapse the two and make "depends on nothing"
    unsayable.
    """
    return [field for field in CR_DEPENDS_DECLARED_FIELDS
            if getattr(args, field, None) is None]


def queue_candidates(resp):
    """P7 (PURE) — the crs this board actually holds, from `GET …/queue`: the
    live candidates a dependency declaration can name.

    A dependency's candidates are CRs, not release proposals, because
    `dependsOn` points at crs — so this verb's ask reads the queue where
    `cr-plan`'s reads the proposals. Only the columns that identify a
    candidate are carried; the row's full declaration is `queue`'s answer to
    give, not this ask's."""
    return [{"cr": str(e.get("cr")),
             "wave": str(e.get("wave")),
             "status": str(e.get("status"))}
            for e in (resp or {}).get("entries") or []
            if isinstance(e, dict)]


def cr_depends_ask_help(cr):
    """P9 (PURE) — the pre-filled next steps, with the caller's OWN `--cr`
    already substituted: the declaration it was about to make, and the empty
    declaration, which is the one a caller cannot otherwise guess is legal.

    ONE line per SHAPE rather than one per candidate, unlike
    `cr_plan_ask_help`: a release proposal list is bounded by the milestones a
    project has open, while a dependency may name any cr on the board, so a
    template per candidate would emit a line per row of a 100-row roadmap and
    bury the two shapes that matter. The candidates themselves ride the
    envelope's own list.

    NOTE: the CR fixes that an empty set is a legitimate declaration (§S1) but
    names no command-line spelling for one; `--on ""` is this client half's
    reading, reported as a spec silence rather than smuggled in."""
    return [f"cr-depends --cr {cr} --on <a,b,c> — the WHOLE set; re-sending "
            f"REPLACES it",
            f'cr-depends --cr {cr} --on "" — declares that {cr} depends on '
            f"nothing",
            "queue"]


def emit_cr_depends_ask(args, project_dir, ops, needs, agent_id):
    """§S1/§S6 — resolve the undeclared `cr-depends` BEFORE posting: read the
    live candidates, emit the `ok:false` envelope on stdout, exit 2, POST
    nothing.

    A candidate read that FAILS is not "an empty board", and degrades exactly
    as `emit_cr_plan_ask` degrades its own: an empty list plus a STRUCTURED
    warning naming the condition, and still no guess, because the caller's own
    declaration is what is missing either way."""
    resp = ops.get(f"/api/v2/projects/{ops.project_key(project_dir)}/queue")
    warnings = []
    if resp.get("ok"):
        candidates = queue_candidates(resp)
    else:
        candidates = []
        warnings.append({
            "code": "queue-unavailable",
            "detail": (f"could not read the registered CR queue: "
                       f"{resp.get('error')}"),
        })
    full = bool(getattr(args, "full", False))
    visible = truncate_rows(
        select_row_fields(candidates, getattr(args, "fields", None)), full=full)
    ops.emit("cr-depends", False,
             {"converged": False,
              "needs": needs,
              "crs": visible,
              "totalCount": len(candidates),
              "requiredRole": ROADMAP_ROLE,
              "help": cr_depends_ask_help(args.cr)},
             ops.context(project_dir, agent_id=agent_id, cr=args.cr),
             warnings,
             f"cr-depends: ok=False needs={','.join(needs)} — nothing was "
             f"posted; {len(candidates)} cr(s) on the board to depend on")
    return EXIT_USAGE


def cr_depends_help(args, unknown):
    """§S10 P9 (PURE) — the STATE-DERIVED next step after a declaration.

    AC5 rules that an unknown target is ACCEPTED and FLAGGED, so the flag is
    given somewhere to go: the declaration stands, and the actionable thing
    left is planning the target it names."""
    if unknown:
        return [f"cr-plan --cr {unknown[0]} --release <v> --wave <n> "
                f"--title <brief> — {', '.join(unknown)} is not on the board; "
                f"the declaration stands and is flagged", "queue"]
    return ["queue", "next"]


def cmd_cr_depends(args, project_dir, ops):
    """§S1 — declare one cr's COMPLETE dependency set → POST …/queue/depends.
    The whole set is the payload and re-sending REPLACES it, so a dependency
    dropped from a re-sent set is a declaration rather than an accident of
    arrival.

    §S6 — a call that declares no `--on` is resolved HERE and never reaches
    the server."""
    agent_id = ops.agent_id(args)
    needs = undeclared_cr_depends_fields(args)
    if needs:
        return emit_cr_depends_ask(args, project_dir, ops, needs, agent_id)
    full = bool(getattr(args, "full", False))
    resp = ops.post(queue_depends_path(ops.project_key(project_dir)),
                    {"cr": args.cr, "dependsOn": parse_crs(args.on),
                     "agentId": agent_id}) or {}
    ok = bool(resp.get("ok", False))
    context = ops.context(project_dir, agent_id=agent_id, cr=args.cr)
    if not ok:
        ops.emit("cr-depends", False,
                 roadmap_failure_fields("cr-depends", resp, ops, full),
                 context, [],
                 f"cr-depends: ok=False error={resp.get('error')}")
        return 1
    unknown = roadmap_scalar_list(resp, "unknownDependencies")
    declared = roadmap_entry(resp, args) or {}
    converged = bool(resp.get("converged", False))
    ops.emit("cr-depends", True,
             {"converged": converged,
              "entry": declared,
              "unknownDependencies": unknown,
              "totalCount": 1,
              "help": cr_depends_help(args, unknown)},
             context, resp.get("warnings") or [],
             f"cr-depends: ok=True cr={args.cr} "
             f"dependsOn={len(parse_crs(args.on))} converged={converged}"
             + (f" unknownDependencies={','.join(unknown)}" if unknown else ""))
    return 0


def add_cr_depends_verb(sub, func, *, parents=(), add_args=()):
    """CR-CRU-106 §S1 — register the ONE `cr-depends` subparser on `sub`.

    A single callable rather than `add_roadmap_verbs`' verb-name→delegator
    dict, following `add_next_verb`'s precedent for the same reason: one verb
    needs one delegator, and a one-entry dict would be ceremony that hides
    that. It is its OWN registrar rather than a sixth entry in
    `add_roadmap_verbs` because that registrar's contract is CR-CRU-091's
    frozen five, asserted by name in the fleet inventory.
    """
    cd = sub.add_parser(
        "cr-depends", parents=list(parents),
        help="Declare one CR's COMPLETE dependency set → POST …/queue/depends "
             "(§S1). Re-sending REPLACES the set. Omit --on and the client "
             "ASKS instead of guessing. ORCHESTRATOR only.")
    cd.add_argument("--cr", required=True,
                    help="The CR whose dependency set this declares.")
    cd.add_argument("--on",
                    help="The WHOLE set, comma-separated. Undeclared → the "
                         'client lists the board\'s crs and exits 2 (§S6); '
                         '--on "" declares that this CR depends on nothing.')
    add_roadmap_projection_args(cd)
    for adder in add_args:
        adder(cd)
    cd.set_defaults(func=func)


def add_roadmap_projection_args(p):
    """§S10 P2/P3 — the two envelope-shaping flags every roadmap verb carries,
    added identically in all five clients so the surface cannot drift."""
    p.add_argument("--fields",
                   help="Comma-separated columns to NARROW the envelope's "
                        "records to (§S10 P2).")
    p.add_argument("--full", action="store_true",
                   help="Emit the whole list and untruncated text fields "
                        "(§S10 P3).")


def add_roadmap_verbs(sub, funcs, *, parents=(), add_args=()):
    """§S3/§S9 — register the five roadmap subparsers on `sub`.

    The registration itself is shared, so "a reviewer diffing two client files
    sees near-identical thin registrations" is guaranteed rather than hoped
    for. Only the three genuinely per-client pieces are injected — and they
    are injected rather than flattened into one shared constant, which is the
    silent fleet-wide regression CR-CRU-054 §S1's classification exists to
    prevent:

      * `funcs` — verb name → that client's own delegator;
      * `parents` — a client that already carries `--agent`/`--project-dir` on
        a shared parent parser (arduino's `common`) passes it here;
      * `add_args` — the per-verb arg adders for the other four, each client's
        OWN `_add_workflow_agent_arg` / `_add_project_dir_arg` (mvn's
        `_add_project_args` also carries its `--maven-dir` convention).
    """
    def _common(p):
        for adder in add_args:
            adder(p)

    rp = sub.add_parser(
        "release-propose", parents=list(parents),
        help="Record or REVISE a proposed release → POST …/release-proposals "
             "(§S1/§S3). ORCHESTRATOR only.")
    rp.add_argument("--label", required=True,
                    help="The version this release proposes to ship, e.g. 0.4.0.")
    rp.add_argument("--target",
                    help="Declared target date (ISO-8601 date/datetime, or "
                         "epoch SECONDS). Optional and revisable; a revision "
                         "retires its predecessor rather than editing it.")
    add_roadmap_projection_args(rp)
    _common(rp)
    rp.set_defaults(func=funcs["release-propose"])

    cp = sub.add_parser(
        "cr-plan", parents=list(parents),
        help="Declare one CR's release, wave and title → POST …/queue/plan "
             "(§S3). Omit --release/--wave and the client ASKS (§S6) instead "
             "of guessing. ORCHESTRATOR only.")
    cp.add_argument("--cr", required=True, help="The CR this plan declares.")
    cp.add_argument("--title", required=True, help="The CR's brief.")
    cp.add_argument("--release",
                    help="The release this CR targets. Undeclared → the client "
                         "lists the live proposals and exits 2 (§S6).")
    cp.add_argument("--wave",
                    help="The wave within the release. Undeclared → the client "
                         "lists the waves already planned and exits 2 (§S6).")
    add_roadmap_projection_args(cp)
    _common(cp)
    cp.set_defaults(func=funcs["cr-plan"])

    ws = sub.add_parser(
        "wave-sequence", parents=list(parents),
        help="Author a whole wave's order in ONE call → POST …/queue/sequence "
             "(§S4): the position of each cr in --crs becomes its seq. "
             "ORCHESTRATOR only.")
    ws.add_argument("--release", required=True,
                    help="The release whose wave is being sequenced.")
    ws.add_argument("--wave", required=True,
                    help="The wave whose order this call authors.")
    ws.add_argument("--crs", required=True,
                    help="The WHOLE ordered list, comma-separated. Insert and "
                         "reorder are the same call: re-send the list.")
    ws.add_argument("--track",
                    help="The track this wave's crs run in — 2, track-2 or "
                         '"Track 2". The SERVER normalises to track-<n>.')
    add_roadmap_projection_args(ws)
    _common(ws)
    ws.set_defaults(func=funcs["wave-sequence"])

    cs = sub.add_parser(
        "cr-supersede", parents=list(parents),
        help="Record that a CR's work moves to a successor → POST "
             "…/queue/<cr>/supersede (§S3). The row is kept. ORCHESTRATOR only.")
    cs.add_argument("--cr", required=True, help="The superseded CR.")
    cs.add_argument("--by", required=True,
                    help="The successor CR the work moves to.")
    add_roadmap_projection_args(cs)
    _common(cs)
    cs.set_defaults(func=funcs["cr-supersede"])

    cv = sub.add_parser(
        "cr-void", parents=list(parents),
        help="Record that a CR's work is not happening → POST "
             "…/queue/<cr>/void (§S3). The row is kept, and the dependants it "
             "breaks are named. ORCHESTRATOR only.")
    cv.add_argument("--cr", required=True, help="The voided CR.")
    cv.add_argument("--reason", required=True,
                    help="Why the work is not happening.")
    add_roadmap_projection_args(cv)
    _common(cv)
    cv.set_defaults(func=funcs["cr-void"])


def add_next_verb(sub, func, *, parents=(), add_args=()):
    """CR-CRU-092 §S6 — register the ONE `next` subparser on `sub`.

    The subparser BODY lives here, once, so the flag surface cannot fork into
    five for one verb — the same rule (and the same `parents`/`add_args` seam)
    `add_roadmap_verbs` above follows. What stays per-client is exactly the
    delegator plus that client's own project-dir convention, which is why the
    five call sites read alike.

    Three deliberate ABSENCES, each of which a census asserts rather than
    assumes:

      * no `--full` (§S6 P3, N/A BY SHAPE) — the answer is ONE decision, never
        a truncated list, so a `--full` here could reveal nothing. "A faked
        `--full` on a one-record answer is as wrong as a missing one."
      * no `--agent` (§S4/AC10) — `next` is READ-ONLY: it performs no write,
        claims nothing, and must never route through
        `emit_agent_identity_hard_stop`.
      * no `--user-approved` — there is no mutation to approve.

    `func` is a single callable rather than the verb-name→delegator dict
    `add_roadmap_verbs` takes: one verb needs one delegator, and a one-entry
    dict would be ceremony that hides that.
    """
    nx = sub.add_parser(
        "next", parents=list(parents),
        help="Ask the DECLARED roadmap what is actionable now → GET …/queue "
             "(§S2). Answers NEXT | HOLD | DRAINED, all exit 0. Read-only: "
             "asking claims nothing.")
    nx.add_argument("--track",
                    help="The lane to resolve — 2, track-2 or \"Track 2\" "
                         "(canonicalised client-side, §S3, because this verb "
                         "writes nothing and so has no server round-trip to "
                         "normalise it). Required ONLY when the project "
                         "declares more than one track.")
    nx.add_argument("--release",
                    help="The release to resolve within — the CRs DECLARED "
                         "into it, matched VERBATIM against each entry's own "
                         "label (nothing is coerced, so 0.2.0 and v0.2.0 are "
                         "two releases). Membership is declared, never "
                         "inferred: an entry with no release is in none.")
    nx.add_argument("--wave",
                    help="The wave to resolve — matched VERBATIM too, so 6 "
                         "and 06 are two waves and no integer parse merges "
                         "them. Unset, the wave is the one the first "
                         "actionable cr declares, in the order the server "
                         "published.")
    nx.add_argument("--fields",
                    help="Comma-separated keys to NARROW the decision to "
                         "(§S6 P2). There is no --full: the answer is one "
                         "decision, never a truncated list (P3).")
    for adder in add_args:
        adder(nx)
    nx.set_defaults(func=func)


def add_queue_file_verb(sub, func, *, parents=(), add_args=()):
    """CR-CRU-075 §S1 — register the ONE `queue-file` subparser on `sub`.

    CR-CRU-014 §S2 put the parse and the full-replace POST in this module from
    the start but left the SUBPARSER per-client: python hand-rolled its own and
    the other four registered nothing, so one verb was an envelope on one stack
    and argparse's `invalid choice` on four. The body lands here for the reason
    `add_next_verb` and `add_cr_depends_verb` above give — one verb needs one
    flag surface — through their identical seam: `func` is the CALLER'S own
    delegator, `parents` the shared parent a client like arduino already
    carries, `add_args` that client's own project-dir convention.

    `--from-file` is OPTIONAL and carries no default, so the shared
    `cmd_queue_file` keeps resolving the unset case to
    `<project>/docs/changes/README.md` (§S2) rather than the registrar deciding
    a path five clients would then have to agree on.

    No `--agent`: the verb registers a PROJECT's queue, not an agent's work,
    and has never declared an identity — AC6's unchanged surface.
    """
    qf = sub.add_parser(
        "queue-file", parents=list(parents),
        help="Parse docs/changes/README.md (or --from-file) queue table and "
             "POST the full CR set → /api/v2/projects/<key>/queue (§S2).")
    qf.add_argument("--from-file", dest="from_file",
                    help="Source Markdown file (default: "
                         "<project>/docs/changes/README.md).")
    for adder in add_args:
        adder(qf)
    qf.set_defaults(func=func)


# ── CR-CRU-111 §S1/AC10 — the tier vocabulary, mirrored ONCE ─────────────
#
# PROVENANCE: the server DECLARES this vocabulary as the `Tier` union in
# `src/types.ts`, and that declaration is authoritative. The dict below is the
# client side's ONLY copy of it: `tests/client/test_client_tier_surface.py`
# parses that union out by SYMBOL and asserts the two are the same set, so a
# seventh server-side value fails a test rather than quietly narrowing five
# clients. Reading `src/types.ts` at client RUNTIME is not the requirement and
# cannot be — an installed wheel ships no `src/` — so this is the
# mirror-plus-guard pattern `canonical_track` already uses for `normalizeTrack`
# above. What is forbidden is a SECOND mirror: no client carries its own copy
# of the six, they take them from here through `add_tier_verbs`.
#
# The VALUE is what the tier means: the DEPENDENCY a run of it takes. That is
# the only definition portable across five toolchains — a tier is never a
# subject matter and never a size.
TIER_MEANINGS = {
    "unit": "no dependency beyond the code under test — no process, no "
            "socket, no live service, no wait on the clock",
    "module": "one module or package of this project, across its own boundary",
    "integration": "a real dependency — a spawned process, a socket, a live "
                   "service, or a wait on real time",
    "e2e": "the assembled system, driven the way it is really driven",
    "regression": "every tier the project declares, run as one suite",
    "bdd": "executable specifications, in the project's own BDD form",
}

# CR-CRU-112 §S1 — WHICH TIERS THE GATE COVERS, ruled at cycle 388 after RED
# measured that a `package.json` script table cannot carry a per-target flag.
# Gate coverage is a property of the TIER, so it is named HERE, beside the
# vocabulary it belongs to and for the same reason `TIER_MEANINGS` lives here:
# a per-project field would be the second declaration format §S1 forbids, and
# five clients each deciding coverage would be the second mirror AC10 forbids.
#
# `e2e` is the ONE tier the gate does not cover, fleet-wide, and the reason is
# a citation rather than a preference: who runs an e2e suite and who ingests it
# is DN open question 5 (`docs/research/DN-testing-tiers-in-crucible-
# projects.md`), which CR-CRU-112's non-goals defer. A project that wants its
# e2e suite gated is the CR that answers that question, never a flag here.
#
# The VALUE is the sentence the gate's envelope prints beside that suite: an
# excluded target is NAMED as excluded rather than omitted, so a reader can
# tell a decision from an oversight (§S1).
#
# That sentence NAMES the open question and cites no CR id, and the omission is
# deliberate: the value is EMITTED into `suites[].excluded`, and a project
# namespace literal at a position a client EMITS is what this project's own
# tripwire forbids. The lineage belongs in this comment, where it already is;
# the reader of the envelope needs the REASON, which is the unanswered
# question, not the number of the CR that declined to answer it.
GATE_UNCOVERED_TIERS = {
    "e2e": ("excluded from the gate fleet-wide — who runs the e2e suite and "
            "who ingests it is DN open question 5 (`docs/research/DN-testing-"
            "tiers-in-crucible-projects.md`), still unanswered; this gate "
            "defers to that answer rather than invent one"),
}

# What a client hands `add_tier_verbs` for a tier it actually RUNS:
#
#   * `func` — that client's own delegator, exactly as the other registrars
#     take one;
#   * `runs` — one sentence naming what this tier runs ON THIS STACK, which
#     the registrar folds into the verb's help. It says what the verb DOES and
#     never what a run claims: printed help asserting a tier the client does
#     not send is a defect this CR's own Context measured, not a pattern to
#     copy;
#   * `add_args` — that ONE verb's own flag adders. The client-wide pieces
#     ride `parents=`/`add_args=` as they do for `add_roadmap_verbs`, but a
#     flag belonging to a single tier (mvn's `unit --test`, arduino's
#     `regression --coverage`) belongs here — so migrating a pre-existing
#     tier-named verb onto the shared registration cannot cost it a flag.
TierVerb = collections.namedtuple(
    "TierVerb", ("func", "runs", "add_args"), defaults=((),))


# CR-CRU-111 §S5/AC7 — WHAT THE ENVELOPE SAYS IT INGESTED.
#
# "The AXI envelope names the tier of the run it just ingested, so an
# orchestrator reading the envelope knows what was covered without inspecting
# the board. Every exit path states it." The value is a CLOSED vocabulary,
# because a consumer MATCHES on it, and it lives HERE — once, beside the
# `Tier` mirror it extends (`TIER_MEANINGS` above IS this fleet's one mirror of
# `Tier` in `src/types.ts`; AC10 forbids a second copy, and five clients each
# spelling their own sentinel would be exactly that second mirror). Ratified at
# cycle 381 rather than left to GREEN, so AC7 fails on a defect and never on a
# naming disagreement.
#
#   one of `TIER_MEANINGS`   a TEST run reached the board under THAT tier;
#   ENVELOPE_TIER_UNSTATED   a test run reached the board and the client stated
#                            NO tier (§S2/AC3), so the server applied its own
#                            documented default. The envelope neither invents a
#                            tier nor prints a null — it says, positively, that
#                            the client asserted nothing;
#   ENVELOPE_TIER_COMPILE    a COMPILE event was ingested, which is not a test
#                            tier at all (AC13a): a build in the test-tier
#                            record is the conflation that AC forbids;
#   ENVELOPE_TIER_NONE       this exit ingested nothing — python's
#                            zero-discovery, §S1's `tier-run-undeclared`
#                            refusal, a no-report exit, and every verb that
#                            runs no tests at all.
ENVELOPE_TIER_UNSTATED = "unstated"
ENVELOPE_TIER_COMPILE = "compile"
ENVELOPE_TIER_NONE = "none"

# The ingest endpoints, by what an ingest to them MEANS. `/api/v2/runs/start`
# is deliberately NOT here: it OPENS a run before any test has finished, so a
# verb that opened a run and then ingested a compile failure (bun `test` with
# no JUnit) has ingested no test run at all, and must say `compile`.
RUN_INGEST_PATHS = ("/api/v2/runs", "/api/v2/runs/parsed")
COMPILE_INGEST_PATH = "/api/v2/runs/compile"

# What THIS invocation has put on the board so far. Module state, because the
# statement belongs to the whole exit and not to the one call site that made
# it: the client that ingests and the client that emits are the same process,
# and `run_verb` clears it before every verb so a second invocation inside one
# process cannot inherit the first one's claim.
_ingested_run_tier = AXI_UNSET
_ingested_compile = False


def forget_ingested_run():
    """§S5 — clear what this process claims to have ingested. Called once per
    verb dispatch (`run_verb`), so an envelope can only ever state the ingest
    of the invocation it belongs to."""
    global _ingested_run_tier, _ingested_compile
    _ingested_run_tier = AXI_UNSET
    _ingested_compile = False


def post_ingest(post_fn, path, payload):
    """§S5/AC7 — send a run to the board through the client's own `_post` seam
    and REMEMBER what went out, so `emit_axi` can state the tier of the run it
    ingested without any client deciding that answer for itself.

    `post_fn` is that client's `_post`, taken as a parameter the way
    `post_gate`/`post_milestone` already take it: this module owns the meaning
    of an ingest, never the transport. The tier is read off the BODY rather
    than from a parameter, so the envelope can only repeat what the wire
    carried — an ingest that stated no tier is remembered as having stated
    none, which §S2/AC3 made the honest answer."""
    global _ingested_run_tier, _ingested_compile
    if path in RUN_INGEST_PATHS:
        _ingested_run_tier = (payload or {}).get("tier")
    elif path == COMPILE_INGEST_PATH:
        _ingested_compile = True
    return post_fn(path, payload)


def ingested_tier():
    """§S5/AC7 — the envelope's tier statement for this exit, drawn from the
    closed vocabulary above.

    A TEST ingest decides the answer whether or not a compile event also rode
    out on the same exit: a run that reached the board as a test run IS what an
    orchestrator reading the envelope is asking about."""
    if _ingested_run_tier is not AXI_UNSET:
        return _ingested_run_tier or ENVELOPE_TIER_UNSTATED
    return ENVELOPE_TIER_COMPILE if _ingested_compile else ENVELOPE_TIER_NONE


def tier_verb_help(tier, meaning, wired):
    """§S1 — the one line a tier verb prints in its client's help: what the
    tier MEANS (from the mirror, so all five clients teach one vocabulary) and
    what THIS client does with it — the run it performs, or the refusal it
    answers with while the project has declared no target for it."""
    if wired is not None:
        return f"{tier.upper()} tier — {meaning}. {wired.runs}"
    return (f"{tier.upper()} tier — {meaning}. No target for it is declared on "
            f"this stack: the verb refuses (ok:false, exit 1) naming what to "
            f"declare, and never falls back to another target.")


# ── §S6 — a DECLARED target is DETECTED and RUN, not merely demanded ──────
#
# §S3 said a cell with no toolchain split "requires a project declaration", and
# what shipped was the REFUSAL half only: nothing read a declaration, so a cell
# refused even when the project HAD declared its target. "An instruction that
# changes nothing when followed is worse than no instruction" (§S6), so the
# refusal stays exactly as it was for the case it was written for and becomes
# REACHABLE-PAST for every other.
#
# WHAT LIVES HERE IS THE POLICY, and it is the whole of it: the NAME a declared
# target is looked up under is one template applied to the tier
# (`declared_target_name`), the refusal's example is that SAME string
# (`declared_tier_surface_line`, §S6 ruling 5 — "a refusal that shows an example
# the client would not then find is the defect AC14a exists to catch"), a miss
# is the §S1 refusal and never a fallback, and a hit runs under the VERB's own
# tier. Five clients repeating that policy would be the second mirror AC10
# forbids; what stays per-stack is the two facts only that stack knows — how to
# READ its own surface and how to RUN what it found.
#
#   `target`    the ONE template, `<tier>` substituted: a bun `package.json`
#               script (`test:<tier>`), an arduino native make target
#               (`junit-<tier>`), a maven / nextest profile whose id IS the
#               tier (`<tier>`), python's example discovery start-dir.
#   `names`     this stack's one-line naming of WHERE the declaration goes,
#               with `<target>` filled from the template above.
#   `read`      `(args, target) -> declared-or-None`, that stack's own read.
#   `run`       `(args, tier, declared) -> exit code`, that stack's own run.
#   `add_args`  ruling 4 — the flag surface every DECLARED cell of this client
#               takes: the one its test-running sibling already takes, so the
#               instruction a refusal gives can actually be typed (AC14b).
#   `suites`    CR-CRU-112 §S1 — THE ONE FIELD THIS CR ADDS: how this stack
#               ENUMERATES what the project declared, and with what command,
#               `(args, surface) -> ((target, command-or-None), …)`. A target's
#               COMMAND is what names the stack that owns it
#               (`declaring_stack`); a target that names none is the reading
#               client's own, so every CR-CRU-111 declaration keeps its
#               meaning. `template_declared_suites` is the default reading for
#               a stack whose declarable names ARE the tier vocabulary, and
#               `None` says this surface cannot enumerate a project's
#               declaration at all (python, whose declaration IS the
#               invocation — CR-CRU-111 ruling 1).
DeclaredTierSurface = collections.namedtuple(
    "DeclaredTierSurface",
    ("target", "names", "read", "run", "add_args", "suites"),
    defaults=((), None))


def declared_target_name(surface, tier):
    """§S6 ruling 5 — THE template, applied. The lookup and the refusal's help
    example are both this string, so the two cannot drift apart."""
    return surface.target.replace("<tier>", tier)


def declared_tier_surface_line(surface, tier):
    """§S3/AC6a — the surface sentence a refusal names, carrying the example
    `declared_target_name` would find."""
    return surface.names.replace("<target>",
                                 declared_target_name(surface, tier))


def declared_tier_run(tier, funcs, surface):
    """§S1/§S6 — the handler a DECLARED cell is registered with: DETECT this
    project's declaration at this stack's own surface and RUN it, or refuse.

    The refusal is unchanged in shape — it RAISES, so it travels the fleet's
    own hard-stop route through `run_verb` (the `ok:false` envelope carrying
    the project context, exit 1, nothing run and nothing posted) and no client
    repeats a line of it. Never a no-op, and never a fall-back run: the verb
    has to ANSWER, and what it answers is which declaration is missing and
    WHERE on this stack it goes.

    What §S6 adds is the other branch. A declaration the project HAS made is
    read and run, and the run rides the VERB's own tier — §S2's rule holds
    without exception, and a detected declaration is the project's
    classification decision being honoured, never the client classifying."""
    declared = sorted(funcs)

    def _run_declared_tier(args):
        target = declared_target_name(surface, tier)
        found = surface.read(args, target)
        if not found:
            raise TierRunUndeclared(tier, declared,
                                    declared_tier_surface_line(surface, tier))
        return surface.run(args, tier, found)

    return _run_declared_tier


def add_tier_verbs(sub, funcs, *, declares, parents=(), add_args=()):
    """§S1 — register the SIX tier subparsers on `sub`, in every client that
    runs tests.

    The vocabulary is the mirror's, never an argument: the loop is driven off
    `TIER_MEANINGS`, so the six a client exposes cannot drift from the six the
    server declares, and a client cannot quietly expose five. That is the
    whole reason this registration is shared rather than hand-rolled five
    times — the fleet answered the same question two different ways before it
    (mvn had `unit`/`module`/`e2e` as verbs, everyone else had a hardcoded
    tier literal buried in a run path).

    What stays per-client is exactly what the other registrars leave
    per-client:

      * `funcs` — tier → that client's `TierVerb` for the tiers it RUNS. A
        tier absent from the mapping is registered all the same: it answers
        its own `--help` and refuses with `TierRunUndeclared`, because the
        vocabulary containing a tier and this project having a target for it
        are two different facts and conflating them is the defect;
      * `parents` — the shared parent a client like arduino already carries
        (its `common` bundles `--agent`/`--project-dir`);
      * `add_args` — the client's own per-verb conventions, applied to all
        six (each client's project-dir flag), with a single verb's own flags
        riding that verb's `TierVerb.add_args`;
      * `declares` — §S3/AC6a and §S6: this stack's `DeclaredTierSurface` —
        WHERE a declaration goes, how to READ it, how to RUN it, and the flag
        surface a declared cell takes. Required, because §S3's rule is per
        CELL: a client wires the cells its toolchain already splits and
        DETECTS the rest, and a refusal that cannot say where the declaration
        goes is not actionable. The surface is the client's fact (a
        `package.json` script, a discovery start-dir, a profile in `pom.xml` /
        `.config/nextest.toml`, a native `make` target); the policy it rides —
        the template, the refusal, the verb's tier — is this module's.
    """
    for tier, meaning in TIER_MEANINGS.items():
        wired = funcs.get(tier)
        tp = sub.add_parser(tier, parents=list(parents),
                            help=tier_verb_help(tier, meaning, wired))
        for adder in add_args:
            adder(tp)
        # §S6 ruling 4 — a DECLARED cell takes its client's declared-cell flag
        # surface. Before this it took NOTHING, not even `--agent`, so it
        # exited 2 before any declaration could be read: unusable, not merely
        # inert, and a refusal naming a flag its own verb rejects (AC14b).
        for adder in (wired.add_args if wired is not None else declares.add_args):
            adder(tp)
        tp.set_defaults(func=(wired.func if wired is not None
                              else declared_tier_run(tier, funcs, declares)))


# ── CR-CRU-112 §S1/§S2 — THE GATE COVERS EVERY DECLARED SUITE ─────────────
#
# §S1: "the gate's scope becomes the project's declared suites rather than one
# runner's discovery … each suite ingests through THAT stack's client … No
# client learns to run another language's tests." §S2: "`regression` is the
# union of the declared targets."
#
# The composition lives HERE, once, for the reason `add_tier_verbs` does: all
# five clients own a `cmd_pre_merge_gate` (`check` then `regression`), and a
# per-suite gate written five times would diverge five ways. What stays
# per-client is what only that client knows — how to RUN one of its own
# declared targets, and WHERE a declared command of its project runs.
#
# The declaration is CR-CRU-111's extended by ONE field (`DeclaredTierSurface.
# suites`): the targets a project declares, each with the command that declares
# it where the surface has one. Which STACK owns a target is then read off that
# command by ONE shared rule, so five surfaces cannot answer it five ways.

SIBLING_CLIENT = "<stack>-crucible.py"

_SIBLING_CLIENT_RE = re.compile(
    SIBLING_CLIENT.replace(".", r"\.").replace("<stack>", r"([a-z][a-z0-9_]*)"))

# The INTERPRETER a stack's suite is driven by, for a declaration that spells
# the suite out instead of naming that stack's client. Cycle 388 ruling 3: a
# project's test script must stay runnable with no agent and no ingest, so this
# repo declares `test:client` as `python3 -m unittest discover -s tests/client
# -t .` — the FIRST TOKEN identifies the stack, the flags identify the paths,
# and the GATE does the client dispatch itself. One entry per stack whose
# declarations take that form; a head that is not here names no stack, and a
# target that names no stack is the reading client's own.
STACK_INTERPRETERS = {"python": ("python",)}


def sibling_client(stack):
    """§S1 — the file name of the client that OWNS `stack`. The fleet's one
    naming of a sibling client, so a gate's dispatch and a declaration's
    ownership read the same string."""
    return SIBLING_CLIENT.replace("<stack>", stack)


def clients_dir():
    """The directory this shared module lives in — where every sibling client
    sits beside it, which is how a gate finds the one it must dispatch to."""
    return os.path.dirname(os.path.abspath(__file__))


def declaring_stack(command):
    """§S1 — the stack a declared target's COMMAND names, or None when it names
    none (→ the reading client's own stack).

    Two spellings and no third: the command INVOKES that stack's client
    (`…/python-crucible.py regression …`), or its first token is that stack's
    INTERPRETER (`python3 -m unittest …`). Both are read off the command the
    project already wrote, so neither invents the second declaration format
    §S1 forbids."""
    if not command:
        return None
    match = _SIBLING_CLIENT_RE.search(command)
    if match:
        return match.group(1)
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    head = os.path.basename(tokens[0]) if tokens else ""
    for stack, heads in STACK_INTERPRETERS.items():
        if any(head.startswith(prefix) for prefix in heads):
            return stack
    return None


def _python_suite_argv(tokens):
    """`python -m unittest discover -s <dir> [-p <pattern>]` → the python
    client's own `regression` over that SAME discovery.

    Nothing is invented: the flags that client takes are the discovery's own
    (CR-CRU-111 ruling 1 — on that stack the declaration IS the invocation), so
    the gate reads the declared paths and hands them to the client that can
    ingest them. `-t` has no client flag and is dropped: the run's top-level
    dir is the project dir the client resolves. None when the command declares
    no discovery this gate can read, which the gate REPORTS against the suite
    rather than skipping."""
    if "unittest" not in tokens:
        return None
    flags = {"-s": "--start-dir", "--start-dir": "--start-dir",
             "-p": "--pattern", "--pattern": "--pattern"}
    argv = [tokens[0], os.path.join(clients_dir(), sibling_client("python")),
            "regression"]
    start_dir = False
    for index, token in enumerate(tokens[:-1]):
        flag = flags.get(token)
        if flag is None:
            continue
        argv += [flag, tokens[index + 1]]
        start_dir = start_dir or flag == "--start-dir"
    return argv if start_dir else None


_SUITE_ARGV_BY_STACK = {"python": _python_suite_argv}


def sibling_client_argv(stack, command, agent=None):
    """§S1's DISPATCH — the invocation of `stack`'s OWN client that runs what
    `command` declares, or None when this declaration cannot be dispatched.

    A command that already invokes that client IS the invocation and runs as
    declared. One that spells its suite out is translated by the one rule that
    stack's declarations take (`_SUITE_ARGV_BY_STACK`) — the gate reading the
    declared paths, never a re-implementation of the suite: what runs the tests
    is that stack's client, in its own process, ingesting under its own stack,
    which is §S1's "no client learns another language's tests" enforced by
    construction.

    The gate's `--agent` rides last so the dispatched run is attributed to the
    gate that asked for it; a client handed the flag twice takes the last,
    which is this one."""
    try:
        tokens = shlex.split(command or "")
    except ValueError:
        return None
    if not tokens:
        return None
    if any(os.path.basename(token) == sibling_client(stack) for token in tokens):
        argv = list(tokens)
    else:
        builder = _SUITE_ARGV_BY_STACK.get(stack)
        argv = builder(tokens) if builder else None
    if argv and agent:
        argv += ["--agent", agent]
    return argv


# One declared suite of a project: the target, the stack that owns it, the tier
# it names (None when it names none of the vocabulary — `test:client` is a
# declared target and not a tier), the command it was declared with, and
# whether the GATE covers it.
GateSuite = collections.namedtuple(
    "GateSuite", ("target", "stack", "tier", "command", "gated", "excluded"))

GATE_SUITE_FAILED_CODE = "gate-suite-failed"
GATE_SUITE_UNREPORTED_CODE = "gate-suite-unreported"
GATE_SUITE_UNDISPATCHABLE_CODE = "gate-suite-undispatchable"
# AC3 — a suite whose RUNNER is not there: the run never happened, so it has no
# exit code and no envelope of its own, and the gate NAMES it instead of dying
# with it.
GATE_SUITE_UNRUNNABLE_CODE = "gate-suite-unrunnable"

# The OSError shapes a PROCESS LAUNCH raises, and the ONLY ones AC3's "the
# runner is not there" produces: `Popen` re-raises the child's failed `exec` as
# one of these three, and a run that never started is the whole content of
# `gate-suite-unrunnable`.
#
# It is a closed list rather than a bare `OSError` because `OSError` is not the
# spawn's alone. `urllib.error.URLError` is an `OSError` SUBCLASS, and so is
# `TimeoutError`: a board that goes unreachable during a run's INGEST raises
# one of those out of the run body, LONG after the suite has run to completion.
# Reading that as "could NOT be run" would have the gate tell a reader a suite
# that ran and passed never ran at all — the one misreport a gate must not
# make, because a reader cannot tell it from a real one.
SPAWN_FAILURES = (FileNotFoundError, NotADirectoryError, PermissionError)


def declared_target_tier(surface, target):
    """The `<tier>` slot's value in a declared target's NAME, or None when the
    name does not fit this stack's template at all.

    It is not necessarily a TIER: `test:client` fits `test:<tier>` and names no
    tier of the vocabulary, which is why every caller checks the answer against
    `TIER_MEANINGS` rather than assuming it."""
    head, _, tail = surface.target.partition("<tier>")
    if not target.startswith(head) or not target.endswith(tail):
        return None
    return target[len(head):len(target) - len(tail) if tail else None]


def template_declared_suites(args, surface):
    """The DEFAULT enumeration, for a stack whose declarable target NAMES are
    the tier vocabulary itself (`<tier>` for a maven / nextest profile,
    `junit-<tier>` for a native make target): every tier whose target this
    surface can READ.

    It is CR-CRU-111's own lookup asked six times instead of once — the same
    parse, without the single-name filter — so enumeration and lookup cannot
    disagree about what a project declared. Such a target carries no command,
    so it names no stack and belongs to the client reading it."""
    return tuple((declared_target_name(surface, tier), None)
                 for tier in TIER_MEANINGS
                 if surface.read(args, declared_target_name(surface, tier)))


def declared_gate_suites(args, surface, stack):
    """§S1/§S2 — the SUITES this project declares: every declared target, the
    stack that owns it, and whether the gate covers it.

    EMPTY when this stack's surface cannot enumerate a project's declaration
    (`suites=None`) or the project declares nothing; the gate then keeps its
    own single-runner regression, which is the one suite such a project has
    (§S2: "where a project declares one suite, behaviour is unchanged").

    `regression` is never a MEMBER: §S2 makes it the UNION of the declared
    targets, and a union is not an element of itself."""
    reader = surface.suites
    if reader is None:
        return ()
    suites = []
    for target, command in reader(args, surface) or ():
        named = declared_target_tier(surface, target)
        tier = named if named in TIER_MEANINGS else None
        if tier == "regression":
            continue
        excluded = GATE_UNCOVERED_TIERS.get(tier)
        suites.append(GateSuite(target=target, tier=tier, command=command,
                                stack=declaring_stack(command) or stack,
                                gated=excluded is None, excluded=excluded))
    return tuple(suites)


def _captured_suite_run(call):
    """Run one suite in THIS process and take the envelope it emits, as
    `(exit code, stdout, error)`.

    The gate puts exactly ONE document on stdout (CR-CRU-058 §S1) and it is now
    composing N runs, so a locally-run suite's own envelope is READ here
    instead of printed. Nothing else about the run changes: it ingests,
    narrates on stderr and returns its exit code exactly as a standalone run
    does — only the destination of the document it emits differs.

    AC3, the LOCAL half of the guard: a runner that is not there raises out of
    the client's own run body (`bun-crucible.py`'s `Popen`), and a gate that
    lets that propagate reports NOTHING — no envelope, no verdict, and not a
    word about the suites it could have run. The `OSError` is caught and
    handed back so the gate can name the suite and the reason; there is then no
    exit code and no document, which is what `code=None` says.

    The catch stays WIDE and the reading is narrow. It has to stay wide: an
    error the gate does not catch here kills the composition, which is the very
    defect AC3 exists to close. But `call()` is a whole run — spawn, collect,
    ingest — so an `OSError` out of it is not evidence the suite failed to
    START; the board going unreachable at the ingest raises one too. Deciding
    WHICH failure this was belongs to `_run_outcome`, once, for this path and
    the dispatched one alike (`SPAWN_FAILURES`)."""
    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer):
            code = call()
    except OSError as error:
        return None, buffer.getvalue(), error
    return code, buffer.getvalue(), None


def _suite_envelope(stdout_text):
    """The AXI envelope a suite's run put on stdout — the LAST decodable
    document, because a DISPATCHED client's stdout carries whatever its own
    children printed before it."""
    for match in reversed(list(re.finditer(r"(?m)^axi:", stdout_text or ""))):
        decoded = _decode_axi_snapshot(stdout_text[match.start():])
        axi = decoded.get("axi") if isinstance(decoded, dict) else None
        if isinstance(axi, dict):
            return axi
    return None


# Everything a run's own envelope counts, `files` INCLUDED. CR-CRU-051 §S2
# carries that count "so a suite that silently shrinks is visible in the gate
# output itself", which is this CR's own thesis — a composition that dropped it
# would hide precisely what the gate exists to show (AC4).
SUITE_COUNT_KEYS = ("passed", "failed", "pending", "total", "files")


def _suite_counts(envelope):
    """The run counts a suite's own envelope reports, or None when it reported
    none — a suite that never said what it ran is not a suite the gate can
    claim it covered."""
    run = (envelope or {}).get("run")
    if not isinstance(run, dict):
        return None
    counts = {key: run[key] for key in SUITE_COUNT_KEYS
              if isinstance(run.get(key), int)}
    return counts or None


def _gate_suite_warning(code, suite, detail):
    return {"code": code,
            "detail": f"declared suite `{suite.target}` ({suite.stack}) {detail}"}


def whole_suite_label(stack):
    """§S2 rule 1 — what the invoking stack's own regression IS, named once so
    the `suites[]` row that points at it and the warning that reports it read
    alike."""
    return f"the whole {stack} suite this gate ran"


def _whole_suite_warning(code, stack, covered, detail):
    """The same finding, for the run that is no declared suite but COVERS them:
    §S2 rule 3 makes an own-stack declared target a subset of the whole-suite
    run, so that run's outcome is reported against every declared target it
    covered — which is how AC2's `warnings[]` still NAMES the suite whose
    caller has somewhere to look."""
    covers = (" covering " + ", ".join(f"`{target}`" for target in covered)
              if covered else "")
    return {"code": code,
            "detail": f"{whole_suite_label(stack)}{covers} {detail}"}


def _run_outcome(code, counts, error):
    """What the gate has to SAY about ONE run it made: `(ok, warning code,
    warning detail)`, the detail None for a run that simply passed.

    One reading for the whole-suite run and for a dispatched suite, so the two
    cannot report the same condition differently.

    A raised error is CLASSIFIED and never taken at face value. Only a
    `SPAWN_FAILURES` shape means the run never happened; every other `OSError`
    that reaches here — an unreachable board during the INGEST above all — was
    raised by a suite that HAD already run, and it is reported as the thing it
    actually is: a run with no counts to show for it."""
    if isinstance(error, SPAWN_FAILURES):
        return False, GATE_SUITE_UNRUNNABLE_CODE, f"could NOT be run: {error}"
    if error is not None:
        return False, GATE_SUITE_UNREPORTED_CODE, (
            f"RAN, and then failed before it could report what it ran, so the "
            f"gate cannot say what it covered: {error}")
    if counts is None:
        return False, GATE_SUITE_UNREPORTED_CODE, (
            f"reported no run counts (exit {code}), so the gate cannot say "
            f"what it covered")
    if counts.get("failed") or code != 0:
        return False, GATE_SUITE_FAILED_CODE, (
            f"FAILED: {counts.get('failed', 0)} of {counts.get('total', 0)} "
            f"test(s) failed (exit {code})")
    return True, None, None


def _adopt_suite_warnings(gate_warnings, envelope):
    """A run's own findings are the gate's: the document they rode on is not
    printed any more, so they ride this one."""
    for warning in (envelope or {}).get("warnings") or []:
        if isinstance(warning, dict) and warning not in gate_warnings:
            gate_warnings.append(warning)


def run_gate_suites(suites, *, stack, verb, whole_suite, dispatch, context,
                    crucible_url, warnings=()):
    """§S2 — the ADDITIVE composition: this stack's OWN whole-suite regression,
    plus one dispatched run for every declared suite another stack owns, in ONE
    envelope naming them all.

    Three rules, and only the second adds a run to a project that already had a
    gate:

    1. the invoking stack's whole-suite regression ALWAYS runs (`whole_suite`),
       unchanged — same argv, same `regression` tier, same `run` block
       INCLUDING `files`. It is the gate's union BASE, so the union is never
       smaller than what the gate covered before this CR (AC4);
    2. a declared suite owned by ANOTHER stack is ADDED — one dispatched run
       each, run and ingested by that stack's own client, under its own stack;
    3. a declared target owned by THIS stack is NOT re-run. The whole-suite run
       already collected it — there is no discovery exclusion (AC6/§S3), so an
       own-stack target is a SUBSET of a run that has already happened — and
       its `suites[]` row records which run covered it rather than running it
       twice.

    Each row's counts are attributed to the suite that produced them (AC1),
    never pooled into one total. A run that FAILED, that could not be RUN at
    all, that could not be dispatched, or that reported no counts makes the
    gate NOT ok and is NAMED in `warnings[]`: "a gate that ran a subset reports
    as a gate that ran a subset"."""
    rows, gate_warnings = [], list(warnings)
    ok, worst = True, 0

    # Rule 1, and FIRST: every own-stack declared target is reported against
    # this run, so its outcome has to be known before they are named.
    covered = tuple(suite.target for suite in suites
                    if suite.gated and suite.stack == stack)
    code, out, error = _captured_suite_run(whole_suite)
    envelope = _suite_envelope(out)
    whole_counts = _suite_counts(envelope)
    _adopt_suite_warnings(gate_warnings, envelope)
    totals = {"passed": 0, "failed": 0, "pending": 0, "total": 0}
    totals.update(whole_counts or {})
    whole_ok, warning_code, detail = _run_outcome(code, whole_counts, error)
    if not whole_ok:
        gate_warnings.append(
            _whole_suite_warning(warning_code, stack, covered, detail))
        ok, worst = False, worst or (code or 0)

    for suite in suites:
        row = {"suite": suite.target, "stack": suite.stack, "gated": suite.gated}
        if not suite.gated:
            # §S1 — declared and OUT, with the reason, so an omission by
            # silence cannot pass for a decision.
            row["excluded"] = suite.excluded
            rows.append(row)
            continue
        if suite.stack == stack:
            # Rule 3 — covered by the run that already happened, and SAYING so
            # rather than collecting the same files a second time. The counts
            # are that run's, and they are NOT added to the union again.
            row["coveredBy"] = whole_suite_label(stack)
            row.update(whole_counts or {})
            rows.append(row)
            continue
        row["client"] = sibling_client(suite.stack)
        argv, cwd = dispatch(suite) if dispatch else (None, None)
        if not argv:
            rows.append(row)
            gate_warnings.append(_gate_suite_warning(
                GATE_SUITE_UNDISPATCHABLE_CODE, suite,
                f"declares no invocation this gate can dispatch to "
                f"{sibling_client(suite.stack)}, so it did NOT run"))
            ok, worst = False, worst or 1
            continue
        print(f"[crucible] {verb}: dispatching `{suite.target}` to "
              f"{' '.join(argv)}  (cwd={cwd})", file=sys.stderr)
        try:
            result = subprocess.run(argv, cwd=cwd, capture_output=True,
                                    text=True)
        except OSError as spawn_error:
            # AC3, the DISPATCHED half of the guard: a declared command whose
            # first token is not there would otherwise kill the gate
            # mid-composition, taking the suites that DID run with it.
            code, out, error = None, "", spawn_error
        else:
            sys.stderr.write(result.stderr or "")
            code, out, error = result.returncode, result.stdout or "", None
        envelope = _suite_envelope(out)
        counts = _suite_counts(envelope)
        if counts:
            row.update(counts)
            for key, value in counts.items():
                totals[key] = totals.get(key, 0) + value
        rows.append(row)
        _adopt_suite_warnings(gate_warnings, envelope)
        suite_ok, warning_code, detail = _run_outcome(code, counts, error)
        if not suite_ok:
            gate_warnings.append(
                _gate_suite_warning(warning_code, suite, detail))
            ok = False
        worst = worst or (code or 0)
    emit_axi(verb, ok,
             {"run": totals, "suites": rows,
              "help": run_help(verb, ok, totals["failed"], crucible_url)},
             context, gate_warnings,
             f"{verb}: ok={ok} suites={len(rows)} passed={totals['passed']} "
             f"failed={totals['failed']} total={totals['total']}")
    return 0 if ok else (worst or 1)


def gate_regression(args, *, surface, stack, verb, whole_suite, dispatch,
                    context, crucible_url):
    """§S1/§S2 — the GATE's regression step: the one composition all five gates
    run, so "the gate covers every declared suite" is a property of the fleet
    and not of one client.

    `whole_suite` is this client's OWN whole-suite regression, and §S2's
    additive rule runs it either way — as the gate's whole answer for a project
    whose declaration this stack cannot enumerate or that declares nothing (it
    IS that project's one suite), and as the union BASE for a project that
    declares suites, which are added to it and never substituted for it."""
    suites = declared_gate_suites(args, surface, stack)
    if not suites:
        return whole_suite()
    return run_gate_suites(suites, stack=stack, verb=verb,
                           whole_suite=whole_suite, dispatch=dispatch,
                           context=context, crucible_url=crucible_url)


# ── CR-CRU-111 §S4 — a `unit` run that WAITS says so (AC6b) ───────────────
#
# `unit` is the one tier of the six whose MEANING forbids waiting ("no wait on
# the clock", `TIER_MEANINGS` above), so a run of it that spends its wall clock
# not computing has taken a dependency its tier does not name. The check is
# scoped to that tier alone and it is deliberate: `integration`, `e2e`,
# `regression` and `bdd` name real elapsed time as a dependency by definition,
# and a warning there would be noise, not a finding.
#
# It WARNS and never refuses. Classification is the project's decision, so the
# client reports the contradiction rather than vetoing it: `ok` and the exit
# code are the run's own, untouched, and a check that turned a passing suite
# red would be a worse defect than the one it detects.
#
# The measurement is `resource.getrusage(RUSAGE_CHILDREN)` deltas taken around
# the client's OWN `subprocess.run` — stdlib, no dependency. Measured
# discrimination: a sleeping child reads 38.4x, a CPU-bound child 1.00x, and
# this repo's own unit target 1.09x (17.8 s wall / 16.3 s CPU), so 2x sits ~1.8x
# above a real unit suite and ~19x below a sleeping one. `RUSAGE_CHILDREN` sums
# CPU across cores, so a PARALLEL runner reads BELOW 1x and can never
# false-positive — the asymmetry is the reason this factor is safe.
#
# BOUND, stated where the mechanism is: `RUSAGE_CHILDREN` is a per-PROCESS
# cumulative counter, so a delta taken around one `subprocess.run` is
# attributable to that child only while the bracketed call spawns exactly ONE.
# Every `unit` run in the fleet does. Widening this check past `unit` would
# demand a delta per `subprocess.run` rather than one per verb (a gate that
# brings a compose stack up spawns two), which is why widening it is not a
# wording change.
UNIT_RUN_WALL_EXCEEDS_CPU_CODE = "unit-run-wall-exceeds-cpu"

# The tier the check is scoped to, and the factor §S4 states: wall at or over
# 2x CPU. Named rather than spelled at the comparison so the one definition the
# fleet shares is also the one it prints.
WALL_VS_CPU_TIER = "unit"
WALL_VS_CPU_FACTOR = 2.0


class ChildRunTiming:
    """§S4 — the bracket around a child run: wall seconds, child CPU seconds,
    and the ratio between them.

    Used as a context manager around the ONE `subprocess.run` a test verb makes
    (`with ChildRunTiming() as timing: result = _run_logged(...)`), so the
    rusage delta covers that child and nothing else. `wall` and `cpu` are 0.0
    until the block exits, and never negative: a monotonic clock cannot go
    backwards, and a rusage counter is cumulative, but clamping costs nothing
    and keeps a nonsense figure out of a warning.

    `ratio` is None when no CPU was measurable at all rather than raising or
    reporting an infinity — a child that consumed no measurable CPU is the
    STRONGEST form of the condition this exists to detect, so the division is
    guarded and the caller words that case for itself."""

    __slots__ = ("wall", "cpu", "_wall_at", "_cpu_at")

    def __init__(self):
        self.wall = 0.0
        self.cpu = 0.0
        self._wall_at = None
        self._cpu_at = None

    @staticmethod
    def _child_cpu():
        """CPU seconds this process's waited-for children have consumed, user
        plus system — the whole cost of a child, since a run that spends its
        time in the kernel is computing just as much as one in user space."""
        usage = resource.getrusage(resource.RUSAGE_CHILDREN)
        return usage.ru_utime + usage.ru_stime

    def __enter__(self):
        self._wall_at = time.monotonic()
        self._cpu_at = self._child_cpu()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.wall = max(time.monotonic() - self._wall_at, 0.0)
        self.cpu = max(self._child_cpu() - self._cpu_at, 0.0)
        return False

    @property
    def ratio(self):
        """wall / cpu, or None when no child CPU was measurable."""
        return self.wall / self.cpu if self.cpu > 0 else None


def unit_run_wall_vs_cpu_warnings(tier, client, timing,
                                  factor=WALL_VS_CPU_FACTOR):
    """§S4/AC6b — the envelope `warnings[]` fragment for a `unit` run that spent
    its wall clock waiting: `[]` or exactly one `{code, detail}`, in the shape
    `preflight_cycle_warnings` returns its finding, so a call site adds it to
    the warnings it already carries and changes nothing else.

    ONE definition for the fleet: five clients reach this, and a consumer
    matches on `UNIT_RUN_WALL_EXCEEDS_CPU_CODE`, so `client` (this client's own
    name — its own fact, like the declaration surface it hands
    `add_tier_verbs`) is what tells a reader of the board WHICH stack waited.

    `tier` is the tier the caller STATED, so an untiered run (`tier=None`) and
    every tier but `unit` return `[]` without measuring anything twice. A run
    with no wall time at all — nothing was bracketed — is not a finding
    either."""
    if tier != WALL_VS_CPU_TIER or timing is None or timing.wall <= 0.0:
        return []
    if timing.wall < factor * timing.cpu:
        return []
    ratio = timing.ratio
    measured = (f"{ratio:.1f}x" if ratio is not None
                else "no child CPU was measurable at all")
    return [{
        "code": UNIT_RUN_WALL_EXCEEDS_CPU_CODE,
        "detail": (f"{client} {tier}: this run spent {timing.wall:.3f}s of "
                   f"wall time against {timing.cpu:.3f}s of child CPU "
                   f"({measured}, at or over the {factor:g}x mark) — a "
                   f"{tier} run that spends its time WAITING is taking a "
                   f"dependency its tier does not name (a process, a socket, "
                   f"a live service, or the clock itself). Reclassify the "
                   f"run, or find what it waits on; it is reported either "
                   f"way, because which tier these tests belong to is the "
                   f"project's call and not this client's"),
    }]


def remove_agent_silent(project_dir, agent_id, ops):
    """CR-CRU-008 §S4 anti-ghost cleanup for a gated run: remove the agent row
    WITHOUT journaling a lifecycle event (a plain unregister would journal an
    'unregistered' event and bury the run just ingested).

    CR-CRU-056 — call this ONLY for an identity the gated run itself created
    (`GatedRunIdentity.should_remove`). §S1 stores the cycle binding ON the
    agent row, so removing a CALLER-owned registration destroys that caller's
    binding and the next gated run under the same identity ingests unattached.

    CR-CRU-054 §S2b (DN §4 finding #6) — the removal must never crash the
    closing bracket AND must never be reported as a success it cannot vouch
    for: the real response is returned when the server answered, and None when
    the call did not reach it, so `close_gate_identity` can say which
    happened."""
    try:
        return ops.post(AGENT_UNREGISTER_PATH,
                        {"agentId": agent_id,
                         "projectKey": ops.project_key(project_dir),
                         "silent": True})
    except (OSError, ValueError):
        # A transport/decode failure here is best-effort cleanup, not a run
        # verdict — but it is NOT swallowed: None is the caller's signal to
        # report the outcome as unknown rather than claim a removal.
        return None


def open_gate_identity(project_dir, agent_id, cycle_id, message, ops):
    """CR-CRU-056 — open a gated run's identity and learn whether the run
    CREATED it. One role-optional heartbeat (never /register: the gated verbs
    declare no role, and the heartbeat route is the one touch that cannot
    blank a pre-registered caller's role); `cycle_id` is the verb's `--cycle`,
    validated SERVER-side. The returned `GatedRunIdentity` answers
    `should_remove` for the closing anti-ghost cleanup."""
    identity = GatedRunIdentity(agent_id, cycle_id)
    resp = ops.post(identity.PATH,
                    identity.open_payload(ops.project_key(project_dir),
                                          message=message))
    identity.observe(resp)
    if resp.get("error") is not None or not resp.get("ok", False):
        print(gate_identity_open_failed_line(agent_id, resp.get("error")),
              file=sys.stderr)
    return identity


def close_gate_identity(project_dir, identity, ops, remove_fn=None):
    """CR-CRU-056 — the closing half of the bracket: silently remove the agent
    row ONLY when this run created it, and SAY SO either way on stderr so the
    decision is never invisible.

    CR-CRU-054 §S2b (DN §4 finding #6) — the line reports the REAL outcome of
    the removal (or that it is unknown), never a blanket "removed".

    `remove_fn` is the CLIENT's own silent-removal entry point (its delegator to
    `remove_agent_silent`), kept a parameter for the same reason `ClientOps` is
    built fresh per call: the removal stays a patchable seam in the client
    module the fleet's harness already targets."""
    if identity is None:
        return
    if not identity.should_remove:
        print(gate_identity_skipped_line(identity.agent_id, identity.confirmed),
              file=sys.stderr)
        return
    cleanup_resp = (remove_fn(project_dir, identity.agent_id) if remove_fn is not None
                    else remove_agent_silent(project_dir, identity.agent_id, ops))
    print(gate_identity_cleanup_line(identity.agent_id, cleanup_resp),
          file=sys.stderr)


def post_gate(project_key, agent_id, gate, post_fn, context=None, release=None):
    """POST a gate event. `context` is OMITTED entirely when falsy — never a
    fabricated empty dict.

    `release` is the label of the release this gate gates, and rides as the
    event's own top-level `version` — a SIBLING of `gate`, the server's
    first-class field, never a key inside the gate object. It travels
    VERBATIM: nothing here normalises a pre-release suffix, strips a prefix or
    derives a label from a branch name. It follows `context`'s absent-key rule
    for the same reason the server does: `version` is taken only when it is a
    non-empty string, and a gate carrying one is retention-protected until its
    release records, so an empty or null value would either be dropped
    silently or make every gate look release-bound and unprunable."""
    payload = {"projectKey": project_key, "agentId": agent_id, "gate": gate}
    if context:
        payload["context"] = context
    if isinstance(release, str) and release:
        payload["version"] = release
    return post_fn("/api/v2/gates", payload)


def post_milestone(project_key, agent_id, mtype, post_fn,
                   label=None, commit=None, context=None,
                   released_at=None, crs=None, packages=None,
                   repair_provenance=False):
    """POST a workflow milestone (§S4b). Absent label/commit/context keys are
    OMITTED rather than sent as nulls.

    CR-CRU-080 §S4 — a release's provenance travels the same way: `releasedAt`
    (the tag's commit date, epoch seconds) only when it was computed, and
    `crs` whenever a scan HAPPENED — including as an empty list, which says
    "the queue registered none of them" and is a different fact from a release
    that carries no CR set at all.

    CR-CRU-081 §S3 — `repairProvenance` is sent ONLY when the caller asked for
    it, so an ordinary post is byte-identical to the pre-081 one and stays the
    server's dedup replay. It is the whole opt-in: without this key on the
    wire a held release cannot be rewritten.

    CR-CRU-084 §S1/§S3 — `packages` rides on `crs`' exact terms, because AC4
    gives its empty state the same kind of meaning: the key is OMITTED when
    the ceremony said nothing about packages, and SENT as `[]` when it
    declared none. Hence `is not None` rather than a truthiness test — a
    falsy check here would silently turn "this release delivered nothing"
    into "this ceremony said nothing"."""
    payload = {"projectKey": project_key, "agentId": agent_id, "type": mtype}
    if label:
        payload["label"] = label
    if commit:
        payload["commit"] = commit
    if released_at:
        payload["releasedAt"] = released_at
    if crs is not None:
        payload["crs"] = crs
    if packages is not None:
        payload["packages"] = packages
    if repair_provenance:
        payload["repairProvenance"] = True
    if context:
        payload["context"] = context
    return post_fn("/api/v2/milestones", payload)


def add_gate_cycle_arg(p):
    """CR-CRU-056 — bind `--cycle` on a GATED verb (test/regression/
    pre-merge-gate): the binding for the register-inside-the-run case."""
    p.add_argument("--cycle", type=int, help=GATE_CYCLE_HELP)


def add_gate_release_arg(p):
    """Declare `--release` on a GATE verb (gate-run/gate-report): the label of
    the release this gate gates, posted as the event's top-level `version`.
    One helper for the whole fleet, so all five clients spell the flag and its
    help identically."""
    p.add_argument("--release", help=GATE_RELEASE_HELP)


def cmd_gate_report(args, project_dir, ops):
    """§S8 — report a single already-run gate (flags path). Emits the §S1
    envelope plus the interactive line on stderr, and ALWAYS raises the
    prefer-gate-run discouragement warning (envelope + stderr) regardless of the
    POST outcome — the discouragement is a property of using gate-report at
    all."""
    prefer = PREFER_GATE_RUN_WARNING
    warnings = [dict(prefer)]
    print(f"warning: {prefer['code']} — {prefer['detail']}", file=sys.stderr)
    agent_id = ops.agent_id(args)
    context = ops.context(project_dir, agent_id=agent_id)
    try:
        steps = parse_steps_flag(args.steps) if args.steps else []
    except ValueError as e:
        legacy = f"gate-report: ERROR: {e}"
        ops.emit("gate-report", False, {"outcome": args.outcome}, context, warnings, legacy)
        return 1
    # gate.intent is REQUIRED server-side (400 if missing/empty); when no
    # explicit intent is given, derive a non-empty one from the outcome.
    intent = args.intent or f"{args.outcome} gate"
    gate = {"intent": intent, "outcome": args.outcome, "steps": steps}
    if args.commit:
        gate["push"] = {"commit": args.commit}
    resp = ops.post_gate(project_dir, agent_id, gate, fleet_context() or None,
                         getattr(args, "release", None))
    ok = resp.get("ok", False)
    legacy = (f"gate-report: ok={ok} outcome={args.outcome}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    # §S11 — a failed POST can carry a large server error/detail string; surface
    # it as a truncated `error` field (size-hint suffix), verbatim under --full.
    result_fields = {"outcome": args.outcome}
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = truncate_field(err, full=getattr(args, "full", False))
    ops.emit("gate-report", bool(ok), result_fields, context, warnings, legacy)
    return 0 if ok else 1


# §S8 — how often `gate-run` posts an INTERIM snapshot while the proxied run is
# in flight, and how often it wakes to check. One cadence for the whole fleet.
_GATE_POLL_CADENCE_S = 2.0
_GATE_POLL_TICK_S = 0.4


def cmd_gate_run(args, project_dir, no_mistakes_path, ops):
    """§S8 — axi PROXY wrapper: launch `no-mistakes axi run`, poll `axi status`
    for throttled interim gates, seal a final gate from the run's outcome, and
    relay the axi detail to the caller. The caller issues NO POST itself, and
    there is no prefer-gate-run warning (gate-run IS the streaming standard).

    `no_mistakes_path` is resolved by the client wrapper (its own `shutil`), so
    the tool-discovery seam stays where each client's test harness patches it."""
    nm = no_mistakes_path
    if not nm:
        print("gate-run: ERROR: `no-mistakes` not found on PATH — cannot proxy axi run",
              file=sys.stderr)
        return 1

    intent = args.intent
    agent_id = ops.agent_id(args)
    context = fleet_context()

    # CR-CRU-061 §S5 — PURE passthrough of `--skip`. WHICH pipeline steps a
    # project skips is a per-project workflow decision, not a client-fleet
    # fact, so the value is never validated, split, normalised or rewritten
    # here; when unset, no `--skip` token reaches the argv at all.
    run_argv = [nm, "axi", "run", "--intent", intent]
    skip = getattr(args, "skip", None)
    if skip is not None:
        run_argv += ["--skip", skip]

    try:
        proc = subprocess.Popen(
            run_argv,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
    except OSError as e:
        print(f"gate-run: ERROR: could not launch `no-mistakes axi run`: {e}",
              file=sys.stderr)
        return 1

    # Poll `axi status` while the run is in flight; post throttled INTERIM
    # gates decoded from each (partial) snapshot. Whether the loop actually
    # POSTED is remembered, because the envelope below states which gate this
    # exit put on the board and the sealing decision cannot see the loop.
    last_post = None
    posted_interim = False
    while proc.poll() is None:
        now = time.monotonic()
        if last_post is None or (now - last_post) >= _GATE_POLL_CADENCE_S:
            status = subprocess.run([nm, "axi", "status"], capture_output=True, text=True)
            snap = (status.stdout or "").strip()
            if snap:
                decoded = _decode_axi_snapshot(snap)
                if isinstance(decoded, dict):
                    run = decoded.get("run") or {}
                    in_flight = (str(run.get("status")) != "completed"
                                 and "outcome" not in decoded)
                    gate, nsteps = gate_from_axi(decoded, intent, final=False)
                    # Post only a genuine PARTIAL ladder (never a resolved /
                    # full 9-step snapshot masquerading as interim).
                    if in_flight and 0 < nsteps < 9:
                        ops.post_gate(project_dir, agent_id, gate, context or None)
                        last_post = now
                        posted_interim = True
        time.sleep(_GATE_POLL_TICK_S)

    out, _err = proc.communicate()
    # Proxy role: relay the axi detail to the caller's OWN stdout.
    if out:
        sys.stdout.write(out)

    final_snap = (out or "").strip()
    final_decoded = _decode_axi_snapshot(final_snap) if final_snap else None
    if not isinstance(final_decoded, dict):
        print("gate-run: ERROR: `axi run` produced no parseable final snapshot",
              file=sys.stderr)
        return 1

    # Only the SEAL carries the release: a version-stamped gate is retention-
    # protected until its release records, so stamping every interim snapshot
    # of the poll loop above would leave a run's worth of unprunable gates
    # behind for one release — and the seal restates the release anyway.
    final_gate, _ = gate_from_axi(final_decoded, intent, final=True)
    outcome = final_gate.get("outcome")

    # §S4 — the envelope STATES what was posted, always as a value and never as
    # an absent key: a reader cannot tell a missing field from a client too old
    # to have one. `unstated` and `none` are the fleet's own distinction and are
    # not interchangeable — `unstated` means nothing was ASSERTED (no
    # `--release` was given; the run named no outcome), `none` means this exit
    # did the thing ZERO times (no gate reached the wire).
    raw = final_decoded.get("outcome")
    resolved = raw if isinstance(raw, str) and raw else None
    release = getattr(args, "release", None)
    held = outcome is None and resolved is None
    result_fields = {
        "outcome": outcome or ENVELOPE_TIER_NONE,
        "rawOutcome": resolved or ENVELOPE_TIER_UNSTATED,
        "release": release if isinstance(release, str) and release
                   else ENVELOPE_TIER_UNSTATED,
        "postedGate": (GATE_POSTED_FINAL if outcome
                       else GATE_POSTED_INTERIM if posted_interim
                       else ENVELOPE_TIER_NONE),
        "inFlight": held,
    }
    envelope_context = ops.context(project_dir, agent_id=agent_id)

    if outcome is None:
        # §S3 — the run reached no terminus, so this exit SEALS nothing. Not
        # merely nothing green: every gate carries an outcome, and both values
        # that would fit an unfinished ladder (`passed`, `checks-passed`) are
        # read as a verdict by the wave lens, so there is no shape in today's
        # vocabulary that says "still going" without claiming one. Silence on
        # the board is the honest state; a green gate over a run sitting at
        # `awaiting_approval` is not. The poll loop above may ALREADY have put
        # such a ladder there on a short snapshot — that false green is the
        # follow-on change request's whole subject, and until it is repaired
        # the envelope at least states the gate honestly rather than reporting
        # a silence the board does not have.
        #
        # The report goes to the CALLER instead, naming the run's OWN error —
        # the fact that answers "did this run terminate?", already in hand —
        # and the move that resumes it.
        detail = final_decoded.get("error")
        said = ("the run is still in flight — `axi run` resolved no outcome"
                if held else
                f"the run resolved {resolved!r}, which is in no pass family "
                f"this client knows, so it is not sealed")
        print(f"gate-run: NOT SEALED: {said}", file=sys.stderr)
        if detail:
            print(f"gate-run: the run said: {detail}", file=sys.stderr)
        if held:
            print(f"gate-run: {AXI_REATTACH_HELP}", file=sys.stderr)
        legacy = (f"gate-run: ok=False sealed=nothing exit={proc.returncode} "
                  f"— {said}"
                  + (f"; the run said: {detail}" if detail else "")
                  + (f"; {AXI_REATTACH_HELP}" if held else ""))
        ops.emit("gate-run", False, result_fields, envelope_context, [], legacy)
        return 1

    resp = ops.post_gate(project_dir, agent_id, final_gate, context or None,
                         release)
    ok = resp.get("ok", False)
    overall = bool(ok and proc.returncode == 0)
    legacy = (f"gate-run: ok={ok} outcome={outcome} "
              f"exit={proc.returncode}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    ops.emit("gate-run", overall, result_fields, envelope_context, [], legacy)
    return 0 if overall else 1


def _decode_axi_snapshot(snapshot):
    """Decode one `no-mistakes axi` TOON snapshot, or None when it is not
    decodable.

    An UNPARSEABLE snapshot is a normal, expected state of a run still being
    written — not an error to propagate — so the decode failure is converted
    into a None the caller acts on visibly (skip this tick / report "no
    parseable final snapshot"), never silently swallowed."""
    try:
        return _toon().decode(snapshot)
    except Exception:
        return None


def gate_identity_cleanup_line(agent_id, cleanup_resp):
    """CR-CRU-054 §S2b (DN §4 finding #6) — the stderr line for a gated run's
    anti-ghost cleanup, reporting what ACTUALLY happened.

    No client had this right: bun let the removal POST raise (crashing the
    closing bracket), while the other four guarded it but discarded the
    response and printed a fixed "removed" line even when the removal had
    silently failed. The corrected pair returns the real response (or None when
    the call never reached the server) and reports the true outcome — `ok=` when
    the server answered, "outcome unknown" on a transport failure, and never a
    blanket claim of removal."""
    if cleanup_resp is None:
        return (f"cleanup: agent={agent_id} removal attempted, outcome unknown — "
                f"the silent-unregister call did not reach the server")
    return f"cleanup: ok={cleanup_resp.get('ok', False)} agent={agent_id}"
