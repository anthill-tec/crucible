"""CR-CRU-118 §S3 (fleet half) -- the deprecation notice reaches ALL FIVE
clients, and the client count itself is asserted.

The route half lives in `tests/queue-file-deprecation.test.ts`: every bulk
queue POST raises a structured deprecation finding naming the three per-CR
verbs that replace `queue-file` (`cr-plan`, `cr-depends`, `wave-sequence`).
This file is the other half of the same criterion -- "it reaches all five
clients, asserted per client, with the client count itself asserted (5)".

WHY THE COUNT IS PART OF THE ASSERTION (CR-CRU-075's census pattern): the
findings the server raises are rendered by shared code in
`clients/_crucible_axi.py`, so a change that reaches the shared module but not
the census would pass silently -- which is exactly how `queue-file` itself sat
in 1 of 5 clients across three CRs that each cited it as the gap not to repeat.
A per-client assertion that never noticed a client had gone missing would be
the same act of faith.

WHAT IS RED HERE, AND WHY IT IS A REAL DEFECT RATHER THAN A MISSING SERVER
-------------------------------------------------------------------------
Measured 2026-09-10, by reading `clients/_crucible_axi.py::cmd_queue_file`: it
emits its envelope as

    ops.emit("queue-file", bool(ok),
             {"entries": entries, "unknownDependencies": unknown, ...},
             ops.context(project_dir), [], None)

and that fifth positional argument is `emit_axi`'s `warnings` -- hard-coded to
the empty list. The verb DROPS every finding the queue route answered with, so
no warning the server raises can reach an orchestrator through this verb, on
any of the five clients. §S3's notice is the finding that makes that visible,
but the hole is not specific to it: §S2's `inherited-release-less` migration
list is discarded by the same line today.

The drives below therefore need NO real Crucible server. They point the real
client subprocesses at a stub that answers the one full-replace POST with the
warnings the route raises, which is a fair census of the CLIENT's half of the
contract: what the fleet does with the findings it is handed.

IDIOM -- borrowed whole, never re-invented: the fleet census
(`test_client_fleet_envelope_census.py`) already drives all five clients as
GENUINE subprocesses against a local stub HTTP server, with a fake-tool PATH
dir and a throwaway project fixture per client, and decodes stdout as TOON. Its
helpers are imported here rather than copied, exactly as
`test_shared_module_envelope_gaps.py` and `test_toolchain_verb_envelopes.py`
import them.
"""

import http.server
import json
import shutil
import threading
import unittest

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _QUEUE_TABLE_HEADER,
    _QUEUE_TABLE_ROWS,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    classify_envelope,
    drive_verb,
)

# ── the contract, as the route half pins it ────────────────────────────────
#
# One spelling, shared with `tests/queue-file-deprecation.test.ts`. The CR
# names the three verbs and the `{code, message}` finding shape; the code and
# the machine-readable field are chosen ONCE by RED and implemented by GREEN.
QUEUE_FILE_VERB = "queue-file"
DEPRECATION_CODE = "deprecated-route"
REPLACEMENT_VERBS = ["cr-plan", "cr-depends", "wave-sequence"]

# §S2's finding, raised on the same call. It is here to prove the notice is
# ADDITIVE through the CLIENT as well as through the route: a client that
# forwarded only the first finding, or only the one it recognised, would render
# a migration list of one and hide the rest.
INHERITED_CODE = "inherited-release-less"
INHERITED_CRS = ["QF-DEPR-101", "QF-DEPR-102"]

# What the route answers, in the shape the server sends it. The `message` is
# the ready-to-print line the five clients render; `verbs` / `crs` are the
# machine halves nobody has to parse prose for (§S9 -- a client renders a
# finding and decides nothing).
DEPRECATION_WARNING = {
    "code": DEPRECATION_CODE,
    "message": (
        "the bulk queue post is DEPRECATED and will be removed: declare membership "
        "per CR with cr-plan, dependencies with cr-depends, and order with "
        "wave-sequence"
    ),
    "verbs": REPLACEMENT_VERBS,
}

INHERITED_WARNING = {
    "code": INHERITED_CODE,
    "message": (
        f"{', '.join(INHERITED_CRS)} were kept as they stand and still name no "
        f"release -- run cr-plan for each to empty this list"
    ),
    "crs": INHERITED_CRS,
}

# The server's own order, which the client must not reorder either: findings
# are rendered, not re-decided.
ANSWERED_WARNINGS = [DEPRECATION_WARNING, INHERITED_WARNING]


