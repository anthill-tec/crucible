#!/bin/sh
# Crucible — one-line distro-agnostic bootstrap (CR-CRU-009 §S1).
#
#   curl -fsSL https://raw.githubusercontent.com/anthill-tec/crucible/master/install.sh | sh
#
# That URL is this script's canonical home: the repo is public, and `master`
# only advances at a release, so the `master` ref always serves the installer
# of the latest RELEASED version and never needs a per-release bump. Astral's
# uv installer URL below is likewise its own canonical source.
#
# The ONLY prerequisites are `curl` and `sh`. No apt/dnf/pacman, no
# pre-existing system Python or Node: `uv` is a single static distro-agnostic
# binary that brings its own Python, and it installs the `crucible-axi`
# primary orchestrator from PyPI. `crucible-axi install` then provisions the
# rest and EXITS — it guarantees Bun (the server's runtime), provisions the
# Bun server user-scoped, and writes the client discovery manifest under its
# target dir (the `server` and `manifest` stages) — see §S2.
#
# Re-running this script is also how you UPGRADE (CR-CRU-072): an existing
# install is advanced with `uv tool upgrade` — uv's `install` alone no-ops over
# one — and the staged install then follows so the server half matches the CLI.
# On a fully-current machine it converges with no reinstall and no re-provision.
#
# Skip the staged install with `--no-install`, or `CRUCIBLE_NO_INSTALL=1`:
#   curl -fsSL https://raw.githubusercontent.com/anthill-tec/crucible/master/install.sh | sh -s -- --no-install
#
# TEARDOWN — the exact inverse, along the same path (CR-CRU-069):
#   curl -fsSL https://raw.githubusercontent.com/anthill-tec/crucible/master/install.sh | sh -s -- --uninstall
# `crucible-axi uninstall` reverses the stages it owns (program artifacts only;
# the store and config survive), and `uv tool uninstall` runs LAST because a
# running tool cannot remove itself. Add `--purge` to also destroy the store and
# config — nothing else deletes them.

set -eu

# --- args / flags -----------------------------------------------------------
run_install="${CRUCIBLE_NO_INSTALL:+0}"
run_install="${run_install:-1}"
mode=install
purge=0
for arg in "$@"; do
  case "$arg" in
    --no-install) run_install=0 ;;
    --uninstall) mode=uninstall ;;
    --purge) purge=1 ;;
    *) echo "install.sh: ignoring unknown argument '$arg'" >&2 ;;
  esac
done

# --- teardown (inverse of everything below) ---------------------------------
if [ "$mode" = uninstall ]; then
  echo "==> Crucible teardown starting"
  if command -v crucible-axi >/dev/null 2>&1; then
    if [ "$purge" = 1 ]; then
      echo "==> Reversing staged install: crucible-axi uninstall --purge"
      crucible-axi uninstall --purge
    else
      echo "==> Reversing staged install: crucible-axi uninstall"
      crucible-axi uninstall
    fi
  else
    # A partially-uninstalled machine still converges: with the verb already
    # gone there are no stages left for it to reverse.
    echo "==> crucible-axi not present — skipping the staged teardown"
  fi
  # LAST: the tool that ran the verb. Tolerated when already absent so a
  # re-run of this teardown is indistinguishable from one run.
  if command -v uv >/dev/null 2>&1; then
    echo "==> Removing the crucible-axi tool: uv tool uninstall crucible-axi"
    uv tool uninstall crucible-axi || true
  else
    echo "==> uv not present — nothing to remove"
  fi
  echo "==> Crucible teardown complete (Bun left installed; the store and"
  echo "    config are kept unless --purge was passed)"
  exit 0
fi

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

# --- 2. install OR upgrade the crucible-axi primary orchestrator (PyPI) -----
# uv's `install` does NOT advance an already-installed tool — it reports
# "Checked 1 package" and leaves the old version in place, which stranded every
# existing user on a stale CLI (CR-CRU-072). Advancing is `uv tool upgrade`.
# Version selection stays uv's job: no version specifier appears here.

# The version uv currently has installed, or empty when the tool is absent.
axi_version() {
  uv tool list 2>/dev/null | awk '$1 == "crucible-axi" { v = $2; sub(/^v/, "", v); print v; exit }'
}

axi_before="$(axi_version || true)"
advanced=0

if [ -n "$axi_before" ]; then
  echo "==> crucible-axi already installed ($axi_before) — asking uv for the latest release"
  # `uv tool install --upgrade`, NOT `uv tool upgrade`: the latter resolves
  # WITHIN the constraint the tool was installed under, so a tool installed as
  # `crucible-axi==X` reports "already current" forever and never advances
  # (measured against real uv 0.11.8: seeded 0.1.1, `uv tool upgrade` left it
  # at 0.1.1; `--upgrade` moved it to 0.1.2). `--upgrade` ignores that pin,
  # which is the only form that advances BOTH a pinned and an unpinned
  # install. Version selection is still entirely uv's: no specifier here.
  uv tool install --upgrade crucible-axi
  axi_after="$(axi_version || true)"
  if [ "$axi_after" = "$axi_before" ]; then
    echo "==> crucible-axi already current: $axi_before"
  else
    echo "==> crucible-axi upgraded: $axi_before -> ${axi_after:-unknown}"
    advanced=1
  fi
else
  echo "==> Installing crucible-axi (PyPI primary orchestrator) via uv"
  uv tool install crucible-axi
  axi_after="$(axi_version || true)"
  echo "==> crucible-axi installed${axi_after:+ ($axi_after)}"
  advanced=1
fi

# Nothing moved: converge silently rather than re-provisioning, and never claim
# a bootstrap completed over work that did not happen (AC3/AC6).
if [ "$advanced" = 0 ]; then
  echo "==> Nothing to do — the CLI and its staged install are already converged"
  exit 0
fi

# --- 3. run the staged sub-installers (§S2) ---------------------------------
if [ "$run_install" = "1" ]; then
  echo "==> Running staged install: crucible-axi install"
  crucible-axi install
else
  echo "==> Skipping staged install (--no-install / CRUCIBLE_NO_INSTALL set)"
  echo "    Run it later with: crucible-axi install"
fi

echo "==> Crucible bootstrap complete"
