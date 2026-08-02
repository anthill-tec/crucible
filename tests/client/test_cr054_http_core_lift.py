"""CR-CRU-054 C2 -- HTTP-core lift RED tests.

Pins the two contracts C2's dispatch brief names for this cycle's slice of
the client-fleet lift (docs/changes/CR-CRU-054-client-fleet-dry.md §S2/§S2b):

  A. THE LIFT: `_request`, `_post`, `_get`, `_patch`, `_abbrev_home` -- SHARED
     per docs/research/DN-client-fleet-inventory.md §1 (`_request` is also
     DRIFTED per §4 finding #7) -- must have their REAL logic (the
     `urllib.request`/`json` transport call, the `os.path.expanduser` home-dir
     collapse) live exactly once, in `clients/_crucible_axi.py`. No client may
     keep its own copy of that logic. Each client's own module must still
     expose WORKING, unqualified access under the SAME names
     (`_request`/`_post`/`_get`/`_patch`/`_abbrev_home`) -- the established
     CR-CRU-030 delegation pattern (`_axi_context`/`_emit_axi` keep a thin
     per-client `def` that forwards to the shared module; they are not
     deleted, their BODIES stop containing independent logic). Keeping the
     names is not optional: dozens of existing tests
     (tests/client/test_python_crucible_axi.py and siblings) do
     `mock.patch.object(self.module, "_post", ...)`, and every internal
     call site (`_post_gate`, `cmd_register`, ...) calls the client's own
     local `_post`/`_get`/`_patch`/`_request` unqualified -- §S4 requires
     those to keep passing UNMODIFIED, which is only possible if the local
     names survive the lift.
  B. THE §S2b DRIFT CORRECTION: `_request` must adopt arduino's tolerant
     empty-response-body handling (`{"ok": True}`) across ALL FIVE clients;
     today bun/rust/mvn/python raise an uncaught `json.JSONDecodeError`.

Test design note -- structural + functional assertions are DELIBERATELY
combined in one test per name (`test_request_transport_call_moves_out_of_...`,
`test_abbrev_home_path_logic_moves_out_of_...`) rather than split into a
"logic moved" test plus a separate "still works" test: the latter would pass
TODAY even before any lift happens (the current, unlifted implementation
already behaves correctly -- it just is not yet SHARED), which is not a valid
RED signal. Combining them means the test fails today for the real,
structural reason (the logic has not moved), and once GREEN satisfies that,
the SAME test goes on to exercise the delegated call end-to-end -- so it also
serves as GREEN's regression guard against a lift that moves the code but
breaks the client-facing contract while doing so.

ESCALATION -- `_project_key` EXCLUDED from this cycle's scope. The dispatch
brief named `_project_key` as part of the "HTTP core" to lift (+ `_abbrev_home`
"if C1 classed it SHARED"). `_abbrev_home` IS SHARED (DN §1) so it is
included below. `_project_key` is NOT SHARED -- DN §3 explicitly classifies
it GENUINELY PER-CLIENT: arduino's version delegates to its own `_load_env`,
which ALSO reads `CRUCIBLE_PROJECT_NAME` (needed for arduino's unique
`_ensure_project`/self-registration bootstrap, per
DN-crucible-api-reconstruction.md §4) and falls back to the ambient
environment, versus bun/rust/mvn/python's strict single-key `.env`-only read
with `sys.exit` on absence -- "a real, justified divergence... not a
candidate for a shared PARAMETERISED lift without also lifting
`_load_env`/`_ensure_project`, which is out of this CR's 42." The CR's own
Non-goals section excludes "the genuinely per-client logic" from any lift,
and `tests/client/test_cr054_fleet_inventory.py` (C1, committed) already
encodes `_project_key` in `GENUINELY_PER_CLIENT`, not `SHARED`. Per the AC
Cross-Check rule the DN -- the CR's own normative §S1 classification
deliverable -- wins over the dispatch brief's summary: no test below asserts
a single/shared definition for `_project_key`; it is untouched by this
cycle. Flagged for the orchestrator to confirm or correct.

RED: `clients/_crucible_axi.py` does not yet define any HTTP-core logic at
all (confirmed: `grep -n "urllib.request.urlopen(" clients/_crucible_axi.py`
returns nothing), and each of the five clients still carries the FULL,
independent implementation of `_request`/`_abbrev_home` (confirmed by
reading clients/{bun,rust,mvn,python,arduino}-crucible.py directly -- see
line refs in the classes below). Every test in this module fails today for
that reason -- a real production gap, not a harness bug. No production code
was moved to write this file.

Invocation:
    python3 -m pytest tests/client/test_cr054_http_core_lift.py -q
Fallback:
    python3 tests/client/test_cr054_http_core_lift.py
"""

