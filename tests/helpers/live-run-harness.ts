// A happy-dom mount of the REAL public/app.js for an open run's live view —
// the running card's progress line and the live run detail at /run/<runId>.
//
// Real VanJS/VanX vendor bundles, real public/app-logic.mjs, real
// public/app.js; `fetch` is scripted and reads the fixture object LIVE (at
// call time), so a test mutates the fixture after mount and the next read sees
// it. A FAKE EventSource (happy-dom has none) is installed before app.js
// evaluates, so a test fires a real `events` change frame through the page's
// own stream handler rather than waiting out the 5s poll.
//
// The live state is a STUBBED READ: `live[runId]` is what
// GET /api/v2/runs/<runId>/live answers (an open answer honours `?from=`), and
// an open run's brief carries its `live` counts exactly as the events feed
// serves them. No write path is driven — filling the live state is
// CR-CRU-200's.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./dom-settle";
import { FakeEventSource, installEventSource, restoreEventSource } from "./stream-workspace-harness";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

/** The integer `const <name> = <n>;` declares in the script `src`; throws when
 *  `src` declares no such constant, so a renamed constant can never read as 0. */
export function jsConstIn(src: string, name: string): number {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
  if (m === null) throw new Error(`live-run-harness: const ${name} not found`);
  return Number(m[1]);
}

/** The run detail's existing virtualisation window (`VIRT_WINDOW` in
 *  public/app.js), read off the source so the bound follows the real one. */
export const VIRT_WINDOW: number = jsConstIn(APP_JS_SRC, "VIRT_WINDOW");

/** A live failure row's height in the script (`LIVE_ROW_HEIGHT` in
 *  public/app.js) — the number `LiveRunBody`'s window divides scrollTop by. */
export const LIVE_ROW_HEIGHT: number = jsConstIn(APP_JS_SRC, "LIVE_ROW_HEIGHT");

export interface LiveCounts {
  completed: number;
  total?: number;
  passed: number;
  failed: number;
  pending: number;
  currentFile?: string;
}

export interface LiveFailureFixture {
  id: string;
  name: string;
  suite: string;
  file: string;
  message?: string;
  type?: string;
}

export type LiveAnswer =
  | { state: "open"; live: LiveCounts; failures: LiveFailureFixture[] }
  | { state: "ended" | "aborted"; eventId: string };

export interface OpenRunFixture {
  runId: string;
  projectKey: string;
  agentId: string;
  startedAt: number;
  tier?: string;
  live?: LiveCounts;
}

export interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  retention?: number;
}

export interface AgentFixture {
  agentId: string;
  projectKey: string;
  liveness: "online" | "stale" | "tombstoned";
  lastSeen: number;
  message?: string;
}

interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: { message?: string };
}

export interface SuiteFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  children: LeafFixture[];
}

export interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec?: string;
  timestamp: number;
  status?: "aborted";
  abortReason?: string;
  summary?: { total: number; passed: number; failed: number; pending: number; duration_ms: number };
  tree?: SuiteFixture[];
}

export interface EventBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  status?: "aborted";
  abortReason?: string;
}

export interface LiveMountOpts {
  pathname: string;
  projects: ProjectFixture[];
  agents: AgentFixture[];
  events: EventBriefFixture[];
  eventDetails: Record<string, EventDetailFixture>;
  openRuns: OpenRunFixture[];
  /** What GET /api/v2/runs/<runId>/live answers, by run id; absent = 404. */
  live: Record<string, LiveAnswer>;
  /** When set and it returns a promise for a /live URL, that read waits for
   *  it before answering — and computes its answer only then, from `live`. */
  holdLive?: (url: string) => Promise<void> | null;
}

export interface LiveMounted {
  /** Every URL the page fetched, in order. */
  readonly fetchLog: string[];
  /** Every URL the page pushed onto / replaced in its history, in order. */
  readonly pushed: string[];
  readonly replaced: string[];
  /** The page's one live stream. */
  source(): FakeEventSource;
}

