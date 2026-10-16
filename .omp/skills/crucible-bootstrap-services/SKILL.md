---
name: crucible-bootstrap-services
description: "Crucible project service lifecycle for the Mainline orchestrator — RESTORE at every /bootstrap mainline (the DEVELOPMENT board, whose port its own crucible.toml declares — a separate production install is never touched — vidushi registration, both Lavish sessions, the three Chrome tabs through the global `chrome-ui-relay` skill, one storyboard poll) and TEAR DOWN at every /shutdown (close the tabs through `chrome-ui-relay`, end the Lavish sessions, stop the poll, unregister, stop the board). Use whenever bootstrapping, shutting down, or after an omp restart in ~/Documents/data_projects/crucible."
---

# Crucible — service lifecycle (bootstrap restore / shutdown teardown)

Run this as part of `/bootstrap mainline` for `~/Documents/data_projects/crucible`, after the role rules are loaded and BEFORE the status report to the user. Supervised processes, Lavish sessions and browser tabs do not survive a session restart, so all of it is re-done each run. The harness is Pi: long-running processes go through its `process` tool, never a detached shell job. The Sandesh notifier is part of the restore — see step 6, and read its correction before deciding anything about it.

## 1. Board server — the DEVELOPMENT instance

**This skill names NO port and NO URL.** A skill drives the client scripts; the connection is
CONFIGURATION, and it is declared in `crucible.toml` — `[server]` for the listener,
`[client]` for the target board (CR-CRU-139). Read the value from there when you need it; never
hardcode one here, and never pass a URL to a client.

```
process start name=crucible-board-dev-<n> command="cd <repo> && bun run src/server.ts" readyPattern="listening on"
python3 clients/python-crucible.py status              # the client finds the board itself
```
The ready lines name the listener and the store: `listener 127.0.0.1:<port> (port: file, …)` and
`store <repo>/data/crucible.db (rule: cwd-data, schema v<N>)`.
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

## 1b. Chrome: through the global `chrome-ui-relay` skill (Model B CR-MDB-061)

Every browser step is the global **`chrome-ui-relay`** skill's (`~/.agents/skills/chrome-ui-relay/SKILL.md`),
dev-deployed from Model B develop `be7bb20` (CR-MDB-061, and CR-MDB-076's wait for Chrome's prompt) (user ruling 2026-10-16: adopt the dev-deployed copy
ahead of Model B 1.0.0). Read it before step 4 and follow it exactly: its session, its open and
close procedures, its handling of a bridge that cannot attach, and its rule that every
`chrome-devtools-axi` envelope is read whole. This skill only supplies its inputs.

- **Session:** `PROJECT_TOKEN` in `.env` (`crucible`). It gives this project its own bridge, so its
  `stop` touches no other project's.
- **Never start the omp-era relay** (`omp browser-relay`, or the old `pi-relay.ts` wrapper, now
  deleted): it never connects under Pi and takes :9224.

The inputs, all derived from configuration, never hardcoded here:

| Input | Value |
|---|---|
| URLs to open | the board roadmap `http://127.0.0.1:<port>/p/<CRUCIBLE_PROJECT_KEY>/roadmap` (`<port>` from `[server] port` in `data/crucible.toml`, the key from `.env`); then the two Lavish `url:` lines step 3 printed |
| Our URL patterns | `http://127.0.0.1:<port>/p/<CRUCIBLE_PROJECT_KEY>/` (and the same on `localhost`); `http://127.0.0.1:4387/session/` |
| Protected patterns | the production install's board, on the shipped `[server] port` in `src/crucible.toml`, on `127.0.0.1` and `localhost`. Never selected, evaluated or closed. |

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

## 4. Chrome tabs: `chrome-ui-relay`'s Open, with the step 1b inputs

**Relay `chrome-ui-relay`'s warning to the user first**, unchanged in substance: Chrome will ask
them to accept a remote-debugging connection; they accept within about a minute, and again if
Chrome asks again. The skill gives the same warning before shutdown's calls, except `stop`.