class _WarningAnsweringQueueStub:
    """A real HTTP server accepting the ONE full-replace POST `queue-file`
    makes and answering it the way the route answers it after §S3: `ok: true`
    plus the findings the call raised.

    The sibling census's `_QueueFileStubServer` answers the same POST with no
    warnings at all, which is why this one exists rather than a flag on that
    one: the whole subject here is what the client does with a NON-empty
    `warnings` list, and a shared stub answering both shapes would have to be
    told which case it was in by the test that is supposed to be measuring it.
    """

    def __init__(self):
        self.requests = []
        stub = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _answer(self, status, body):
                encoded = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw.decode() or "null")
                except ValueError:
                    body = None
                stub.requests.append(("POST", self.path, body))
                if self.path.endswith("/queue"):
                    self._answer(200, {"ok": True, "unknownDependencies": [],
                                       "warnings": ANSWERED_WARNINGS})
                else:
                    self._answer(404, {"ok": False,
                                       "error": f"no stub for {self.path}"})

            def do_GET(self):
                stub.requests.append(("GET", self.path, None))
                self._answer(404, {"ok": False,
                                   "error": f"no stub for {self.path}"})

            def log_message(self, *args):
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.base_url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        daemon=True)
        self._thread.start()

    def env(self):
        """The base-URL overrides `drive_verb` needs (arduino accepts
        `CRUCIBLE_BASE` as its second choice), plus a blanked orchestrator env
        so an ambient session cannot colour the `context` block."""
        return {"CRUCIBLE_URL": self.base_url,
                "CRUCIBLE_BASE": self.base_url,
                "WORKFLOW_ROLE": "", "WORKFLOW_WAVE": ""}

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


_DRIVE_CACHE = None


def _get_drives():
    """Drive `queue-file` once per client as a real subprocess, cached at
    module scope exactly like the census's own drives.

    Each value keeps the RAW `CompletedProcess` (the exit code is part of the
    contract: deprecated is not removed), the decoded `axi`, and the requests
    the stub actually saw -- so "the client sent the queue and rendered what
    came back" is measured across a genuine socket rather than inferred.
    """
    global _DRIVE_CACHE
    if _DRIVE_CACHE is not None:
        return _DRIVE_CACHE
    fake_bin_dir = _build_fake_bin_dir()
    toon_module = _load_toon_module()
    stub = _WarningAnsweringQueueStub()
    drives = {}
    try:
        for client_key, script_path in CLIENT_FILES.items():
            project_dir = _make_project_dir(client_key)
            try:
                queue_path = project_dir / "docs" / "changes" / "README.md"
                queue_path.parent.mkdir(parents=True, exist_ok=True)
                queue_path.write_text(_QUEUE_TABLE_HEADER + _QUEUE_TABLE_ROWS,
                                      encoding="utf-8")
                seen = len(stub.requests)
                result = drive_verb(script_path,
                                    [QUEUE_FILE_VERB, "--project-dir", str(project_dir)],
                                    project_dir, fake_bin_dir,
                                    extra_env=stub.env())
                _emits, axi = classify_envelope(result.stdout, toon_module)
                drives[client_key] = {"result": result, "axi": axi,
                                      "requests": stub.requests[seen:]}
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        stub.close()
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _DRIVE_CACHE = drives
    return drives


def _warnings_of(axi):
    """The findings the client rendered, or `None` when there was no envelope
    at all -- a distinction the offender messages keep, because "no envelope"
    and "an envelope carrying no findings" are different defects."""
    if not isinstance(axi, dict):
        return None
    raised = axi.get("warnings")
    return raised if isinstance(raised, list) else None


def _finding(axi, code):
    """The one rendered finding carrying `code`, or None."""
    for warning in _warnings_of(axi) or []:
        if isinstance(warning, dict) and warning.get("code") == code:
            return warning
    return None


