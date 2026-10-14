"""RED — the fleet's shared `run_verb` (`clients/_crucible_axi.py`) converts
only its six NAMED typed hard stops (`AgentIdentityRequired`,
`CycleSelectionRefused`, `TierRunUndeclared`, `ReleaseRunRefused`,
`UnattributedRunRefused`, `RunAbandoned` — read directly off its own
`except` chain) into the `ok:false` envelope. An `OSError` or a `ValueError`
escaping a verb's own body reaches none of those clauses, so it propagates
out of `run_verb` uncaught and `main()` prints a Python traceback instead of
an envelope. The no-argument dashboard (`cmd_dashboard`) never even reaches
`run_verb` — every client's `main()` calls `sys.exit(cmd_dashboard())`
directly (confirmed by reading all five `main()` bodies) — so the same
failure there is unconverted for a second, independent reason.

Driven through each client's own REAL `main()` (`module.main()` with
`sys.argv` patched — the fleet's own established in-process harness idiom,
e.g. `tests/client/test_python_crucible_axi.py::_run_main`), never a
replacement of `run_verb` itself. The injected seam is each client's own
module-level `_post` (for `register`) / `_get` (for the no-arg dashboard,
whose `cmd_status` issues exactly one `ops.get`) — the real HTTP-transport
calls the verb's own body genuinely makes (confirmed structurally identical
across all five clients by reading `cmd_register`/`_register_agent`/
`cmd_status`/`_ops()` in each `clients/*-crucible.py`), and the exact
monkeypatch idiom `tests/client/test_cr054_verb_surface_lift.py` already
uses for the same two names
(`mock.patch.object(module, "_post", side_effect=OSError(...))`). This is
NOT a claim that a real network failure raises these from `_post` today
(the fleet's own `_request` already turns a connection refusal into a
structured `{"ok": False, "error": ...}` rather than raising) — `run_verb`'s
fix is TYPE-based, not origin-based, so any genuine call site a verb's real
body makes is a valid probe of it.

A `register`/dashboard `--agent`/`--role`/`--project-dir` argv is built from
each client's OWN real argparse (`enumerate_verbs`/`build_argv`, imported
from `test_client_fleet_envelope_census.py`, never hand-listed) against a
real project fixture (`_make_project_dir`) carrying a valid
`CRUCIBLE_PROJECT_KEY`, so nothing here is refused before it reaches the
patched seam.

Every method below loops `CLIENT_FILES` with `subTest` and asserts
`len(CLIENT_FILES) == 5` first — a CENSUS, not a single client — so a sixth
client silently dropped from the loop fails loudly rather than passing
quietly.

No CR-shaped literal anywhere (agent ids below are plain lowercase words)."""

import contextlib
import io
import os
import shutil
import sys
import unittest
from unittest import mock

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _load_module,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    enumerate_verbs,
)