let cacheBust = 0;

function respond(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function suiteCounts(children: LeafFixture[]): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of children) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

const LIVE_RE = /\/api\/v2\/runs\/([^/?]+)\/live(?:\?(.*))?$/;

function answerLive(opts: LiveMountOpts, url: string): Response {
  const m = LIVE_RE.exec(url);
  const runId = decodeURIComponent(m?.[1] ?? "");
  const answer = opts.live[runId];
  if (answer === undefined) return respond(404, { ok: false, error: `no live state for ${runId}` });
  if (answer.state !== "open") return respond(200, { ok: true, state: answer.state, eventId: answer.eventId });
  const from = Number(new URLSearchParams(m?.[2] ?? "").get("from") ?? "0") || 0;
  return respond(200, {
    ok: true,
    state: "open",
    live: answer.live,
    failures: answer.failures.slice(from),
    failuresFrom: from,
  });
}

function answerEventDetail(opts: LiveMountOpts, url: string): Response {
  const m = /\/api\/v2\/events\/([^/?]+)/.exec(url);
  const id = decodeURIComponent(m?.[1] ?? "");
  const detail = opts.eventDetails[id];
  if (detail === undefined) return respond(404, { ok: false, error: `unknown event ${id}` });
  const parsed = new URL(url, "http://localhost");
  const suite = parsed.searchParams.get("suite");
  if (suite !== null) {
    const match = (detail.tree ?? []).find((n) => n.name === suite);
    return respond(200, { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } });
  }
  if (parsed.searchParams.get("depth") === "suites") {
    const tree = (detail.tree ?? []).map((n) => ({ name: n.name, status: n.status, counts: suiteCounts(n.children) }));
    return respond(200, { ok: true, event: { ...detail, tree } });
  }
  return respond(200, { ok: true, event: detail });
}

/**
 * Mount the app at `opts.pathname`. Resolves after the first render settles.
 * Unknown URLs answer 404 (logged in `fetchLog`) rather than throwing, so a
 * read the app makes that this fixture does not script reads as "nothing
 * there", never as a fixture crash.
 */
export async function mountLive(opts: LiveMountOpts): Promise<LiveMounted> {
  const fetchLog: string[] = [];
  const pushed: string[] = [];
  const replaced: string[] = [];
  let live: FakeEventSource | null = null;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${opts.pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
    pushed.push(String(url));
    push(data, unused, url);
  };
  history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
    replaced.push(String(url));
    replace(data, unused, url);
  };

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: string): Promise<Response> => {
    const url = String(input);
    fetchLog.push(url);
    if (LIVE_RE.test(url)) {
      const hold = opts.holdLive?.(url) ?? null;
      if (hold !== null) await hold;
      return answerLive(opts, url);
    }
    const isList = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (url.includes("/api/v2/events/") && !isList) return answerEventDetail(opts, url);
    if (isList) return respond(200, { ok: true, events: opts.events, openRuns: opts.openRuns });
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      return respond(200, { ok: true, proposals: [], totalCount: 0 });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) return respond(200, { ok: true, releases: [] });
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) return respond(200, { ok: true, entries: [] });
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) return respond(200, { ok: true, plans: [] });
    if (/\/api\/v2\/projects\/[^/?]+\/history/.test(url)) return respond(200, { ok: true, releases: [] });
    if (url.startsWith("/api/v2/projects")) return respond(200, { ok: true, projects: opts.projects });
    if (url.includes("/api/v2/agents")) return respond(200, { ok: true, agents: opts.agents });
    if (url.includes("/api/v2/health")) return respond(200, { ok: true, version: "2.0.0-test", counts: { events: 0 } });
    return respond(404, { ok: false, error: `live-run-harness: unscripted url ${url}` });
  }) as typeof fetch;

  installEventSource(
    class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        live = this;
      }
    },
  );

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?liveRunHarness=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settle();

  return {
    fetchLog,
    pushed,
    replaced,
    source: () => {
      if (live === null) throw new Error("live-run-harness: the page opened no stream");
      return live;
    },
  };
}

