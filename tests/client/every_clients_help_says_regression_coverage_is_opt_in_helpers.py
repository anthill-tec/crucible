"""The helpers of `test_every_clients_help_says_regression_coverage_is_opt_in.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import argparse
import contextlib
import importlib.util
import io
import sys
from unittest import mock

from tests.client import TEST_INSTALL_CLIENTS


CLIENTS_DIR = TEST_INSTALL_CLIENTS


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_PARSERS = {}


def _root_parser(client):
    """The client's ROOT argparse parser, captured at the moment it parses.

    Mirrors `_root_parser` in `test_client_tier_verb_contract`: `main()` builds
    the parser inline, so `parse_args` is spied on, the bound `self` kept, and
    `SystemExit` raised before any verb is dispatched."""
    if client in _PARSERS:
        return _PARSERS[client]
    module = _load_module(CLIENTS_DIR / f"{client}-crucible.py",
                          f"{client}_crucible_under_test_coverage_opt_in_help")
    captured = {}

    def spy(self, args=None, namespace=None):
        captured.setdefault("root", self)
        raise SystemExit(0)

    with mock.patch.object(argparse.ArgumentParser, "parse_args", spy), \
            mock.patch.object(sys, "argv", [f"{client}-crucible.py", "status"]), \
            contextlib.redirect_stdout(io.StringIO()), \
            contextlib.redirect_stderr(io.StringIO()), \
            contextlib.suppress(SystemExit):
        module.main()
    root = captured.get("root")
    assert root is not None, f"{client}-crucible.py never parsed its arguments"
    _PARSERS[client] = root
    return root


def _subparsers_action(client):
    for action in _root_parser(client)._actions:
        if isinstance(action, argparse._SubParsersAction):
            return action
    raise AssertionError(f"{client}-crucible.py's root parser carries no verbs")


def _root_line(client, verb):
    """The verb's one-line summary in the ROOT `--help` listing — the `help=`
    given to `add_parser`, held on the sub-parsers action's pseudo-action."""
    for pseudo in _subparsers_action(client)._choices_actions:
        if pseudo.dest == verb:
            return pseudo.help or ""
    raise AssertionError(f"{client}-crucible.py lists no {verb!r} in its root help")


def _plain(text):
    """Lower-cased, backticks dropped, whitespace runs collapsed — a phrase is
    found whether or not it was typeset or wrapped."""
    return " ".join((text or "").replace("`", "").lower().split())
