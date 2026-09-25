---
name: crucible-bootstrap-services
description: "Crucible project service lifecycle for the Mainline orchestrator — RESTORE at every /bootstrap mainline (the DEVELOPMENT board, whose port its own crucible.toml declares — a separate production install is never touched — vidushi registration, both Lavish sessions, the three Chrome tabs in the Pi tab group via the Pi relay, one storyboard poll) and TEAR DOWN at every /shutdown (close the tabs, end the Lavish sessions, stop the poll, unregister, stop the board). Use whenever bootstrapping, shutting down, or after an omp restart in ~/Documents/data_projects/crucible."
---

# Crucible — service lifecycle (bootstrap restore / shutdown teardown)

Run this as part of `/bootstrap mainline` for `~/Documents/data_projects/crucible`, after the role rules are loaded and BEFORE the status report to the user. Hub-supervised processes and relay tab handles die with every omp restart, so all of it is re-done each run. The Sandesh notifier is part of the restore — see step 6, and read its correction before deciding anything about it.

## 1. Board server — the DEVELOPMENT instance

**This skill names NO port and NO URL.** A skill drives the client scripts; the connection is
CONFIGURATION, and it is declared in `crucible.toml` — `[server]` for the listener,
`[client]` for the target board (CR-CRU-139). Read the value from there when you need it; never
hardcode one here, and never pass a URL to a client.

```
hub ps                                                 # is crucible-board-dev running?
hub start name=crucible-board-dev application=bun args=[run, src/server.ts] cwd=<repo>
python3 clients/python-crucible.py status              # the client finds the board itself
```
Plain `bun run` (no `--watch`); restart after every merge to develop so it serves the merged code.
Take `ready.port` from `[server] port` in **`data/crucible.toml`** — the file beside THIS board's
store, which is where an operator's declaration lives (`src/limits.ts:166` resolves it from the
store's directory). `src/crucible.toml` is the SHIPPED file (`SHIPPED_DATA_FILE`, `src/limits.ts:94`):
it documents the defaults we stand behind and declares no port for this instance, so reading the
port from there gives you production's number, not this one's. Neither number belongs in this file.
Health tells you which layer answered: `portRule: "file"` = the declaration was read,
`portRule: "shipped"` = nothing declared and you are about to collide with the production install.

**TWO INSTANCES ON THIS MACHINE (user ruling 2026-09-16).** A separate PRODUCTION install serves
every OTHER project on the workstation; it is **not this session's concern** — never start, stop or
write to it. This repo and Model B dog-food the DEVELOPMENT instance, whose port its own
`crucible.toml` declares. The data axis already separates itself and needs nothing: a server booted
from this repo adopts `<repo>/data/crucible.db` (the `cwd-data` rule), while a production install
keeps its own store under `~/.local/share/crucible/`.

**A client is never told where to post.** It resolves its own target from `clients/crucible.toml`
through the project → install → shipped chain (CR-CRU-138 §S1). So a dispatch brief carries the
assigned `--agent` id and nothing about connectivity. If a verb reaches the wrong board, the
defect is in that file or in the resolver — not something a brief should paper over with an export.

**When the port changes, the UI moves with it.** Step 4's tabs point at the board, so a port change
with a stale tab leaves the user looking at a dead page (done wrong 2026-09-16). Re-point the
`board` handle in the same turn, deriving its URL from the same config value, and wait for real
rendered text before reporting it healthy — a `domcontentloaded` read of this SPA returns ~370
chars and looks EMPTY.

## 1b. CDP relay (`:9224`) — restore it BEFORE the tabs; the tab group is named **Pi**

```
process start name=pi-relay command="bun .omp/skills/crucible-bootstrap-services/scripts/pi-relay.ts" \
              readyPattern="extension connected"
curl -s http://127.0.0.1:9224/json/list  # the user's tabs, as JSON
```
**The group is titled `Pi` (user ruling 2026-09-25).** `omp browser-relay serve` hard-codes the
title `omp` and has no flag for it, so `scripts/pi-relay.ts` starts omp's own relay server
(`startRelayServer`) with `group: { title: "Pi", color: "cyan" }` — same bridge, same port, only the
title differs. Never run `omp browser-relay serve` alongside it (the port is taken) and never pass
`group: false`.