import ast
import json
import sys
import unittest
import importlib.util
import urllib.error
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}
CLIENTS = tuple(CLIENT_FILES)


def _load_module_by_path(path, cache_key):
    """Load a module by file path, mirroring the fleet's own `_axi()`/`_toon()`
    loader pattern (importlib.util.spec_from_file_location) -- the same
    convention every existing client/shared-module test in this directory
    uses (test_crucible_axi_shared.py, test_python_crucible_axi.py)."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module(client):
    return _load_module_by_path(
        CLIENT_FILES[client], f"cr054_http_core_{client}_under_test")


def _function_source_segment(path, name):
    """AST-extract the exact source text of a top-level `def <name>` in
    `path` (ast.parse, not grep/eyeball -- mirrors
    test_cr054_fleet_inventory.py's method). Returns None if not defined as
    a top-level function at all (e.g. reduced to a module-level assignment)."""
    text = path.read_text()
    tree = ast.parse(text, filename=str(path))
    for node in tree.body:
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == name):
            return ast.get_source_segment(text, node)
    return None


def _clients_with_marker_in_function(name, marker):
    """Every client whose own top-level `def <name>` still contains `marker`
    literally -- i.e. still carries the REAL logic, not a delegator."""
    offenders = []
    for client, path in CLIENT_FILES.items():
        body = _function_source_segment(path, name)
        if body is not None and marker in body:
            offenders.append(client)
    return offenders


def _client_base_url(module):
    """Each client resolves its base URL from a differently-named module
    constant (bun/rust/mvn/python: CRUCIBLE_URL; arduino: CRUCIBLE) -- read
    it back dynamically rather than assume one name, so this test does not
    itself invent a fleet-wide rename that is out of C2's scope."""
    return getattr(module, "CRUCIBLE_URL", None) or getattr(module, "CRUCIBLE", None)


def _fake_response(body_bytes):
    """A stand-in for the object `urllib.request.urlopen(...)` returns --
    usable both as `urlopen(req).read()` (bun/rust/mvn/python's call shape)
    and as `with urlopen(req) as r: r.read()` (arduino's call shape)."""
    response = mock.MagicMock()
    response.read.return_value = body_bytes
    response.__enter__ = mock.Mock(return_value=response)
    response.__exit__ = mock.Mock(return_value=False)
    return response


def _raising_http_error(code=409, reason="Conflict", body=b"conflict detail"):
    def _raiser(*_args, **_kwargs):
        err = urllib.error.HTTPError("http://x", code, reason, {}, None)
        err.read = lambda: body
        raise err
    return _raiser


# ── Contract A -- the lift itself ───────────────────────────────────────────


class HttpCoreSingleLocusOfTruthTest(unittest.TestCase):
    """`_request`'s real transport logic and `_abbrev_home`'s real path logic
    must live in `clients/_crucible_axi.py` ONLY -- no client may keep its own
    copy. Each combined test below asserts the STRUCTURAL "no private copy"
    condition first (this is what fails TODAY, for the real reason: the lift
    has not happened) and, once that holds, goes on to prove the client's own
    name still delegates correctly -- the functional half never gets a chance
    to matter until the structural half is satisfied, so this file never
    carries a test that is vacuously green before any production change."""

    def test_request_transport_call_moves_out_of_every_client_and_still_works(self):
        """RED today: every client's own `_request` contains
        `urllib.request.urlopen(` directly (bun-crucible.py:162,
        rust-crucible.py:199, mvn-crucible.py:203, python-crucible.py:170,
        arduino-crucible.py:143) -- the real logic, not a delegator."""
        offenders = _clients_with_marker_in_function(
            "_request", "urllib.request.urlopen(")
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _request's REAL transport "
            f"call (urllib.request.urlopen) in their own source instead of "
            f"delegating to clients/_crucible_axi.py: {offenders!r}")

        # Structural condition satisfied (post-GREEN) -- now prove the
        # client's own _request still performs a correct request end-to-end.
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                base_url = _client_base_url(module)
                fake = _fake_response(b'{"ok": true, "agent": "A1"}')
                with mock.patch("urllib.request.urlopen",
                                 return_value=fake) as urlopen_mock:
                    result = module._request(
                        "POST", "/api/v2/agents/register", {"agentId": "A1"})
                self.assertEqual(
                    result, {"ok": True, "agent": "A1"},
                    f"{client}-crucible.py's _request must still return the "
                    f"parsed JSON response body after delegating")
                sent_request = urlopen_mock.call_args.args[0]
                self.assertEqual(sent_request.get_method(), "POST")
                self.assertEqual(
                    sent_request.full_url,
                    f"{base_url}/api/v2/agents/register",
                    f"{client}-crucible.py's _request must send the request "
                    f"to the resolved base URL + the given path")
                self.assertEqual(
                    json.loads(sent_request.data), {"agentId": "A1"},
                    f"{client}-crucible.py's _request must send the payload "
                    f"as the JSON request body")

                # The pre-existing HTTPError handling (SHARED, not part of
                # the §S2b carve-out) must also survive the lift unchanged.
                with mock.patch("urllib.request.urlopen",
                                 side_effect=_raising_http_error()):
                    error_result = module._request(
                        "POST", "/api/v2/agents/register", {"agentId": "A1"})
                self.assertEqual(
                    error_result,
                    {"ok": False, "error": "HTTP 409: conflict detail"},
                    f"{client}-crucible.py's _request must still convert an "
                    f"HTTPError into the structured "
                    f"{{'ok': False, 'error': ...}} result after delegating")

    def test_request_transport_call_lives_in_the_shared_axi_module(self):
        source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            "urllib.request.urlopen(", source,
            "clients/_crucible_axi.py must own the real HTTP transport call "
            "(urllib.request.urlopen) after the §S2 lift -- not present yet")

    def test_abbrev_home_path_logic_moves_out_of_every_client_and_still_works(self):
        """RED today: every client's own `_abbrev_home` contains
        `os.path.expanduser("~")` directly (confirmed identical bodies in
        bun/rust/mvn/python/arduino-crucible.py) -- the real logic, not a
        delegator."""
        offenders = _clients_with_marker_in_function(
            "_abbrev_home", 'os.path.expanduser("~")')
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _abbrev_home's REAL path "
            f"logic (os.path.expanduser) in their own source instead of "
            f"delegating to clients/_crucible_axi.py: {offenders!r}")

        home = "/home/fake-user-cr054"
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                with mock.patch("os.path.expanduser", return_value=home):
                    collapsed = module._abbrev_home(
                        f"{home}/Documents/repo/clients/x.py")
                    unchanged = module._abbrev_home("/opt/other/x.py")
                self.assertEqual(
                    collapsed, "~/Documents/repo/clients/x.py",
                    f"{client}-crucible.py's _abbrev_home must still "
                    f"collapse a path under the home directory after "
                    f"delegating")
                self.assertEqual(
                    unchanged, "/opt/other/x.py",
                    f"{client}-crucible.py's _abbrev_home must still leave "
                    f"a path outside the home directory unchanged")

    def test_abbrev_home_path_logic_lives_in_the_shared_axi_module(self):
        source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            'os.path.expanduser("~")', source,
            "clients/_crucible_axi.py must own the real home-dir-collapse "
            "logic (os.path.expanduser) after the §S2 lift -- not present yet")


