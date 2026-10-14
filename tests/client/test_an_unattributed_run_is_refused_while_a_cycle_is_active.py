"""RED — the first paragraph of the run-attribution step: while a project has
an ACTIVE cycle, every client's `test` and `pre-merge-gate` refuse a run that
would carry no cycle (the agent bound to no cycle, neither `--cycle` nor
`--release` given), exiting non-zero BEFORE the runner starts, with `help[]`
naming the active cycle (`--cycle <id>`). With `--cycle <id>` the run still
proceeds and is stored under that cycle. With NO active cycle, today's soft
`no-cycle` warning stands unchanged. A `--release` run is never refused by
this check, active cycle or not.

Driven against a REAL, ephemeral `bun run src/server.ts` board (never
:3850/:3849) — the only way to have a genuine ACTIVE cycle for the pre-flight
read to answer, which a canned/recording stub cannot fake — following the
same real-server idiom every other end-to-end suite in this directory uses
(`test_status_verb_shows_open_plans_end_to_end.py`,
`test_bun_regression_declares_its_release_end_to_end.py`). Each of the five
clients' `test`/`pre-merge-gate` verbs is driven as a genuine OS subprocess,
argv built from each client's OWN real argparse
(`test_client_fleet_envelope_census.py`'s `enumerate_verbs`/`build_argv`),
toolchains stubbed by that module's own proven `_build_fake_bin_dir` (so
`pre-merge-gate`'s docker-up/down, clippy, tsc and `arduino-cli compile`
steps all run for real against fakes, never skipped).

RED phase — today's code only WARNS (`no-cycle`) and lets the run proceed
regardless of an active cycle: `preflight_cycle_warnings`
(`clients/_crucible_axi.py`) never reads whether the project has an active
cycle at all, so every refusal case below fails on its very first assertion
(`returncode != 0`) because today's run actually succeeds. The three GUARD
cases (`--cycle` still binds, no active cycle still warns, `--release` is
never refused) are expected to PASS today — they pin behaviour this fix must
not disturb — and are filed here rather than skipped because they are the
asserted OTHER HALF of the very same acceptance criterion.

Invocation:
    python3 -m unittest tests.client.test_an_unattributed_run_is_refused_while_a_cycle_is_active -v
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import json as _json
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
    enumerate_verbs,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

NO_CYCLE_CODE = "no-cycle"
RELEASE_RUN_CODE = "release-run"

# Every (client, verb) pair this acceptance criterion names — the fleet's run
# verbs, never the gate-milestone/cr-close verbs (a later cycle's scope).
CLIENT_VERB_PAIRS = sorted(
    (client_key, verb) for client_key in CLIENT_FILES for verb in ("test", "pre-merge-gate")
)


def _free_port():
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _declare_listener(store_dir, port, host="127.0.0.1"):
    Path(store_dir, "crucible.toml").write_text(
        f'[server]\nhost = "{host}"\nport = {port}\n', encoding="utf-8")


def _call(base, path, payload=None, method=None):
    data = None if payload is None else _json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path, data=data, method=method or ("POST" if data is not None else "GET"),
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return _json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return _json.loads(exc.read().decode())


def _await_server(base, proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"scratch server exited early with {proc.returncode}")
        try:
            with urllib.request.urlopen(base + "/api/v2/health", timeout=2):  # noqa: S310
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"scratch server never became reachable at {base}")


class UnattributedRunRefusedWhileACycleIsActiveTest(unittest.TestCase):
    """AC — "An unattributed run is refused", read for all five clients
    against one shared live board: a project carrying an ACTIVE cycle, and a
    sibling project carrying none."""

    ORCHESTRATOR = "cycle-refusal-fixture-orchestrator"
    RELEASE_LABEL = "4.4.4-cycle-refusal-fixture"
    RELEASE_WAVE = "1"
    PLANTED_CR = "CR-T-CYCLE-REFUSAL-ACTIVE"
    RELEASE_CR = "CR-T-CYCLE-REFUSAL-RELEASE"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="cycle-refusal-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "an ACTIVE cycle for the pre-flight read to answer is a "
                "property of a REAL store: without `bun` there is no server "
                "to carry one. A missing toolchain, not a passing assertion.")
        port = _free_port()
        assert port not in (3850, 3849, 39877), (
            f"fixture sanity: the OS handed back a reserved port {port}")
        cls.base = f"http://127.0.0.1:{port}"
        _declare_listener(cls._tmpdir, port)
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ, "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            cls._boot()
        except BaseException:
            cls._stop_server()
            raise

    @classmethod
    def _http(cls, path, payload=None, method=None):
        return _call(cls.base, path, payload, method)

    @classmethod
    def _boot(cls):
        _await_server(cls.base, cls._proc)
        cls.toon = _load_toon_module()

        # `active_key` — one project carrying exactly ONE active cycle (plus
        # a declared release, filed through a SECOND, still-pending cycle so
        # it never contends for "the" active one), used by every case below
        # that needs the project to HAVE an active cycle.
        project = cls._http("/api/v2/projects", {"name": "cycle-refusal-active"})
        assert project.get("ok"), f"project creation failed: {project!r}"
        cls.active_key = project["project"]["key"]

        reg = cls._http("/api/v2/agents/register",
                        {"projectKey": cls.active_key, "agentId": cls.ORCHESTRATOR,
                         "role": "ORCHESTRATOR"})
        assert reg.get("ok"), f"orchestrator registration failed: {reg!r}"

        filed = cls._http(f"/api/v2/projects/{cls.active_key}/plans",
                          {"cr": cls.PLANTED_CR, "cycles": [{"label": "solo"}],
                           "agentId": cls.ORCHESTRATOR})
        assert filed.get("ok"), f"plan-file failed: {filed!r}"
        plan_id = filed["planId"]
        cycle_id = filed["cycles"][0]["id"]
        activated = cls._http(
            f"/api/v2/projects/{cls.active_key}/plans/{plan_id}/cycles/{cycle_id}",
            {"status": "active", "agentId": cls.ORCHESTRATOR}, method="PATCH")
        assert activated.get("ok"), f"cycle activation failed: {activated!r}"
        cls.active_cycle_id = cycle_id

        # §S1's own declaration rule ("a CR planned into it") — a release
        # declared on the SAME project, via its own plan/cycle (left
        # pending, never activated, so the project still carries exactly
        # one active cycle: the one above).
        proposed = cls._http(f"/api/v2/projects/{cls.active_key}/release-proposals",
                             {"agentId": cls.ORCHESTRATOR, "label": cls.RELEASE_LABEL,
                              "targetAt": int(time.time()) + 86400})
        assert proposed.get("ok"), f"release proposal failed: {proposed!r}"
        planned = cls._http(f"/api/v2/projects/{cls.active_key}/queue/plan",
                            {"cr": cls.RELEASE_CR, "title": "release-run fixture CR",
                             "release": cls.RELEASE_LABEL, "wave": cls.RELEASE_WAVE,
                             "agentId": cls.ORCHESTRATOR})
        assert planned.get("ok"), f"cr-plan under the release failed: {planned!r}"

        # `no_active_key` — a sibling project with NO plan filed at all, so
        # NO active cycle, for the "between CRs" regression pin.
        no_active = cls._http("/api/v2/projects", {"name": "cycle-refusal-no-active"})
        assert no_active.get("ok"), f"project creation failed: {no_active!r}"
        cls.no_active_key = no_active["project"]["key"]

        # Fixture sanity — the comparisons below are read against these, not
        # hardcoded, but a silently-empty board would make every assertion
        # below vacuous.
        active_plans = cls._http(f"/api/v2/projects/{cls.active_key}/plans")
        active_cycles = [c for p in active_plans.get("plans", []) for c in p.get("cycles", [])
                         if c.get("status") == "active"]
        assert len(active_cycles) == 1 and active_cycles[0]["id"] == cls.active_cycle_id, (
            f"fixture sanity: expected exactly one active cycle "
            f"({cls.active_cycle_id}) on {cls.active_key}; got {active_plans!r}")
        no_active_plans = cls._http(f"/api/v2/projects/{cls.no_active_key}/plans")
        assert no_active_plans.get("filed") == 0, (
            f"fixture sanity: expected NO plans filed on {cls.no_active_key}; "
            f"got {no_active_plans!r}")

    @classmethod
    def tearDownClass(cls):
        cls._stop_server()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    @classmethod
    def _stop_server(cls):
        proc = getattr(cls, "_proc", None)
        if proc is None:
            return
        cls._proc = None
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    # ── drive + read helpers ────────────────────────────────────────────────

    def _project_dir(self, client_key, project_key):
        d = _make_project_dir(client_key)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={project_key}\n"]
        if client_key == "arduino":
            env_lines.append("CRUCIBLE_PROJECT_NAME=cycle-refusal-fixture-project\n")
        (d / ".env").write_text("".join(env_lines))
        self.addCleanup(shutil.rmtree, d, True)
        return d

    def _drive(self, client_key, verb_name, agent_id, project_key, extra_argv=()):
        fake_bin_dir = _build_fake_bin_dir()
        self.addCleanup(shutil.rmtree, fake_bin_dir, True)
        project_dir = self._project_dir(client_key, project_key)
        script_path = CLIENT_FILES[client_key]
        verbs = enumerate_verbs(client_key, script_path)
        assert verb_name in verbs, (
            f"{client_key}: verb {verb_name!r} not found in its real argparse "
            f"— {sorted(verbs)!r}")
        argv = build_argv(verb_name, verbs[verb_name], project_dir)
        argv = argv + ["--agent", agent_id] + list(extra_argv)
        result = drive_verb(script_path, argv, project_dir, fake_bin_dir,
                            timeout=90, board=self.base)
        emits, axi = classify_envelope(result.stdout, self.toon)
        # `axi` is None on a decode failure; every caller asserts `emits`
        # first (which fails loudly and stops the test right there), so an
        # empty-dict fallback here only keeps the subsequent `.get(...)`
        # calls type-safe, it never masks a real decode failure.
        return result, emits, axi or {}

    def _events_for(self, project_key, agent_id):
        """The RUN-RESULT events (`kind == "test"`) this agent filed — never
        the opening heartbeat's own `kind: "lifecycle", action: "registered"`
        touch, which is identity management, not the runner's evidence (a
        refusal that opens the identity bracket before declining to spawn
        the runner must still read back NO run-result event here)."""
        read = self._http(f"/api/v2/events?project={project_key}")
        self.assertTrue(read.get("ok"), f"events read failed: {read!r}")
        return [e for e in (read.get("events") or [])
               if e.get("agentId") == agent_id and e.get("kind") == "test"]

    def _warnings_of(self, axi, code):
        return [w for w in (axi.get("warnings") or [])
               if isinstance(w, dict) and w.get("code") == code]

    # ── the refusal itself ──────────────────────────────────────────────────

    def test_refused_before_the_runner_starts_for_every_client_and_verb(self):
        """The core case: an agent bound to no cycle, no `--cycle`, no
        `--release`, against a project that HAS an active cycle — every
        client's `test`/`pre-merge-gate` must exit non-zero before spawning
        its runner, naming the active cycle id in `help[]`, and leave NO
        trace on the board (the runner's own evidence never reaches it)."""
        for client_key, verb_name in CLIENT_VERB_PAIRS:
            with self.subTest(client=client_key, verb=verb_name):
                agent_id = f"cycle-refusal-{client_key}-{verb_name}".replace(" ", "-")
                result, emits, axi = self._drive(
                    client_key, verb_name, agent_id, self.active_key)

                self.assertNotEqual(
                    result.returncode, 0,
                    f"{client_key} {verb_name}: a run with NO --cycle and NO "
                    f"--release, filed by an agent bound to no cycle while "
                    f"project {self.active_key} has an ACTIVE cycle "
                    f"({self.active_cycle_id}), must exit NON-ZERO before "
                    f"the runner starts; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                self.assertTrue(
                    emits,
                    f"{client_key} {verb_name}: the refusal must still "
                    f"decode as one TOON axi: envelope; got "
                    f"stdout={result.stdout!r}")
                self.assertFalse(
                    axi.get("ok"),
                    f"{client_key} {verb_name}: the refusal envelope must "
                    f"carry ok:false; got {axi!r}")
                help_text = " ".join(str(h) for h in (axi.get("help") or []))
                self.assertIn(
                    "--cycle", help_text,
                    f"{client_key} {verb_name}: the refusal's help[] must "
                    f"name the lever (--cycle <id>); got "
                    f"help={axi.get('help')!r}")
                self.assertIn(
                    str(self.active_cycle_id), help_text,
                    f"{client_key} {verb_name}: the refusal's help[] must "
                    f"name the project's ACTUAL active cycle id "
                    f"({self.active_cycle_id}), not a placeholder; got "
                    f"help={axi.get('help')!r}")

                events = self._events_for(self.active_key, agent_id)
                self.assertEqual(
                    events, [],
                    f"{client_key} {verb_name}: a refused run must leave NO "
                    f"ingested evidence on the board — the runner's own "
                    f"proof it never started; got events={events!r}")

    # ── GUARD 1 — --cycle still binds the run, even with an active cycle ───

    def test_cycle_flag_still_binds_the_run_despite_the_active_cycle(self):
        """GUARD — expected to PASS today and after the fix: `--cycle
        <active id>` must still open and store the run under that cycle,
        proved by the ingested event's own echoed `context.cycleId` (which
        survives this run's own anti-ghost identity cleanup, unlike the
        agent row)."""
        for client_key, verb_name in CLIENT_VERB_PAIRS:
            with self.subTest(client=client_key, verb=verb_name):
                agent_id = f"cycle-refusal-bound-{client_key}-{verb_name}".replace(" ", "-")
                result, emits, axi = self._drive(
                    client_key, verb_name, agent_id, self.active_key,
                    extra_argv=["--cycle", str(self.active_cycle_id)])

                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key} {verb_name}: `--cycle "
                    f"{self.active_cycle_id}` must still be a green wrapped "
                    f"run even while the project has an active cycle; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                self.assertTrue(
                    emits,
                    f"{client_key} {verb_name}: must decode as one TOON "
                    f"axi: envelope; got stdout={result.stdout!r}")
                self.assertTrue(
                    axi.get("ok"),
                    f"{client_key} {verb_name}: a bound run must carry "
                    f"ok:true; got {axi!r}")
                self.assertEqual(
                    self._warnings_of(axi, NO_CYCLE_CODE), [],
                    f"{client_key} {verb_name}: a run filed with --cycle "
                    f"{self.active_cycle_id} must carry NO {NO_CYCLE_CODE!r} "
                    f"warning; got warnings={axi.get('warnings')!r}")

                events = self._events_for(self.active_key, agent_id)
                self.assertEqual(
                    len(events), 1,
                    f"{client_key} {verb_name}: --cycle "
                    f"{self.active_cycle_id} must file exactly one event "
                    f"for this agent; got events={events!r}")
                self.assertEqual(
                    (events[0].get("context") or {}).get("cycleId"),
                    self.active_cycle_id,
                    f"{client_key} {verb_name}: the stored event must carry "
                    f"EXACTLY the cycle this run was bound to "
                    f"({self.active_cycle_id}); got event={events[0]!r}")

    # ── GUARD 2 — no active cycle: today's soft warning stands ─────────────

    # rust `pre-merge-gate` dispatches to `cmd_workspace_regression`, whose
    # own run body (`_workspace_regression_run`, clients/rust-crucible.py)
    # never calls `preflight_cycle_warnings` at all — read directly: its
    # only cycle-adjacent warning is the `release_run_note` it builds
    # in-line when `--release` is given, with NO `no_cycle_warning` branch
    # for any other case. A PRE-EXISTING asymmetry confirmed by reading the
    # source, outside this acceptance criterion's own scope (it is not a
    # refusal-mechanism gap) — carried here as a documented exception
    # rather than silently assumed uniform across the fleet.
    NO_CYCLE_WARNING_NOT_WIRED_TODAY = {("rust", "pre-merge-gate")}

    def test_no_active_cycle_still_only_warns_as_today(self):
        """GUARD — expected to PASS today and after the fix: with NO active
        cycle on the project, an unattributed run is project-scoped on
        purpose (§S2's own exemption) and proceeds, carrying the SAME
        `no-cycle` warning it carries today."""
        for client_key, verb_name in CLIENT_VERB_PAIRS:
            if (client_key, verb_name) in self.NO_CYCLE_WARNING_NOT_WIRED_TODAY:
                continue
            with self.subTest(client=client_key, verb=verb_name):
                agent_id = f"cycle-refusal-noactive-{client_key}-{verb_name}".replace(" ", "-")
                result, emits, axi = self._drive(
                    client_key, verb_name, agent_id, self.no_active_key)

                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key} {verb_name}: with NO active cycle on the "
                    f"project, an unattributed run must still proceed; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                self.assertTrue(
                    emits,
                    f"{client_key} {verb_name}: must decode as one TOON "
                    f"axi: envelope; got stdout={result.stdout!r}")
                missing = self._warnings_of(axi, NO_CYCLE_CODE)
                self.assertEqual(
                    len(missing), 1,
                    f"{client_key} {verb_name}: with no active cycle the run "
                    f"must carry exactly one {NO_CYCLE_CODE!r} warning, "
                    f"unchanged from today; got "
                    f"warnings={axi.get('warnings')!r}")

    # ── GUARD 3 — a --release run is never refused ──────────────────────────

    def test_release_run_is_never_refused_despite_the_active_cycle(self):
        """GUARD — expected to PASS today and after the fix: `--release
        <declared label>` is unattributed to a cycle BY DESIGN, so it must
        proceed even on a project that HAS an active cycle, carrying the
        `release-run` note instead of `no-cycle`."""
        for client_key, verb_name in CLIENT_VERB_PAIRS:
            with self.subTest(client=client_key, verb=verb_name):
                agent_id = f"cycle-refusal-release-{client_key}-{verb_name}".replace(" ", "-")
                result, emits, axi = self._drive(
                    client_key, verb_name, agent_id, self.active_key,
                    extra_argv=["--release", self.RELEASE_LABEL])

                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key} {verb_name}: a --release "
                    f"{self.RELEASE_LABEL} run must never be refused, even "
                    f"while project {self.active_key} has an active cycle "
                    f"({self.active_cycle_id}); "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                self.assertTrue(
                    emits,
                    f"{client_key} {verb_name}: must decode as one TOON "
                    f"axi: envelope; got stdout={result.stdout!r}")
                self.assertEqual(
                    self._warnings_of(axi, NO_CYCLE_CODE), [],
                    f"{client_key} {verb_name}: a release run must NEVER "
                    f"carry the {NO_CYCLE_CODE!r} warning; got "
                    f"warnings={axi.get('warnings')!r}")
                release_notes = self._warnings_of(axi, RELEASE_RUN_CODE)
                self.assertEqual(
                    len(release_notes), 1,
                    f"{client_key} {verb_name}: a release run must carry "
                    f"exactly one {RELEASE_RUN_CODE!r} note instead; got "
                    f"warnings={axi.get('warnings')!r}")


if __name__ == "__main__":
    unittest.main()
