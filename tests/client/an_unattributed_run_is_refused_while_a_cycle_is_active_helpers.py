"""The helpers of `test_an_unattributed_run_is_refused_while_a_cycle_is_active.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json as _json
import time
import urllib.error
import urllib.request
from pathlib import Path

from tests.client.live_run_harness import INGEST_PATHS, PLANS_ANSWER, RecordingBoard

# The routes a run, or a compile or lint result, is filed through.
FILING_PATHS = INGEST_PATHS


def cycle_board(project_key, agent_id, active_cycle_id=None,
                cr="CR-T-CYCLE-REFUSAL-ACTIVE",
                orchestrator="cycle-refusal-fixture-orchestrator"):
    """A `RecordingBoard` answering the pre-flight reads as the server answers
    them for a project that holds `agent_id` registered bound to no cycle, and
    — with `active_cycle_id` — one open plan whose one cycle is ACTIVE, or no
    plan filed at all without it. The shapes are the server's: the agent list
    of `GET /api/v2/agents?project=` (`Store.toAgent`: no `boundCycleId` key
    for an unbound agent) and the plans read of
    `GET /api/v2/projects/<key>/plans` (`PLANS_ANSWER`)."""
    board = RecordingBoard()
    now = int(time.time() * 1000)
    board.answer("GET", f"/api/v2/agents?project={project_key}",
                 {"ok": True, "agents": [
                     {"agentId": agent_id, "projectKey": project_key,
                      "status": "online", "message": "", "identity": {},
                      "firstSeen": now, "lastSeen": now, "role": "report"}]})
    plans = dict(PLANS_ANSWER)
    if active_cycle_id is not None:
        plans = {**PLANS_ANSWER, "filed": 1, "plans": [
            {"planId": 1, "projectKey": project_key, "cr": cr,
             "status": "open", "orchestrator": orchestrator,
             "cycles": [{"id": active_cycle_id, "label": "solo",
                         "kind": "red-green", "status": "active"}]}]}
    board.answer("GET", f"/api/v2/projects/{project_key}/plans", plans,
                 prefix=True)
    return board


def filed(board):
    """`[(path, body), ...]` for every run, compile or lint result filed."""
    return [(p, b) for p, b in board.posts() if p in FILING_PATHS]


def runs_touched(board):
    """Every POST to a run route — opening, streaming, filing, aborting."""
    return [p for p, _b in board.posts() if p.startswith("/api/v2/runs")]


def unattributed_to(board, cycle_id):
    """The results filed that the server would NOT store under `cycle_id`,
    by its attach rule (`ingest-binding-attach.test.ts`): a result carries the
    cycle when its own `context.cycleId` names it, or the run it closes was
    opened with that `context.cycleId`, or its agent was registered (or
    heartbeated) bound to that cycle before it was filed."""
    opened = {}
    run_seq = 0
    bound = set()
    missing = []
    for path, body in board.posts():
        body = body if isinstance(body, dict) else {}
        raw_context = body.get("context")
        context = raw_context if isinstance(raw_context, dict) else {}
        if path in ("/api/v2/agents/register", "/api/v2/agents/heartbeat"):
            if body.get("cycleId") == cycle_id:
                bound.add(body.get("agentId"))
        elif path == "/api/v2/runs/start":
            run_seq += 1
            opened[f"run-live-{run_seq}"] = context.get("cycleId")
        elif path in FILING_PATHS:
            if (context.get("cycleId") == cycle_id
                    or opened.get(body.get("runId")) == cycle_id
                    or body.get("agentId") in bound):
                continue
            missing.append((path, body.get("agentId"), body.get("runId"),
                            context))
    return missing


def _free_port():
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _declare_listener(store_dir, port, host="127.0.0.1"):
    Path(store_dir, "crucible.toml").write_text(
        f'[server]\nhost = "{host}"\nport = {port}\n', encoding="utf-8")


def _call(base, path, payload=None, method=None):
    data = None if payload is None else _json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path, data=data, method=method or ("POST" if data is not None else "GET"),
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return _json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return _json.loads(exc.read().decode())


def _await_server(base, proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"scratch server exited early with {proc.returncode}")
        try:
            with urllib.request.urlopen(base + "/api/v2/health", timeout=2):  # noqa: S310
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"scratch server never became reachable at {base}")