The relay DIES between runs — nothing listens on 9224 until it is started, and step 4 then has
nothing to talk to. The extension half is the user's: it reconnects on its own within seconds (the
ready line reports its tab count). If `/json/list` answers but control fails, say so and wait; never
cold-start Chrome, and never `browser-relay install` behind the user's back.

## 2. Orchestrator registration

```
python3 clients/python-crucible.py register --agent vidushi --role ORCHESTRATOR
```
`vidushi` is pruned by silence — re-register before any board verb.

## 3. Lavish sessions (both artifacts)

```
npx -y lavish-axi .lavish/crucible-v2-design.html          # storyboard
npx -y lavish-axi .lavish/crucible-workflow-flowchart.html # design authority for roadmap CRs
```
Take the printed `url:` of each session. Do NOT rely on Lavish's own browser open — the workstation default is Zen, not Chrome. If a session was ended from the browser, `lavish-axi` refuses; pass `--reopen` only because bootstrap needs the surfaces back.

## 4. Chrome tabs: create your own, NEVER navigate the user's, and group them under **Pi**

```
bun .omp/skills/crucible-bootstrap-services/scripts/open-tabs.ts <storyboard-url> <flowchart-url>
process start name=pi-tab-claim command="bun .omp/skills/crucible-bootstrap-services/scripts/claim-tabs.ts" \
              readyPattern="holding claims"
```
- **`open-tabs.ts`** creates the board tab (URL derived from `[server] port` in
  `data/crucible.toml`) plus each Lavish session URL from step 3, through CDP
  `Target.createTarget` on the relay. It never navigates an existing tab, skips a URL that is
  already open, and prints `before= after= delta= ourTabsPresent= userTabsLost=`. It exits non-zero
  unless every tab is present and zero user tabs are lost.
- **`claim-tabs.ts`** is what GROUPS them. The relay only groups a tab some connection *claims*
  (the relay-private `OMP.claimTarget`, `bridge.ts`), and the claim lasts exactly as long as that
  connection. So it runs SUPERVISED for the whole session. If it exits, the tabs fall out of the
  group; relaunch it. Re-run it after opening a new project tab, because claims are taken once, at
  start. The relay log line `grouped tabs {... "grouped":{<tabId>:<groupId>}}` is the proof: every
  tab must share ONE group id.

**The hazard that broke this on 2026-09-08**, and why no script ever passes a URL to an existing
tab: omp's `browser.open({ name, url, app: { relay: true } })` **navigates the adopted tab**, and
with no `target` the adopted tab is the **user's visible tab**. It hijacked the user's `claude.ai`
tab twice. The page count stayed at 30 while three tabs were "opened", and all three handles
collapsed onto one URL.

- **Verify by delta, never by assertion.** `+N` pages AND zero baseline URLs lost. A flat page
  count means you are navigating the user's tabs, not creating your own. Stop immediately.
- Never `xdg-open`, never `google-chrome-stable <url>` from bash, never chrome-devtools-axi
  (cold-starts its own Chrome), never a supervised Chrome.
- If the user says stop, **STOP**. Do not restart the relay verbose and retry. That turned one
  hijacked tab into two.
- If the user closes your tabs or the relay drops mid-session, re-run `open-tabs.ts`, then relaunch
  `pi-tab-claim`.

## 5. One storyboard poll — SUPERVISED, not a fire-and-forget bash job

```
hub start name=lavish-poll-storyboard application=npx \
     args=[-y, lavish-axi, poll, .lavish/crucible-v2-design.html, --agent-reply, "<one-line state>"] \
     cwd=<repo>
```
Exactly one poll process (one-listener invariant; `pgrep -af 'lavish-axi poll'` must show none
before arming). Never truncate its output.

**THE REPLY IS THE RE-ARM — make them ONE command, never two steps.** The rule "re-arm after every
fetch" was already written here on 2026-09-18 and I broke it within the hour: the poll delivered
feedback, I read it, went off applying the change, and never restarted the listener — so the user's
NEXT message queued with nobody reading it and they had to ask twice. Reading a poll result and
arming the next poll are not two tasks that happen to be adjacent; a consumed poll IS a dead
listener, and the gap starts the instant you read it.

