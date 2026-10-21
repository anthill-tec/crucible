// A compile diagnostic renders only the location it actually has.
//
// Not every compiler reports a full `file:line:col`. A linker's
// `file:line: undefined reference to …` carries a file and a line but no
// column (and so do python's diagnostics); an object-only link error carries
// no source location at all. The two places the dashboard renders compile
// diagnostics — the run card's inline preview (`[data-testid="diag-preview"]`,
// built by `DiagPreview` in public/app.js) and the run drill-in's compile pane
// (`CompileBody` in public/app.js) — must render the location only as far as
// the diagnostic has it, and never the text `undefined`:
//
//   drill-in pane, one `[data-testid="diag-line"]` per diagnostic:
//     file + line + col  →  `file:line:col — message`   (unchanged)
//     file + line        →  `file:line — message`
//     file only          →  `file — message`
//     no file            →  no `undefined`; the message is shown, last
//
//   card preview, one `[data-testid="diag-line"]` per previewed diagnostic:
//     file + line (+ col) →  `file:line — message`        (unchanged — the
//                                                           card never showed
//                                                           a column)
//     file only           →  `file — message`
//     no file             →  the message alone, no location prefix at all.
//
// THE RULE CHOSEN FOR A FILE-LESS DIAGNOSTIC IN THE CARD PREVIEW: the card
// has no file grouping to hang an "(unknown file)" label on, so a diagnostic
// with no file renders NO location — its preview line is exactly its
// message. (The drill-in groups by file and may keep its "(unknown file)"
// group header; its line is only required to end with the message and carry
// no `undefined`.)
//
// The fixture messages deliberately avoid the word "undefined" (a real link
// error's message is "undefined reference to …") so that "the rendered line
// contains no `undefined`" checks the LOCATION, never the message.
//
// Harness: the same happy-dom mount as tests/drill-in.test.ts and
// tests/run-cards.test.ts — a compile event's brief (with its first two
// diagnostics, as the server's event brief carries them) renders the card;
// clicking the card fetches the event detail and renders the drill-in.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"),
  "utf8",
);
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

interface DiagnosticFixture {
  file?: string;
  line?: number;
  col?: number;
  message: string;
  level: "error" | "warning";
}

interface CompileEventCase {
  id: string;
  agentId: string;
  diagnostics: DiagnosticFixture[];
}

const PROJECT_KEY = "proj-compile-locations";

// (a) a full location — the guard: renders exactly as it does today.
const FULL: DiagnosticFixture = {
  file: "/sketch/blink/blink.ino",
  line: 12,
  col: 5,
  message: "expected ';' before '}' token",
  level: "error",
};
// (b) a file and a line but no column — a link error or a python diagnostic.
const NO_COL: DiagnosticFixture = {
  file: "/sketch/lnk/lnk.ino",
  line: 2,
  message: "multiple definition of `setup'",
  level: "error",
};
// (c) no file, no line, no column — an object-only link error.
const NOTHING: DiagnosticFixture = {
  message: "ld returned 1 exit status",
  level: "error",
};
// (d) a file but neither a line nor a column.
const FILE_ONLY: DiagnosticFixture = {
  file: "/sketch/lnk/lnk.ino.cpp.o",
  message: "relocation truncated to fit",
  level: "error",
};

let cacheBust = 0;

/** Mounts the app on `/` with the given compile events: the list endpoint
 * serves each event's brief (carrying its first two diagnostics), and the
 * per-id detail endpoint serves its full compile payload. */
