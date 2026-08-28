"""RED — CR-CRU-091 C3: the five roadmap-registration verbs across the fleet.

The verbs (§S3): `release-propose`, `cr-plan`, `wave-sequence`, `cr-supersede`
and `cr-void`. The implementation lands ONCE in `clients/_crucible_axi.py`
(the CR-CRU-054 DRY rule) and each of the five clients wires a subparser that
delegates — so EVERY behavioural assertion in this file is driven through all
five clients. That is not redundancy: §S6's own words are "no business rule
lives in a client and no two clients may decide differently", and the only way
to falsify that is to ask all five the same question and demand one answer.

What is asserted here, and where it comes from:

- **§S6 — the client ASKS** (AC11). A `cr-plan` missing `--release` or
  `--wave` never reaches the server: the client resolves it, emits an
  `ok:false` envelope on STDOUT with exit 2 carrying `needs`, the live
  `releases[]` candidates (read from `GET …/release-proposals`) and pre-filled
  `help[]` templates, and POSTs NOTHING. All three states are covered — some
  proposals, none at all (the definitive empty state, P5), and exactly one
  proposal with exactly one wave (which still asks: silent inference is the
  failure class the design removes).
- **§S8 — the wire** (AC20). Each verb POSTs the exact method, path and body
  §S8 names, asserted against a RECORDING STUB so it holds with no live
  server. The bodies are §S8's fields plus the one caller-identity field
  `requireRegisteredCaller` reads (`agentId`) and nothing else.
- **§S8 "Settled during C2"**. `warnings[]` members are STRUCTURED objects and
  ride the envelope verbatim; the client keys on `ok` + `converged`, never on
  a status code; the GET answers `{ok, proposals[{label,targetAt?,timestamp,
  waves[]}], totalCount}` and emits NO `status` field — the CLIENT labels a
  candidate live, because every returned proposal is live by construction.
- **§S7 — `converged`** rides every envelope, success or failure.
- **§S3/AC16 — ORCHESTRATOR only.** An unregistered caller and a wrong-role
  caller each produce a structured envelope on stdout naming the required
  role, with a non-zero exit.
- **§S10 — AXI conformance** (AC19), the half a stub can prove: `--fields`
  narrows, `--full` defeats truncation, `totalCount` rides every envelope,
  every failure envelope carries a state-derived `help[]`, and a refusal goes
  to STDOUT with exit 2 (usage) or 1 (transport/refusal), never bare prose on
  stderr. The other half — presence and the live envelope census over all 25
  (verb × client) pairs — extends the two existing fleet harnesses
  (`test_cr054_fleet_inventory.py`, `test_client_fleet_envelope_census.py`).
- **§S2/AC17 — `--track` is passed through VERBATIM.** The SERVER normalises
  `2` / `track-2` / `Track 2` to `track-<n>`; a client re-implementing that
  normalisation is the second decision-maker §S9 forbids, so the assertion is
  that the caller's spelling reaches the wire untouched.
"""

import ast
import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
TOON_PATH = CLIENTS_DIR / "toon.py"

CLIENT_FILES = {
    "python": CLIENTS_DIR / "python-crucible.py",
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}

PROJECT_KEY = "cr091-roadmap-key"

# §S8 — the five routes, as the client must address them.
PROPOSALS_PATH = f"/api/v2/projects/{PROJECT_KEY}/release-proposals"
PLAN_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue/plan"
SEQUENCE_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue/sequence"


def _lifecycle_path(cr, verb):
    return f"/api/v2/projects/{PROJECT_KEY}/queue/{cr}/{verb}"


