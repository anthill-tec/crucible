"""CR-CRU-046 C3 -- the §S3 ENVIRONMENT GATE (docs/changes/
CR-CRU-046-toon-conformance.md §S3 / AC "on an environment where only
`crucible-axi` + uv are installed, `uv run <client>.py` (the documented
way) succeeds").

`crucible_axi/manifest.py:43` records each client as a bare FILE PATH, and
every documented invocation is now `uv run <client>.py` (PEP 723 inline
script metadata + uv, landed in C1/C2). §S3's risk section is explicit that
this AC is deliberately an ENVIRONMENT test, not a unit test -- the failure
mode it guards (`ModuleNotFoundError: toon` on any machine that only has
`crucible-axi` + uv, without the repo checkout's ambient tooling) is
invisible to every in-repo import-by-path test, because those tests run
with the repo's own interpreter and cwd on `sys.path`.

This suite builds the real wheel, installs it into a SCRATCH uv venv (so
the on-disk client copies are the ACTUAL installed artifact, not an
unzipped wheel member), locates the installed `crucible_axi` package's own
`clients/` directory (mirroring `manifest.source_clients_dir()`'s
"installed package data" candidate and `manifest.py`'s
`<dir>/{stack}-crucible.py` naming), then drives `uv run <installed
path> --help` through a SANITIZED environment (no `PYTHONPATH`, no
`VIRTUAL_ENV`) from a cwd OUTSIDE the repo (and outside the scratch venv's
own directory, which would otherwise present a project root uv might try
to sync instead of resolving the script's own PEP 723 block).

Three guarantees, in order:

    1. THE GATE ITSELF -- `uv run <installed bun-crucible.py> --help` and
       `uv run <installed python-crucible.py> --help` both exit 0 with
       non-empty help output, proving the mechanism is not bun-specific.
    2. PEP 723 SURVIVAL -- the wheel/install pipeline must not strip the
       `# /// script` block off any of the five installed clients; each
       still declares `requires-python = ">=3.10"` and an EMPTY
       `dependencies = []` (the §S2/§S3 stub-landmine guard).
    3. NEGATIVE CONTROL -- a copy of an installed client with its PEP 723
       `dependencies` corrupted to name a package that cannot exist MUST
       make `uv run` fail with a resolver error naming that package. This
       is what proves guarantees 1-2 actually exercise uv's metadata
       resolution rather than passing no matter what a script declares.

HONESTY NOTE (per the C3 dispatch): guarantees 1 and 2 may well be BORN
GREEN -- the PEP 723 + `uv run` mechanism landed in C1, and reality may
already conform. That is a legitimate, expected outcome for an
environment-gate cycle; this file does not manufacture failure to force a
RED signal on them. The negative control (guarantee 3) is what demonstrates
the harness has bite regardless of the born-state of 1-2.

Cost: ONE wheel build (`python -m build --wheel`, ~1s warm) + ONE `uv venv`
+ ONE `uv pip install` of that wheel, shared by the whole class via
`setUpClass` (same posture as `test_crucible_axi_wheel_packaging.py`) --
each of the four test methods below then costs only its own `uv run`
subprocess (each performs its own fresh dependency resolution, since `uv
run` on a standalone script does not reuse the scratch venv's
site-packages).

Invocation:
    python3 -m pytest tests/client/test_cr046_uv_env_gate.py -q
Fallback:
    python3 tests/client/test_cr046_uv_env_gate.py
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

UV_BINARY = shutil.which("uv")

# The five client stacks that ship a `*-crucible.py` client, matching
# `crucible_axi/manifest.py`'s `CLIENT_STACKS` tuple exactly.
CLIENT_STACKS = ("bun", "python", "rust", "mvn", "arduino")

BUILD_TIMEOUT_SECONDS = 600
UV_TIMEOUT_SECONDS = 120
CORRUPT_DEPENDENCY = "definitely-not-a-real-package-xyzzy>=99"

# Mirrors test_cr046_pep723_metadata.py's PEP 723 block regex/unpacking so
# this file asserts the SAME shape the C2 contract test pins, but against
# the INSTALLED copies rather than the source checkout.
PEP723_BLOCK_RE = re.compile(
    r"(?m)^# /// script\s*$\n((?:^#(?:| .*)$\n)*)^# ///\s*$", re.MULTILINE
)


def _resolve_build_interpreter():
    """Return the first interpreter on this machine that can `import
    build`, or None. Duplicated from test_crucible_axi_wheel_packaging.py's
    helper of the same name (kept local rather than cross-imported, so this
    file's `python3 tests/client/test_cr046_uv_env_gate.py` fallback
    invocation does not depend on `tests` being importable as a package)."""
    candidates = [sys.executable,
                  shutil.which("python3"),
                  shutil.which("python"),
                  str(Path(sys.base_prefix) / "bin" / "python3")]
    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            probe = subprocess.run([candidate, "-c", "import build"],
                                   capture_output=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            continue
        if probe.returncode == 0:
            return candidate
    return None


def _sanitized_env():
    """Environment for a `uv run` invocation that must resolve PURELY from
    the script's own PEP 723 metadata: strip `PYTHONPATH` (would leak repo
    modules onto `sys.path`) and `VIRTUAL_ENV` (would make `uv run` reuse an
    ambient venv's site-packages instead of building its own isolated
    resolution) so the gate reflects a machine with only `crucible-axi` +
    uv installed, not this test process's own tooling."""
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.pop("VIRTUAL_ENV", None)
    return env