export async function settle(ticks = 12): Promise<void> {
  await settleDom({ ticks });
}

export async function unmountLive(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  restoreEventSource();
}

/** Every /live read in `urls`. */
export function liveReads(urls: readonly string[], runId: string): string[] {
  return urls.filter((u) => u.startsWith(`/api/v2/runs/${encodeURIComponent(runId)}/live`));
}

/** The `from` a /live read asked for (absent = 0). */
export function liveFrom(url: string): number {
  const query = url.split("?")[1] ?? "";
  return Number(new URLSearchParams(query).get("from") ?? "0");
}

// ── A small cascade over public/styles.css ───────────────────────────────
//
// happy-dom never attaches public/styles.css, so `getComputedStyle` answers
// nothing about it. This reads the stylesheet's top-level rules (at-rule
// blocks — @media, @keyframes — are skipped: these are the desktop rules) and
// resolves one property for one element the way the cascade does: the
// matching rule with the highest specificity wins, a later rule winning a tie,
// and the element's inline style beating every rule. Inherited properties walk
// up the ancestors until one declares the property.

interface CssRule {
  selector: string;
  specificity: [number, number, number];
  order: number;
  decls: Map<string, string>;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function specificityOf(selector: string): [number, number, number] {
  const s = selector.replace(/:not\(([^)]*)\)/g, " $1 ");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (s.replace(/"[^"]*"/g, "").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return [ids, classes, types];
}

function parseRules(css: string): CssRule[] {
  const src = stripComments(css);
  const rules: CssRule[] = [];
  let i = 0;
  let order = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open === -1) break;
    const prelude = src.slice(i, open).trim();
    // Find the matching close brace.
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") depth -= 1;
      j += 1;
    }
    const body = src.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith("@")) continue;
    const decls = new Map<string, string>();
    for (const decl of splitTopLevel(body, ";")) {
      const colon = decl.indexOf(":");
      if (colon === -1) continue;
      decls.set(decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).replace(/!important/, "").trim());
    }
    for (const selector of splitTopLevel(prelude, ",")) {
      const sel = selector.trim();
      if (sel.length === 0) continue;
      rules.push({ selector: sel, specificity: specificityOf(sel), order: order++, decls });
    }
  }
  return rules;
}

/**
 * The px value the top-level rule(s) for exactly `selector` give `prop` in the
 * stylesheet `css` — the last one winning, as the cascade does for a tie. A
 * rule inside an at-rule (@media) is not top-level and is never read. Throws
 * when no top-level rule for `selector` declares `prop`, or when the value it
 * declares is not a px length, so a missing rule can never read as a number.
 */
export function cssPxIn(css: string, selector: string, prop: string): number {
  let value: string | undefined;
  for (const rule of parseRules(css)) {
    if (rule.selector === selector) value = rule.decls.get(prop) ?? value;
  }
  if (value === undefined) throw new Error(`live-run-harness: no top-level \`${selector}\` rule declares ${prop}`);
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (m === null) throw new Error(`live-run-harness: \`${selector}\` ${prop} is ${value}, not a px length`);
  return Number(m[1]);
}

/** A live failure row's height in the stylesheet (`.app-live-failure`'s
 *  `height` in public/styles.css) — the height each row is drawn at. */
export const LIVE_ROW_CSS_HEIGHT: number = cssPxIn(STYLES_SRC, ".app-live-failure", "height");

/** Shorthands that set a longhand this resolver is asked about. */
const SHORTHANDS: Record<string, string[]> = {
  "white-space": ["white-space"],
  "text-overflow": ["text-overflow"],
  overflow: ["overflow"],
  "overflow-x": ["overflow-x", "overflow"],
  cursor: ["cursor"],
  color: ["color"],
};

const INHERITED = new Set(["white-space", "cursor", "color"]);

