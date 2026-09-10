"""CR-CRU-118 §S4a (fleet half) -- `release-propose` cannot be called without
a target, in ALL FIVE clients, and the client count itself is asserted.

The route half lives in `tests/release-target-mandatory.test.ts`: the POST
refuses a proposal carrying no `targetAt` even when a client is bypassed. This
file is the other half of the same criterion -- "refused by argparse in all
five clients, asserted per client, with the client count itself asserted (5)".

WHY THE COUNT IS PART OF THE ASSERTION (CR-CRU-075's census pattern): the flag
is registered ONCE, in `clients/_crucible_axi.py::add_roadmap_verbs`, and each
of the five clients injects only its own `funcs`/`parents`/`add_args`. So the
change §S4 needs is one line -- and a census that never noticed a client had
gone missing would pass just as happily on four stacks as on five. That is the
exact failure mode CR-CRU-075 exists to prevent: "one verb was an envelope on
one stack and argparse's `invalid choice` on four". The single-registrar design
is only a FACT if something asks all five the same question.

WHY ARGPARSE AND NOT THE ENVELOPE. A required flag is refused BEFORE any verb
function runs: argparse prints its own usage to stderr and exits 2, and nothing
reaches the wire. That is a different kind of refusal from the fleet's TOON-AXI
envelope, and it is the one §S4 asks for client-side, so it is asserted as what
it is -- exit 2, argparse's own sentence on stderr, and a stub server that saw
NO request at all. The last of those three is the load-bearing one: "refused
client-side" is a claim about what did NOT leave the process.

WHAT IS RED HERE, AND WHY IT IS A REAL DEFECT. Measured 2026-09-10 by reading
`add_roadmap_verbs`: `rp.add_argument("--target", ...)` carries no
`required=True`, and its own help text calls the flag "Optional and revisable".
So today all five clients accept a targetless `release-propose` and POST it,
which is precisely what §S4 closes -- a release that names no date it is aiming
at, which is the axis burn-down will later read.

IDIOM -- borrowed whole, never re-invented: the fleet census
(`test_client_fleet_envelope_census.py`) already drives all five clients as
GENUINE subprocesses with a fake-tool PATH dir and a throwaway project fixture
per client, and decodes stdout as TOON. Its helpers are imported here rather
than copied, exactly as `test_queue_file_deprecation_fleet.py` and
`test_shared_module_envelope_gaps.py` import them.
"""

import http.server
import json
import re
import shutil
import threading
import unittest

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    classify_envelope,
    drive_verb,
)

RELEASE_PROPOSE = "release-propose"
TARGET_FLAG = "--target"

# This suite's own label shape -- a version no live board holds.
LABEL = "0.9.0"

# The declared target in the two forms a caller may type, and the ONE integer
# both must reach the wire as: midnight UTC on an unambiguous day, in epoch
# SECONDS (§S1 -- the unit `releasedAt` uses). An ISO date carries no zone of
# its own, so a client reading it as LOCAL midnight, or as milliseconds, lands
# a different number and fails here rather than silently storing a date nobody
# typed.
TARGET_ISO = "2026-09-01"
TARGET_SECONDS = 1788220800


class _ProposalRecordingStub:
    """A real HTTP server accepting the ONE POST `release-propose` makes, and
    RECORDING every request it is sent.

    Not the census's unreachable URL, and not a mock: the whole subject here is
    whether a request LEAVES the client at all, and an unreachable port cannot
    tell "argparse refused" from "the POST failed" -- both exit non-zero. A
    server that would have accepted the call, and saw nothing, can.
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
                if self.path.endswith("/release-proposals"):
                    proposal = {"label": (body or {}).get("label")}
                    if isinstance(body, dict) and "targetAt" in body:
                        proposal["targetAt"] = body["targetAt"]
                    self._answer(200, {"ok": True, "converged": False,
                                       "proposal": proposal, "warnings": []})
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
        so an ambient session cannot colour the envelope."""
        return {"CRUCIBLE_URL": self.base_url,
                "CRUCIBLE_BASE": self.base_url,
                "WORKFLOW_ROLE": "", "WORKFLOW_WAVE": ""}

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


_DRIVE_CACHE = None


