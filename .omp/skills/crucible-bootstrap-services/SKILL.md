---
name: crucible-bootstrap-services
description: "Crucible project service lifecycle for the Mainline orchestrator — RESTORE at every /bootstrap mainline (the DEVELOPMENT board, whose port its own crucible.toml declares — a separate production install is never touched — vidushi registration, both Lavish sessions, the three Chrome tabs under the omp group via the relay, one storyboard poll) and TEAR DOWN at every /shutdown (close the tabs, end the Lavish sessions, stop the poll, unregister, stop the board). Use whenever bootstrapping, shutting down, or after an omp restart in ~/Documents/data_projects/crucible."
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
Take `ready.port` from `[server] port` in `src/crucible.toml` rather than writing a number into
this file.

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

## 1b. CDP relay (`:9224`) — restore it BEFORE the tabs

```
ss -ltnp | grep 9224                     # is the relay listening?
hub start name=omp-relay application=omp args=[browser-relay, serve] ready.port=9224
curl -s http://127.0.0.1:9224/json/list  # the user's tabs, as JSON
```
The relay is a bootstrap service and it DIES between runs — after an omp restart it is absent from
`hub ps` and nothing listens on 9224, and step 4 then silently degrades to driving the user's
visible tab. Default grouping is what puts your tabs in Chrome's **omp** group — never
`--no-group`. The extension half is the user's: if `/json/list` answers but control fails, say so
and wait; never cold-start Chrome, and never `browser-relay install` behind the user's back.

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

## 4. Chrome tabs — CREATE your own, NEVER navigate the user's

**The hazard that broke this on 2026-09-08:** with `app: { relay: true }`, passing `url`
**navigates the adopted tab**, and with no `target` the adopted tab is the **user's visible tab**.
`browser.open({ name, url, app: { relay: true } })` — the pattern this section used to prescribe —
hijacked the user's `claude.ai` tab twice: total page count stayed at 30 while three tabs were
"opened", and all three handles collapsed onto one URL. **Never pass `url` to `browser.open`
against the user's Chrome.** `/json/new` is 405 on the relay, so Puppeteer `newPage()` is the ONLY
creation path. In `eval` (JS):

```js
const snap = async () => (await fetch("http://127.0.0.1:9224/json/list").then(r => r.json()))
  .filter(t => t.type === "page").map(t => t.url);

await browser.close({ all: true });   // 1. drop stale handles FIRST — a dead handle falls back to the visible tab
const before = await snap();          // 2. baseline of the USER's tabs

// 3. read-only anchor: `target` and NO `url` => attaches, navigates nothing
const anchor = await browser.open({
  name: "anchor",
  app: { relay: true, target: before.find(u => u.includes("status.claude.com")) ?? before[0] },
});

// 4. CREATE each tab through the anchor's Puppeteer connection
for (const url of [boardUrl, storyboardUrl, flowchartUrl]) {
  await anchor.run(async ({ page }, target) => {
    const p = await page.browser().newPage();
    await p.goto(target, { waitUntil: "domcontentloaded" });
  }, { args: [url] });
}

// 5. attach handles by unique target (still NO `url`) — marks them controllable, so the relay
//    gathers them into Chrome's "omp" group
for (const [name, target] of [
  ["board", boardHost],   // boardHost derived from [server] port in src/crucible.toml
  ["storyboard", "session/<storyboard-session-id>"],
  ["flowchart", "session/<flowchart-session-id>"],
]) await browser.open({ name, app: { relay: true, target } });
await browser.close({ name: "anchor" });

const after = await snap();           // 6. PROVE isolation before reporting
// after.length - before.length === 3   &&   before.filter(u => !after.includes(u)).length === 0
```
- **Verify by delta, never by assertion.** `+3` pages AND zero baseline URLs lost. A flat page
  count means you are navigating the user's tabs, not creating your own — stop immediately.
- Also assert every handle is bound to a distinct URL and none of them is a baseline URL. Three
  handles reading the same URL is the hijack signature.
- **Keep the handles for the whole session**; release only at `/shutdown`.
- Never `xdg-open`, never `google-chrome-stable <url>` from bash, never chrome-devtools-axi
  (cold-starts its own Chrome), never a supervised Chrome via hub.
- If the user says stop, **STOP**. Do not restart the relay verbose and retry — that turned one
  hijacked tab into two.
- If the user closes your tabs or disconnects the relay mid-session, redo this whole sequence from
  step 1; stale handles are the danger, not the closed tabs.

## 5. One storyboard poll

```
npx -y lavish-axi poll .lavish/crucible-v2-design.html --agent-reply "<one-line state summary>"
```
As a tracked async bash job (`async: true`, `timeout: 0`). Exactly one poll process (one-listener invariant; `pgrep -af 'lavish-axi poll'` must show none before arming). Re-arm on the same artifact after every fetch; never truncate its output.

## 6. Sandesh notifier

```
sandesh addressbook --project Crucible        # who can address me?
sandesh projects                              # CROSS-PROJECT grant per project
sandesh register --project Crucible --as 'Mainline - Crucible'   # only if inactive
hub start name=sandesh-notify-crucible application=sandesh \
     args=[notify, --project, Crucible, --to, "Mainline - Crucible", --timeout, 14400]
```

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

The three relay-managed tabs are CLOSED, not merely released. In `eval` (JS), for each held handle (`storyboard`, `flowchart`, `board`):

```js
for (const name of ["storyboard", "flowchart", "board"]) {
  const t = browser.tab(name);
  await t.run(async ({ page }) => { await page.close(); });   // closes the real Chrome tab
}
await browser.close({ all: true });                           // then drop the handles
```
`browser.close` alone never closes a relay page (docs: "Connected and relay pages remain open"), so `page.close()` inside `tab.run` is the step that removes the tab from the omp group. Verify with `GET http://127.0.0.1:9224/json/list` — no Lavish page and no page on this project's declared board port remain (a production-install page is not ours, leave it).

**Close by URL, not by held handle, and never by assumption.** Handles go stale across an omp
restart and a dead handle falls back to the user's visible tab. Snapshot `/json/list` first, select
ONLY pages whose host:port matches the board port this project DECLARES (read it from
`src/crucible.toml`) or the Lavish server — never a page belonging to the production install,
which is not ours to close — plus anything this session itself opened, e.g. a
release-checking `npmjs.com/package/@anthill-tec` or `github.com/anthill-tec/crucible/actions`
tab), then attach a read-only anchor (`target` + NO `url`) and close those URLs through its
Puppeteer connection. Re-snapshot and prove the delta: the count drops by exactly the number
closed, and **zero baseline URLs of the user's are gone**.

**If relay CONTROL fails, stop and say so.** Observed 2026-09-16 at shutdown: `/json/list` answered
normally (39 pages) while every attach died with
`Protocol error (Network.enable): extension rpc 'send' timed out after 20000ms`. The extension half
is the user's. Retry ONCE after `browser.close({all:true})`; if it still fails, release the handles,
report the tabs as "left open, yours to close" naming their URLs, and continue the teardown. Do NOT
restart the relay verbose and retry — that escalation is what hijacked a user tab once before.


## 4. Orchestrator registration

```
python3 clients/python-crucible.py unregister --agent vidushi
```
Must run while the board is still up.

## 5. Board server + relay — LAST

```
hub stop name=crucible-board
hub stop name=omp-relay          # only if THIS session started it
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
