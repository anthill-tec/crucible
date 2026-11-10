"""The go client offers the six tier verbs through the shared registration.

`unit`, `module`, `integration`, `e2e` and `bdd` are registered by the shared
`add_tier_verbs` with go's `DeclaredTierSurface` (a tier is declared by
`//go:build <tier>` in a `_test.go` file that declares a test), and
`regression` moves onto the same registration as a wired verb that keeps its
flags. Each verb's help line is the shared `tier_verb_help`, carrying go's own
text where go wires the verb. `pre-merge-gate` stays where it is.

Read off the parser the go client's `main()` really builds, captured at its
one `parse_args()` call before any verb runs.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_go_client_offers_the_tier_verbs
"""

import argparse
import contextlib
import importlib.util
import inspect
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
GO_CLIENT = REPO_ROOT / "clients" / "go-crucible.py"
DECLARED = ("unit", "module", "integration", "e2e", "bdd")
SIX = DECLARED + ("regression",)
#: The flags every go tier verb carries.
TIER_VERB_FLAGS = ("--agent", "--cycle", "--release", "--module-dir", "--reports", "--log")
#: The flags `regression` keeps when it moves onto the shared registration.
REGRESSION_FLAGS = ("--agent", "--cycle", "--release", "--reports", "--log",
                    "--project-dir", "--coverage")


class _Captured(Exception):
    def __init__(self, parser):
        super().__init__("parser captured")
        self.parser = parser


def _go_module_and_parser():
    """`(module, root parser, registrations)`: `registrations` is the `funcs`
    mapping of every call `main()` made to the shared `add_tier_verbs`."""
    spec = importlib.util.spec_from_file_location("go_tier_verbs_under_test", GO_CLIENT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    shared = module._axi()
    real_add_tier_verbs = shared.add_tier_verbs
    registrations = []

    def spy(sub, funcs, **kwargs):
        registrations.append(dict(funcs))
        return real_add_tier_verbs(sub, funcs, **kwargs)

    def capture(self, *_args, **_kwargs):
        raise _Captured(self)

    with mock.patch.object(argparse.ArgumentParser, "parse_args", capture), \
            mock.patch.object(shared, "add_tier_verbs", spy), \
            mock.patch.object(sys, "argv", ["go-crucible.py"]), \
            contextlib.redirect_stdout(io.StringIO()), \
            contextlib.redirect_stderr(io.StringIO()):
        try:
            module.main()
        except _Captured as captured:
            return module, captured.parser, registrations
    raise AssertionError("go-crucible.py never parsed its arguments")


class TheGoClientOffersTheSixTierVerbsTest(unittest.TestCase):
    maxDiff = 4000

    @classmethod
    def setUpClass(cls):
        cls.module, root, cls.registrations = _go_module_and_parser()
        cls.axi = cls.module._axi()
        cls.sub = next(a for a in root._actions
                       if isinstance(a, argparse._SubParsersAction))
        cls.verbs = cls.sub.choices
        cls.help_lines = {a.dest: a.help for a in cls.sub._choices_actions}

    def options(self, verb):
        self.assertIn(verb, self.verbs, f"the go client's verbs: {sorted(self.verbs)!r}")
        return {o for a in self.verbs[verb]._actions for o in a.option_strings}

    def test_the_parser_offers_all_six_tier_verbs_and_keeps_the_gate(self):
        self.assertEqual(sorted(set(SIX) - set(self.verbs)), [],
                         f"the go client's verbs: {sorted(self.verbs)!r}")
        self.assertEqual(sorted(SIX), sorted(self.axi.TIER_MEANINGS),
                         "the six are the shared vocabulary")
        self.assertIn("pre-merge-gate", self.verbs)

    def test_each_declared_tier_verb_is_the_shared_declared_tier_handler(self):
        for tier in DECLARED:
            with self.subTest(tier=tier):
                self.assertIn(tier, self.verbs, f"the go client's verbs: {sorted(self.verbs)!r}")
                func = self.verbs[tier].get_default("func")
                self.assertEqual(getattr(func, "__name__", None), "_run_declared_tier",
                                 f"{tier}: registered by the shared add_tier_verbs as a "
                                 f"declared cell; got {func!r}")
                surface = inspect.getclosurevars(func).nonlocals.get("surface")
                line = self.axi.declared_tier_surface_line(surface, tier)
                self.assertIn(f"//go:build {tier}", line,
                              f"{tier}: the surface names the build tag; {line!r}")
                self.assertIn("_test.go", line, f"{tier}: and the file it goes in; {line!r}")

    def test_regression_is_wired_through_the_shared_registration(self):
        self.assertEqual(len(self.registrations), 1,
                         f"main() calls the shared add_tier_verbs once; "
                         f"{self.registrations!r}")
        funcs = self.registrations[0] if self.registrations else {}
        self.assertEqual(sorted(funcs), ["regression"],
                         f"go wires regression and declares the other five; {funcs!r}")
        wired = funcs.get("regression")
        self.assertIs(getattr(wired, "func", None), self.module.cmd_regression,
                      f"regression runs go's own cmd_regression; {wired!r}")
        self.assertIs(self.verbs["regression"].get_default("func"),
                      self.module.cmd_regression)

    def test_each_help_line_is_the_shared_tier_verb_help(self):
        """Each declared verb's help opens with the shared meaning, and goes on
        in go's own words: a tier is declared by build tag. The shared line
        for a cell with no declaration ("No target for it is declared on this
        stack") would say go declares no tier, which the help no longer
        says."""
        meanings = self.axi.TIER_MEANINGS
        for tier in DECLARED:
            with self.subTest(tier=tier):
                line = self.help_lines.get(tier) or ""
                prefix = f"{tier.upper()} tier — {meanings[tier]}. "
                self.assertTrue(line.startswith(prefix),
                                f"{tier}: the shared meaning opens the line; {line!r}")
                self.assertNotIn("no target for it is declared", line.lower(),
                                 f"{tier}: the help does not say go declares no tier; "
                                 f"{line!r}")
                self.assertRegex(line[len(prefix):], r"//go:build|build tag",
                                 f"{tier}: go's own text names the build-tag "
                                 f"declaration; {line!r}")
        regression = self.help_lines.get("regression") or ""
        prefix = f"REGRESSION tier — {meanings['regression']}. "
        self.assertTrue(regression.startswith(prefix),
                        f"regression's help is the shared line; {regression!r}")
        own = regression[len(prefix):]
        self.assertIn("go test", own, f"carrying go's own text; {regression!r}")

    def test_each_declared_tier_verb_carries_the_tier_verb_flags(self):
        for tier in DECLARED:
            with self.subTest(tier=tier):
                self.assertEqual(sorted(set(TIER_VERB_FLAGS) - self.options(tier)), [],
                                 f"{tier}: {sorted(self.options(tier))!r}")

    def test_regression_keeps_its_flags(self):
        """PIN — passes today, and is kept as the guard on the move: migrating
        `regression` onto the shared registration without its own flags (the
        shared declared-cell flag set has no `--coverage` and no
        `--project-dir` of its own) fails it."""
        self.assertEqual(sorted(set(REGRESSION_FLAGS) - self.options("regression")), [],
                         f"regression: {sorted(self.options('regression'))!r}")


if __name__ == "__main__":
    unittest.main()
