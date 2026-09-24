"""RED/KEPT — CR-CRU-098 C1: the NEXT start template survives the move,
adapted from `test_plan_file_declares_each_cycle_kind.py`'s
`SuggestedInvocationTemplatesTeachTheMandatedFormTest.test_the_next_start_
template_files_a_plan_under_the_mandate` / `.test_both_templates_teach_the_
same_form` (CR-CRU-127 §S6).

Spec: docs/changes/CR-CRU-098-the-plan-pointer-has-no-publisher.md AC10
Classification: docs/changes/CR-CRU-098-test-classification.md (census)

WHY THIS FILE EXISTS. Both ported tests call `AXI._next_start_help(...)`
directly to get the START template, then DRIVE it through the real
`plan-file` verb to prove the template is one the CR-127 mandate actually
ACCEPTS (kinded cycles, not merely a string that looks right). `_next_start_
help` is deleted from the client by AC10 — the template moves to `src/next.ts`
and is published as `help[0]` of a NEXT decision (proved byte-identical to
today's Python output by `tests/next-resolver.test.ts`'s AC5 group, via a live
subprocess cross-check). This file keeps the DRIVE-THROUGH-plan-file half —
which is not testable from bun, `plan-file` being a Python verb — sourcing the
template from a LOCAL, independently-stated reconstruction of the mandated
format instead of the soon-removed function.

THE CROSS-CHECK BELOW (`test_the_reconstruction_matches_next_start_help_
today`) is a REGRESSION PIN, not new behaviour under test: it proves, while
`_next_start_help` still exists, that the reconstruction below is not a
drifted guess. It PASSES today (a fixture/invariant guard — see the CR-092
suite's own precedent for this shape of test in its RED docstring) and — per
this CR's AC10 — GREEN C1/C2 must DELETE this one cross-check test (not the
whole file) when `_next_start_help` is removed, because its subject is gone;
the other two tests below have no such dependency and survive unedited.

AC13 — every fixture is synthetic (`CR-NEXTPTR-*`, registered in
tests/project-namespace-tripwire.test.ts's SYNTHETIC_NAMESPACES).

Invocation:
    python3 -m pytest tests/client/test_cr098_next_start_template_survives_the_move.py -q
"""

import copy
import importlib.util
import shlex
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(AXI_MODULE_PATH, "cr098_template_axi_under_test")

FIRST_LABEL, FIRST_KIND = "the verify sweep", "verify"
SECOND_LABEL, SECOND_KIND = "the follow-up repair", "fix"
CR = "CR-NEXTPTR-TEMPLATE"
WAVE = "7"
AGENT = "cr098-template-probe"

_PLACEHOLDERS = {
    "<brief>": "a plan", "<c1>": FIRST_LABEL, "<c2>": SECOND_LABEL,
    "<k1>": FIRST_KIND, "<k2>": SECOND_KIND, "<agentId>": AGENT,
}


def _expected_next_start_template(cr, wave):
    """The EXACT literal `_next_start_help` built
    (clients/_crucible_axi.py:2392-2402 at 7f2a85c; deleted by this CR, the
    template is now `nextHints.start`, src/hints.ts:503-510), reconstructed
    independently — this
    is the format `src/next.ts` must publish verbatim as `help[0]` for a NEXT
    decision (CR-107 §S1's mandate: `--cycle`, never `--cycles`)."""
    step = (f'plan-file --cr {cr} --title "<brief>" '
            f'--cycle "<c1>" --cycle-kind <k1> '
            f'--cycle "<c2>" --cycle-kind <k2> --agent <agentId>')
    if wave:
        step += f" --wave {wave}"
    return step


def _substituted(template):
    """`shlex.split`, with every `<placeholder>` swapped for its concrete
    value — the same non-vacuity gate the original file's `_drive_template`
    used, kept narrow: a template spelling a placeholder this file does not
    know fails LOUDLY rather than filing a literal `<c1>`."""
    tokens = shlex.split(template)
    unknown = sorted({t for t in tokens if t.startswith("<") and t.endswith(">")
                      and t not in _PLACEHOLDERS})
    assert not unknown, f"template spells unknown placeholders: {unknown!r}"
    return [_PLACEHOLDERS.get(t, t) for t in tokens]


