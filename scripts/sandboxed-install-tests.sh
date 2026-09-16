#!/usr/bin/env bash
# CR-CRU-138 §S3 L3 — run the install-touching python suites under a kernel-level
# sandbox, so even a hardcoded absolute write cannot reach the operator's real
# $HOME.
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
# Usage:
#   scripts/sandboxed-install-tests.sh            # the install-touching suites
#   scripts/sandboxed-install-tests.sh -k pattern # narrow by unittest -k
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

# --dev-bind / /   : the toolchain (python, uv, bun) stays reachable
# --tmpfs "$HOME"  : the operator's real home is shadowed by an empty tmpfs
# --tmpfs /run/user/$(id -u) : no session bus, so a stray `systemctl --user` fails
#                    loudly instead of touching the real session
# --bind REPO_ROOT : the checkout is writable, because pytest/unittest write
#                    caches and the suites read the repo's own files
# --unshare-user/pid/net : no privileged namespace, no stray processes, and NO
#                    NETWORK — nothing here may contact a board, PyPI or npm
exec bwrap \
  --dev-bind / / \
  --tmpfs "$HOME" \
  --tmpfs /run/user/"$(id -u)" \
  --bind "$REPO_ROOT" "$REPO_ROOT" \
  --dir "$SANDBOX_HOME" \
  --setenv HOME "$SANDBOX_HOME" \
  --setenv XDG_DATA_HOME "$SANDBOX_HOME/.local/share" \
  --setenv XDG_CONFIG_HOME "$SANDBOX_HOME/.config" \
  --setenv BUN_INSTALL "$SANDBOX_HOME/.bun" \
  --setenv CRUCIBLE_NO_SERVICE 1 \
  --setenv CRUCIBLE_NO_BUN_BOOTSTRAP 1 \
  --unshare-user \
  --unshare-pid \
  --unshare-net \
  --chdir "$REPO_ROOT" \
  python3 -m unittest discover -s tests/client -t . "$@"