class HttpCoreStdlibOnlyTest(unittest.TestCase):
    """Binding constraint (CR-CRU-054 §S2): `_crucible_axi.py` is loaded BY
    FILE PATH into five vendored, standalone client repos -- a third-party
    import would break every consumer on its next sync. Ties the check to
    the lift itself landing (the `assertIn` fails today, before any HTTP-core
    logic exists in the shared module, which is the correct RED reason) so
    this is not a guard that is born green with nothing new to prove."""

    def test_shared_module_gains_the_http_core_and_stays_stdlib_only(self):
        source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            "urllib.request.urlopen(", source,
            "the §S2 HTTP-core lift must land the real transport call in "
            "clients/_crucible_axi.py -- not present yet, confirming this "
            "cycle's production gap")
        tree = ast.parse(source, filename=str(AXI_MODULE_PATH))
        stdlib_names = set(getattr(sys, "stdlib_module_names", ()))
        offenders = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = alias.name.split(".")[0]
                    if root not in stdlib_names:
                        offenders.append(root)
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                if node.module:
                    root = node.module.split(".")[0]
                    if root not in stdlib_names:
                        offenders.append(root)
        self.assertEqual(
            offenders, [],
            f"clients/_crucible_axi.py must remain stdlib-only (vendored, "
            f"loaded by file path into consumer repos) -- found third-party "
            f"import(s): {offenders!r}")


