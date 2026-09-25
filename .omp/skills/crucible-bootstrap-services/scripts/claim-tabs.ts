// Hold a relay claim on this project's tabs so the relay gathers them into the "Pi" group. A claim
// lives exactly as long as this connection, so it runs SUPERVISED for the whole session:
//   process start name=pi-tab-claim command="bun <this file>"  (ready: "holding claims")
// Re-run it after opening a new project tab — claims are taken once, at start.
import { connect, isOurs, listPages } from "./lib.ts";

const pages = (await listPages()).filter((t) => isOurs(t.url));
console.log(`claiming ${pages.length}: ${pages.map((p) => p.url).join(" | ")}`);

const { call } = await connect(() => { console.log("relay connection closed — claims released"); process.exit(1); });
for (const p of pages) {
  const att = await call("Target.attachToTarget", { targetId: p.id, flatten: true });
  const sid = att.result?.sessionId;
  if (!sid) { console.log(`attach failed ${p.url}: ${JSON.stringify(att.error)}`); continue; }
  // Relay-private verb: marks the tab as driven by this connection (bridge.ts OMP.claimTarget).
  const c = await call("OMP.claimTarget", {}, sid);
  console.log(`claim ${p.url}: ${c.error ? JSON.stringify(c.error) : "ok"}`);
}
console.log("holding claims");
setInterval(() => {}, 1 << 30);
