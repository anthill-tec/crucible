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

## 4. Chrome tabs under the omp group (relay)

The user's visual contract: the three project tabs sit in Chrome's **omp** tab group, which only happens while the omp relay holds them. In `eval` (JS):

```js
const specs = [
  ["storyboard", "session/<storyboard-session-id>", "<storyboard url>"],
  ["flowchart",  "session/<flowchart-session-id>",  "<flowchart url>"],
  ["board",      "127.0.0.1:3849/",                 "http://127.0.0.1:3849/"],
];
const list = await fetch("http://127.0.0.1:9224/json/list").then(r => r.json());
for (const [name, target, url] of specs) {
  const exists = list.some(t => t.type === "page" && t.url.includes(target));
  await browser.open(exists
    ? { name, app: { relay: true, target } }        // adopt the existing tab
    : { name, url, app: { relay: true } });        // open a new managed tab
}
```
- `target` goes INSIDE `app` — a top-level `target` is ignored and the visible tab is adopted instead.
- Check `/json/list` first so nothing is opened twice.
- **Keep the handles for the whole session.** `browser.close({ all: true })` releases them and pulls the tabs out of the omp group. Release only at `/shutdown`.
- Never `xdg-open`, never `google-chrome-stable <url>` from bash, never chrome-devtools-axi (cold-starts its own Chrome), never a supervised Chrome via hub.

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

## 5. Board server — LAST

```
hub stop name=crucible-board
```
State is in `data/crucible.db`; a stop is safe. Confirm `hub ps` shows it exited and `:3849` answers nothing.

Then the shutdown report names each of the five as down/closed, with the evidence (`json/list` count, `hub ps` line).