def _parse_pep723_block(text):
    """Return the parsed PEP 723 TOML body, or None if no block is found."""
    match = PEP723_BLOCK_RE.search(text)
    if match is None:
        return None
    toml_lines = []
    for line in match.group(1).splitlines():
        if line == "#":
            toml_lines.append("")
        elif line.startswith("# "):
            toml_lines.append(line[2:])
        else:
            return None
    return tomllib.loads("\n".join(toml_lines))


class Cr046UvEnvironmentGateTest(unittest.TestCase):
    """§S3 gate (CR-CRU-046 C3). See module docstring for the full
    contract. No skip-guard: `setUpClass` raises (fail-fast) rather than
    skips when `uv` or a `build`-capable interpreter is absent -- a silent
    skip is exactly how an environment defect this suite exists to catch
    would stay invisible."""

    tmp_root = None
    wheel_path = None
    build_result = None
    venv_python = None
    venv_result = None
    install_result = None
    installed_clients_dir = None

    @classmethod
    def setUpClass(cls):
        if UV_BINARY is None:
            # Fail LOUDLY, not a skip: the whole point of this suite is to
            # prove the documented `uv run` invocation works. A silent skip
            # would hide the exact defect class §S3 exists to catch.
            raise RuntimeError(
                "`uv` is not on PATH; the §S3 environment gate cannot be "
                "verified without it (uv is a hard prerequisite of the "
                "install chain per CR-CRU-046 §S3). Remedy: install uv.")

        interpreter = _resolve_build_interpreter()
        if interpreter is None:
            raise RuntimeError(
                "no interpreter on this machine can `import build`; the "
                "§S3 gate needs a real wheel to install. Remedy: "
                "`python3 -m pip install --upgrade build`.")

        cls.tmp_root = tempfile.mkdtemp(prefix="cr046-uv-env-gate-")
        dist_dir = os.path.join(cls.tmp_root, "dist")
        cls.build_result = subprocess.run(
            [interpreter, "-m", "build", "--wheel", "--outdir", dist_dir],
            cwd=str(REPO_ROOT), capture_output=True, text=True,
            timeout=BUILD_TIMEOUT_SECONDS)

        wheels = (sorted(Path(dist_dir).glob("*.whl"))
                   if os.path.isdir(dist_dir) else [])
        cls.wheel_path = wheels[0] if wheels else None
        if cls.wheel_path is None:
            return  # test methods report the precise diagnostic

        venv_dir = os.path.join(cls.tmp_root, "scratch-venv")
        cls.venv_result = subprocess.run(
            [UV_BINARY, "venv", venv_dir], capture_output=True, text=True,
            timeout=UV_TIMEOUT_SECONDS)
        cls.venv_python = os.path.join(venv_dir, "bin", "python")
        if cls.venv_result.returncode != 0:
            return

        cls.install_result = subprocess.run(
            [UV_BINARY, "pip", "install", "--python", cls.venv_python,
             str(cls.wheel_path)],
            capture_output=True, text=True, timeout=UV_TIMEOUT_SECONDS)
        if cls.install_result.returncode == 0:
            cls.installed_clients_dir = cls._resolve_installed_clients_dir()

    @classmethod
    def _resolve_installed_clients_dir(cls):
        """Ask the SCRATCH venv's own interpreter where it laid down the
        installed `crucible_axi` package, mirroring
        `manifest.source_clients_dir()`'s "installed package data" candidate
        (`<package-dir>/clients`) and `manifest.py`'s
        `{stack}-crucible.py` naming. Run from `cls.tmp_root` (NOT the
        repo) so `-c`'s implicit cwd-on-sys.path cannot shadow the
        installed package with the source-checkout `crucible_axi/`
        directory sitting at the repo root -- that shadowing is a real
        failure mode this helper hit during development."""
        probe = subprocess.run(
            [cls.venv_python, "-c",
             "import crucible_axi, os; "
             "print(os.path.dirname(crucible_axi.__file__))"],
            cwd=cls.tmp_root, capture_output=True, text=True,
            timeout=UV_TIMEOUT_SECONDS)
        if probe.returncode != 0:
            return None
        return os.path.join(probe.stdout.strip(), "clients")

    @classmethod
    def tearDownClass(cls):
        if cls.tmp_root:
            shutil.rmtree(cls.tmp_root, ignore_errors=True)

    def _require_installed_clients_dir(self):
        self.assertIsNotNone(
            self.wheel_path,
            f"no wheel was produced; build stderr:\n"
            f"{self.build_result.stderr if self.build_result else '(none)'}")
        self.assertIsNotNone(
            self.venv_result, "uv venv was never attempted")
        self.assertEqual(
            self.venv_result.returncode, 0,
            f"`uv venv` failed to create the scratch venv; stderr:\n"
            f"{self.venv_result.stderr}")
        self.assertIsNotNone(
            self.install_result, "install was never attempted")
        self.assertEqual(
            self.install_result.returncode, 0,
            f"`uv pip install` of the built wheel into the scratch venv "
            f"failed; stderr:\n{self.install_result.stderr}")
        self.assertIsNotNone(
            self.installed_clients_dir,
            "could not resolve the installed crucible_axi package's "
            "clients directory")
        return self.installed_clients_dir

    def _fresh_run_dir(self):
        """A fresh, empty directory OUTSIDE the repo (and outside the
        scratch venv) to `uv run` from. cwd matters here: `uv run
        <script>.py` treats the cwd as a potential project root, and the
        repo root carries its OWN `pyproject.toml`, which would make uv try
        to sync the repo's project environment instead of resolving the
        script's inline PEP 723 metadata. A directory with no
        `pyproject.toml` anywhere above it forces the PEP-723-script code
        path -- the one the §S3 AC actually documents."""
        run_dir = tempfile.mkdtemp(prefix="cr046-uv-run-", dir=self.tmp_root)
        self.addCleanup(shutil.rmtree, run_dir, ignore_errors=True)
        return run_dir

    def _uv_run_help(self, client_path):
        return subprocess.run(
            [UV_BINARY, "run", client_path, "--help"],
            cwd=self._fresh_run_dir(), env=_sanitized_env(),
            capture_output=True, text=True, timeout=UV_TIMEOUT_SECONDS)

    # -- 1. THE GATE ITSELF ----------------------------------------------

    def test_uv_run_installed_bun_client_help_succeeds(self):
        """The §S3 AC, literally: `uv run <installed bun-crucible.py>
        --help` under a sanitized environment (no PYTHONPATH/VIRTUAL_ENV,
        cwd outside the repo) must exit 0 with non-empty help output."""
        clients_dir = self._require_installed_clients_dir()
        client_path = os.path.join(clients_dir, "bun-crucible.py")
        self.assertTrue(os.path.isfile(client_path),
                         f"installed client missing: {client_path}")
        result = self._uv_run_help(client_path)
        self.assertEqual(
            result.returncode, 0,
            f"`uv run {client_path} --help` failed under a sanitized env "
            f"(only crucible-axi + uv installed); stderr:\n{result.stderr}")
        self.assertTrue(
            result.stdout.strip(),
            "`uv run bun-crucible.py --help` produced empty stdout")
        self.assertIn("bun-crucible", result.stdout,
                      f"expected the client's own usage banner in stdout, "
                      f"got:\n{result.stdout}")

    def test_uv_run_installed_python_client_help_succeeds(self):
        """Repeats the gate on a SECOND, unrelated client to prove the
        mechanism is not bun-specific -- PEP 723 + `uv run` is uniform
        across the fleet."""
        clients_dir = self._require_installed_clients_dir()
        client_path = os.path.join(clients_dir, "python-crucible.py")
        self.assertTrue(os.path.isfile(client_path),
                         f"installed client missing: {client_path}")
        result = self._uv_run_help(client_path)
        self.assertEqual(
            result.returncode, 0,
            f"`uv run {client_path} --help` failed under a sanitized env "
            f"(only crucible-axi + uv installed); stderr:\n{result.stderr}")
        self.assertTrue(
            result.stdout.strip(),
            "`uv run python-crucible.py --help` produced empty stdout")
        self.assertIn("python-crucible", result.stdout,
                      f"expected the client's own usage banner in stdout, "
                      f"got:\n{result.stdout}")

    # -- 2. PEP 723 SURVIVAL THROUGH THE WHEEL/INSTALL PIPELINE ----------

    def test_installed_clients_carry_intact_pep723_block(self):
        """The wheel + `uv pip install` pipeline must not strip or corrupt
        any of the five clients' `# /// script` blocks: each installed copy
        must still declare `requires-python = ">=3.10"` and an EMPTY
        `dependencies = []` (the §S2/§S3 stub-landmine guard, re-asserted
        here against the INSTALLED artifact rather than the source
        checkout that test_cr046_pep723_metadata.py already covers)."""
        clients_dir = self._require_installed_clients_dir()
        offenders = {}
        for stack in CLIENT_STACKS:
            client_path = os.path.join(clients_dir, f"{stack}-crucible.py")
            if not os.path.isfile(client_path):
                offenders[stack] = f"installed client missing: {client_path}"
                continue
            parsed = _parse_pep723_block(
                Path(client_path).read_text(encoding="utf-8"))
            if parsed is None:
                offenders[stack] = "no parseable PEP 723 block found"
            elif parsed.get("requires-python") != ">=3.10":
                offenders[stack] = (
                    f"requires-python={parsed.get('requires-python')!r}")
            elif parsed.get("dependencies") != []:
                offenders[stack] = f"dependencies={parsed.get('dependencies')!r}"
        self.assertEqual(
            offenders, {},
            f"installed clients with a broken/missing PEP 723 block: "
            f"{offenders}")

    # -- 3. NEGATIVE CONTROL ----------------------------------------------

    def test_uv_run_fails_when_pep723_dependency_is_corrupted(self):
        """Proves the gate has BITE. A copy of the installed
        bun-crucible.py with its PEP 723 `dependencies` corrupted to name a
        package that cannot possibly exist MUST make `uv run` FAIL (a
        clean 0-exit here would mean guarantees 1-2 above pass vacuously,
        regardless of what the script's metadata says)."""
        clients_dir = self._require_installed_clients_dir()
        source_path = os.path.join(clients_dir, "bun-crucible.py")
        corrupt_dir = tempfile.mkdtemp(prefix="cr046-corrupt-",
                                        dir=self.tmp_root)
        self.addCleanup(shutil.rmtree, corrupt_dir, ignore_errors=True)
        corrupt_path = os.path.join(corrupt_dir, "corrupt-bun-crucible.py")

        text = Path(source_path).read_text(encoding="utf-8")
        corrupted = text.replace(
            "# dependencies = []",
            f'# dependencies = ["{CORRUPT_DEPENDENCY}"]')
        self.assertNotEqual(
            corrupted, text,
            "failed to corrupt the PEP 723 dependencies line -- the "
            "installed client's dependencies declaration must have "
            "changed shape")
        Path(corrupt_path).write_text(corrupted, encoding="utf-8")

        result = self._uv_run_help(corrupt_path)

        self.assertNotEqual(
            result.returncode, 0,
            f"expected `uv run` to FAIL against a corrupted PEP 723 "
            f"dependency, but it exited 0. stdout:\n{result.stdout}")
        self.assertIn(
            "definitely-not-a-real-package-xyzzy", result.stderr,
            f"expected the resolver failure to name the bogus dependency "
            f"on stderr; got:\n{result.stderr}")


if __name__ == "__main__":
    unittest.main()
