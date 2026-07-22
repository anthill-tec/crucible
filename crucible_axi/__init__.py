"""crucible-axi — the Crucible install orchestrator package (CR-CRU-009).

Primary entry point is the ``crucible-axi`` console script (``cli.main``),
which stages the server/skills/manifest sub-installers and emits a single
TOON-AXI envelope. This cycle (C1) builds the orchestrator framework +
discovery manifest with the external tools mocked/injected; the real
sub-installer delegation is C2.
"""