So the ONLY sanctioned shape after consuming feedback is a single `hub start` that carries the reply
and re-arms in the same call:

```
hub start name=lavish-poll-storyboard application=npx \
     args=[-y, lavish-axi, poll, <artifact>, --agent-reply, "<what changed>"] cwd=<repo>
```

Never answer in the conversation panel by any other route, and never apply the feedback first and
arm "once it's done" — apply-then-arm is exactly the window the user falls into.

**CORRECTED 2026-09-18 — this section used to say "as a tracked async bash job (`async: true`,
`timeout: 0`)", and that is how the user's editor went unattended for a whole session.** A poll
launched that way exits on its own (its review windows disconnect past the reconnect grace period —
and omp FREEZES idle tabs at turn settle, which drops the Lavish socket), and because nothing
supervises a detached bash job, **nothing tells you it is gone**. The user asked "have you stopped
listening to lavish editor" before I noticed.

`hub start` fixes exactly that: a supervised process announces its own exit, the same mechanism that
made the Sandesh notifier reliable all session (it exited twice, and both times the notice arrived
and it was relaunched in the same turn). Treat a dead poll like a dead watcher — relaunch it in the
turn you learn of it.

**Open the two Lavish tabs with `persist: true`** (step 4) so they are not auto-frozen at turn
settle; a frozen review window is the thing that kills the poll in the first place. Feedback is
never lost while the poll is down — it queues until a poll delivers it — so a re-arm always
recovers it, but the user is left talking to a surface nobody is reading.

## 6. Sandesh notifier

```
sandesh addressbook --project Crucible        # who can address me?
sandesh projects                              # CROSS-PROJECT grant per project
sandesh register --project Crucible --address 'Mainline - Crucible'   # only if inactive; NOT --as (that's unregister's flag)
hub start name=sandesh-notify-crucible application=sandesh \
     args=[notify, --project, Crucible, --to, "Mainline - Crucible", --timeout, 43200]
```

**`--timeout 43200`, raised from 14400 and MEASURED 2026-09-18.** The 4h ceiling fired mid-session:
`timed out (1441 polls)` — 1441 × 10s = exactly its 14400s — and `sandesh notify` exits **2** on
timeout, so `hub` reports the process as **failed** when nothing failed. That costs a relaunch every
four hours and, worse, trains you to read a red "failed" line as routine. 12h covers a working day
in one process. It is still a CEILING, not a heartbeat: when it fires, RELAUNCH — a timeout exit is
not a reason to leave the channel dead.

**Read the exit code before reacting:** `0` = mail arrived (fetch it, then relaunch), `2` = the
ceiling fired (just relaunch, there is no mail), anything else = a real fault worth reading the log
for.

**CORRECTED 2026-09-16. This section previously read "retired for this project — never launch it",
and that was wrong on both the fact and the framing.**

