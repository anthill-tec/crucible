#!/usr/bin/env bash
# CR-CRU-138 §S3 L3 — run the install-touching python suites under a kernel-level
# sandbox, so even a hardcoded absolute write cannot reach the operator's real
# $HOME.
#
# THE SUITE THIS EXISTS FOR
#   tests/client/test_an_installed_deployment_resolves_its_configuration.py
# is the one that installs and THEN resolves, so it drives the real installer
# end to end. Every other suite under tests/client/ is wrapped too, because
# discovery runs the directory and any of them may grow an install-driving
# fixture later.
#
# WHY THIS EXISTS, AND WHY IT IS NOT IN CI
# The suites below drive the REAL installer: it writes files, and two of its
# stages would otherwise run `bun add -g` and `systemctl --user enable --now`.
# The suites already sandbox themselves at two levels — L1 pins $HOME,
# $XDG_DATA_HOME, $XDG_CONFIG_HOME and $BUN_INSTALL into a temp root and stubs
# those two stages; L2 asserts the operator's real paths did not move. Both are
# portable and both run in CI.
#
# L1 protects the machine only from code that plays by the rules. A hardcoded
# path, an `expanduser` evaluated before the patch, or a subprocess handed a
# stale environment all escape it. This script closes that last gap by making
# the escape land on a tmpfs that evaporates: $HOME is replaced wholesale.
#
# It is deliberately NOT a CI job. `bwrap` is not guaranteed on `ubuntu-latest`,
# and a runner's $HOME dies with the container anyway — there is nothing there to
# protect. The value is local: YOUR dotfiles, YOUR ~/.crucible, YOUR systemd
# units.
#
# NETWORK IS OFF, SO THE DEFAULT TARGET IS NARROW
# `--unshare-net` is part of the isolation, and some suites under tests/client/
# legitimately need the network (`python -m build --wheel` reaches pypi.org, and
# the uv/cargo/docker gates reach their own registries). Wrapping the whole
# directory therefore reports dozens of failures that say nothing about the code
# — so with NO arguments this runs the install-touching suites only, which is
# what the sandbox exists for. Pass your own unittest arguments to widen it, and
# expect network-dependent suites to fail when you do.
#
# Usage:
#   scripts/sandboxed-install-tests.sh                  # the install suites
#   scripts/sandboxed-install-tests.sh -k pattern       # your own narrowing
#   scripts/sandboxed-install-tests.sh -k ''            # the whole directory
#                                                       # (network-dependent
#                                                       #  suites will fail)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v bwrap >/dev/null 2>&1; then
  cat >&2 <<'MSG'
bwrap (bubblewrap) is not on PATH, so this script cannot isolate anything and
will NOT silently run the suites unsandboxed — that would hand you the exact
false assurance this script exists to remove.

  Arch/CachyOS: sudo pacman -S bubblewrap
  Debian/Ubuntu: sudo apt install bubblewrap

The suites' own L1+L2 sandboxing is independent of this script: running them
directly with `python3 -m unittest discover -s tests/client -t .` is safe by
design and is exactly what CI does.
MSG
  exit 127
fi

# A scratch HOME inside the sandbox. Bound as a tmpfs, so writes live in memory
# and vanish with the process — including any write that ignored $HOME entirely.
SANDBOX_HOME=/tmp/crucible-sandbox-home

echo "==> bwrap $(bwrap --version | awk '{print $2}')  |  \$HOME -> tmpfs  |  repo bound read-write"
echo "==> real \$HOME ($HOME) is NOT visible inside the sandbox"

# With no arguments, target the suites that actually drive the installer. The
# pattern is unittest's own `-k` substring match, so it needs no list of file
# names to fall out of date. `-k ''` from the caller widens to the directory.
if [ "$#" -eq 0 ]; then
  set -- -k an_installed_deployment -k installer_lays_down -k cr069_uninstall \
         -k cr090 -k crucible_axi_install -k crucible_axi_stages
  echo "==> default target: the install-touching suites (network is off; pass your own arguments to widen)"
fi

# --dev-bind / /   : the toolchain (python, uv) stays reachable
# --tmpfs "$HOME"  : the operator's real home is shadowed by an empty tmpfs
# --ro-bind bun    : bun lives under $HOME/.bun, which the tmpfs above shadows,
#                    so it is re-exposed OUTSIDE $HOME and READ-ONLY. Suites
#                    that resolve the bun binary then work, and no test can
#                    write into the operator's real bun prefix — the isolation
#                    is kept, not traded away for convenience.
# --tmpfs /run/user/$(id -u) : no session bus, so a stray `systemctl --user` fails
#                    loudly instead of touching the real session
# --bind REPO_ROOT : the checkout is writable, because pytest/unittest write
#                    caches and the suites read the repo's own files
# --unshare-user/pid/net : no privileged namespace, no stray processes, and NO
#                    NETWORK — nothing here may contact a board, PyPI or npm
SANDBOX_BUN=/tmp/crucible-sandbox-bun
BUN_PREFIX="${BUN_INSTALL:-$HOME/.bun}"
bun_binding=(--tmpfs "$SANDBOX_BUN")
if [ -d "$BUN_PREFIX" ]; then
  bun_binding=(--ro-bind "$BUN_PREFIX" "$SANDBOX_BUN")
fi

# NOTHING here sets CRUCIBLE_NO_SERVICE / CRUCIBLE_NO_BUN_BOOTSTRAP. An earlier
# version did, "belt and braces", and it silently OVERRODE what the suites
# assert: test_server_stage_bootstraps_bun_via_curl_installer_before_provision_
# when_bun_absent exists to check that the bootstrap RUNS, so a sandbox that
# disables it makes that suite fail for a reason having nothing to do with the
# code. The suites own their own stubbing (L1); this script owns the filesystem
# and the network, and nothing else.
exec bwrap \
  --dev-bind / / \
  --tmpfs "$HOME" \
  "${bun_binding[@]}" \
  --tmpfs /run/user/"$(id -u)" \
  --bind "$REPO_ROOT" "$REPO_ROOT" \
  --dir "$SANDBOX_HOME" \
  --setenv HOME "$SANDBOX_HOME" \
  --setenv XDG_DATA_HOME "$SANDBOX_HOME/.local/share" \
  --setenv XDG_CONFIG_HOME "$SANDBOX_HOME/.config" \
  --setenv BUN_INSTALL "$SANDBOX_BUN" \
  --setenv PATH "$SANDBOX_BUN/bin:/usr/local/bin:/usr/bin:/bin" \
  --unshare-user \
  --unshare-pid \
  --unshare-net \
  --chdir "$REPO_ROOT" \
  python3 -m unittest discover -s tests/client -t . "$@"
