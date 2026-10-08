"""`gate-respond` -- the argv it builds for `no-mistakes axi respond`, and its
flag surface across the fleet (§S1, G1-G3, AC1, AC7 flag-surface half).

Ground truth, measured directly from the five client scripts and the shared
`clients/_crucible_axi.py` module before this slice: NONE of the five clients
defines a `gate-respond` subcommand today -- grepping all five for the string
"gate-respond" returns zero matches, and `_crucible_axi.py` exposes
`cmd_gate_run`/`cmd_gate_report` but no `cmd_gate_respond` and no builder that
posts to `/api/v2/gate-decisions`. Every test below therefore fails against
today's tree because argparse itself refuses the subcommand ("invalid choice:
'gate-respond'") before any flag, argv or POST assertion is even reached --
real RED from a not-yet-existing verb, not an accident of harness wiring.

The spec's own words (quoted verbatim from the scope and gap-analysis
sections) pin the flag surface this file asserts:

  §S1 -- "Every client gains `gate-respond --agent <id> --action
  approve|fix|skip [--findings <id,...>] [--add-finding <JSON finding
  object>] [--instructions <text>] [--reason <text>] [--step <step>] [--wait
  <duration>]` (no `--yes`, G3)."

  G2 -- "`--action approve|fix|skip` (required), `--findings <id,...>`,
  `--add-finding <JSON finding object>` (ONE JSON object, not free text, and
  not repeatable), `--instructions`, `--reason` ..., `--step` ..., `--wait`,
  and `--yes` (auto-resolve later gates)." -- and `gate-respond` does NOT
  offer that last one (G3): "`gate-respond` does not offer `--yes`."

  G1 -- "`gate-respond` is `gate-run` with a different argv ... The shared
  runner inside `cmd_gate_run` is factored out once and both verbs use it;
  nothing is copied." -- i.e. the client passes its flags through to
  `no-mistakes axi respond` exactly as `cmd_gate_run` passes `--intent`
  (and, since CR-061-class §S5, `--skip`) through to `no-mistakes axi run`:
  unchanged, un-validated, un-reformatted.

This file does NOT assert anything about the gate-decision POST itself (the
HTTP contract, AC2/AC3/AC5/G6) -- that is the sibling
`test_gate_respond_records_a_decision.py`'s job, with its own fake
`no-mistakes` tuned to accepted/refused/held outcomes. This file's fake tool
always accepts immediately with one resolved final snapshot; the only things
under test here are (a) the argv `gate-respond` hands to the no-mistakes
process and (b) the flag surface's shape (present, documented, and --yes
absent/rejected) on every client.

Module-loading, `_run_main` and the fake-no-mistakes-on-PATH idiom are the
same REPO_ROOT-relative, by-file-path convention every sibling harness in
this directory already uses.

Invocation:
    python3 -m pytest tests/client/test_gate_respond_argv_and_flag_surface.py -q
Fallback:
    python3 tests/client/test_gate_respond_argv_and_flag_surface.py
"""

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}

# The declared flag surface, pinned verbatim from §S1/G2 above (minus --yes,
# which G3 forbids and gets its own dedicated-rejection test).
DECLARED_FLAGS = (
    "--action", "--findings", "--add-finding", "--instructions",
    "--reason", "--step", "--wait",
)


def _load_module_by_path(path, cache_key):
    if not path.exists():
        raise unittest.SkipTest(f"{path} not found")
    import importlib.util
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module(name):
    return _load_module_by_path(
        CLIENT_FILES[name], f"gate_respond_argv_{name}_under_test")


def _run_main(module, argv):
    prog = str(CLIENT_FILES.get("bun", "client"))
    full_argv = [prog] + argv
    stdout = io.StringIO()
    stderr = io.StringIO()
    # os.environ is restored on exit: arduino's main() exports $AGENT_ID from --agent for its
    # children, which would otherwise leak into every later test in this process.
    with mock.patch.object(sys, "argv", full_argv), mock.patch.dict(os.environ), \
         contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
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


def _assert_verb_recognized(testcase, err, client_name=""):
    """A bare non-zero-exit check would ALSO pass vacuously today -- nothing
    distinguishes 'rejected because the subcommand does not exist' from
    'rejected because the real verb refused this particular call'. Pinning
    the FAILURE MODE specifically is what makes this a guard against a
    vacuous pass rather than the assertion the test is actually about."""
    testcase.assertNotIn(
        "invalid choice", err,
        f"gate-respond must be a REGISTERED subcommand on {client_name!r}, "
        f"not rejected as an unknown one: {err!r}")
    testcase.assertNotIn(
        "unrecognized arguments", err,
        f"gate-respond's own flags must be recognized on {client_name!r}: {err!r}")


