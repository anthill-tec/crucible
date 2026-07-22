#!/bin/sh
# Crucible — one-line distro-agnostic bootstrap (CR-CRU-009 §S1).
#
#   curl -fsSL <crucible>/install.sh | sh
#
# The ONLY prerequisites are `curl` and `sh`. No apt/dnf/pacman, no
# pre-existing system Python or Node: `uv` is a single static distro-agnostic
# binary that brings its own Python, and it installs the `crucible-axi`
# primary orchestrator from PyPI. `crucible-axi install` then self-provisions
# the rest (bun/node server via npx, the multi-harness skill set) — see §S2.
#
# Re-running this script is safe (idempotent): uv and the tool install both
# converge, and `crucible-axi install` is itself idempotent.
#
# Skip the staged install with `--no-install`, or `CRUCIBLE_NO_INSTALL=1`:
#   curl -fsSL <crucible>/install.sh | sh -s -- --no-install
#
# NOTE: the canonical hosting URL for THIS script (the `<crucible>` above) is a
# human-gated deploy step (open-source the repo + publish) — see §S4/§S6. Only
# Astral's own uv installer URL is hardcoded below, as its canonical source.

set -eu

# --- args / flags -----------------------------------------------------------
run_install="${CRUCIBLE_NO_INSTALL:+0}"
run_install="${run_install:-1}"
for arg in "$@"; do
  case "$arg" in
    --no-install) run_install=0 ;;
    *) echo "install.sh: ignoring unknown argument '$arg'" >&2 ;;
  esac
done

echo "==> Crucible bootstrap starting"

# --- 1. ensure uv (Astral) --------------------------------------------------
if command -v uv >/dev/null 2>&1; then
  echo "==> uv already present ($(uv --version 2>/dev/null || echo uv))"
else
  echo "==> uv not found — installing via Astral's canonical bootstrap"
  # Astral's own installer: a single static binary that brings its own Python.
  curl -fsSL https://astral.sh/uv/install.sh | sh
  # uv installs to ~/.local/bin (or $XDG_BIN_HOME); make it visible for the
  # rest of THIS script even before the user re-sources their shell profile.
  if ! command -v uv >/dev/null 2>&1; then
    PATH="${HOME}/.local/bin:${PATH}"
    export PATH
  fi
  echo "==> uv installed ($(uv --version 2>/dev/null || echo uv))"
fi

# --- 2. install the crucible-axi primary orchestrator (PyPI) ----------------
echo "==> Installing crucible-axi (PyPI primary orchestrator) via uv"
uv tool install crucible-axi
echo "==> crucible-axi installed"

# --- 3. run the staged sub-installers (§S2) ---------------------------------
if [ "$run_install" = "1" ]; then
  echo "==> Running staged install: crucible-axi install"
  crucible-axi install
else
  echo "==> Skipping staged install (--no-install / CRUCIBLE_NO_INSTALL set)"
  echo "    Run it later with: crucible-axi install"
fi

echo "==> Crucible bootstrap complete"