def _args_from_template(argv):
    """`plan-file`'s argv, parsed by HAND into the Namespace shape
    `plan_file_cycle_entries` and `cmd_plan_file` read (`args.cr`, `args.cycle`
    (repeatable), `args.cycle_kind` (repeatable, paired by position),
    `args.title`, `args.wave`) — never through argparse, so this file has no
    dependency on the shared registrar's own wiring, which is a different
    concern (`test_cr054_fleet_inventory.py`'s census owns that)."""
    values = {"cr": None, "title": None, "cycle": [], "cycle_kind": [],
              "cycles": None, "release": None, "wave": None, "agent": None}
    i = 1  # argv[0] is the verb name ("plan-file")
    while i < len(argv):
        flag = argv[i]
        if flag == "--cr":
            values["cr"] = argv[i + 1]
            i += 2
        elif flag == "--title":
            values["title"] = argv[i + 1]
            i += 2
        elif flag == "--cycle":
            values["cycle"].append(argv[i + 1])
            i += 2
        elif flag == "--cycle-kind":
            values["cycle_kind"].append(argv[i + 1])
            i += 2
        elif flag == "--wave":
            values["wave"] = argv[i + 1]
            i += 2
        elif flag == "--agent":
            values["agent"] = argv[i + 1]
            i += 2
        else:
            raise AssertionError(f"unrecognised flag in template argv: {flag!r}")
    from argparse import Namespace
    return Namespace(**values)


def _drive(template):
    """Runs the REAL `cmd_plan_file` over a template's substituted argv, with
    the POST mocked (never a live board) → `(ok, cycles_posted)`."""
    argv = _substituted(template)
    args = _args_from_template(argv)
    posted = []

    def fake_post(path, payload):
        posted.append(copy.deepcopy(payload))
        return {"ok": True, "planId": 1, "cr": args.cr, "status": "open",
                "cycles": [{"label": FIRST_LABEL, "id": 7}]}

    ops = AXI.ClientOps(
        get=lambda path: {"ok": False},
        post=fake_post,
        patch=lambda path, payload: {"ok": True},
        emit=lambda *a, **kw: None,
        context=lambda project_dir, **kw: {},
        agent_id=lambda args: AGENT,
        project_key=lambda project_dir: "cr098-template-key",
        plans_path=lambda project_dir: "/api/v2/projects/cr098-template-key/plans",
        open_plans=lambda project_dir: [],
        resolve_plan=lambda *a, **kw: None,
        post_gate=lambda *a, **kw: {"ok": True},
        post_milestone=lambda *a, **kw: {"ok": True},
        base_url="http://127.0.0.1:0")
    code = AXI.cmd_plan_file(args, "/fake/dir", ops)
    return code, posted


class TheNextStartTemplateFilesAPlanUnderTheMandateTest(unittest.TestCase):
    """CR-127 §S6 — the START template `next`'s NEXT decision hands back is a
    `plan-file` invocation the kinded-cycle mandate ACCEPTS, never a string
    that merely looks right."""

    # CR-CRU-098 C3: the `_next_start_help` regression pin was deleted here — AC10 removed its subject.

    def test_the_next_start_template_files_a_plan_under_the_mandate(self):
        template = _expected_next_start_template(CR, WAVE)
        self.assertNotIn(
            "--cycles ", template,
            "the template must not hand back the legacy comma-split form "
            "\u00a7S4a refuses")
        code, posted = _drive(template)
        self.assertEqual(
            code, 0,
            f"the template must teach a command the mandate ACCEPTS; "
            f"template={template!r}")
        self.assertEqual(len(posted), 1, f"exactly one plans POST; got {posted!r}")
        cycles = posted[0].get("cycles") or []
        self.assertGreaterEqual(
            len(cycles), 2,
            f"the START template teaches the shape of a whole plan; got "
            f"{cycles!r}")
        self.assertTrue(
            cycles and all(c.get("kind") for c in cycles),
            f"every cycle the template files must carry a declared kind; "
            f"got {posted[0]!r}")

    def test_both_the_shared_refusal_template_and_the_next_start_template_teach_the_same_form(self):
        """DRIFT-1's actual finding, re-pinned: the template exists twice
        (`AXI.CYCLE_FLAG_TEMPLATE` and the NEXT start template), and both must
        repeat `--cycle`/`--cycle-kind` the same number of times — a shared
        constant on one side and a hand-built string on the other is exactly
        how the two drift apart silently."""
        start = _expected_next_start_template(CR, WAVE)
        for flag in ("--cycle", "--cycle-kind"):
            with self.subTest(flag=flag):
                shared_count = shlex.split(AXI.CYCLE_FLAG_TEMPLATE).count(flag)
                self.assertGreaterEqual(shared_count, 2)
                self.assertEqual(
                    shared_count, shlex.split(start).count(flag),
                    f"both suggested-invocation templates must teach the "
                    f"same form; `{flag}` appears a different number of "
                    f"times in CYCLE_FLAG_TEMPLATE="
                    f"{AXI.CYCLE_FLAG_TEMPLATE!r} and in the NEXT start "
                    f"template={start!r}")


if __name__ == "__main__":
    unittest.main()
