// Shared helpers for the Pi-group browser scripts. The board port is CONFIGURATION: read from
// [server] port in data/crucible.toml (the file beside THIS board's store), never hard-coded.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const RELAY = "127.0.0.1:9224";
export const LAVISH_PORT = 4387;

export function boardPort(repo = resolve(import.meta.dir, "../../../..")): number {
  const toml = readFileSync(resolve(repo, "data/crucible.toml"), "utf8");
  const section = toml.split(/^\[server\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  const m = section.match(/^\s*port\s*=\s*(\d+)/m);
  if (!m) throw new Error("no [server] port in data/crucible.toml");
  return Number(m[1]);
}

/** True for a page this project owns: the dev board or a Lavish session. Never the production board. */
export function isOurs(url: string, port = boardPort()): boolean {
  return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):(${port}|${LAVISH_PORT})/`).test(url);
}

export type Page = { id: string; url: string; type: string };

export async function listPages(): Promise<Page[]> {
  const all = (await (await fetch(`http://${RELAY}/json/list`)).json()) as Page[];
  return all.filter((t) => t.type === "page");
}

/** A CDP connection to the relay with a promise-per-call helper. */
export async function connect(onClose?: () => void) {
  const ws = new WebSocket(`ws://${RELAY}/cdp`);
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.onmessage = (ev) => {
    let m: { id?: number };
    try { m = JSON.parse(String(ev.data)); } catch { return; } // a non-JSON frame answers no call
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  };
  if (onClose) ws.onclose = onClose;
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); res({ error: { message: "timeout" } }); } }, 20000);
    });
  return { ws, call };
}