- **Wrong on fact.** The 2026-09-03 reasoning was "the addressbook holds only me, cross-project
  sending needs a CLI-only admin grant, and none exists, so the inbox has no possible sender."
  Measured 2026-09-16: `sandesh projects` shows **both `Crucible` and `ModelB` with
  `CROSS-PROJECT ✓`** — the grant exists — and `Mainline - ModelB` is **live**. A notifier started
  that day woke within *seconds* on real mail (#1370, #1371) carrying a direct request. A
  single-participant roster does NOT mean a silent inbox once a cross-project peer is granted.
- **Wrong on framing.** It was written as a standing prohibition and later quoted to the user as
  *their* rule when declining to start the watcher. It was self-authored. A note written here
  carries no authority over the user's choices and must never be presented as their decision.

So: **check, then act.** Launch the notifier when anyone can address this project — a Track on the
roster, or a cross-project peer with `CROSS-PROJECT ✓` (today: ModelB). Skip it and SAY SO only
when nothing can. The real 2026-09-03 cost was operational, not strategic: the watcher hit its
`--timeout 3600` ceiling and was relaunched five times in one day, and its log spam burned ~4,000
characters of context. Both are fixed by `--timeout 14400` and `hub start` (tracked, its output in
`hub logs`, not the transcript) — not by refusing to run it.

## Then

Report to the user per the bootstrap skill: services (board pid/health, sessions, tabs, poll), queue state from the client verbs (`status`, `queue`, `next`), carried todos. Do not dispatch.

---

# Shutdown teardown (`/shutdown`)

Reverse of the restore, run as part of the `shutdown` skill's teardown AFTER the active step is finished, todos drained, the tree clean and `vidushi`'s last board write done — and BEFORE the final report. Prior feedback: reporting "left running" for the board was wrong; the user expects the services DOWN and the tabs CLOSED. Order:

## 1. Storyboard poll

Cancel the tracked `lavish-axi poll` job (`hub cancel ids=[<job>]`); confirm `pgrep -af 'lavish-axi poll'` is empty. Never `pkill` by name machine-wide — ModelB's listener may share the host.

## 2. Lavish sessions

```
npx -y lavish-axi end .lavish/crucible-v2-design.html
npx -y lavish-axi end .lavish/crucible-workflow-flowchart.html
npx -y lavish-axi stop            # the background Lavish server (:4387)
```
Ending as the agent still allows a plain reopen at the next bootstrap.

## 3. Chrome tabs

The project's tabs are CLOSED, not merely released, while the relay is still up:

```
bun .omp/skills/crucible-bootstrap-services/scripts/close-tabs.ts
process kill pi-tab-claim        # AFTER the close: the tabs are gone, the claims go with them
```
`close-tabs.ts` closes by URL, never by a held handle and never by assumption. It snapshots
`/json/list`, then selects ONLY pages on the board port this project DECLARES (from
`data/crucible.toml`) or on the Lavish server. A production-install page is not ours, so it is left
open. It closes each one with CDP `Page.close`, re-snapshots, and prints
`delta= expected= oursLeft= userTabsLost=`. It exits non-zero unless `oursLeft=0` and
`userTabsLost=0`. Anything else this session opened (e.g. a release-checking
`npmjs.com/package/@anthill-tec` or `github.com/anthill-tec/crucible/actions` tab) is closed the
same way, by exact URL.

**If relay CONTROL fails, stop and say so.** Observed 2026-09-16 at shutdown: `/json/list` answered
normally (39 pages) while every attach died with
`Protocol error (Network.enable): extension rpc 'send' timed out after 20000ms`. The extension half
is the user's. Retry ONCE; if it still fails, report the tabs as "left open, yours to close" naming
their URLs, and continue the teardown. Do NOT restart the relay verbose and retry. That escalation
is what hijacked a user tab once before.


## 4. Orchestrator registration

```
python3 clients/python-crucible.py unregister --agent vidushi
```
Must run while the board is still up.

## 5. Board server + relay: LAST

```
process kill crucible-board-dev-<n>
process kill pi-relay            # AFTER close-tabs: closing a tab needs the relay alive
```
State is in `data/crucible.db`; a stop is safe. Confirm `hub ps` shows both exited, the declared board port answers
nothing, and 9224 has no listener. The relay is stopped AFTER the tabs are closed — closing a tab
needs the relay alive.

## 6. Sandesh notifier — the FINAL action, and it is NOT relaunched

```
hub stop name=sandesh-notify-crucible                       # only the one THIS session owns
sandesh unregister --project Crucible --as 'Mainline - Crucible' --addr 'Mainline - Crucible'
```

This is the single documented override of the relaunch-on-exit prime directive, and it applies
ONLY here, at a confirmed shutdown's last step. Keep the notifier alive through the whole teardown
— it is how a late emergency-stop or a peer's last message reaches you.

- `unregister` needs **BOTH** `--as` and `--addr`; with `--addr` alone it fails
  `pass --as '<your address>'`. The roster then reads `inactive / ○ offline`.
- **Kill only the process you own.** `pgrep -af 'sandesh notify'` on this host also matches
  **ModelB's** watcher (`--to Mainline - ModelB --project ModelB`) — measured 2026-09-16. A
  machine-wide `pkill sandesh` takes down another orchestrator's channel. Stop it by its `hub`
  name, and if you must match by pattern, match your own exact address.

Then the shutdown report names each of the SIX as down/closed/left-open, with the evidence
(`json/list` count, `hub ps` line, roster state) — and where a step could not complete, says so
plainly and hands it back to the user rather than reporting it as done.
