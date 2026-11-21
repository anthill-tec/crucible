"""The helpers of `test_cr017_client_lifecycle.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json
import time


# The run ingest route: the bun client sends its runner's reports there for
# the board to decode.
RUNS = "/api/v2/runs"

# The `run` block the fake board answers `/api/v2/runs` with: the one passing
# case PASS_JUNIT_XML holds, as the board would decode it. The fake decodes
# nothing.
RUN_BLOCK = {"passed": 1, "failed": 0, "pending": 0, "total": 1, "files": 1}


class _FakeCrucible:
    """An in-process stand-in for the §S1 run-lifecycle server. Models exactly
    the three things this CR's client contract depends on: run-start issues a
    runId and remembers `startedAt`; an ingest carrying that runId CLOSES the
    run and computes `runtime_ms = endedAt - startedAt`; an ingest without one
    is the unchanged single-shot store. `start_status` lets a test model an
    OLDER server whose /runs/start route does not exist (the `_crucible_axi`
    HTTP layer renders a 404 as `{ok: False, error: "HTTP 404: ..."}`)."""

    def __init__(self, start_response=None):
        self.calls = []                 # [(path, payload)] in wire order
        self.start_wall = None          # time.time() when /runs/start ran
        self.runs = {}                  # runId -> startedAt (epoch ms)
        self.events = []                # the CLOSED runs, as the store sees them
        self._start_response = start_response
        self._next_run = 0

    def post(self, path, payload):
        self.calls.append((path, json.loads(json.dumps(payload))))
        if path in ("/api/v2/agents/heartbeat", "/api/v2/agents/register",
                    "/api/v2/agents/unregister"):
            return {"ok": True, "changed": True}
        if path == "/api/v2/runs/start":
            if self._start_response is not None:
                return dict(self._start_response)
            self._next_run += 1
            run_id = f"run-cr017-{self._next_run}"
            self.start_wall = time.time()
            self.runs[run_id] = int(self.start_wall * 1000)
            return {"ok": True, "changed": True, "runId": run_id,
                    "startedAt": self.runs[run_id]}
        if path in ("/api/v2/runs/parsed", "/api/v2/runs", "/api/v2/runs/compile"):
            event = {"path": path, "payload": payload}
            run_id = payload.get("runId")
            if run_id is not None:
                if run_id not in self.runs:
                    return {"ok": False, "error": f"unknown runId: {run_id}"}
                started_at = self.runs.pop(run_id)
                event["startedAt"] = started_at
                event["runtime_ms"] = int(time.time() * 1000) - started_at
            self.events.append(event)
            if path == RUNS:
                return {"ok": True, "run": dict(RUN_BLOCK)}
            return {"ok": True}
        # CR-CRU-170 \u00a7S2 (orchestrator-approved re-pin) \u2014 the client's own
        # close of a run it opened and cannot file: `POST
        # /api/v2/runs/<runId>/abort {projectKey, agentId, reason}`, answered
        # the way `handleRunAbort` (src/v2.ts) answers it for a run this
        # fake still holds open \u2014 settled, removed from `self.runs` so a
        # second attempt would see "unknown", and recorded as an `aborted`
        # event exactly as the real store's `abortRun` stamps one.
        if path.startswith("/api/v2/runs/") and path.endswith("/abort"):
            run_id = path[len("/api/v2/runs/"):-len("/abort")]
            if run_id not in self.runs:
                return {"ok": False, "error": f"unknown runId: {run_id}"}
            reason = payload.get("reason")
            started_at = self.runs.pop(run_id)
            self.events.append({"path": path, "payload": payload,
                                "startedAt": started_at, "status": "aborted",
                                "abortReason": reason})
            return {"ok": True, "changed": True, "runId": run_id,
                    "status": "aborted", "reason": reason}
        return {"ok": False, "error": f"unhandled POST {path}"}

    # -- read helpers -------------------------------------------------------

    def paths(self):
        return [p for p, _ in self.calls]

    def payload_for(self, path):
        for p, payload in self.calls:
            if p == path:
                return payload
        return None

    def index_of(self, path):
        for i, (p, _) in enumerate(self.calls):
            if p == path:
                return i
        return None


# The warning's code, derived from the family it joins: `no_wave_warning` ->
# "no-wave", `no_title_warning` -> "no-title", so a missing cycle attribution
# -> "no-cycle". (Deliberately NOT the retired "no-cycle-id" of CR-CRU-030
# §S3, whose client-side active-cycle resolver CR-CRU-056 §S3 deleted.)
MISSING_CYCLE_CODE = "no-cycle"
