"""The plain helpers of `test_next_lane_carries_release_and_wave`: the
client's own `next` verb driven in process against a board over a real
socket.

Not a test module: it holds no `TestCase`. Lifted from the merged
`test_cr092_next_decision_resolver` with its track-canonicalisation class
(`TrackCanonicalisationAgreesWithTheServerTest`), which reads the decision
the server's `GET …/next` gives through the REAL shared `cmd_next`.
"""

import importlib.util
from argparse import Namespace

from tests.client import TEST_INSTALL_CLIENTS

AXI_MODULE_PATH = TEST_INSTALL_CLIENTS / "_crucible_axi.py"


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(AXI_MODULE_PATH, "cr092_axi_under_test")


def _refuse_write(*args, **kwargs):
    raise AssertionError(f"`next` is read-only and attempted a write: {args!r}")


def _next_through_the_client(base, key, track):
    """`(ok, code, fields)` from the REAL shared `cmd_next`, reading the
    scratch server's `GET …/next` over a real socket (CR-CRU-098 §S3) — the
    drive the deleted client `resolve_next` used to stand in for. The envelope
    is captured at the emitter seam, so nothing is printed."""
    emitted = []

    def _emit(verb, ok, fields, context, warnings, legacy_line=None):
        emitted.append((ok, fields))

    ops = AXI.ClientOps(
        get=lambda path: AXI.http_request(base, "GET", path, timeout=15),
        post=_refuse_write, patch=_refuse_write, emit=_emit,
        context=lambda project_dir, **kwargs: AXI.axi_context(key, **kwargs),
        agent_id=_refuse_write,
        project_key=lambda project_dir: key,
        plans_path=lambda project_dir: f"/api/v2/projects/{key}/plans",
        open_plans=lambda project_dir: [],
        resolve_plan=lambda *args, **kwargs: None,
        post_gate=_refuse_write, post_milestone=_refuse_write, base_url=base)
    code = AXI.cmd_next(
        Namespace(project_dir=None, track=track, release=None, wave=None,
                  fields=None), None, ops)
    assert len(emitted) == 1, f"`next` must emit ONE envelope: {emitted!r}"
    ok, fields = emitted[0]
    return ok, code, fields