def _get_drives():
    """Four real subprocess drives per client, cached at module scope exactly
    like the census's own drives:

    `help`     -- `<client> release-propose --help`, argparse's own published
                  surface (the AC's "driven from each client's real --help").
    `absent`   -- the call §S4 must refuse, with the stub watching the socket.
    `iso`      -- the same call declaring an ISO-8601 date.
    `epoch`    -- the same call declaring epoch SECONDS.

    Each drive keeps the RAW `CompletedProcess` (the exit code and stderr are
    part of an argparse refusal, not decoration), the decoded `axi` when there
    is one, and the requests the stub saw DURING that drive.
    """
    global _DRIVE_CACHE
    if _DRIVE_CACHE is not None:
        return _DRIVE_CACHE
    fake_bin_dir = _build_fake_bin_dir()
    toon_module = _load_toon_module()
    stub = _ProposalRecordingStub()
    cases = {
        "help": [RELEASE_PROPOSE, "--help"],
        "absent": [RELEASE_PROPOSE, "--label", LABEL, "--agent", "orc"],
        "iso": [RELEASE_PROPOSE, "--label", LABEL, TARGET_FLAG, TARGET_ISO,
                "--agent", "orc"],
        "epoch": [RELEASE_PROPOSE, "--label", LABEL, TARGET_FLAG,
                  str(TARGET_SECONDS), "--agent", "orc"],
    }
    drives = {}
    try:
        for client_key, script_path in CLIENT_FILES.items():
            project_dir = _make_project_dir(client_key)
            try:
                for case, argv in cases.items():
                    seen = len(stub.requests)
                    result = drive_verb(
                        script_path,
                        argv + ["--project-dir", str(project_dir)],
                        project_dir, fake_bin_dir, extra_env=stub.env())
                    _emits, axi = classify_envelope(result.stdout, toon_module)
                    drives[(client_key, case)] = {
                        "result": result, "axi": axi,
                        "requests": stub.requests[seen:],
                    }
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        stub.close()
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _DRIVE_CACHE = drives
    return drives


def _usage_block(help_stdout):
    """Argparse's own usage block -- everything up to the first blank line,
    with its wrapping collapsed so a flag that happened to land at a line
    break reads the same as one that did not."""
    head = (help_stdout or "").split("\n\n", 1)[0]
    return " ".join(head.split())


def _target_option_block(help_stdout):
    """The `--target` entry of the options section, with its continuation
    lines -- the text an agent actually reads before deciding whether to pass
    the flag. Returns "" when the flag is not documented at all."""
    lines = (help_stdout or "").split("\n")
    for index, line in enumerate(lines):
        if re.match(r"\s+--target\b", line):
            block = [line.strip()]
            for follow in lines[index + 1:]:
                if follow.strip() == "" or re.match(r"\s{0,4}-", follow):
                    break
                block.append(follow.strip())
            return " ".join(block)
    return ""


def _posted_bodies(drive):
    """The bodies of the proposal POSTs one drive made, in order."""
    return [body for method, path, body in drive["requests"]
            if method == "POST" and path.endswith("/release-proposals")]


