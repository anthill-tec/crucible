"""The helpers of `test_a_scoped_gate_refuses_what_it_cannot_run.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json
import re
import shlex
import sys
from pathlib import Path

from tests.client.a_gate_milestone_carries_each_suite_result_helpers import (
    BUN_SUITE,
    EXCLUDED_SUITE,
    PYTHON_SUITE,
)
from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    declare_eda_entries,
)
from tests.client.every_verb_that_files_a_run_is_refused_while_a_cycle_is_active_helpers import (
    _seed,
)


GATE_VERB = "pre-merge-gate"

#: Per client: the gated targets its fixture declares, the one it declares
#: excluded, and one it does not declare. python declares nothing; its
#: "targets" are names a caller might try.
TARGETS = {
    "bun": {"gated": (BUN_SUITE, PYTHON_SUITE), "excluded": EXCLUDED_SUITE,
            "undeclared": "test:nowhere"},
    "mvn": {"gated": ("unit", "integration"), "excluded": "e2e",
            "undeclared": "module"},
    "rust": {"gated": ("unit", "integration"), "excluded": "e2e",
             "undeclared": "module"},
    "arduino": {"gated": ("junit-unit", "junit-integration"),
                "excluded": "junit-e2e", "undeclared": "junit-module"},
    "python": {"gated": ("tests/unit", "tests/integration"), "excluded": None,
               "undeclared": "tests/nowhere"},
    "go": {"gated": ("untagged", "integration"), "excluded": "e2e",
            "undeclared": "module"},
    "eda": {"gated": ("unit", "integration"), "excluded": "e2e",
             "undeclared": "module"},
}

#: The tier files a go module declares `integration` and `e2e` with, beside
#: the census module's one untagged test.
_GO_TIER_FILES = {
    f"{tier}_tier_test.go": (f"//go:build {tier}\n\npackage probe\n\n"
                             f"import \"testing\"\n\n"
                             f"func Test{tier.title()}Probe(t *testing.T) {{}}\n")
    for tier in ("integration", "e2e")
}


def _named(text, target):
    """True when `target` appears in `text` as a whole name — `unit` is not
    found inside `junit-unit`."""
    return re.search(r"(?<![\w/:.-])" + re.escape(target) + r"(?![\w/:.-])",
                     text) is not None

def _declare(client_key, project_dir):
    """The stack's own declaration of its two gated targets and the excluded
    one."""
    d = Path(project_dir)
    if client_key == "bun":
        python_suite = " ".join(shlex.quote(part) for part in (
            sys.executable, str(CLIENT_FILES["python"]), "regression",
            "--project-dir", str(d)))
        (d / "package.json").write_text(json.dumps({
            "name": "scoped-gate-refusal", "private": True,
            "scripts": {BUN_SUITE: "bun test tests", PYTHON_SUITE: python_suite,
                        EXCLUDED_SUITE: "bunx bddgen && bunx playwright test"}}))
    elif client_key == "mvn":
        profiles = "".join(f"<profile><id>{t}</id></profile>"
                           for t in ("unit", "integration", "e2e"))
        (d / "pom.xml").write_text(
            f"<project><profiles>{profiles}</profiles></project>")
    elif client_key == "rust":
        (d / ".config").mkdir(exist_ok=True)
        (d / ".config" / "nextest.toml").write_text("".join(
            f'[profile.{t}]\n\n[profile.{t}.junit]\npath = "junit.xml"\n\n'
            for t in ("unit", "integration", "e2e")))
    elif client_key == "arduino":
        (d / "tests" / "native" / "Makefile").write_text("".join(
            f"junit-{t}:\n\t@true\n" for t in ("unit", "integration", "e2e")))
    elif client_key == "python":
        # A source that does not compile: a gate whose step 0 ran would file
        # a compile result.
        _seed("python", GATE_VERB, d)
    elif client_key == "go":
        # go declares a tier by build tag: the gate's suites are `untagged`
        # and each declared tier, `e2e` declared and excluded.
        for name, text in _GO_TIER_FILES.items():
            (d / name).write_text(text)
    elif client_key == "eda":
        # eda declares an entry per suite: its gate runs each, `e2e` listed
        # and excluded.
        declare_eda_entries(d, ("unit", "integration", "e2e"))
