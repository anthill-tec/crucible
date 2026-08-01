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
       phase-OPTIONAL heartbeat (`PATH`). The heartbeat route, never
       `/register`, is deliberate: the gated verbs take no `--phase`, and
       CR-CRU-044 §S1(a) makes the heartbeat the one touch that never
       re-declares — nor blanks — the phase a pre-registered caller declared.
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
# entity that is not an agent, with no phase, no lifecycle and no owner. The
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


def run_verb(func, args, project_key_fn=None):
    """Fleet-uniform subcommand dispatch: run the resolved verb and convert an
    undeclared agent identity (§S5) into the `ok:false` hard-stop envelope and a
    non-zero exit code instead of an unhandled traceback.

    `project_key_fn(args)` is the client's own `.env` key resolver (project-dir
    resolution stays client-specific per this module's scope boundary); it is
    best-effort only — a project whose key cannot be resolved still hard-stops,
    just with a bare context."""
    try:
        return func(args)
    except AgentIdentityRequired:
        context = {}
        if project_key_fn is not None:
            try:
                context = axi_context(project_key_fn(args))
            except Exception:
                context = {}
        return emit_agent_identity_hard_stop(getattr(args, "cmd", None), context)


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


def gate_from_axi(decoded, intent, final):
    """Build a `gate` object from a decoded `no-mistakes axi` TOON snapshot.

    An in-flight snapshot (`final=False`) synthesises a valid interim outcome
    from its steps; the sealing snapshot (`final=True`) takes the run's own
    resolved top-level `outcome`. Returns (gate_dict, step_count)."""
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
        raw = decoded.get("outcome")
        outcome = raw if raw in GATE_OUTCOMES else ("failed" if any_failed else "passed")
    else:
        outcome = "failed" if any_failed else "checks-passed"
    gate = {"intent": intent, "outcome": outcome, "steps": steps}
    head = run.get("head")
    if final and head:
        gate["push"] = {"commit": head}
    return gate, len(steps)