/** Why the DOM cannot parse `selector`, or null when it can. */
type SelectorCheck = (selector: string, doc: Document) => string | null;

/**
 * A memoised selector check. It asks a FRESH element every time it meets a new
 * selector, because happy-dom's `Element.matches` caches a selector per
 * element BEFORE parsing it: an unparseable selector throws on that element's
 * first `matches` only, and every later call on the same element answers a
 * quiet `false`. Asking `el.matches` alone would therefore fail loudly once
 * and then read as "no match" forever after.
 */
function selectorCheck(): SelectorCheck {
  const known = new Map<string, string | null>();
  return (selector, doc) => {
    if (!known.has(selector)) {
      try {
        doc.createElement("div").matches(selector);
        known.set(selector, null);
      } catch (err) {
        known.set(selector, err instanceof Error ? err.message : String(err));
      }
    }
    return known.get(selector) ?? null;
  };
}

function declaredOn(rules: readonly CssRule[], check: SelectorCheck, el: Element, prop: string): string | null {
  const names = SHORTHANDS[prop] ?? [prop];
  const inline = (el as HTMLElement).style?.getPropertyValue?.(prop) ?? "";
  if (inline !== "") return inline.trim();
  let best: CssRule | null = null;
  let bestValue: string | null = null;
  // A selector the DOM cannot parse is collected, never read as "no match":
  // a rule silently skipped would let the cascade answer the wrong value.
  const unparseable: string[] = [];
  for (const rule of rules) {
    // Interaction states never apply to a resting element.
    if (/::|:hover|:focus|:active|:visited/.test(rule.selector)) continue;
    let value: string | undefined;
    for (const name of names) value = rule.decls.get(name) ?? value;
    if (value === undefined) continue;
    const parseError = check(rule.selector, el.ownerDocument);
    if (parseError !== null) {
      unparseable.push(`${rule.selector} (${parseError})`);
      continue;
    }
    if (!el.matches(rule.selector)) continue;
    if (
      best === null ||
      rule.specificity[0] > best.specificity[0] ||
      (rule.specificity[0] === best.specificity[0] && rule.specificity[1] > best.specificity[1]) ||
      (rule.specificity[0] === best.specificity[0] &&
        rule.specificity[1] === best.specificity[1] &&
        rule.specificity[2] >= best.specificity[2])
    ) {
      best = rule;
      bestValue = value;
    }
  }
  if (unparseable.length > 0) {
    throw new Error(
      `live-run-harness: the cascade cannot evaluate ${unparseable.length} selector(s) declaring ${prop}: ${unparseable.join("; ")}`,
    );
  }
  return bestValue;
}

/** The cascade over the stylesheet `css`: the value it (plus the inline
 *  style) gives `prop` on `el`, "" when nothing declares it. Throws when a
 *  rule declaring `prop` has a selector the DOM cannot parse. */
export function cascadeOver(css: string): (el: Element, prop: string) => string {
  const rules = parseRules(css);
  const check = selectorCheck();
  return (el, prop) => {
    let node: Element | null = el;
    while (node !== null) {
      const v = declaredOn(rules, check, node, prop);
      if (v !== null) return v.replace(/\s+/g, " ").trim();
      if (!INHERITED.has(prop)) return "";
      node = node.parentElement;
    }
    return "";
  };
}

/** The value public/styles.css (plus the inline style) gives `prop` on `el`;
 *  "" when nothing declares it. */
export const cascaded: (el: Element, prop: string) => string = cascadeOver(STYLES_SRC);

/** True when `el` truncates on one line: no wrapping, its overflow clipped,
 *  and an ellipsis marking the cut. */
export function truncatesOnOneLine(el: Element): boolean {
  const overflow = cascaded(el, "overflow-x") || cascaded(el, "overflow");
  return (
    cascaded(el, "white-space") === "nowrap" &&
    /hidden|clip/.test(overflow) &&
    cascaded(el, "text-overflow") === "ellipsis"
  );
}
