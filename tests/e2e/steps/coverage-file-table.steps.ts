// The coverage file table in a real browser — steps.
//
// A run's coverage files are listed by name, without the directory they all
// share. On a desktop browser a name too long for its cell is cut on the left,
// so its end stays in view. On the phone band a row's functions figure moves
// beneath its name and the table stays inside its pane; on touch media a long
// name is not cut but drawn whole, wrapped after a `/`, and the run page's
// coverage line and the `show all` control are touch targets.
//
// Nothing is doubled: each run is filed through the board's own ingest route
// with an lcov report, and the page draws what the board decoded and stored.
//
// What is DRAWN is measured per character: each character of a row gets its
// box from a DOM Range, and it counts as drawn only where it lies inside every
// clipping box above it (any non-inline ancestor whose overflow-x is not
// `visible`) and inside the viewport. A character pushed out of a clipping box
// still has a box, so "drawn" is geometry, never `textContent`. No class name
// is read: a row is found by its test id and its `title`, a name and a figure
// by their text.
//
// Reuses seeding.steps.ts (the project), navigation.steps.ts and
// workflow.steps.ts (the workspace and its tabs), drillin.steps.ts (a run's
// own page at its address) and pane-scroll.steps.ts (the viewport, the page's
// own horizontal scroll).
import { expect, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { registerAgent } from "./harness.ts";

/** The directory every file of the long-name run shares. */
const SHARED_DIRECTORY = "/home/dev/workspace/services/";

/**
 * A file name far wider than any cell it is drawn in, at every band. Each of
 * its directories is short, so a browser that may break after a `/` never
 * needs to break anywhere else; it holds no hyphen and no space.
 */
const LONG_NAME = [
  "billing_engine",
  "src",
  "domain",
  "invoices",
  "reconciliation",
  "adapters",
  "ledger_gateway",
  "internal",
  "retry_policies",
  "exponential_backoff",
  "with_jitter",
  "clients",
  "http_transport",
  "connection_pooling",
  "keep_alive_sessions",
  "retrying_ledger_gateway.rs",
].join("/");

interface ListedFile {
  /** The name as its row shows it: the report's name without the shared directory. */
  name: string;
  lines: [covered: number, total: number];
  functions: [covered: number, total: number];
  /** The functions figure as its row words it. */
  functionsFigure: RegExp;
}

/** The long-name run's three files, least covered first, as the board keeps them. */
const LISTED: ListedFile[] = [
  { name: LONG_NAME, lines: [10, 40], functions: [1, 4], functionsFigure: /1\/4\s*·\s*25%/ },
  { name: "api/server.rs", lines: [20, 40], functions: [2, 4], functionsFigure: /2\/4\s*·\s*50%/ },
  { name: "cli/main.rs", lines: [30, 40], functions: [3, 4], functionsFigure: /3\/4\s*·\s*75%/ },
];

/** How many of the long name's first characters must not be drawn where it is cut. */
const FIRST_CHARACTERS = 3;

/** Sub-pixel slack only. */
const TOL = 0.5;

const GREEN_REPORT = [
  '<testsuite name="Green" tests="2">',
  '<testcase name="g1" time="0.01"/>',
  '<testcase name="g2" time="0.02"/>',
  "</testsuite>",
].join("\n");

interface LcovRecord {
  path: string;
  lines: [covered: number, total: number];
  functions: [covered: number, total: number];
}

function lcovOf(records: readonly LcovRecord[]): string {
  return records
    .map((record) =>
      [
        `SF:${record.path}`,
        `FNF:${String(record.functions[1])}`,
        `FNH:${String(record.functions[0])}`,
        `LF:${String(record.lines[1])}`,
        `LH:${String(record.lines[0])}`,
        "end_of_record",
        "",
      ].join("\n"),
    )
    .join("");
}

async function ingestGreenRunWithCoverage(
  request: import("@playwright/test").APIRequestContext,
  projectKey: string,
  agentId: string,
  records: readonly LcovRecord[],
): Promise<string> {
  await registerAgent(request, projectKey, agentId, "filing a coverage run");
  const res = await request.post("/api/v2/runs", {
    data: {
      projectKey,
      agentId,
      codec: "junit",
      data: GREEN_REPORT,
      coverage: { codec: "lcov", data: lcovOf(records) },
    },
  });
  expect(res.ok(), `the coverage run is filed: ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { event: string };
  expect(typeof body.event).toBe("string");
  return body.event;
}

Step(
  "a green run whose coverage report names one very long file and two short ones is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    world.eventId = await ingestGreenRunWithCoverage(
      request,
      world.projectKey as string,
      agentId,
      LISTED.map((file) => ({ path: `${SHARED_DIRECTORY}${file.name}`, lines: file.lines, functions: file.functions })),
    );
  },
);

Step(
  "a green run whose coverage report names {int} files is ingested for agent {string}",
  async ({ request, world }, count: number, agentId: string) => {
    world.eventId = await ingestGreenRunWithCoverage(
      request,
      world.projectKey as string,
      agentId,
      Array.from({ length: count }, (_, index) => ({
        path: `/srv/app/src/m${String(index).padStart(2, "0")}.ts`,
        lines: [index, 100] as [number, number],
        functions: [2, 4] as [number, number],
      })),
    );
  },
);

Step("I tap the run's coverage line", async ({ page }) => {
  const line = page.getByTestId("run-coverage");
  await expect(line).toBeVisible();
  await line.click();
});

Step("the coverage file table lists {int} files", async ({ page }, count: number) => {
  await expect(page.getByTestId("coverage-files")).toBeVisible();
  await expect(page.getByTestId("coverage-file-row")).toHaveCount(count);
});

// ── geometry, measured in the page ─────────────────────────────────────────

interface CharBox {
  ch: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  /** The horizontal window the character can be drawn in: the viewport ∩ every clipping box. */
  visLeft: number;
  visRight: number;
}

interface RowGeometry {
  /** The row's `title`. */
  title: string | null;
  /** The row's characters in document order, zero-width spaces left out. */
  chars: CharBox[];
}

/** The geometry of the row whose `title` is `wholeName`, which must be there. */
async function rowGeometry(page: Page, wholeName: string): Promise<RowGeometry> {
  const rows = page.getByTestId("coverage-file-row");
  await expect(rows.first()).toBeVisible();
  const reading = await page.evaluate((whole) => {
    const row = Array.from(document.querySelectorAll('[data-testid="coverage-file-row"]')).find(
      (el) => el.getAttribute("title") === whole,
    );
    if (row === undefined) return null;
    row.scrollIntoView({ block: "center" });

    const clipOf = (node: Node): { left: number; right: number } => {
      let left = 0;
      let right = document.documentElement.clientWidth;
      for (let el = node.parentElement; el !== null; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.display === "inline" || cs.display === "contents") continue;
        if (cs.overflowX === "visible") continue;
        const r = el.getBoundingClientRect();
        const l = r.left + el.clientLeft;
        left = Math.max(left, l);
        right = Math.min(right, l + el.clientWidth);
      }
      return { left, right };
    };

    const chars: {
      ch: string;
      left: number;
      right: number;
      top: number;
      bottom: number;
      width: number;
      visLeft: number;
      visRight: number;
    }[] = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const data = (node as Text).data;
      const clip = clipOf(node);
      for (let i = 0; i < data.length; i += 1) {
        if (data[i] === "\u200B") continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        chars.push({
          ch: data[i] ?? "",
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: r.width,
          visLeft: clip.left,
          visRight: clip.right,
        });
      }
    }
    return { title: row.getAttribute("title"), chars };
  }, wholeName);
  expect(reading, `a coverage file row whose title is ${wholeName}`).not.toBeNull();
  return reading!;
}

const textOf = (chars: readonly CharBox[]): string => chars.map((c) => c.ch).join("");

/** Fully drawn: a real box inside every clipping box and the viewport. */
const drawn = (c: CharBox): boolean => c.width > 0 && c.left >= c.visLeft - TOL && c.right <= c.visRight + TOL;

/** Not drawn at all: no box, or wholly outside the window it could be drawn in. */
const hidden = (c: CharBox): boolean => c.width === 0 || c.right <= c.visLeft + TOL || c.left >= c.visRight - TOL;

/** The characters of `name` in the row, which must hold it. */
function nameChars(g: RowGeometry, name: string): CharBox[] {
  const at = textOf(g.chars).indexOf(name);
  expect(at, `the row shows the name ${name}; it reads "${textOf(g.chars)}"`).toBeGreaterThanOrEqual(0);
  return g.chars.slice(at, at + name.length);
}

/** The characters of the row's functions figure, which must be there, after the name. */
function functionsChars(g: RowGeometry, file: ListedFile): CharBox[] {
  const text = textOf(g.chars);
  const afterName = text.indexOf(file.name) + file.name.length;
  const found = file.functionsFigure.exec(text.slice(afterName));
  expect(found, `the row of ${file.name} shows its functions figure; it reads "${text}"`).not.toBeNull();
  const at = afterName + found!.index;
  return g.chars.slice(at, at + found![0].length).filter((c) => c.ch.trim() !== "");
}

/** The distinct lines the characters are drawn on, top to bottom. */
function lineTops(chars: readonly CharBox[]): number[] {
  const tops: number[] = [];
  for (const c of chars) {
    if (c.width === 0) continue;
    if (!tops.some((top) => Math.abs(top - c.top) <= 2)) tops.push(c.top);
  }
  return tops.sort((a, b) => a - b);
}

const wholeNameOf = (file: ListedFile): string => `${SHARED_DIRECTORY}${file.name}`;
const LONG_FILE = LISTED[0]!;
const SHORT_FILE = LISTED[1]!;

// ── the phone band ─────────────────────────────────────────────────────────

Step("every coverage file row draws its functions figure beneath its file's name", async ({ page }) => {
  for (const file of LISTED) {
    const g = await rowGeometry(page, wholeNameOf(file));
    const name = nameChars(g, file.name).filter((c) => c.width > 0);
    const figure = functionsChars(g, file);
    expect(name.length, `the name ${file.name} is drawn`).toBeGreaterThan(0);
    expect(figure.length, `the functions figure of ${file.name} is drawn`).toBeGreaterThan(0);
    const nameBottom = Math.max(...name.map((c) => c.bottom));
    const figureTop = Math.min(...figure.map((c) => c.top));
    expect(
      figureTop,
      `the functions figure of ${file.name} starts at ${String(figureTop)}, its name ends at ${String(nameBottom)}`,
    ).toBeGreaterThanOrEqual(nameBottom - TOL);
    for (const c of figure) expect(drawn(c), `"${c.ch}" of the functions figure of ${file.name} is drawn`).toBe(true);
  }
});

Step("the coverage file table is no wider than its pane", async ({ page }) => {
  const table = page.getByTestId("coverage-files");
  await expect(table).toBeVisible();
  const m = await table.evaluate((el) => {
    const pane = el.closest('[data-testid="pane-scroll"]');
    if (pane === null) return null;
    const paneRect = pane.getBoundingClientRect();
    const paneLeft = paneRect.left + pane.clientLeft;
    const tableRect = el.getBoundingClientRect();
    return {
      tableLeft: tableRect.left,
      tableRight: tableRect.right,
      tableWidth: tableRect.width,
      tableScrollWidth: el.scrollWidth,
      tableClientWidth: el.clientWidth,
      paneLeft,
      paneRight: paneLeft + pane.clientWidth,
      paneClientWidth: pane.clientWidth,
      paneScrollWidth: pane.scrollWidth,
    };
  });
  expect(m, "the coverage file table sits in a pane").not.toBeNull();
  expect(m!.tableWidth, "the table's width against its pane's").toBeLessThanOrEqual(m!.paneClientWidth + TOL);
  expect(m!.tableLeft, "the table's left edge against its pane's").toBeGreaterThanOrEqual(m!.paneLeft - TOL);
  expect(m!.tableRight, "the table's right edge against its pane's").toBeLessThanOrEqual(m!.paneRight + TOL);
  expect(m!.tableScrollWidth, "the table's own content against its width").toBeLessThanOrEqual(m!.tableClientWidth + 1);
  expect(m!.paneScrollWidth, "the pane does not scroll sideways").toBeLessThanOrEqual(m!.paneClientWidth + 1);
});

Step("the long coverage file name is drawn whole, without the directory its files share", async ({ page }) => {
  const g = await rowGeometry(page, wholeNameOf(LONG_FILE));
  expect(textOf(g.chars).includes(SHARED_DIRECTORY), `the row shows the shared directory: "${textOf(g.chars)}"`).toBe(false);
  const name = nameChars(g, LONG_FILE.name);
  const undrawn = name.filter((c) => !drawn(c));
  expect(
    undrawn.length,
    `${String(undrawn.length)} of the long name's ${String(name.length)} characters are not drawn inside their cell`,
  ).toBe(0);
});

