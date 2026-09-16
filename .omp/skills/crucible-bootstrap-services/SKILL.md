---
name: crucible-bootstrap-services
description: "Crucible project service lifecycle for the Mainline orchestrator — RESTORE at every /bootstrap mainline (board server on :3849, vidushi registration, both Lavish sessions, the three Chrome tabs under the omp group via the relay, one storyboard poll) and TEAR DOWN at every /shutdown (close the tabs, end the Lavish sessions, stop the poll, unregister, stop the board). Use whenever bootstrapping, shutting down, or after an omp restart in ~/Documents/data_projects/crucible."
---

# Crucible — service lifecycle (bootstrap restore / shutdown teardown)

Run this as part of `/bootstrap mainline` for `~/Documents/data_projects/crucible`, after the role rules are loaded and BEFORE the status report to the user. Hub-supervised processes and relay tab handles die with every omp restart, so all of it is re-done each run. Sandesh notifier: retired for this project — never launch it.

## 1. Board server (`:3849`)

```
hub ps                                   # is crucible-board running?
hub start name=crucible-board application=bun args=[run, src/server.ts] cwd=<repo> ready.port=3849
curl -s http://127.0.0.1:3849/api/v2/health   # {"ok":true,"status":"healthy",...}
```
Plain `bun run` (no `--watch`); restart after every merge to develop so it serves the merged code.

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
  ["board", "127.0.0.1:3849/"],
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
`browser.close` alone never closes a relay page (docs: "Connected and relay pages remain open"), so `page.close()` inside `tab.run` is the step that removes the tab from the omp group. Verify with `GET http://127.0.0.1:9224/json/list` — no `127.0.0.1:4387` or `127.0.0.1:3849` pages remain.

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
State is in `data/crucible.db`; a stop is safe. Confirm `hub ps` shows both exited, `:3849` answers
nothing, and 9224 has no listener. The relay is stopped AFTER the tabs are closed — closing a tab
needs the relay alive.

Then the shutdown report names each of the five as down/closed, with the evidence (`json/list` count, `hub ps` line).
