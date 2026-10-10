// CREATE this project's tabs in the user's Chrome — never navigate one of theirs. Opens the dev
// board (port from data/crucible.toml) plus every Lavish session URL passed as an argument, via
// CDP Target.createTarget on the relay, then proves the delta (+N pages, zero user tabs lost).
//   bun open-tabs.ts <lavish-session-url> [<lavish-session-url> ...]
import { boardPort, connect, listPages } from "./lib.ts";

const PROJECT_KEY = "019f6228-63a7-7000-b3d4-ebe7f5dbe6c6";
const urls = [`http://127.0.0.1:${boardPort()}/p/${PROJECT_KEY}/roadmap`, ...process.argv.slice(2)];

let before;
try { before = await listPages(); } catch (err) { console.log(`RELAY UNREACHABLE: ${err}`); process.exit(1); }
const todo = urls.filter((u) => !before.some((t) => t.url === u));
console.log(`before=${before.length} alreadyOpen=${urls.length - todo.length}`);

const { call } = await connect();
for (const url of todo) {
  const r = await call("Target.createTarget", { url, background: true });
  console.log(`create ${url}: ${r.error ? JSON.stringify(r.error) : r.result?.targetId}`);
}
await new Promise((r) => setTimeout(r, 3000));
const after = await listPages();
const lost = before.filter((t) => !after.some((a) => a.id === t.id));
const present = urls.filter((u) => after.some((t) => t.url.startsWith(u)));
console.log(`after=${after.length} delta=${after.length - before.length} ourTabsPresent=${present.length}/${urls.length} userTabsLost=${lost.length}`);
process.exit(lost.length === 0 && present.length === urls.length ? 0 : 1);