def _flag_values(tokens):
    """Pair up a flat `--flag value --flag2 value2 ...` token list into a
    dict. Every flag this file cares about takes exactly one value (none of
    `--action`/`--findings`/`--add-finding`/`--instructions`/`--reason`/
    `--step`/`--wait` is a boolean switch per §S1/G2's own grammar)."""
    values = {}
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("--") and i + 1 < len(tokens):
            values[tok] = tokens[i + 1]
            i += 2
        else:
            i += 1
    return values


# ---------------------------------------------------------------------------
# A minimal fake `no-mistakes`: ANY `axi respond`/`axi status` invocation
# accepts immediately with ONE resolved final snapshot (no interim ladder, no
# sleep) and captures the exact argv it was invoked with -- same lightweight
# shape as the sibling skip-passthrough harness's fake tool, extended with an
# `axi respond` branch instead of `axi run`.
# ---------------------------------------------------------------------------

_RELAY_MARKER = "gate-respond-argv-relay-marker"

_FINAL_SNAPSHOT = (
    'run:\n'
    '  id: "gate-respond-argv-run-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: abc1234\n'
    '  findings: 0\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    fix,completed,0,10\n'
    'outcome: passed\n'
)

_FAKE_NO_MISTAKES_BODY = f'''
import json
import os
import sys

argv = sys.argv[1:]

if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("respond", "status"):
    if argv[1] == "respond":
        argv_file = os.environ.get("GATE_RESPOND_FAKE_ARGV_FILE")
        if argv_file:
            with open(argv_file, "w") as f:
                json.dump(argv, f)
    sys.stdout.write({_FINAL_SNAPSHOT!r})
    sys.exit(0)
else:
    sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
    sys.exit(1)
'''