**Every browser call gets a shell timeout of at least 150 seconds**: the skill sets the bridge to
wait up to 2 minutes for the acceptance, and a shorter shell timeout kills the call first. On
`BRIDGE_NOT_READY` the skill skips the browser steps and reports the envelope's `error` and `help`
in full. It never retries; neither does this skill.

Then run `chrome-ui-relay`'s **Open** with the three inputs from step 1b. Keep the (id, URL) record it
returns in this session's context: shutdown closes from that record and nothing else. Then confirm
rendered text on our own tabs. The board renders about 2,000 characters and a Lavish session about
400,000; a `domcontentloaded` read of the board SPA (~370 characters) looks EMPTY.

If the user closes our tabs mid-session, run Open again for the missing URLs only.

## 5. One storyboard poll — SUPERVISED, not a fire-and-forget bash job

```
process start name=lavish-poll-storyboard \
     command="cd <repo> && npx -y lavish-axi poll .lavish/crucible-v2-design.html --agent-reply \"<one-line state>\""
```
Exactly one poll process (one-listener invariant; `pgrep -af 'lavish-axi poll'` must show none
before arming). Never truncate its output.

**THE REPLY IS THE RE-ARM — make them ONE command, never two steps.** The rule "re-arm after every
fetch" was already written here on 2026-09-18 and I broke it within the hour: the poll delivered
feedback, I read it, went off applying the change, and never restarted the listener — so the user's
NEXT message queued with nobody reading it and they had to ask twice. Reading a poll result and
arming the next poll are not two tasks that happen to be adjacent; a consumed poll IS a dead
listener, and the gap starts the instant you read it.

So the ONLY sanctioned shape after consuming feedback is a single `process start` that carries the
reply and re-arms in the same call:

```
process start name=lavish-poll-storyboard \
     command="cd <repo> && npx -y lavish-axi poll <artifact> --agent-reply \"<what changed>\""
```

Never answer in the conversation panel by any other route, and never apply the feedback first and
arm "once it's done" — apply-then-arm is exactly the window the user falls into.

**CORRECTED 2026-09-18 — this section used to say "as a tracked async bash job (`async: true`,
`timeout: 0`)", and that is how the user's editor went unattended for a whole session.** A poll
launched that way exits on its own (its review windows disconnect past the reconnect grace period —
and omp FREEZES idle tabs at turn settle, which drops the Lavish socket), and because nothing
supervises a detached bash job, **nothing tells you it is gone**. The user asked "have you stopped
listening to lavish editor" before I noticed.

The `process` tool fixes exactly that: a supervised process announces its own exit, the same mechanism that
made the Sandesh notifier reliable all session (it exited twice, and both times the notice arrived
and it was relaunched in the same turn). Treat a dead poll like a dead watcher — relaunch it in the
turn you learn of it.

A review window that stays disconnected past Lavish's grace period ends the poll too: if a poll
returns `browser_disconnected`, ask the user whether to reopen or end the session. Feedback is
never lost while the poll is down — it queues until a poll delivers it — so a re-arm always
recovers it, but the user is left talking to a surface nobody is reading.

## 6. Sandesh notifier — the Sandesh-Pi extension (user direction 2026-10-01)

The wake watcher is the **Sandesh-Pi extension**, not a supervised `sandesh notify` process. Do NOT
`process start sandesh notify …` any more; the extension replaces that loop.

```
sandesh_addressbook(project_id="Crucible")                         # who can address me?
sandesh_register(address="Mainline - Crucible", kind="mainline", project_id="Crucible")  # only if inactive
sandesh_fetch(recipient="Mainline - Crucible", project_id="Crucible")  # drain gap mail FIRST
sandesh_notify_start(address="Mainline - Crucible", project="Crucible")
sandesh_notify_status(project="Crucible")                          # running: true
```

