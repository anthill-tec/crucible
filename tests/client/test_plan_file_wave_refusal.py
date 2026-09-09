"""CR-CRU-116 Integration AC -- the wave-scope refusal reaches an ORCHESTRATOR
through the client it actually uses.

The AC, verbatim: "An existing client flow proves it end to end: `plan-file`
for a CR in a non-active wave returns the refusal through the client envelope,
with the client's own non-zero exit."

Why a client test and not another server test. The refusal is asserted on the
plans route by tests/wave-single-active.test.ts, but no orchestrator calls that
route by hand -- they run `plan-file`, and between the route and the caller sit
two lossy seams. `http_request` FLATTENS an HTTP error to `"HTTP <code>:
<body>"`, so the server's structured refusal survives only as text; and
`cmd_plan_file`'s failure branch then chooses which of that text becomes AXI
fields. A refusal that is correct on the wire and empty in the envelope is a
refusal the fleet cannot act on, and only a test that drives the CLIENT can
tell the two apart.

Also CR-CRU-116 S3 -- "the refusal names the move that clears it". S3 is a
claim about what the CALLER receives, so it is asserted where the caller
receives it: the `help[]` the server derived must arrive in the envelope
intact, and the `code` must arrive beside it so a machine caller can branch on
WHICH rule refused rather than matching a sentence.

THE STUB IS AT THE TRANSPORT SEAM, not at `_post`. `urllib.request.urlopen` is
the seam the shared module's own docstring names as the one the client test
harnesses stub, and stubbing there leaves `http_request`'s real flattening --
the first of the two lossy seams -- under test. A stub at `_post` would hand
the client a dict this file had flattened by hand, and the test would then pass
whether or not the flattening it depends on still works that way.

The refusal body is the SERVER's, transcribed: `handlePlanFile` answers
`fail(400, waveScope.error, { code, help })` (src/v2.ts), the sentence is
`Store.waveScopeRefusal`'s and the steps are `waveHints.alreadyActive`'s
(src/hints.ts). Transcribed rather than derived, because a fixture that
recomputed the server's wording could never disagree with it.

Module-loading + HTTP-stubbing convention: the sibling
`test_bun_crucible_wave.py` harness in this same directory -- REPO_ROOT-relative
load of `clients/bun-crucible.py` (the in-repo SOURCE OF TRUTH), real argparse
dispatch through `module.main()`, and never a call to the live board.

Invocation:
    python3 -m pytest tests/client/test_plan_file_wave_refusal.py -q
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

# The refusal `handlePlanFile` answers when the target cr's wave is not the
# active one, transcribed from the server. Wave 6 holds CR-CRU-115's open plan;
# the caller is filing for a cr in wave 7.
ACTIVE_WAVE = "6"
OPEN_CR = "CR-CRU-115"
TARGET_CR = "CR-CRU-140"
REFUSAL_BODY = {
    "ok": False,
    "error": (f"wave {ACTIVE_WAVE} is already active: {OPEN_CR} has an open plan — "
              f"only one wave holds open work at a time"),
    "code": "already-active",
    "help": [
        f"close or abort {OPEN_CR}'s open plan first — wave {ACTIVE_WAVE} holds the "
        f"open work, and one wave is active at a time",
        f"or file this plan for a cr in wave {ACTIVE_WAVE}, the active wave",
    ],
}


def _load_bun_crucible_module():
    """Load clients/bun-crucible.py by file path (a hyphenated filename cannot
    be `import`ed) -- pointed at the REPO copy, the source of truth."""
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_wave_refusal", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched. Returns (exit_code, stdout,
    stderr). Only SystemExit is caught -- any other exception propagates so
    unittest reports it as an ERROR rather than a silent pass."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.object(sys, "argv", ["bun-crucible.py"] + argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                if e.code is None:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _refusing_urlopen(body):
    """A `urlopen` double that answers the plans POST the way the route does: an
    HTTP 400 whose body is the JSON refusal. `HTTPError` IS a readable file
    object, which is exactly what `http_request`'s handler reads."""
    def _urlopen(request, timeout=None):
        raise urllib.error.HTTPError(
            request.full_url, 400, "Bad Request", {},
            io.BytesIO(json.dumps(body).encode()))
    return _urlopen