# The env keys the fleet's `context` block reads — cleared so an ambient
# orchestrator session can never colour an envelope this file asserts on.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_PROJECT_NAME")


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke `module.main()` with sys.argv patched → (code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with mock.patch.object(sys, "argv", ["client"] + argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


def _proposals_response(*proposals):
    """The §S8 shape of `GET …/release-proposals`: no `status` field (every
    returned proposal is live by construction — the CLIENT labels them)."""
    return {"ok": True, "proposals": list(proposals), "totalCount": len(proposals)}


def _proposal(label, waves=(), target_at=None):
    row = {"label": label, "timestamp": 1787149125000, "waves": list(waves)}
    if target_at is not None:
        row["targetAt"] = target_at
    return row


class _RoadmapVerbTestBase(unittest.TestCase):
    """Drives ONE client's real `main()` in-process with `_post`/`_get`
    replaced by recording stubs — the fleet's established harness idiom
    (`test_queue_file_verb.py`), and exactly the "recording stub" AC20 asks
    for so the wire is asserted with no live server."""

    CLIENT = None

    @classmethod
    def setUpClass(cls):
        if cls.CLIENT is None:
            raise unittest.SkipTest("abstract base")

    def setUp(self):
        self.module = _load_module(CLIENT_FILES[self.CLIENT],
                                   f"cr091_{self.CLIENT}_under_test")
        self.toon = _load_module(TOON_PATH, "cr091_toon_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix=f"cr091-{self.CLIENT}-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            # arduino's `_load_env` requires the name too; harmless elsewhere.
            fh.write("CRUCIBLE_PROJECT_NAME=cr091-roadmap-project\n")
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ── driving ────────────────────────────────────────────────────────────

    def drive(self, argv, post_return=None, get_return=None):
        """Run the verb with recording `_post`/`_get`. Returns
        (code, axi, post_mock, get_mock)."""
        post_return = post_return if post_return is not None else {"ok": True}
        get_return = get_return if get_return is not None else _proposals_response()
        argv = argv + ["--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_post", return_value=post_return,
                               create=True) as post_mock, \
                mock.patch.object(self.module, "_get", return_value=get_return,
                                  create=True) as get_mock, \
                mock.patch.object(self.module, "_patch", return_value=None,
                                  create=True):
            code, out, err = _run_main(self.module, argv)
        self.stdout_text, self.stderr_text = out, err
        return code, self.decode(out), post_mock, get_mock

    def decode(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIsInstance(
            decoded, dict,
            f"stdout must decode as a TOON document; got {stdout_text!r}")
        self.assertIn(
            "axi", decoded,
            f"stdout must carry the fleet's §S1 TOON-AXI envelope (P1); "
            f"got {stdout_text!r}")
        return decoded["axi"]

    def post_call(self, post_mock, path):
        for call in post_mock.call_args_list:
            args, kwargs = call
            called = args[0] if args else kwargs.get("path")
            if called == path:
                return call
        return None

    def assert_posted(self, post_mock, path):
        call = self.post_call(post_mock, path)
        self.assertIsNotNone(
            call,
            f"{self.CLIENT}: the verb must POST to {path} (§S8's wire); "
            f"calls={post_mock.call_args_list!r}")
        return call[0][1]

    def assert_no_post(self, post_mock):
        self.assertEqual(
            post_mock.call_args_list, [],
            f"{self.CLIENT}: nothing may reach the server — the client "
            f"resolved this call itself (§S6); "
            f"calls={post_mock.call_args_list!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S8 / AC20 — the wire: exact method, path and body
# ═══════════════════════════════════════════════════════════════════════════


class _WireTests:
    """AC20 — "the two halves meet exactly at §S8". Each body is §S8's own
    field set plus `agentId`, the one caller-identity field
    `requireRegisteredCaller` reads — and NOTHING else, so a client that
    smuggles an extra field or invents a path fails here without a server."""

    def test_release_propose_posts_the_S8_body_to_the_S8_path(self):
        _code, _axi, post_mock, _get = self.drive(
            ["release-propose", "--label", "0.4.0", "--agent", "orc"],
            post_return={"ok": True, "converged": False,
                         "proposal": {"label": "0.4.0"}})
        body = self.assert_posted(post_mock, PROPOSALS_PATH)
        self.assertEqual(
            body, {"label": "0.4.0", "agentId": "orc"},
            f"{self.CLIENT}: release-propose's body is §S8's {{label, targetAt?}} "
            f"plus agentId; got {body!r}")

    def test_release_propose_target_rides_as_epoch_seconds_named_targetAt(self):
        _code, _axi, post_mock, _get = self.drive(
            ["release-propose", "--label", "0.4.0", "--target", "2026-09-01",
             "--agent", "orc"],
            post_return={"ok": True, "converged": False,
                         "proposal": {"label": "0.4.0", "targetAt": 1788220800}})
        body = self.assert_posted(post_mock, PROPOSALS_PATH)
        self.assertEqual(
            body, {"label": "0.4.0", "targetAt": 1788220800, "agentId": "orc"},
            f"{self.CLIENT}: `--target` is stored as `targetAt` in epoch "
            f"SECONDS (§S1 — the unit `releasedAt` uses); got {body!r}")

    def test_cr_plan_posts_the_S8_body_to_the_S8_path(self):
        _code, _axi, post_mock, _get = self.drive(
            ["cr-plan", "--cr", "CR-CRU-092", "--release", "0.2.0",
             "--wave", "5", "--title", "next verb", "--agent", "orc"],
            post_return={"ok": True, "converged": False,
                         "entry": {"cr": "CR-CRU-092"}, "warnings": [],
                         "unknownDependencies": []})
        body = self.assert_posted(post_mock, PLAN_PATH)
        self.assertEqual(
            body, {"cr": "CR-CRU-092", "release": "0.2.0", "wave": "5",
                   "title": "next verb", "agentId": "orc"},
            f"{self.CLIENT}: cr-plan's body is §S8's {{cr, release, wave, title}} "
            f"plus agentId; got {body!r}")

    def test_wave_sequence_posts_the_ordered_list_to_the_S8_path(self):
        _code, _axi, post_mock, _get = self.drive(
            ["wave-sequence", "--release", "0.2.0", "--wave", "5",
             "--crs", "CR-A,CR-B,CR-C", "--agent", "orc"],
            post_return={"ok": True, "converged": False, "entries": [],
                         "warnings": [], "unknownDependencies": []})
        body = self.assert_posted(post_mock, SEQUENCE_PATH)
        self.assertEqual(
            body, {"release": "0.2.0", "wave": "5",
                   "crs": ["CR-A", "CR-B", "CR-C"], "agentId": "orc"},
            f"{self.CLIENT}: wave-sequence carries the WHOLE ordered list in "
            f"ONE call — array position IS seq (§S4); got {body!r}")

    def test_wave_sequence_passes_track_through_verbatim(self):
        """§S2/AC17 — the SERVER normalises `2` / `track-2` / `Track 2` to
        `track-<n>`. A client that normalises is the second decision-maker
        §S9 forbids, so the caller's spelling must reach the wire untouched."""
        for spelling in ("2", "track-2", "Track 2"):
            with self.subTest(track=spelling):
                _code, _axi, post_mock, _get = self.drive(
                    ["wave-sequence", "--release", "0.2.0", "--wave", "5",
                     "--crs", "CR-A", "--track", spelling, "--agent", "orc"],
                    post_return={"ok": True, "converged": False, "entries": [],
                                 "warnings": [], "unknownDependencies": []})
                body = self.assert_posted(post_mock, SEQUENCE_PATH)
                self.assertEqual(
                    body.get("track"), spelling,
                    f"{self.CLIENT}: --track must reach the wire VERBATIM — "
                    f"normalisation is the server's (§S2); got {body!r}")

    def test_cr_supersede_posts_by_to_the_S8_path(self):
        _code, _axi, post_mock, _get = self.drive(
            ["cr-supersede", "--cr", "CR-X", "--by", "CR-Y", "--agent", "orc"],
            post_return={"ok": True, "converged": False, "entry": {"cr": "CR-X"},
                         "resolvedDependants": []})
        body = self.assert_posted(post_mock, _lifecycle_path("CR-X", "supersede"))
        self.assertEqual(
            body, {"by": "CR-Y", "agentId": "orc"},
            f"{self.CLIENT}: cr-supersede's body is §S8's {{by}} plus agentId; "
            f"got {body!r}")

    def test_cr_void_posts_reason_to_the_S8_path(self):
        _code, _axi, post_mock, _get = self.drive(
            ["cr-void", "--cr", "CR-X", "--reason", "folded into 092",
             "--agent", "orc"],
            post_return={"ok": True, "converged": False, "entry": {"cr": "CR-X"},
                         "brokenDependants": []})
        body = self.assert_posted(post_mock, _lifecycle_path("CR-X", "void"))
        self.assertEqual(
            body, {"reason": "folded into 092", "agentId": "orc"},
            f"{self.CLIENT}: cr-void's body is §S8's {{reason}} plus agentId; "
            f"got {body!r}")

    def test_no_verb_ever_issues_a_patch_put_or_delete(self):
        """§S8 — "No PATCH, no PUT, no DELETE." Re-planning and re-sequencing
        are re-POSTs and neither lifecycle verb deletes a row."""
        with mock.patch.object(self.module, "_patch", create=True) as patch_mock:
            with mock.patch.object(self.module, "_post", create=True,
                                   return_value={"ok": True}), \
                    mock.patch.object(self.module, "_get", create=True,
                                      return_value=_proposals_response()):
                for argv in (
                        ["release-propose", "--label", "0.4.0"],
                        ["cr-plan", "--cr", "CR-X", "--release", "0.2.0",
                         "--wave", "5", "--title", "t"],
                        ["wave-sequence", "--release", "0.2.0", "--wave", "5",
                         "--crs", "CR-X"],
                        ["cr-supersede", "--cr", "CR-X", "--by", "CR-Y"],
                        ["cr-void", "--cr", "CR-X", "--reason", "r"]):
                    _run_main(self.module,
                              argv + ["--agent", "orc",
                                      "--project-dir", self.tmpdir])
        self.assertEqual(
            patch_mock.call_args_list, [],
            f"{self.CLIENT}: no roadmap verb may PATCH — §S8 adds no "
            f"PATCH/PUT/DELETE route; calls={patch_mock.call_args_list!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S6 / AC11 — the client asks, in all three states
# ═══════════════════════════════════════════════════════════════════════════


class _AskingTests:

    ASK_ARGV = ["cr-plan", "--cr", "CR-CRU-092", "--title", "the next verb",
                "--agent", "orc"]

    def test_cr_plan_without_release_or_wave_asks_and_posts_nothing(self):
        code, axi, post_mock, get_mock = self.drive(
            self.ASK_ARGV,
            get_return=_proposals_response(
                _proposal("0.2.0", waves=["4", "5"]),
                _proposal("0.3.0", waves=["6"])))
        self.assert_no_post(post_mock)
        self.assertEqual(
            code, 2,
            f"{self.CLIENT}: an undeclared cr-plan exits 2 — the fleet's usage "
            f"code (§S6); got {code}")
        self.assertIs(
            axi.get("ok"), False,
            f"{self.CLIENT}: the asking envelope is ok:false; got {axi!r}")
        self.assertEqual(
            axi.get("needs"), ["release", "wave"],
            f"{self.CLIENT}: `needs` names EXACTLY the undeclared fields (P6); "
            f"got {axi.get('needs')!r}")
        self.assertEqual(
            [r.get("label") for r in axi.get("releases") or []],
            ["0.2.0", "0.3.0"],
            f"{self.CLIENT}: `releases[]` carries the live candidates read from "
            f"GET …/release-proposals (P7); got {axi.get('releases')!r}")
        self.assertEqual(
            [r.get("waves") for r in axi.get("releases") or []],
            [["4", "5"], ["6"]],
            f"{self.CLIENT}: each candidate carries the waves already planned "
            f"against it (P7); got {axi.get('releases')!r}")
        self.assertEqual(
            {r.get("status") for r in axi.get("releases") or []}, {"live"},
            f"{self.CLIENT}: the CLIENT labels a candidate live — §S8 settles "
            f"that the server emits NO status field, so reading one off the "
            f"wire would be fabricating it; got {axi.get('releases')!r}")

    def test_the_release_proposals_get_is_the_only_call_the_ask_makes(self):
        _code, _axi, _post, get_mock = self.drive(self.ASK_ARGV)
        called = [c[0][0] if c[0] else c[1].get("path")
                  for c in get_mock.call_args_list]
        self.assertIn(
            PROPOSALS_PATH, called,
            f"{self.CLIENT}: §S6's candidate list is read from "
            f"GET {PROPOSALS_PATH} — `listReleases` must not be repurposed "
            f"(§S1); GETs were {called!r}")

    def test_the_ask_help_substitutes_the_callers_own_cr_and_title(self):
        _code, axi, _post, _get = self.drive(
            self.ASK_ARGV,
            get_return=_proposals_response(
                _proposal("0.2.0", waves=["4", "5"]),
                _proposal("0.3.0", waves=["6"])))
        help_steps = axi.get("help") or []
        self.assertEqual(
            help_steps[:3],
            ['cr-plan --cr CR-CRU-092 --release 0.2.0 --wave 4 '
             '--title "the next verb"',
             'cr-plan --cr CR-CRU-092 --release 0.2.0 --wave 5 '
             '--title "the next verb"',
             'cr-plan --cr CR-CRU-092 --release 0.3.0 --wave 6 '
             '--title "the next verb"'],
            f"{self.CLIENT}: help[] is one PRE-FILLED cr-plan line per "
            f"candidate release/wave, with the caller's OWN --cr and --title "
            f"already substituted (P9); got {help_steps!r}")
        self.assertEqual(
            help_steps[-1], "release-propose --label <v>",
            f"{self.CLIENT}: help[] ends with the release-propose line for the "
            f"case where the intended release does not exist yet (P9); "
            f"got {help_steps!r}")

    def test_a_candidate_with_no_planned_wave_still_gets_a_template(self):
        _code, axi, _post, _get = self.drive(
            self.ASK_ARGV,
            get_return=_proposals_response(_proposal("0.4.0", waves=[])))
        self.assertEqual(
            axi.get("help"),
            ['cr-plan --cr CR-CRU-092 --release 0.4.0 --wave <n> '
             '--title "the next verb"',
             "release-propose --label <v>"],
            f"{self.CLIENT}: a proposal with zero planned waves is legal (§S1) "
            f"and still offers a template, with the wave left a placeholder; "
            f"got {axi.get('help')!r}")

    def test_zero_proposals_is_a_definitive_empty_state(self):
        code, axi, post_mock, _get = self.drive(
            self.ASK_ARGV, get_return=_proposals_response())
        self.assert_no_post(post_mock)
        self.assertEqual(code, 2, f"{self.CLIENT}: still the usage exit")
        self.assertEqual(
            axi.get("releases"), [],
            f"{self.CLIENT}: zero proposals is an ANSWER, not a blank (P5); "
            f"got {axi!r}")
        self.assertEqual(
            axi.get("totalCount"), 0,
            f"{self.CLIENT}: the empty state still carries its aggregate (P4); "
            f"got {axi!r}")
        self.assertEqual(
            axi.get("help"), ["release-propose --label <v>"],
            f"{self.CLIENT}: with NO proposal recorded the ONLY help[] entry is "
            f"the release-propose line (AC11); got {axi.get('help')!r}")

    def test_exactly_one_proposal_and_one_wave_still_asks(self):
        """AC11's sharpest clause: "an implementation that infers the single
        candidate fails this AC"."""
        code, axi, post_mock, _get = self.drive(
            self.ASK_ARGV,
            get_return=_proposals_response(_proposal("0.2.0", waves=["5"])))
        self.assert_no_post(post_mock)
        self.assertEqual(
            code, 2,
            f"{self.CLIENT}: one candidate is not a decision — the verb still "
            f"exits 2 and writes nothing (AC11); got {code}")
        self.assertEqual(
            axi.get("needs"), ["release", "wave"],
            f"{self.CLIENT}: needs is unchanged by the candidate count; "
            f"got {axi.get('needs')!r}")

    def test_only_the_undeclared_field_is_named(self):
        for argv, expected in (
                (["cr-plan", "--cr", "CR-X", "--title", "t", "--wave", "5",
                  "--agent", "orc"], ["release"]),
                (["cr-plan", "--cr", "CR-X", "--title", "t",
                  "--release", "0.2.0", "--agent", "orc"], ["wave"])):
            with self.subTest(needs=expected):
                code, axi, post_mock, _get = self.drive(
                    argv, get_return=_proposals_response(
                        _proposal("0.2.0", waves=["5"])))
                self.assert_no_post(post_mock)
                self.assertEqual(code, 2)
                self.assertEqual(
                    axi.get("needs"), expected,
                    f"{self.CLIENT}: `needs` is EXACTLY the undeclared fields, "
                    f"never the whole pair (P6); got {axi.get('needs')!r}")

    def test_an_unreachable_proposals_read_still_answers_definitively(self):
        """The candidate read failing is NOT "zero proposals" — the fleet's
        tolerant-degrade idiom (`cmd_status`/`cmd_queue`) names the condition
        in a STRUCTURED warning rather than reporting an empty roadmap as
        fact, and the verb still refuses to guess."""
        code, axi, post_mock, _get = self.drive(
            self.ASK_ARGV,
            get_return={"ok": False, "error": "connection failed: refused"})
        self.assert_no_post(post_mock)
        self.assertEqual(code, 2)
        codes = [w.get("code") for w in axi.get("warnings") or []]
        self.assertIn(
            "release-proposals-unavailable", codes,
            f"{self.CLIENT}: an unreadable candidate list must be named in a "
            f"structured warning, never silently rendered as an empty "
            f"roadmap; got {axi.get('warnings')!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S7 / §S8 — convergence and the structured server answer
# ═══════════════════════════════════════════════════════════════════════════


class _EnvelopeContractTests:

    SUCCESS_CALLS = None  # filled in below (argv, post_return)

    def _each_verb(self):
        return (
            (["release-propose", "--label", "0.4.0", "--agent", "orc"],
             {"ok": True, "converged": True,
              "proposal": {"label": "0.4.0"}},
             "release-propose"),
            (["cr-plan", "--cr", "CR-X", "--release", "0.2.0", "--wave", "5",
              "--title", "t", "--agent", "orc"],
             {"ok": True, "converged": True, "entry": {"cr": "CR-X"},
              "warnings": [], "unknownDependencies": []},
             "cr-plan"),
            (["wave-sequence", "--release", "0.2.0", "--wave", "5",
              "--crs", "CR-X", "--agent", "orc"],
             {"ok": True, "converged": True, "entries": [{"cr": "CR-X"}],
              "warnings": [], "unknownDependencies": []},
             "wave-sequence"),
            (["cr-supersede", "--cr", "CR-X", "--by", "CR-Y", "--agent", "orc"],
             {"ok": True, "converged": True, "entry": {"cr": "CR-X"},
              "resolvedDependants": []},
             "cr-supersede"),
            (["cr-void", "--cr", "CR-X", "--reason", "r", "--agent", "orc"],
             {"ok": True, "converged": True, "entry": {"cr": "CR-X"},
              "brokenDependants": []},
             "cr-void"),
        )

    def test_every_verb_surfaces_the_servers_converged_verdict(self):
        for argv, resp, verb in self._each_verb():
            for converged in (True, False):
                with self.subTest(verb=verb, converged=converged):
                    code, axi, _post, _get = self.drive(
                        argv, post_return={**resp, "converged": converged})
                    self.assertEqual(code, 0)
                    self.assertEqual(
                        axi.get("verb"), verb,
                        f"{self.CLIENT}: the envelope names its own verb (P1)")
                    self.assertIs(
                        axi.get("converged"), converged,
                        f"{self.CLIENT}/{verb}: §S7 — every envelope carries "
                        f"`converged`, computed by the SERVER and surfaced by "
                        f"the client; got {axi!r}")

    def test_every_envelope_carries_a_total_count(self):
        for argv, resp, verb in self._each_verb():
            with self.subTest(verb=verb):
                _code, axi, _post, _get = self.drive(argv, post_return=resp)
                self.assertIn(
                    "totalCount", axi,
                    f"{self.CLIENT}/{verb}: P4 — a pre-computed aggregate rides "
                    f"every roadmap envelope; got {axi!r}")

    def test_every_success_envelope_carries_a_state_derived_help(self):
        for argv, resp, verb in self._each_verb():
            with self.subTest(verb=verb):
                _code, axi, _post, _get = self.drive(argv, post_return=resp)
                self.assertTrue(
                    axi.get("help"),
                    f"{self.CLIENT}/{verb}: P9 — every envelope names the next "
                    f"move; got {axi!r}")

    def test_release_propose_help_names_the_label_just_proposed(self):
        _code, axi, _post, _get = self.drive(
            ["release-propose", "--label", "0.4.0", "--agent", "orc"],
            post_return={"ok": True, "converged": False,
                         "proposal": {"label": "0.4.0"}})
        self.assertTrue(
            any("0.4.0" in step for step in axi.get("help") or []),
            f"{self.CLIENT}: the next step is STATE-DERIVED — it names the "
            f"release just proposed (P9); got {axi.get('help')!r}")

    def test_cr_plan_help_names_the_container_just_declared(self):
        _code, axi, _post, _get = self.drive(
            ["cr-plan", "--cr", "CR-X", "--release", "0.2.0", "--wave", "5",
             "--title", "t", "--agent", "orc"],
            post_return={"ok": True, "converged": False, "entry": {"cr": "CR-X"},
                         "warnings": [], "unknownDependencies": []})
        self.assertTrue(
            any("wave-sequence" in step and "0.2.0" in step and "5" in step
                for step in axi.get("help") or []),
            f"{self.CLIENT}: after planning a CR the next move is sequencing "
            f"its own container (P9); got {axi.get('help')!r}")

    def test_structured_server_warnings_ride_the_envelope_verbatim(self):
        """§S8 "Settled during C2": `warnings[]` members are STRUCTURED
        objects `{code, message, crs?, containers?}`, never prose — five
        clients must render a warning without parsing English."""
        warnings = [
            {"code": "out-of-order", "message": "B precedes its dependency A",
             "crs": ["CR-B", "CR-A"]},
            {"code": "cross-wave-backwards", "message": "wave 4 depends on 5",
             "containers": ["0.2.0/4", "0.2.0/5"]},
        ]
        _code, axi, _post, _get = self.drive(
            ["wave-sequence", "--release", "0.2.0", "--wave", "5",
             "--crs", "CR-B,CR-A", "--agent", "orc"],
            post_return={"ok": True, "converged": False, "entries": [],
                         "warnings": warnings, "unknownDependencies": []})
        self.assertEqual(
            axi.get("warnings"), warnings,
            f"{self.CLIENT}: the server's structured warnings ride the "
            f"envelope verbatim; got {axi.get('warnings')!r}")

    def test_unknown_dependencies_ride_cr_plan_and_wave_sequence(self):
        """§S8 "Settled during C2": `unknownDependencies` rides both write
        verbs under the key `handleQueuePost` already uses (AC9)."""
        for argv, resp, verb in self._each_verb()[1:3]:
            with self.subTest(verb=verb):
                _code, axi, _post, _get = self.drive(
                    argv, post_return={**resp,
                                       "unknownDependencies": ["CR-CRU-999"]})
                self.assertEqual(
                    axi.get("unknownDependencies"), ["CR-CRU-999"],
                    f"{self.CLIENT}/{verb}: an unknown dependency is FLAGGED, "
                    f"never rejected (§S5/AC9); got {axi!r}")

    def test_a_converged_second_run_is_reported_not_re_decided(self):
        """§S7/AC12 — the client keys on `ok` + `converged`, never on the
        status code (§S8 settles that every success is 200)."""
        code, axi, _post, _get = self.drive(
            ["release-propose", "--label", "0.4.0", "--agent", "orc"],
            post_return={"ok": True, "converged": True,
                         "proposal": {"label": "0.4.0"}})
        self.assertEqual(code, 0)
        self.assertIs(axi.get("ok"), True)
        self.assertIs(axi.get("converged"), True)

    def test_supersede_and_void_report_their_dependants_differently(self):
        """AC15 — "an implementation collapsing both into one 'removed'
        response fails this AC"."""
        _code, sup, _p, _g = self.drive(
            ["cr-supersede", "--cr", "CR-X", "--by", "CR-Y", "--agent", "orc"],
            post_return={"ok": True, "converged": False,
                         "entry": {"cr": "CR-X"},
                         "resolvedDependants": ["CR-C", "CR-D"]})
        self.assertEqual(sup.get("resolvedDependants"), ["CR-C", "CR-D"])
        self.assertNotIn(
            "brokenDependants", sup,
            f"{self.CLIENT}: supersede reports NO broken-dependant list — the "
            f"work still happens, elsewhere (AC15); got {sup!r}")
        self.assertEqual(sup.get("totalCount"), 2)
        _code, void, _p, _g = self.drive(
            ["cr-void", "--cr", "CR-X", "--reason", "r", "--agent", "orc"],
            post_return={"ok": True, "converged": False,
                         "entry": {"cr": "CR-X"},
                         "brokenDependants": ["CR-C", "CR-D"]})
        self.assertEqual(void.get("brokenDependants"), ["CR-C", "CR-D"])
        self.assertNotIn(
            "resolvedDependants", void,
            f"{self.CLIENT}: void reports the dependants BROKEN, never resolved "
            f"(AC15); got {void!r}")
        self.assertTrue(
            any("CR-C" in step for step in void.get("help") or []),
            f"{self.CLIENT}: the void help[] is STATE-DERIVED — it names the "
            f"dependants that now point at a VOID cr (P9); "
            f"got {void.get('help')!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S3/AC16 + §S10 P6 — refusals reach STDOUT with the right exit code
# ═══════════════════════════════════════════════════════════════════════════


UNREGISTERED_409 = {
    "ok": False,
    "error": ('HTTP 409: {"ok":false,"error":"agent orc is not registered with '
              'this project — refused","help":["POST /api/v2/agents/register '
              '{projectKey, agentId, role}"]}'),
}

WRONG_ROLE_409 = {
    "ok": False,
    "error": ('HTTP 409: {"ok":false,"error":"agent orc carries role RED — '
              'roadmap registration requires ORCHESTRATOR","help":'
              '["re-register orc with role ORCHESTRATOR: POST '
              '/api/v2/agents/register {projectKey, agentId, role: '
              '\\"ORCHESTRATOR\\"} — it currently holds RED"]}'),
}

UNPROPOSED_404 = {
    "ok": False,
    "error": ('HTTP 404: {"ok":false,"error":"release 9.9.9 has no live '
              'proposal — it is not a plannable target","help":'
              '["release-propose --label 9.9.9 — the super container must '
              'exist before a CR can target it"]}'),
}

TRANSPORT_FAILURE = {
    "ok": False,
    "error": "connection failed: [Errno 111] Connection refused "
             "(is Crucible running at http://127.0.0.1:1?)",
}


class _RefusalTests:

    def _all_verb_argv(self):
        return (
            ("release-propose", ["release-propose", "--label", "0.4.0",
                                 "--agent", "orc"]),
            ("cr-plan", ["cr-plan", "--cr", "CR-X", "--release", "0.2.0",
                         "--wave", "5", "--title", "t", "--agent", "orc"]),
            ("wave-sequence", ["wave-sequence", "--release", "0.2.0",
                               "--wave", "5", "--crs", "CR-X", "--agent", "orc"]),
            ("cr-supersede", ["cr-supersede", "--cr", "CR-X", "--by", "CR-Y",
                              "--agent", "orc"]),
            ("cr-void", ["cr-void", "--cr", "CR-X", "--reason", "r",
                         "--agent", "orc"]),
        )

    def test_an_unregistered_caller_is_refused_on_stdout_naming_the_role(self):
        for verb, argv in self._all_verb_argv():
            with self.subTest(verb=verb):
                code, axi, _post, _get = self.drive(
                    argv, post_return=UNREGISTERED_409)
                self.assertNotEqual(
                    code, 0,
                    f"{self.CLIENT}/{verb}: a refusal exits non-zero (AC16)")
                self.assertIs(axi.get("ok"), False)
                self.assertEqual(
                    axi.get("requiredRole"), "ORCHESTRATOR",
                    f"{self.CLIENT}/{verb}: the refusal envelope NAMES the "
                    f"required role structurally — the unregistered-caller 409 "
                    f"is the shared seam's and does not mention it (AC16); "
                    f"got {axi!r}")
                self.assertNotIn(
                    "[crucible] ERROR", self.stdout_text,
                    f"{self.CLIENT}/{verb}: stdout is the machine channel — "
                    f"prose belongs on stderr (P1); got {self.stdout_text!r}")

    def test_a_wrong_role_caller_is_refused_and_the_server_error_surfaces(self):
        for verb, argv in self._all_verb_argv():
            with self.subTest(verb=verb):
                code, axi, _post, _get = self.drive(
                    argv, post_return=WRONG_ROLE_409)
                self.assertEqual(
                    code, 1,
                    f"{self.CLIENT}/{verb}: a server refusal is the transport "
                    f"exit 1, never the usage exit 2 (P6); got {code}")
                self.assertIn(
                    "ORCHESTRATOR", str(axi.get("error")),
                    f"{self.CLIENT}/{verb}: the server's refusal text is "
                    f"surfaced faithfully; got {axi!r}")
                self.assertEqual(axi.get("requiredRole"), "ORCHESTRATOR")

    def test_a_refusal_carries_the_servers_own_state_derived_help(self):
        """AC6 — `cr-plan --release 9.9.9` must carry a `help[]` entry
        `release-propose --label 9.9.9`. The server already derives it
        (`roadmapHints.unproposedRelease`); the client LIFTS it rather than
        re-deriving, because §S9 puts no business rule in a client."""
        _code, axi, _post, _get = self.drive(
            ["cr-plan", "--cr", "CR-X", "--release", "9.9.9", "--wave", "5",
             "--title", "t", "--agent", "orc"],
            post_return=UNPROPOSED_404)
        self.assertTrue(
            any(step.startswith("release-propose --label 9.9.9")
                for step in axi.get("help") or []),
            f"{self.CLIENT}: the refusal's help[] names the unproposed release "
            f"by label (AC6/P9); got {axi.get('help')!r}")

    def test_a_transport_failure_exits_one_with_a_reachability_help(self):
        for verb, argv in self._all_verb_argv():
            with self.subTest(verb=verb):
                code, axi, _post, _get = self.drive(
                    argv, post_return=TRANSPORT_FAILURE)
                self.assertEqual(
                    code, 1,
                    f"{self.CLIENT}/{verb}: a transport failure exits 1 (P6)")
                self.assertIs(axi.get("ok"), False)
                self.assertTrue(
                    axi.get("help"),
                    f"{self.CLIENT}/{verb}: even an unreachable server gets a "
                    f"next step (P9); got {axi!r}")
                self.assertIs(
                    axi.get("converged"), False,
                    f"{self.CLIENT}/{verb}: §S7 — `converged` rides EVERY "
                    f"envelope; a call that never landed converged on nothing")

    def test_a_malformed_target_is_a_usage_refusal_that_posts_nothing(self):
        code, axi, post_mock, _get = self.drive(
            ["release-propose", "--label", "0.4.0", "--target", "next tuesday",
             "--agent", "orc"])
        self.assert_no_post(post_mock)
        self.assertEqual(
            code, 2,
            f"{self.CLIENT}: a value the CLIENT itself cannot resolve is the "
            f"usage exit 2, resolved before anything reaches the wire (P6)")
        self.assertIn(
            "next tuesday", str(axi.get("error")),
            f"{self.CLIENT}: the refusal names the offending value; got {axi!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S10 P2/P3/P4 — --fields narrows, --full defeats truncation
# ═══════════════════════════════════════════════════════════════════════════


def _many_entries(count):
    return [{"cr": f"CR-{i:03d}", "release": "0.2.0", "wave": "5",
             "seq": i * 10, "title": f"entry {i}"} for i in range(count)]


class _ProjectionTests:

    def test_fields_narrows_the_entry_rows(self):
        _code, axi, _post, _get = self.drive(
            ["wave-sequence", "--release", "0.2.0", "--wave", "5",
             "--crs", "CR-000,CR-001", "--agent", "orc",
             "--fields", "cr,seq"],
            post_return={"ok": True, "converged": False,
                         "entries": _many_entries(2), "warnings": [],
                         "unknownDependencies": []})
        self.assertEqual(
            [sorted(row) for row in axi.get("entries") or []],
            [["cr", "seq"], ["cr", "seq"]],
            f"{self.CLIENT}: `--fields` NARROWS the envelope to the requested "
            f"columns (P2); got {axi.get('entries')!r}")

    def test_fields_narrows_the_single_entry_of_a_lifecycle_verb(self):
        _code, axi, _post, _get = self.drive(
            ["cr-void", "--cr", "CR-000", "--reason", "r", "--agent", "orc",
             "--fields", "cr"],
            post_return={"ok": True, "converged": False,
                         "entry": _many_entries(1)[0], "brokenDependants": []})
        self.assertEqual(
            sorted(axi.get("entry") or {}), ["cr"],
            f"{self.CLIENT}: `--fields` narrows a single-record answer too "
            f"(P2); got {axi.get('entry')!r}")

    def test_a_long_list_truncates_by_default_and_totalCount_stays_true(self):
        _code, axi, _post, _get = self.drive(
            ["wave-sequence", "--release", "0.2.0", "--wave", "5",
             "--crs", "CR-000", "--agent", "orc"],
            post_return={"ok": True, "converged": False,
                         "entries": _many_entries(25), "warnings": [],
                         "unknownDependencies": []})
        self.assertEqual(
            len(axi.get("entries") or []), 20,
            f"{self.CLIENT}: a list-bearing envelope truncates by default "
            f"(P3); got {len(axi.get('entries') or [])} rows")
        self.assertEqual(
            axi.get("totalCount"), 25,
            f"{self.CLIENT}: `totalCount` is the TRUE total, unaffected by "
            f"truncation (P4); got {axi!r}")

    def test_full_defeats_the_truncation(self):
        _code, axi, _post, _get = self.drive(
            ["wave-sequence", "--release", "0.2.0", "--wave", "5",
             "--crs", "CR-000", "--agent", "orc", "--full"],
            post_return={"ok": True, "converged": False,
                         "entries": _many_entries(25), "warnings": [],
                         "unknownDependencies": []})
        self.assertEqual(
            len(axi.get("entries") or []), 25,
            f"{self.CLIENT}: `--full` emits the whole list (P3); "
            f"got {len(axi.get('entries') or [])} rows")

    def test_the_ask_candidate_list_truncates_and_full_defeats_it(self):
        many = _proposals_response(
            *[_proposal(f"0.{i}.0", waves=["1"]) for i in range(25)])
        _code, axi, _post, _get = self.drive(
            ["cr-plan", "--cr", "CR-X", "--title", "t", "--agent", "orc"],
            get_return=many)
        self.assertEqual(len(axi.get("releases") or []), 20)
        self.assertEqual(axi.get("totalCount"), 25)
        _code, full, _post, _get = self.drive(
            ["cr-plan", "--cr", "CR-X", "--title", "t", "--agent", "orc",
             "--full"], get_return=many)
        self.assertEqual(
            len(full.get("releases") or []), 25,
            f"{self.CLIENT}: `--full` defeats the candidate-list truncation "
            f"too (P3); got {full!r}")


# ═══════════════════════════════════════════════════════════════════════════
# The five per-client suites — one shared behaviour, asked five ways
# ═══════════════════════════════════════════════════════════════════════════


class _AllRoadmapVerbTests(_WireTests, _AskingTests, _EnvelopeContractTests,
                           _RefusalTests, _ProjectionTests,
                           _RoadmapVerbTestBase):
    """Every mixin above, bound to one client by the five subclasses below."""


class PythonRoadmapVerbTest(_AllRoadmapVerbTests):
    CLIENT = "python"


class BunRoadmapVerbTest(_AllRoadmapVerbTests):
    CLIENT = "bun"


class RustRoadmapVerbTest(_AllRoadmapVerbTests):
    CLIENT = "rust"


class MvnRoadmapVerbTest(_AllRoadmapVerbTests):
    CLIENT = "mvn"


class ArduinoRoadmapVerbTest(_AllRoadmapVerbTests):
    CLIENT = "arduino"


# ═══════════════════════════════════════════════════════════════════════════
# §S3/§S9 — the implementation lands ONCE
# ═══════════════════════════════════════════════════════════════════════════


class RoadmapVerbsLandOnceTest(unittest.TestCase):
    """CR-CRU-054's DRY rule, applied to this CR's own surface: the five
    clients hold a thin subparser + delegation each, and every line of logic
    lives in `clients/_crucible_axi.py`. A reviewer diffing two client files
    must see near-identical thin registrations."""

    SHARED = CLIENTS_DIR / "_crucible_axi.py"
    DELEGATORS = ("cmd_release_propose", "cmd_cr_plan", "cmd_wave_sequence",
                  "cmd_cr_supersede", "cmd_cr_void")

    def test_the_shared_module_defines_all_five_implementations(self):
        source = self.SHARED.read_text()
        missing = [name for name in self.DELEGATORS
                   if f"def {name}(" not in source]
        self.assertEqual(
            missing, [],
            f"the five verbs land ONCE in _crucible_axi.py (§S3/§S9); "
            f"missing {missing!r}")

    def test_each_client_delegator_is_a_thin_wrapper(self):
        """The `queue-file` shape (`clients/python-crucible.py:1100-1104`):
        the client body is one `return _axi().<impl>(args, <project dir>,
        _ops())` call. Anything longer means logic leaked into a client."""
        offenders = {}
        for client, path in CLIENT_FILES.items():
            tree = ast.parse(path.read_text())
            found = {node.name: node for node in ast.walk(tree)
                     if isinstance(node, ast.FunctionDef)
                     and node.name in self.DELEGATORS}
            for name in self.DELEGATORS:
                node = found.get(name)
                if node is None:
                    offenders[f"{client}:{name}"] = "not defined"
                    continue
                body = [stmt for stmt in node.body
                        if not (isinstance(stmt, ast.Expr)
                                and isinstance(stmt.value, ast.Constant))]
                if len(body) != 1 or not isinstance(body[0], ast.Return):
                    offenders[f"{client}:{name}"] = (
                        f"{len(body)} statement(s), expected one `return`")
        self.assertEqual(
            offenders, {},
            f"every client's roadmap verb is a THIN delegator over the shared "
            f"implementation (§S9/CR-CRU-054 DRY rule): {offenders!r}")


if __name__ == "__main__":
    unittest.main()