Step(
  "the long coverage file name is wrapped over more than one line, breaking only after a {string}",
  async ({ page }, breakAfter: string) => {
    const g = await rowGeometry(page, wholeNameOf(LONG_FILE));
    const name = nameChars(g, LONG_FILE.name).filter((c) => c.width > 0);
    expect(lineTops(name).length, "the lines the long name is drawn on").toBeGreaterThan(1);
    const lastOfEachBrokenLine: string[] = [];
    for (let i = 0; i + 1 < name.length; i += 1) {
      if (name[i + 1]!.top > name[i]!.top + 2) lastOfEachBrokenLine.push(name[i]!.ch);
    }
    expect(lastOfEachBrokenLine.length, "the long name's line breaks").toBeGreaterThanOrEqual(1);
    expect(
      lastOfEachBrokenLine.filter((ch) => ch !== breakAfter),
      `the character before each line break: ${JSON.stringify(lastOfEachBrokenLine)}`,
    ).toEqual([]);
  },
);

Step("the run's coverage line is at least 44px tall", async ({ page }) => {
  const line = page.getByTestId("run-coverage");
  await expect(line).toBeVisible();
  const box = await line.boundingBox();
  expect(box, "the coverage line has a box").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

Step("the coverage file table's show all control is at least 44px tall", async ({ page }) => {
  const control = page.getByTestId("coverage-files-show-all");
  await expect(control).toBeVisible();
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box, "the show all control has a box").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

// ── a desktop browser ──────────────────────────────────────────────────────

Step("the long coverage file name is wider than the cell it is drawn in", async ({ page }) => {
  const g = await rowGeometry(page, wholeNameOf(LONG_FILE));
  const name = nameChars(g, LONG_FILE.name);
  const natural = name.reduce((sum, c) => sum + c.width, 0);
  const cell = Math.min(...name.map((c) => c.visRight)) - Math.max(...name.map((c) => c.visLeft));
  expect(natural, `the long name measures ${String(natural)}px, its cell ${String(cell)}px`).toBeGreaterThan(cell + 20);
});

Step(
  "the long coverage file name's last character is drawn and none of its first characters",
  async ({ page }) => {
    const g = await rowGeometry(page, wholeNameOf(LONG_FILE));
    const name = nameChars(g, LONG_FILE.name);
    const last = name[name.length - 1]!;
    expect(drawn(last), `the long name's last character "${last.ch}" is drawn inside its cell`).toBe(true);
    for (const c of name.slice(-12)) {
      expect(drawn(c), `"${c.ch}", one of the long name's last 12 characters, is drawn inside its cell`).toBe(true);
    }
    for (const c of name.slice(0, FIRST_CHARACTERS)) {
      expect(hidden(c), `"${c.ch}", one of the long name's first characters, is not drawn`).toBe(true);
    }
  },
);

Step("the long coverage file name is drawn on one line, its characters in their own order", async ({ page }) => {
  const g = await rowGeometry(page, wholeNameOf(LONG_FILE));
  const shown = nameChars(g, LONG_FILE.name).filter(drawn);
  expect(shown.length, "the long name's drawn characters").toBeGreaterThan(12);
  expect(lineTops(shown).length, "the lines the long name is drawn on").toBe(1);
  for (let i = 0; i + 1 < shown.length; i += 1) {
    expect(
      shown[i + 1]!.left,
      `"${shown[i + 1]!.ch}" is drawn after "${shown[i]!.ch}" (character ${String(i)} of the drawn part)`,
    ).toBeGreaterThanOrEqual(shown[i]!.left);
  }
  // What is drawn is the name's end, read left to right.
  expect(LONG_FILE.name.endsWith(shown.map((c) => c.ch).join(""))).toBe(true);
});

Step("the long coverage file's row carries its whole name as its title", async ({ page }) => {
  const g = await rowGeometry(page, wholeNameOf(LONG_FILE));
  expect(g.title).toBe(`${SHARED_DIRECTORY}${LONG_NAME}`);
  expect(textOf(g.chars).includes(SHARED_DIRECTORY), `the row shows the shared directory: "${textOf(g.chars)}"`).toBe(false);
});

Step("a short coverage file name is drawn whole on one line", async ({ page }) => {
  const g = await rowGeometry(page, wholeNameOf(SHORT_FILE));
  const name = nameChars(g, SHORT_FILE.name);
  for (const c of name) expect(drawn(c), `"${c.ch}" of ${SHORT_FILE.name} is drawn`).toBe(true);
  expect(lineTops(name).length, `the lines ${SHORT_FILE.name} is drawn on`).toBe(1);
});