class PlanFileWaveRefusalTest(unittest.TestCase):
    """`plan-file` for a cr in a non-active wave, end to end through the client."""

    PROJECT_KEY = "test-key-wave-refusal"

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-wave-refusal-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved = {k: os.environ.get(k)
                       for k in ("WORKFLOW_WAVE", "WORKFLOW_ROLE")}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _file_a_plan(self, body=REFUSAL_BODY):
        with mock.patch("urllib.request.urlopen", _refusing_urlopen(body)):
            return _run_main(self.module, [
                "plan-file", "--cr", TARGET_CR, "--title", "a later wave",
                "--cycle", "c1", "--wave", "7",
                "--agent", "test-agent", "--project-dir", self.tmpdir,
            ])

    def _envelope(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn("axi", decoded,
                      f"stdout must decode to a TOON envelope with a top-level "
                      f"'axi' key; got {decoded!r} from stdout={stdout_text!r}")
        return decoded["axi"]

    def test_the_refusal_returns_through_the_envelope_with_a_non_zero_exit(self):
        """The AC's two halves. A refused plan-file must not report success by
        exit code while the envelope says otherwise, and it must not report the
        refusal on stderr alone: an orchestrator scripting the fleet reads the
        exit code, and one reading the envelope reads `ok`."""
        code, out, err = self._file_a_plan()

        self.assertNotEqual(code, 0,
                            f"a refused plan-file must exit non-zero; "
                            f"stdout={out!r} stderr={err!r}")
        axi = self._envelope(out)
        self.assertEqual(axi.get("verb"), "plan-file")
        self.assertIs(axi.get("ok"), False)
        self.assertEqual(axi.get("cr"), TARGET_CR,
                         f"the failure envelope names the cr it could not file; "
                         f"got {axi!r}")

    def test_the_envelope_carries_the_code_the_server_declared(self):
        """S3, machine half. Two rules can refuse this write and they clear in
        different ways, so a caller must be able to tell WHICH refused without
        parsing an English sentence. Lifted from the server's body -- never
        re-derived client-side, which would be a second decision-maker for a
        rule the server owns."""
        _code, out, _err = self._file_a_plan()

        axi = self._envelope(out)
        self.assertEqual(axi.get("code"), "already-active",
                         f"the refusal's code must ride the envelope; got {axi!r}")

    def test_the_envelope_carries_the_move_that_clears_the_refusal(self):
        """S3, human half: "Each refusal carries `help[]` stating what would make
        the write legal." The server derived those steps and named the open
        plan blocking this one; the envelope must hand them over verbatim,
        because a refusal that only says no is a refusal the caller cannot
        act on."""
        _code, out, _err = self._file_a_plan()

        axi = self._envelope(out)
        self.assertEqual(axi.get("help"), REFUSAL_BODY["help"],
                         f"the server's help[] must arrive intact; got {axi!r}")

    def test_the_error_sentence_names_the_active_wave_and_its_open_cr(self):
        """The refusal's own content is the server's, and the legacy stderr line
        stays the human channel it always was -- the envelope is an ADDITION,
        not a replacement. Asserted so a future edit cannot quietly drop the
        line an orchestrator reads in a terminal."""
        _code, _out, err = self._file_a_plan()

        self.assertIn("ok=False", err)
        self.assertIn(f"wave {ACTIVE_WAVE} is already active", err)
        self.assertIn(OPEN_CR, err)

    def test_a_transport_failure_still_gets_an_actionable_envelope(self):
        """The other direction, and the reason `code` is conditional while
        `help` is not: a body that carries no structured refusal declares no
        code, and the client invents none. It still hands back the fleet's
        reachability step, so no failure path emits a refusal with nothing to
        do about it."""
        code, out, _err = self._file_a_plan(body={"not": "a refusal"})

        self.assertNotEqual(code, 0)
        axi = self._envelope(out)
        self.assertIs(axi.get("ok"), False)
        self.assertNotIn("code", axi,
                         f"no server code was declared, so none may be "
                         f"synthesised; got {axi!r}")
        self.assertTrue(axi.get("help"),
                        f"every refusal names a next move; got {axi!r}")


if __name__ == "__main__":
    unittest.main()