#: Each client's own project-dir env var (read directly off every
#: `_resolve_project_dir`/`_project_dir` docstring + body) — the ONLY
#: resolution path the no-argument dashboard has, since it carries no flags.
_PROJECT_DIR_ENV = {
    "python": "PY_CRUCIBLE_PROJECT_DIR",
    "bun": "BUN_CRUCIBLE_PROJECT_DIR",
    "rust": "RUST_CRUCIBLE_PROJECT_DIR",
    "mvn": "MVN_CRUCIBLE_PROJECT_DIR",
    "arduino": "ARDUINO_CRUCIBLE_PROJECT_DIR",
}


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched -> (code, stdout,
    stderr). The fleet's own established idiom (`_run_main` in every sibling
    client-axi test file) -- only `SystemExit` is caught, any OTHER
    exception (the uncaught traceback this file is about) propagates as a
    genuine unittest ERROR, which is itself a valid RED signal."""
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with mock.patch.object(sys, "argv", argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


def _envelope_naming(axi_fields, needle):
    """True iff `needle` appears anywhere in the envelope's own fields --
    deliberately format-agnostic (the spec states WHAT the error must name,
    "the exception's type and message", never the exact JSON shape), so this
    reads the whole result object rather than one presumed key."""
    return needle in repr(axi_fields)


class _EscapingFailureCase(unittest.TestCase):

    def setUp(self):
        self.assertEqual(
            len(CLIENT_FILES), 5,
            "the fleet census this file drives against has drifted from 5 "
            "clients -- update the loop, not just this assertion")
        self._scratch_dirs = []

    def tearDown(self):
        for d in self._scratch_dirs:
            shutil.rmtree(d, ignore_errors=True)

    def _project_dir(self, client_key):
        d = _make_project_dir(client_key)
        self._scratch_dirs.append(d)
        return d

    def _register_argv(self, client_key, project_dir):
        verbs = enumerate_verbs(client_key, CLIENT_FILES[client_key])
        return build_argv("register", verbs["register"], project_dir)

    def _drive_register(self, client_key, project_dir, exc, cache_tag):
        module = _load_module(CLIENT_FILES[client_key],
                              f"escaping_failure_register_{cache_tag}")
        argv = [CLIENT_FILES[client_key].name] + self._register_argv(
            client_key, project_dir)
        with mock.patch.object(module, "_post", side_effect=exc):
            return _run_main(module, argv)

    def _drive_dashboard(self, client_key, project_dir, exc, cache_tag):
        module = _load_module(CLIENT_FILES[client_key],
                              f"escaping_failure_dashboard_{cache_tag}")
        env_var = _PROJECT_DIR_ENV[client_key]
        with mock.patch.object(module, "_get", side_effect=exc), \
                mock.patch.dict(os.environ, {env_var: str(project_dir)}):
            return _run_main(module, [CLIENT_FILES[client_key].name])


class RegisterEscapingFailureBecomesEnvelopeTest(_EscapingFailureCase):
    """An escaping failure becomes an envelope -- `register`, the simplest
    verb every client exposes, driven
    with its own real `_post` raising first `OSError` then `ValueError`."""

    def test_oserror_from_post_becomes_ok_false_envelope_every_client(self):
        toon = _load_toon_module()
        for client_key in CLIENT_FILES:
            with self.subTest(client=client_key):
                project_dir = self._project_dir(client_key)
                code, out, err = self._drive_register(
                    client_key, project_dir,
                    OSError("connection reset by peer"),
                    f"{client_key}-oserror")
                self.assertNotIn(
                    "Traceback (most recent call last)", err,
                    f"{client_key}: an OSError escaped register() as a "
                    f"Python traceback instead of the ok:false envelope")
                emits, axi = classify_envelope(out, toon)
                self.assertTrue(
                    emits,
                    f"{client_key}: stdout did not decode as a TOON axi "
                    f"envelope at all -- {out!r}")
                assert axi is not None
                self.assertFalse(axi["ok"])
                self.assertNotEqual(code, 0)
                self.assertTrue(
                    _envelope_naming(axi, "OSError")
                    and _envelope_naming(axi, "connection reset by peer"),
                    f"{client_key}: envelope does not name the escaped "
                    f"exception's type and message -- {axi!r}")

    def test_valueerror_from_post_becomes_ok_false_envelope_every_client(self):
        toon = _load_toon_module()
        for client_key in CLIENT_FILES:
            with self.subTest(client=client_key):
                project_dir = self._project_dir(client_key)
                code, out, err = self._drive_register(
                    client_key, project_dir,
                    ValueError("malformed response body"),
                    f"{client_key}-valueerror")
                self.assertNotIn(
                    "Traceback (most recent call last)", err,
                    f"{client_key}: a ValueError escaped register() as a "
                    f"Python traceback instead of the ok:false envelope")
                emits, axi = classify_envelope(out, toon)
                self.assertTrue(
                    emits,
                    f"{client_key}: stdout did not decode as a TOON axi "
                    f"envelope at all -- {out!r}")
                assert axi is not None
                self.assertFalse(axi["ok"])
                self.assertNotEqual(code, 0)
                self.assertTrue(
                    _envelope_naming(axi, "ValueError")
                    and _envelope_naming(axi, "malformed response body"),
                    f"{client_key}: envelope does not name the escaped "
                    f"exception's type and message -- {axi!r}")


class DashboardEscapingFailureBecomesEnvelopeTest(_EscapingFailureCase):
    """The same for the dashboard -- the no-argument invocation, which
    `main()` routes to `cmd_dashboard()` WITHOUT ever calling `run_verb`."""

    def test_oserror_from_get_becomes_ok_false_envelope_every_client(self):
        toon = _load_toon_module()
        for client_key in CLIENT_FILES:
            with self.subTest(client=client_key):
                project_dir = self._project_dir(client_key)
                code, out, err = self._drive_dashboard(
                    client_key, project_dir,
                    OSError("network is unreachable"),
                    f"{client_key}-oserror")
                self.assertNotIn(
                    "Traceback (most recent call last)", err,
                    f"{client_key}: an OSError escaped the no-argument "
                    f"dashboard as a Python traceback instead of the "
                    f"ok:false envelope")
                emits, axi = classify_envelope(out, toon)
                self.assertTrue(
                    emits,
                    f"{client_key}: dashboard stdout did not decode as a "
                    f"TOON axi envelope at all -- {out!r}")
                assert axi is not None
                self.assertFalse(axi["ok"])
                self.assertNotEqual(code, 0)
                self.assertTrue(
                    _envelope_naming(axi, "OSError")
                    and _envelope_naming(axi, "network is unreachable"),
                    f"{client_key}: dashboard envelope does not name the "
                    f"escaped exception's type and message -- {axi!r}")

    def test_valueerror_from_get_becomes_ok_false_envelope_every_client(self):
        toon = _load_toon_module()
        for client_key in CLIENT_FILES:
            with self.subTest(client=client_key):
                project_dir = self._project_dir(client_key)
                code, out, err = self._drive_dashboard(
                    client_key, project_dir,
                    ValueError("could not decode response JSON"),
                    f"{client_key}-valueerror")
                self.assertNotIn(
                    "Traceback (most recent call last)", err,
                    f"{client_key}: a ValueError escaped the no-argument "
                    f"dashboard as a Python traceback instead of the "
                    f"ok:false envelope")
                emits, axi = classify_envelope(out, toon)
                self.assertTrue(
                    emits,
                    f"{client_key}: dashboard stdout did not decode as a "
                    f"TOON axi envelope at all -- {out!r}")
                assert axi is not None
                self.assertFalse(axi["ok"])
                self.assertNotEqual(code, 0)
                self.assertTrue(
                    _envelope_naming(axi, "ValueError")
                    and _envelope_naming(axi, "could not decode response JSON"),
                    f"{client_key}: dashboard envelope does not name the "
                    f"escaped exception's type and message -- {axi!r}")


if __name__ == "__main__":
    unittest.main()