class _FakeNoMistakesOnPathMixin:
    def _install_fake_no_mistakes(self):
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="gate-respond-fake-nm-bin-")
        fake_path = os.path.join(self.fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        os.chmod(fake_path, 0o700)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

        self.argv_capture_dir = tempfile.mkdtemp(prefix="gate-respond-argv-capture-")
        self.argv_file = os.path.join(self.argv_capture_dir, "argv.json")
        os.environ["GATE_RESPOND_FAKE_ARGV_FILE"] = self.argv_file

    def _teardown_fake_no_mistakes(self):
        os.environ["PATH"] = self._saved_path
        os.environ.pop("GATE_RESPOND_FAKE_ARGV_FILE", None)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        shutil.rmtree(self.argv_capture_dir, ignore_errors=True)

    def _captured_argv(self):
        if not os.path.exists(self.argv_file):
            raise AssertionError(
                "the fake no-mistakes's `axi respond` branch was never "
                "invoked -- argv was not captured")
        with open(self.argv_file) as f:
            return json.load(f)


# ---------------------------------------------------------------------------
# Fleet-wide flag surface (AC7's flag-surface half; G3's --yes prohibition).
# ---------------------------------------------------------------------------

class GateRespondFlagSurfaceAcrossFleetTest(_FakeNoMistakesOnPathMixin, unittest.TestCase):
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self._install_fake_no_mistakes()
        self.tmpdir = tempfile.mkdtemp(prefix="gate-respond-fleet-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write("CRUCIBLE_PROJECT_KEY=test-key-gate-respond-fleet\n")
            # arduino's own `_load_env` additionally requires this; harmless
            # extra key for the other four clients.
            f.write("CRUCIBLE_PROJECT_NAME=gate-respond-fleet-test\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        self._teardown_fake_no_mistakes()

    def test_gate_respond_is_a_recognized_subcommand_accepting_a_minimal_call_on_every_client(self):
        offenders = {}
        for name in CLIENT_FILES:
            module = _load_client_module(name)
            argv = ["gate-respond", "--action", "approve", "--agent", "test-agent",
                    "--project-dir", self.tmpdir]
            with mock.patch.object(module, "_post",
                                   side_effect=lambda path, payload: {"ok": True}):
                _code, _out, err = _run_main(module, argv)
            if "invalid choice" in err or "unrecognized arguments" in err:
                offenders[name] = err
        self.assertEqual(
            offenders, {},
            f"gate-respond --action approve must be accepted on EVERY client; "
            f"rejected on: {offenders}")

    def test_gate_respond_help_documents_every_declared_flag_on_every_client(self):
        offenders = {}
        for name in CLIENT_FILES:
            module = _load_client_module(name)
            _code, out, err = _run_main(module, ["gate-respond", "--help"])
            help_text = out + err
            missing = [f for f in DECLARED_FLAGS if f not in help_text]
            if missing:
                offenders[name] = missing
        self.assertEqual(
            offenders, {},
            f"gate-respond --help must document every declared flag "
            f"{DECLARED_FLAGS} on every client; missing: {offenders}")

    def test_gate_respond_help_never_documents_yes_on_any_client(self):
        """G3 -- `gate-respond` offers no `--yes` at all (it would let
        no-mistakes resolve LATER gates itself, silently, which is the exact
        loss this feature exists to close). A client that still documents
        `--yes` on `gate-respond --help` has copied `axi respond`'s full flag
        set instead of the deliberately narrower one the spec requires.

        A bare "no --yes substring" check would ALSO pass vacuously today --
        `gate-respond --help` isn't even a registered subcommand yet, so its
        output is argparse's own "invalid choice" usage error, which
        obviously never mentions --yes either. Requiring the verb to be
        RECOGNIZED first is what makes this a genuine absence check instead
        of an accident of the verb not existing."""
        offenders = []
        unrecognized = []
        for name in CLIENT_FILES:
            module = _load_client_module(name)
            _code, out, err = _run_main(module, ["gate-respond", "--help"])
            help_text = out + err
            if "invalid choice" in help_text:
                unrecognized.append(name)
                continue
            if "--yes" in help_text:
                offenders.append(name)
        self.assertEqual(
            unrecognized, [],
            f"gate-respond must be a recognized subcommand on every client "
            f"for this absence check to mean anything; unrecognized on: "
            f"{unrecognized}")
        self.assertEqual(
            offenders, [],
            f"gate-respond --help must NEVER document --yes (G3); "
            f"documented on: {offenders}")

    def test_gate_respond_rejects_yes_as_an_unrecognized_argument_on_every_client(self):
        """The stronger half of G3: not merely undocumented, but genuinely
        REFUSED by argparse -- a user who tries it anyway cannot silently
        reach the auto-resolve behaviour the client is supposed to withhold."""
        offenders = {}
        for name in CLIENT_FILES:
            module = _load_client_module(name)
            argv = ["gate-respond", "--action", "approve", "--agent", "test-agent",
                    "--project-dir", self.tmpdir, "--yes"]
            with mock.patch.object(module, "_post",
                                   side_effect=lambda path, payload: {"ok": True}):
                _code, _out, err = _run_main(module, argv)
            if "unrecognized arguments" not in err:
                offenders[name] = err
        self.assertEqual(
            offenders, {},
            f"--yes must be REJECTED as an unrecognized argument on every "
            f"client (G3); did not reject on: {offenders}")

    def test_gate_respond_requires_action_on_every_client(self):
        """G2 -- `--action approve|fix|skip` is marked REQUIRED, unlike every
        other flag in the surface. Omitting it must not silently default to
        some action; argparse must refuse the call outright.

        A bare 'non-zero exit' check would ALSO pass vacuously today, for the
        WRONG reason: `gate-respond` itself is not yet a registered
        subcommand, so argparse already refuses every call regardless of
        --action. Pinning that the refusal is about omitted field ANALYSIS,
        not about the subcommand being unknown, requires the verb itself to
        be recognized first."""
        offenders = []
        unrecognized = []
        for name in CLIENT_FILES:
            module = _load_client_module(name)
            argv = ["gate-respond", "--agent", "test-agent", "--project-dir", self.tmpdir]
            with mock.patch.object(module, "_post",
                                   side_effect=lambda path, payload: {"ok": True}):
                code, _out, err = _run_main(module, argv)
            if "invalid choice" in err:
                unrecognized.append(name)
                continue
            if code == 0:
                offenders.append(name)
        self.assertEqual(
            unrecognized, [],
            f"gate-respond must be a recognized subcommand on every client "
            f"for this required-flag check to mean anything; unrecognized "
            f"on: {unrecognized}")
        self.assertEqual(
            offenders, [],
            f"gate-respond without --action must be refused (non-zero exit), "
            f"not silently accepted; accepted on: {offenders}")


# ---------------------------------------------------------------------------
# AC1 -- the argv `gate-respond` builds for `no-mistakes axi respond`, proven
# end-to-end through one real client's CLI dispatch (bun), mirroring the
# sibling skip-passthrough harness's own end-to-end class.
# ---------------------------------------------------------------------------

class GateRespondArgvPassthroughTest(_FakeNoMistakesOnPathMixin, unittest.TestCase):
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self._install_fake_no_mistakes()
        self.module = _load_client_module("bun")
        self.tmpdir = tempfile.mkdtemp(prefix="gate-respond-argv-e2e-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write("CRUCIBLE_PROJECT_KEY=test-key-gate-respond-argv-e2e\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        self._teardown_fake_no_mistakes()

    def test_every_given_flag_reaches_axi_respond_unchanged_and_omitted_ones_leak_no_default(self):
        """Both halves of the SAME passthrough invariant, in ONE test (the
        sibling skip-passthrough harness's own established pattern): a
        test that checked only the omission case would pass vacuously today
        (gate-respond isn't even a recognized subcommand yet, so of course no
        token reaches any argv), proving nothing. The positive half uses
        values a validating/reformatting client would corrupt -- a JSON
        object with internal spaces, finding ids with an embedded dash, a
        multi-word instruction/reason -- so passing byte-for-byte is the only
        way this half can succeed."""
        action = "fix"
        findings = "finding-7,finding-12"
        add_finding = '{"title": "missing null check", "severity": "high"}'
        instructions = "re-run the validator in --strict mode"
        reason = "flaky under load -- approved by the lead"
        step = "test"
        wait = "3m"

        calls = []

        def fake_post(path, payload):
            calls.append((path, payload))
            return {"ok": True, "changed": True, "decision": "dec-argv-test"}

        full_argv = ["gate-respond", "--agent", "test-agent", "--project-dir", self.tmpdir,
                     "--action", action, "--findings", findings,
                     "--add-finding", add_finding, "--instructions", instructions,
                     "--reason", reason, "--step", step, "--wait", wait]
        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, out, err = _run_main(self.module, full_argv)

        _assert_verb_recognized(self, err, "bun")
        self.assertEqual(code, 0, f"gate-respond must succeed against the fake "
                                   f"no-mistakes; stdout={out!r} stderr={err!r}")
        captured = self._captured_argv()
        self.assertEqual(
            captured[:2], ["axi", "respond"],
            f"gate-respond must proxy `no-mistakes axi respond`, got {captured}")
        fv = _flag_values(captured[2:])
        self.assertEqual(fv.get("--action"), action)
        self.assertEqual(fv.get("--findings"), findings)
        self.assertEqual(fv.get("--add-finding"), add_finding,
                         "the JSON finding object must reach axi respond as ONE "
                         "unchanged token, not re-encoded/re-ordered/split")
        self.assertEqual(fv.get("--instructions"), instructions)
        self.assertEqual(fv.get("--reason"), reason)
        self.assertEqual(fv.get("--step"), step)
        self.assertEqual(fv.get("--wait"), wait)
        self.assertNotIn("--yes", captured,
                         "gate-respond must never forward --yes to axi respond (G3)")
        self.assertNotIn("--agent", captured,
                         "--agent/--project-dir are THIS client's own flags, never "
                         "forwarded into the no-mistakes argv")
        self.assertNotIn("--project-dir", captured)
        # Exactly the 7 given flags (14 tokens) plus "axi respond" -- nothing
        # extra leaked in (e.g. a stray --yes, or a duplicated flag).
        self.assertEqual(
            len(captured), 2 + 14,
            f"the axi respond argv must carry EXACTLY the given flags and "
            f"nothing else, got {captured}")

        # -- negative half, same test: proves the omission case is a real
        # guard on the SAME client/verb, not an unreached branch above. --
        os.remove(self.argv_file)
        minimal_argv = ["gate-respond", "--agent", "test-agent",
                        "--project-dir", self.tmpdir, "--action", "approve"]
        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            code2, _out2, err2 = _run_main(self.module, minimal_argv)

        _assert_verb_recognized(self, err2, "bun")
        self.assertEqual(code2, 0, f"a minimal gate-respond (--action only) must "
                                    f"still succeed; stderr={err2!r}")
        captured_minimal = self._captured_argv()
        self.assertEqual(
            captured_minimal, ["axi", "respond", "--action", "approve"],
            f"omitting every optional flag must leak NO default token into "
            f"the axi respond argv, got {captured_minimal}")


if __name__ == "__main__":
    unittest.main()