# ── Contract B -- §S2b: _request's drift correction ─────────────────────────


class RequestToleratesEmptyResponseBodyDriftCorrectionTest(unittest.TestCase):
    """CR-CRU-054 §S2b -- `_request` DRIFTED (DN §4 finding #7): arduino's
    body-presence check (`json.loads(body) if body else {"ok": True}`) is the
    CORRECT version; bun/rust/mvn/python's
    `json.loads(urllib.request.urlopen(req, timeout=timeout).read())` raises
    an UNCAUGHT `json.JSONDecodeError` on the exact same empty-body response.
    The lift must give ALL FIVE clients arduino's tolerant behaviour --
    reached through every verb wrapper (_request directly, and _post/_get/
    _patch, which all funnel through it), so a fix that only patches
    _request's own top-level body but leaves a bypassing verb wrapper behind
    would still be caught.

    RED today: bun/rust/mvn/python (bun-crucible.py:162, rust ~199,
    mvn ~203, python-crucible.py:170) raise json.JSONDecodeError for this
    scenario -- confirmed by reading each `_request` body, and driven here
    through a stubbed HTTP layer (mock.patch on urllib.request.urlopen), not
    a source grep, so this is a REAL behavioural assertion. arduino already
    passes today (it is the correct one, DN §4 finding #7) -- that is
    expected and does not make the fleet-wide test vacuous, since the other
    four still fail it."""

    def _assert_tolerant(self, client, call):
        fake = _fake_response(b"")
        with mock.patch("urllib.request.urlopen", return_value=fake):
            try:
                result = call()
            except json.JSONDecodeError as exc:
                self.fail(
                    f"{client}-crucible.py raised {exc!r} on an empty "
                    f"response body instead of returning the corrected "
                    f"tolerant result (§S2b, arduino's verdict) -- this is "
                    f"the exact DN §4 finding #7 defect")
        self.assertEqual(
            result, {"ok": True},
            f"{client}-crucible.py must return {{'ok': True}} for an empty "
            f"response body (§S2b corrected behaviour), got {result!r}")

    def test_empty_response_body_via_request_directly(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                self._assert_tolerant(
                    client,
                    lambda m=module: m._request(
                        "GET", "/api/v2/some-empty-endpoint"))

    def test_empty_response_body_via_post(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                self._assert_tolerant(
                    client,
                    lambda m=module: m._post(
                        "/api/v2/agents/unregister", {"agentId": "A1"}))

    def test_empty_response_body_via_get(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                self._assert_tolerant(
                    client,
                    lambda m=module: m._get("/api/v2/projects/k/plans"))

    def test_empty_response_body_via_patch(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                self._assert_tolerant(
                    client,
                    lambda m=module: m._patch(
                        "/api/v2/projects/k/plans/1", {"status": "closed"}))


if __name__ == "__main__":
    unittest.main()
