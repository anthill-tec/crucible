# CR-CRU-070 — systemd `--user` unit: install script provisions and reverses it

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 066, 069
- **Status**: PENDING (0.2.0)

## Problem

CR-CRU-066 deferred the systemd `--user` daemon to "a follow-up CR" and that CR
was never filed. The deferral is not inert — shipped 0.1.2 code and specs make
four forward-references to a unit that does not exist:

| site | reference |
|---|---|
| `docs/changes/CR-CRU-066…md:205` | deferred: `crucible-axi service …` + unit template |
| `docs/changes/CR-CRU-066…md:82,153,177` | absolute-path resolution and 128+N signal exits exist *for* the unit |
| `crucible_axi/cli.py:130` | "so a shell — and the follow-up systemd `--user` unit — sees the real …" |
| `crucible_axi/install.py:83` | "a systemd `--user` unit (the follow-up CR) inherits neither the …" |
| `crucible_axi/install.py:397` | "the follow-up systemd `--user` unit …" |

So today the only way to run the server persistently is a foreground
`crucible-axi serve` in a terminal — the exact ergonomics the original bug
report complained about — while three shipped comments imply a supported daemon.

CR-CRU-066 already paid this CR's prerequisites deliberately: absolute-path
launch (a unit inherits no shell PATH), `130` on Ctrl-C, and `128+N` when
signalled, so `systemctl --user stop` yields a truthful status rather than a
spurious failure.

## Design — the script provisions it, and reverses it

The unit is installed and removed **by the install script**, along the same
delegation path as everything else, and teardown is the strict inverse
(CR-CRU-069):

```
install:    install.sh → crucible-axi install    [bun] [server] [unit: write, daemon-reload, enable --now]
uninstall:  install.sh → crucible-axi uninstall  [unit: disable --now, rm, daemon-reload] [state] [server] → uv tool uninstall
```

**The unit stage is torn down FIRST.** Removing the server package while an
enabled unit still points at `~/.bun/bin/crucible-server` would leave systemd
restarting a deleted binary — so this CR extends CR-CRU-069's inversion order
(state → server) to (unit → state → server).

## Scope

Non-goals, explicitly:

- **Not a system-wide unit.** `--user` only: no root, no `sudo`, no
  `/etc/systemd/system`. Consistent with the user-scoped `bun add -g` install.
- **No change** to `serve`'s argv, exit codes, or its envelope-free contract
  (CR-CRU-066) — the unit *consumes* `serve`, it does not modify it.
- **No systemd dependency for the base install.** A machine without systemd (or
  a container, or macOS) must still install and uninstall cleanly.

## Acceptance criteria

**AC1 — the unit runs the server the way `serve` does.** `ExecStart` invokes the
absolute resolved launcher (never a bare `crucible-server`/`bun` off PATH,
because a unit inherits no shell PATH — the reason CR-CRU-066 resolves
absolutely), with `Restart=on-failure`, `WantedBy=default.target`, and the
store/port/host taken from the same `CRUCIBLE_*` environment contract the server
already honours.

**AC2 — install is idempotent and reversible.** The unit stage writes the unit,
`daemon-reload`s, and `enable --now`s; re-running converges (unit unchanged →
no rewrite, already-active → no restart). Teardown does `disable --now`, removes
the unit file, and `daemon-reload`s, converging when the unit is already absent.

**AC3 — teardown order is enforced, not documented.** `uninstall` runs the unit
stage strictly before the server stage, asserted by a test that fails if the
order inverts — the failure mode is systemd restarting a deleted binary.

**AC4 — absent systemd degrades, never fails.** With no `systemctl` on PATH (or
no user D-Bus session), the unit stage reports skipped-with-reason and
`install`/`uninstall` still exit 0. `--no-service` / `CRUCIBLE_NO_SERVICE=1`
opts out explicitly. A skipped unit stage never fails the overall install.

**AC5 — signal semantics are honoured end to end.** `systemctl --user stop`
produces a clean stop, not a failed unit — the 128+N contract CR-CRU-066 shipped
is asserted through the unit, not just through `serve`.

**AC6 — the dangling references are reconciled.** The three shipped comments
(`cli.py:130`, `install.py:83`, `install.py:397`) and CR-CRU-066's deferral note
stop saying "the follow-up CR" and name this one, so no shipped comment points
at unwritten work.

**AC7 — real verification, no mocked systemd.** The unit is installed, started,
queried (`is-active`), stopped, and removed against the real user systemd on a
machine that has it; the port-binding check uses a non-default port so it can
never collide with the dog-food instance on 3849.

## Notes

- Filed 2026-08-20 after the maintainer asked what became of it. It was
  deferred in CR-066 and never queued — the omission is recorded here rather
  than silently backfilled.
- CR-CRU-069 must land first (or together): this CR extends its stage inversion,
  and shipping the unit without teardown would recreate the orphaning problem
  069 exists to fix — with a running daemon attached.