async function mountCompileEvents(cases: CompileEventCase[]): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: "http://localhost/" });
  document.body.innerHTML = '<div id="app"></div>';

  const now = Date.now();
  const briefs = cases.map((c, i) => {
    const errors = c.diagnostics.filter((d) => d.level === "error").length;
    return {
      id: c.id,
      projectKey: PROJECT_KEY,
      agentId: c.agentId,
      kind: "compile" as const,
      tier: "unit",
      codec: "gcc",
      timestamp: now - i * 1000,
      hasCoverage: false,
      errors,
      warnings: c.diagnostics.length - errors,
      diagnostics: c.diagnostics.slice(0, 2),
    };
  });
  const details = new Map(
    cases.map((c, i) => {
      const errors = c.diagnostics.filter((d) => d.level === "error").length;
      return [
        c.id,
        {
          id: c.id,
          projectKey: PROJECT_KEY,
          agentId: c.agentId,
          kind: "compile" as const,
          tier: "unit",
          codec: "gcc",
          timestamp: now - i * 1000,
          compile: {
            format: "gcc",
            errorCount: errors,
            warningCount: c.diagnostics.length - errors,
            diagnostics: c.diagnostics,
            raw: "",
          },
        },
      ] as const;
    }),
  );

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = details.get(id);
      if (detail === undefined) {
        throw new Error(`compile-diagnostics mount: no detail fixture for event id ${id}`);
      }
      body = { ok: true, event: detail };
    } else if (url.includes("/api/v2/projects")) {
      body = {
        ok: true,
        projects: [
          {
            key: PROJECT_KEY,
            name: "Compile Locations",
            type: "backend",
            agentsOnline: 0,
            agentsTotal: 0,
            active: true,
            lastActivity: now,
          },
        ],
      };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: briefs };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`compile-diagnostics mount: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?compileLocations=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 6): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function cardFor(agentId: string): HTMLElement {
  const card = Array.from(document.querySelectorAll('[data-testid="event-card"]')).find((el) =>
    (el.textContent ?? "").includes(agentId),
  ) as HTMLElement | undefined;
  expect(card).toBeDefined();
  return card!;
}

function previewLineTexts(agentId: string): string[] {
  const preview = cardFor(agentId).querySelector('[data-testid="diag-preview"]');
  expect(preview).not.toBeNull();
  return Array.from(preview!.querySelectorAll('[data-testid="diag-line"]')).map((l) =>
    (l.textContent ?? "").trim(),
  );
}

/** Clicks the event's card and returns the drill-in's diag-line texts. */
async function drillInLineTexts(eventId: string, agentId: string): Promise<string[]> {
  cardFor(agentId).click();
  await settle();
  expect(location.pathname).toBe(`/run/${eventId}`);
  const overlay = document.querySelector('[data-testid="run-overlay"]');
  expect(overlay).not.toBeNull();
  return Array.from(overlay!.querySelectorAll('[data-testid="diag-line"]')).map((l) =>
    (l.textContent ?? "").trim(),
  );
}

async function mountSingle(id: string, agentId: string, diag: DiagnosticFixture): Promise<void> {
  await mountCompileEvents([{ id, agentId, diagnostics: [diag] }]);
}

describe("compile drill-in pane renders a diagnostic's location only as far as it has one", () => {
  test("a diagnostic with file, line and column renders `file:line:col — message` (unchanged)", async () => {
    await mountSingle("evt-loc-drill-full", "loc-drill-full-agent", FULL);
    const lines = await drillInLineTexts("evt-loc-drill-full", "loc-drill-full-agent");
    expect(lines).toEqual(["/sketch/blink/blink.ino:12:5 — expected ';' before '}' token"]);
  });

  test("a diagnostic with a file and a line but no column renders `file:line — message`, never `undefined`", async () => {
    await mountSingle("evt-loc-drill-nocol", "loc-drill-nocol-agent", NO_COL);
    const lines = await drillInLineTexts("evt-loc-drill-nocol", "loc-drill-nocol-agent");
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("undefined");
    expect(lines[0]).toBe("/sketch/lnk/lnk.ino:2 — multiple definition of `setup'");
  });

  test("a diagnostic with a file but no line or column renders `file — message`, never `undefined`", async () => {
    await mountSingle("evt-loc-drill-fileonly", "loc-drill-fileonly-agent", FILE_ONLY);
    const lines = await drillInLineTexts("evt-loc-drill-fileonly", "loc-drill-fileonly-agent");
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("undefined");
    expect(lines[0]).toBe("/sketch/lnk/lnk.ino.cpp.o — relocation truncated to fit");
  });

  test("a diagnostic with no file, line or column shows its message and never `undefined`", async () => {
    await mountSingle("evt-loc-drill-none", "loc-drill-none-agent", NOTHING);
    const lines = await drillInLineTexts("evt-loc-drill-none", "loc-drill-none-agent");
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("undefined");
    expect(lines[0]!.endsWith("ld returned 1 exit status")).toBe(true);
    // bound: no line/column numbers are invented for a diagnostic that has none.
    expect(lines[0]).not.toMatch(/:\d/);
  });
});

describe("compile run card preview renders a diagnostic's location only as far as it has one", () => {
  test("a diagnostic with file, line and column previews as `file:line — message` (unchanged)", async () => {
    await mountSingle("evt-loc-card-full", "loc-card-full-agent", FULL);
    expect(previewLineTexts("loc-card-full-agent")).toEqual([
      "/sketch/blink/blink.ino:12 — expected ';' before '}' token",
    ]);
  });

  test("a diagnostic with a file and a line but no column previews as `file:line — message`, never `undefined`", async () => {
    await mountSingle("evt-loc-card-nocol", "loc-card-nocol-agent", NO_COL);
    const lines = previewLineTexts("loc-card-nocol-agent");
    expect(lines).toEqual(["/sketch/lnk/lnk.ino:2 — multiple definition of `setup'"]);
  });

  test("a diagnostic with a file but no line previews as `file — message`, never `undefined`", async () => {
    await mountSingle("evt-loc-card-fileonly", "loc-card-fileonly-agent", FILE_ONLY);
    const lines = previewLineTexts("loc-card-fileonly-agent");
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("undefined");
    expect(lines[0]).toBe("/sketch/lnk/lnk.ino.cpp.o — relocation truncated to fit");
  });

  test("a diagnostic with no file previews as its message alone — no location prefix, never `undefined`", async () => {
    await mountSingle("evt-loc-card-none", "loc-card-none-agent", NOTHING);
    const lines = previewLineTexts("loc-card-none-agent");
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("undefined");
    expect(lines[0]).toBe("ld returned 1 exit status");
  });
});

describe("no rendered compile diagnostic line anywhere says `undefined`", () => {
  test("cards and drill-in over a mix of full, column-less, file-only and location-less diagnostics render every line without `undefined`", async () => {
    await mountCompileEvents([
      { id: "evt-loc-mix-a", agentId: "loc-mix-a-agent", diagnostics: [NO_COL, NOTHING] },
      { id: "evt-loc-mix-b", agentId: "loc-mix-b-agent", diagnostics: [FILE_ONLY, FULL] },
    ]);

    // The card previews first: every diag-line on the home surface, 2 per card.
    const cardLines = Array.from(document.querySelectorAll('[data-testid="diag-line"]')).map((l) =>
      (l.textContent ?? "").trim(),
    );
    expect(cardLines.length).toBe(4);

    // Then the drill-in of the first event: its 2 diagnostics.
    const drillLines = await drillInLineTexts("evt-loc-mix-a", "loc-mix-a-agent");
    expect(drillLines.length).toBe(2);

    const everyLine = [...cardLines, ...drillLines];
    expect(everyLine.filter((t) => t.includes("undefined"))).toEqual([]);

    // Each message still shows somewhere in what was rendered.
    for (const msg of [NO_COL.message, NOTHING.message, FILE_ONLY.message, FULL.message]) {
      expect(everyLine.some((t) => t.includes(msg))).toBe(true);
    }
  });
});
