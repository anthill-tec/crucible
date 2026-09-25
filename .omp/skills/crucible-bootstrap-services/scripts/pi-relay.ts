// The CDP relay on :9224, with the tab group named "Pi". It is omp's own relay server; only the
// group title differs — `omp browser-relay serve` hard-codes "omp" and exposes no title flag.
// Run supervised:  process start name=pi-relay command="bun <this file>"  (ready: "extension connected")
import { startRelayServer } from "/home/antonyj/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/tools/browser/relay/server.ts";

const relay = startRelayServer({
  port: 9224,
  group: { title: "Pi", color: "cyan" },
  log: (message, data) => console.log(`[relay] ${message}${data ? " " + JSON.stringify(data) : ""}`),
});
console.log(`pi-relay listening on 127.0.0.1:${relay.port} (group "Pi")`);
const stop = () => { relay.stop(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
