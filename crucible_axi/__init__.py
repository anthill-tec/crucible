"""crucible-axi — the Crucible install orchestrator package (CR-CRU-009).

Primary entry point is the ``crucible-axi`` console script (``cli.main``),
which stages the server/skills/manifest sub-installers and emits a single
TOON-AXI envelope. This cycle (C1) builds the orchestrator framework +
discovery manifest with the external tools mocked/injected; the real
sub-installer delegation is C2.

CR-CRU-041 §S6 — composite release: this package and the Bun/TS server release
in lockstep off one ``vX.Y.Z`` tag, so ``__version__`` is DERIVED from the
installed distribution metadata (hatch-vcs writes it at build time) rather than
hand-maintained here. A source checkout has no installed ``crucible-axi``
distribution, so the lookup falls back to :data:`_SOURCE_CHECKOUT_VERSION`;
``CRUCIBLE_SERVER_VERSION`` is the documented escape hatch for pinning the
server fetch in that (and any other) situation.
"""

import importlib.metadata

#: Reported by :data:`__version__` when no installed distribution metadata
#: exists — i.e. the package is being run straight from a repo checkout.
_SOURCE_CHECKOUT_VERSION = "0.0.0.dev0+source"


def _resolve_version() -> str:
    """Return the installed distribution version, or the source-checkout
    sentinel when this package is not installed."""
    try:
        return importlib.metadata.version("crucible-axi")
    except importlib.metadata.PackageNotFoundError:
        return _SOURCE_CHECKOUT_VERSION


__version__ = _resolve_version()
