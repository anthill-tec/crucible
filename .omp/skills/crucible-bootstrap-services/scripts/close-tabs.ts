// Shutdown: CLOSE this project's tabs (dev board + Lavish sessions) through the relay — never the
// production board, never a user tab. Proves the delta (-N pages, zero user tabs lost).
// Run BEFORE stopping pi-tab-claim and pi-relay: closing a tab needs the relay alive.
import { connect, isOurs, listPages } from "./lib.ts";

let before;
try { before = await listPages(); } catch (err) { console.log(`RELAY UNREACHABLE: ${err}`); process.exit(1); }
const targets = before.filter((t) => isOurs(t.url));
console.log(`before=${before.length} ours=${targets.length}: ${targets.map((t) => t.url).join(" | ")}`);

const { call } = await connect();
for (const t of targets) {
  const att = await call("Target.attachToTarget", { targetId: t.id, flatten: true });
  const sid = att.result?.sessionId;
  if (!sid) { console.log(`attach failed ${t.url}: ${JSON.stringify(att.error)}`); continue; }
  const closed = await call("Page.close", {}, sid);
  console.log(`close ${t.url}: ${closed.error ? JSON.stringify(closed.error) : "ok"}`);
}
await new Promise((r) => setTimeout(r, 1500));
const after = await listPages();
const lost = before.filter((t) => !isOurs(t.url) && !after.some((a) => a.id === t.id));
const left = after.filter((t) => isOurs(t.url));
console.log(`after=${after.length} delta=${before.length - after.length} expected=${targets.length} oursLeft=${left.length} userTabsLost=${lost.length}`);
process.exit(left.length === 0 && lost.length === 0 ? 0 : 1);