class ReleaseProposeRequiresATargetInEveryClientTest(unittest.TestCase):
    """§S4 -- a release proposal declares its target date, or the call does not
    happen. Asserted through the five real client surfaces, because the flag is
    registered once and rendered five times.
    """

    @classmethod
    def setUpClass(cls):
        cls.drives = _get_drives()

    def test_the_fleet_is_five_clients_and_every_one_of_them_was_driven(self):
        """"The client count itself asserted (5)". Two halves, because a
        per-client census is only as wide as the list it iterates: the fleet IS
        five, and all five produced a real drive for every case. A client
        silently dropped from `CLIENT_FILES` would leave every other assertion
        in this file passing while covering four stacks."""
        self.assertEqual(
            len(CLIENT_FILES), 5,
            f"the fleet is FIVE clients (the census constant); "
            f"got {sorted(CLIENT_FILES)!r}")
        missing = [f"{client}:{case}"
                   for client in CLIENT_FILES
                   for case in ("help", "absent", "iso", "epoch")
                   if (client, case) not in self.drives]
        self.assertEqual(
            missing, [],
            f"every client owes a real drive of every case: {missing!r}")

    def test_every_client_publishes_target_as_a_required_flag_in_its_own_usage(self):
        """Argparse's own ground truth, read from the REAL `--help`: a required
        option appears bare in the usage line, an optional one appears inside
        square brackets. Driven per client because five subparsers render one
        registrar, and a fork in any one of them is invisible drift."""
        offenders = {}
        for client_key in CLIENT_FILES:
            drive = self.drives[(client_key, "help")]
            usage = _usage_block(drive["result"].stdout)
            if drive["result"].returncode != 0:
                offenders[client_key] = (
                    f"--help exited {drive['result'].returncode}")
            elif TARGET_FLAG not in usage:
                offenders[client_key] = f"usage names no {TARGET_FLAG}: {usage!r}"
            elif "[--target" in usage:
                offenders[client_key] = (
                    f"usage still declares {TARGET_FLAG} OPTIONAL: {usage!r}")
        self.assertEqual(
            offenders, {},
            f"every client must publish {TARGET_FLAG} as required on "
            f"{RELEASE_PROPOSE} -- the flag surface is where a caller learns "
            f"the rule: {offenders!r}")

    def test_no_client_still_documents_the_target_as_optional(self):
        """The help TEXT is the other half of that surface, and it currently
        says "Optional and revisable". A required flag whose own help calls
        itself optional teaches an agent to omit it and be refused -- the
        surface would be correct and the documentation would be a lie."""
        offenders = {}
        for client_key in CLIENT_FILES:
            block = _target_option_block(self.drives[(client_key, "help")]["result"].stdout)
            if block == "":
                offenders[client_key] = f"{TARGET_FLAG} is not documented at all"
            elif re.search(r"optional", block, re.IGNORECASE):
                offenders[client_key] = block
        self.assertEqual(
            offenders, {},
            f"no client may describe {TARGET_FLAG} as optional once it is "
            f"required: {offenders!r}")

    def test_every_client_refuses_a_targetless_release_propose_through_argparse(self):
        """The criterion itself, asserted PER CLIENT with the offenders named.
        Argparse's refusal has a shape of its own: exit 2, its own sentence on
        stderr naming the missing flag. Asserted as that shape rather than as a
        whole sentence, so the client keeps argparse's wording rather than
        this test choosing one."""
        offenders = {}
        for client_key in CLIENT_FILES:
            result = self.drives[(client_key, "absent")]["result"]
            stderr = result.stderr or ""
            if result.returncode != 2:
                offenders[client_key] = (
                    f"exit {result.returncode}, expected argparse's usage code 2")
            elif TARGET_FLAG not in stderr:
                offenders[client_key] = f"stderr names no {TARGET_FLAG}: {stderr!r}"
            elif not re.search(r"required", stderr, re.IGNORECASE):
                offenders[client_key] = (
                    f"stderr does not say the flag is required: {stderr!r}")
        self.assertEqual(
            offenders, {},
            f"{RELEASE_PROPOSE} with no {TARGET_FLAG} must be refused by "
            f"argparse in every client: {offenders!r}")

    def test_a_targetless_release_propose_never_reaches_the_wire(self):
        """"Refused client-side" is a claim about what did NOT leave the
        process, so it is measured at the socket: a stub that would have
        ACCEPTED the proposal, and was never asked. Without this, a client that
        posted the call and then complained would look identical to one that
        refused it."""
        offenders = {}
        for client_key in CLIENT_FILES:
            drive = self.drives[(client_key, "absent")]
            if drive["requests"]:
                offenders[client_key] = drive["requests"]
        self.assertEqual(
            offenders, {},
            f"a {RELEASE_PROPOSE} missing its target must reach no server at "
            f"all -- these clients sent it anyway: {offenders!r}")

    def test_every_client_still_posts_a_release_propose_that_declares_its_target(self):
        """The bound on the refusal: it refuses ABSENCE, and nothing else. A
        change that made the verb refuse every call, or that stopped sending
        the field it now demands, would pass every assertion above and break
        the verb -- so the accepted path is measured too, as exactly ONE POST
        carrying the wire body §S8 names."""
        offenders = {}
        for client_key in CLIENT_FILES:
            drive = self.drives[(client_key, "iso")]
            bodies = _posted_bodies(drive)
            if drive["result"].returncode != 0:
                offenders[client_key] = (
                    f"exit {drive['result'].returncode}, "
                    f"stderr={(drive['result'].stderr or '')[:200]!r}")
            elif len(bodies) != 1:
                offenders[client_key] = f"{len(bodies)} proposal POSTs: {bodies!r}"
            elif bodies[0] != {"label": LABEL, "targetAt": TARGET_SECONDS,
                               "agentId": "orc"}:
                offenders[client_key] = f"body {bodies[0]!r}"
        self.assertEqual(
            offenders, {},
            f"a {RELEASE_PROPOSE} that declares its target must still be "
            f"posted, once, by every client: {offenders!r}")

    def test_an_iso_date_and_epoch_seconds_reach_the_wire_as_one_integer(self):
        """An ISO date and an epoch-SECONDS value are two spellings of one
        instant, and the reading lives in the shared module -- so all five
        clients must land the SAME integer, and it must be the seconds one.
        A client reading the date as local midnight or as milliseconds lands a
        different number, which is a target nobody declared."""
        offenders = {}
        for client_key in CLIENT_FILES:
            landed = {}
            for case in ("iso", "epoch"):
                bodies = _posted_bodies(self.drives[(client_key, case)])
                landed[case] = bodies[0].get("targetAt") if len(bodies) == 1 and isinstance(bodies[0], dict) else None
            if landed["iso"] != TARGET_SECONDS or landed["epoch"] != TARGET_SECONDS:
                offenders[client_key] = landed
        self.assertEqual(
            offenders, {},
            f"both forms of the declared target must ride as the same epoch-"
            f"SECONDS integer {TARGET_SECONDS} in every client: {offenders!r}")


if __name__ == "__main__":
    unittest.main()