On a wake: `sandesh_fetch` and act. The extension re-arms itself after mail, timeouts and dedup
(sandesh-pi `WakeSupervisor`). Any stop you did not request posts a warning naming the address; on
that warning, start it again in the same turn (the relaunch-on-exit rule still holds). Since
sandesh-pi 0.4.1 (installed 2026-10-05) each session owns its own watcher, so a sub-agent no longer
stops this one (#1416, fixed); no restart after sub-agents is needed.

Launch it when anyone can address this project: a Track on the roster, or a cross-project peer with
`CROSS-PROJECT ✓` (today: ModelB, Sandesh). Measured 2026-09-16: a single-participant roster does NOT
mean a silent inbox once a cross-project peer is granted.

## Then

Report to the user per the bootstrap skill: services (board pid/health, sessions, tabs, poll), queue state from the client verbs (`status`, `queue`, `next`), carried todos. Do not dispatch.

---

# Shutdown teardown (`/shutdown`)

Reverse of the restore, run as part of the `shutdown` skill's teardown AFTER the active step is finished, todos drained, the tree clean and `vidushi`'s last board write done — and BEFORE the final report. Prior feedback: reporting "left running" for the board was wrong; the user expects the services DOWN and the tabs CLOSED. Order:

## 1. Storyboard poll

Stop the supervised poll (`process kill lavish-poll-storyboard`); confirm `pgrep -af 'lavish-axi poll'` is empty. Never `pkill` by name machine-wide — ModelB's listener may share the host.

## 2. Lavish sessions

```
npx -y lavish-axi end .lavish/crucible-v2-design.html
npx -y lavish-axi end .lavish/crucible-workflow-flowchart.html
npx -y lavish-axi stop            # the background Lavish server (:4387)
```
Ending as the agent still allows a plain reopen at the next bootstrap.

## 3. Chrome tabs

Run `chrome-ui-relay`'s **Close** from the (id, URL) record step 4 of the restore kept, then its
`stop`, which ends only this project's bridge. When the record is missing (a restarted session) or
the bridge has restarted, it closes nothing and reports our tabs for the user to close: say so in
the shutdown report. Anything else this session opened (e.g. a release-checking
`npmjs.com/package/@anthill-tec` tab) is closed the same way, if it is in the record.

## 4. Orchestrator registration

```
python3 clients/python-crucible.py unregister --agent vidushi
```
Must run while the board is still up.

## 5. Board server: LAST

```
process kill crucible-board-dev-<n>
```
State is in `data/crucible.db`; a stop is safe. Confirm the kill reported the process terminated
and the declared board port answers nothing.

## 6. Sandesh notifier — the FINAL action, and it is NOT restarted

```
sandesh_notify_stop(address="Mainline - Crucible")    # only the watcher THIS session owns
sandesh_unregister(address="Mainline - Crucible", requester="Mainline - Crucible", project_id="Crucible")
```

This is the single documented override of the relaunch-on-exit prime directive, and it applies
ONLY here, at a confirmed shutdown's last step. Keep the watcher alive through the whole teardown
— it is how a late emergency-stop or a peer's last message reaches you. Stop it by its own address
only; never a machine-wide kill (ModelB's and Sandesh's watchers share this host). The roster then
reads `inactive / ○ offline`. **Check it:** read the addressbook after the unregister. On 2026-10-15
both tool calls returned no result, and the address was still `active` at the next bootstrap.

## Teardown order (corrected 2026-09-27)

Close the tabs (step 3) BEFORE ending the Lavish sessions and stopping its server (step 2): a
stopped Lavish server leaves its tabs on an error page that no longer shows the URL recorded for
them. Then confirm on Close's AFTER `pages` list that no project board or :4387 page is left.

Then the shutdown report names each of the SIX as down/closed/left-open, with the evidence
(the `pages` counts, the `process` kill lines, the roster state) — and where a step could not complete, says so
plainly and hands it back to the user rather than reporting it as done.