class QueueFileDeprecationReachesEveryClientTest(unittest.TestCase):
    """§S3 -- the notice is rendered by all five clients, or it does not exist.

    A finding the server raises and no client prints is a finding an
    orchestrator never sees, and the whole point of §S3 is that the route SAYS
    what it is on every call.
    """

    @classmethod
    def setUpClass(cls):
        cls.drives = _get_drives()

    def test_the_fleet_is_five_clients_and_every_one_of_them_was_driven(self):
        """AC -- "the client count itself asserted (5)". Two halves, because a
        per-client census is only as wide as the list it iterates: the fleet IS
        five, and all five produced a real drive here. A client silently
        dropped from `CLIENT_FILES` would make every other assertion in this
        file pass while covering four stacks."""
        self.assertEqual(
            len(CLIENT_FILES), 5,
            f"the fleet is FIVE clients (CR-CRU-075 §S2's census constant); "
            f"got {sorted(CLIENT_FILES)!r}")
        self.assertEqual(
            sorted(self.drives), sorted(CLIENT_FILES),
            f"every client must have been driven: got {sorted(self.drives)!r}")
        undriven = {key: "no envelope on stdout"
                    for key, drive in self.drives.items()
                    if not isinstance(drive["axi"], dict)}
        self.assertEqual(
            undriven, {},
            f"`queue-file` must answer with a real TOON-AXI envelope in every "
            f"client before its findings can be censused: {undriven!r}")

    def test_every_client_renders_the_deprecation_notice(self):
        """The criterion itself, asserted PER CLIENT with the offenders named:
        a failure that does not say WHICH client dropped it sends the next
        reader looking through five files."""
        offenders = {}
        for client_key, drive in self.drives.items():
            rendered = _warnings_of(drive["axi"])
            if rendered is None:
                offenders[client_key] = "the envelope carries no `warnings` list"
                continue
            if _finding(drive["axi"], DEPRECATION_CODE) is None:
                offenders[client_key] = (
                    f"rendered {[w.get('code') for w in rendered if isinstance(w, dict)]!r}")
        self.assertEqual(
            offenders, {},
            f"every client must render the `{DEPRECATION_CODE}` finding the "
            f"route answered with -- a notice no client prints is a notice "
            f"nobody receives: {offenders!r}")

    def test_every_client_carries_the_three_replacement_verbs_machine_readably(self):
        """"Names the three replacement verbs by name, machine-readably" --
        asserted as the FIELD, in the route's order, never by matching the
        printable sentence. A client that flattened the finding to prose would
        make an orchestrator regex an English line to find the verbs, which is
        the client deciding something (§S9)."""
        offenders = {}
        for client_key, drive in self.drives.items():
            notice = _finding(drive["axi"], DEPRECATION_CODE)
            if notice is None:
                offenders[client_key] = "no deprecation finding rendered at all"
                continue
            if notice.get("verbs") != REPLACEMENT_VERBS:
                offenders[client_key] = f"verbs={notice.get('verbs')!r}"
                continue
            message = notice.get("message")
            if not isinstance(message, str) or not message:
                offenders[client_key] = f"message={message!r}"
        self.assertEqual(
            offenders, {},
            f"the notice must reach every client with {REPLACEMENT_VERBS!r} "
            f"intact beside its printable message: {offenders!r}")

    def test_the_notice_never_displaces_the_other_findings(self):
        """ADDITIVE, measured through the CLIENT: the route answered TWO
        findings and both must arrive, in the order the server sent them, with
        §S2's machine-readable crs intact.

        A client that rendered only the first, or only the code it recognised,
        would report a migration list of nothing while the board still carried
        the debt."""
        offenders = {}
        for client_key, drive in self.drives.items():
            rendered = _warnings_of(drive["axi"])
            if rendered is None:
                offenders[client_key] = "the envelope carries no `warnings` list"
                continue
            codes = [w.get("code") for w in rendered if isinstance(w, dict)]
            if codes != [DEPRECATION_CODE, INHERITED_CODE]:
                offenders[client_key] = f"codes={codes!r}"
                continue
            inherited = _finding(drive["axi"], INHERITED_CODE)
            if inherited.get("crs") != INHERITED_CRS:
                offenders[client_key] = f"crs={inherited.get('crs')!r}"
        self.assertEqual(
            offenders, {},
            f"every client must render BOTH findings the route raised, in the "
            f"order it raised them and with their machine-readable fields "
            f"intact: {offenders!r}")

    def test_deprecated_is_not_removed_in_any_client(self):
        """The other half of §S3, and the reason the notice is a WARNING rather
        than a refusal: the verb still posts the whole set once and still
        succeeds. A client that turned the notice into an error would break the
        bootstrap the whole board is restored from."""
        offenders = {}
        for client_key, drive in self.drives.items():
            result, axi = drive["result"], drive["axi"]
            queue_posts = [req for req in drive["requests"]
                           if req[0] == "POST" and req[1].endswith("/queue")]
            if len(queue_posts) != 1:
                offenders[client_key] = f"queue posts={drive['requests']!r}"
                continue
            if result.returncode != 0:
                offenders[client_key] = (
                    f"exit={result.returncode} stderr={result.stderr[-400:]!r}")
                continue
            if not isinstance(axi, dict) or axi.get("ok") is not True:
                offenders[client_key] = f"axi={axi!r}"
        self.assertEqual(
            offenders, {},
            f"a DEPRECATED route is not a removed one: every client must still "
            f"POST the whole set once and exit 0 with ok:true: {offenders!r}")


if __name__ == "__main__":
    unittest.main()
