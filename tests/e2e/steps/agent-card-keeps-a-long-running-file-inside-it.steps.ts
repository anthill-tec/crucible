// agent-card-keeps-a-long-running-file-inside-it.feature — steps. A streaming
// agent's card in the project pane keeps `running <done>/<total>` whole and
// cuts a long current file from its start behind a leading `…`, on one line
// inside the card, at the three screen bands in the three densities; the cut
// is visual only (the text keeps the whole path, the characters keep their
// order, the file part's hover title is the whole path); and the card's other
// lines wrap a very long token inside the card.
//
// Nothing is doubled: the run opens through POST /api/v2/runs/start
// (run-lifecycle.steps.ts's "a run is started for agent …"), its batch goes to
// POST /api/v2/runs/<runId>/stream, and the page moves on the board's own
// throttled `events` frames. Every wait is on the page; never a sleep.
//
// What is DRAWN is measured per character: each character of the line gets
// its box from a DOM Range, and it counts as drawn only where it lies inside
// both the card's padding box and every clipping box above it (any non-inline
// ancestor whose overflow-x is not `visible`). A character pushed out of a
// clipping box still has a box, so "drawn" is geometry, never `textContent`.
//
// The drawing checks are soft assertions: a scenario reports every check that
// fails, not only the first, so one run shows each claim's own verdict. The
// waits and the preconditions (the line holds the whole file, the file is
// wider than the card) stay hard: without them the checks would measure
// nothing.
//
// Reuses seeding.steps.ts (project, agent, a passing run),
// navigation.steps.ts (open the workspace), pane-scroll.steps.ts (the
// viewport), run-lifecycle.steps.ts (run start),
// agent-row-follows-its-runs-first-batch.steps.ts (the streaming mark, a
// first batch with a short file) and run-stream-live-page.steps.ts (the
// agent row's text).
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { registerAgent } from "./harness.ts";

const STREAM_CODEC = "crucible-events";

/** The board's own density preference key (`DENSITY_STORAGE_KEY`, public/app.js). */
const DENSITY_STORAGE_KEY = "crucible.density.mode";

/**
 * A test path far longer than the card is wide at every band, with no break
 * point in it. It starts with `./` on purpose: a cut that reverses the
 * line's direction without isolating the path moves a leading `.` or `/` to
 * the path's other end, which the order check catches.
 */
const LONG_FILE =
  "./tests/client/integration_suites/maven_runner_contracts/exit_code_propagation_and_file_reporting/" +
  "forked_surefire_processes/test_mvn_exits_and_files_on_its_runners_exit_code_when_the_forked_surefire_process_dies_mid_suite.py";

/** How many of the long file's first characters must not be drawn. */
const FIRST_CHARACTERS = 3;

const secondsToMs = (seconds: number): number => seconds * 1_000;

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

/** One unbroken token of `length` characters: lower-case letters and digits only. */
function longToken(length: number): string {
  let token = "";
  for (let i = 0; token.length < length; i += 1) token += `unbrokentoken${String(i)}`;
  return token.slice(0, length);
}

/** The project pane — on the phone band, once tapped open, it is the sheet. */
const projectPane = (page: Page): Locator =>
  page.locator('[data-testid="project-pane"], [data-testid="project-band-sheet"]');

const agentCard = (page: Page, text: string): Locator =>
  projectPane(page).getByTestId("agent-row").filter({ hasText: text });

const runningLine = (page: Page, agentId: string): Locator => agentCard(page, agentId).locator(".app-agent-msg");

// ── geometry, measured in the page ─────────────────────────────────────────

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface CharBox extends Box {
  ch: string;
  width: number;
  height: number;
  /** The horizontal window the character can be drawn in: the card ∩ every clipping box. */
  visLeft: number;
  visRight: number;
}

interface Ellipsis {
  how: "text-overflow" | "pseudo";
  /** text-overflow: the clipping box is right-to-left, so its `…` sits at its left. */
  rtl: boolean;
  /** text-overflow: the box's content is wider than the box, so the `…` is drawn. */
  overflowing: boolean;
  /** Whether the box holds the whole long file. */
  holdsFile: boolean;
}

interface Geometry {
  text: string;
  chars: CharBox[];
  card: Box;
  line: Box;
  ellipses: Ellipsis[];
}

/** Sub-pixel slack only — not a loophole for a character half out of the card. */
const TOL = 0.5;

async function geometryOf(target: Locator, file: string): Promise<Geometry> {
  await target.scrollIntoViewIfNeeded();
  return target.evaluate((root, wholeFile) => {
    const card = root.closest('[data-testid="agent-row"]');
    if (card === null) throw new Error("the line is not inside an agent card");
    const cardRect = card.getBoundingClientRect();
    const cardLeft = cardRect.left + card.clientLeft;
    const cardBox = { left: cardLeft, right: cardLeft + card.clientWidth, top: cardRect.top, bottom: cardRect.bottom };

    const clipOf = (node: Node): { left: number; right: number } => {
      let left = cardBox.left;
      let right = cardBox.right;
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
      height: number;
      visLeft: number;
      visRight: number;
    }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const data = (node as Text).data;
      const clip = clipOf(node);
      for (let i = 0; i < data.length; i += 1) {
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
          height: r.height,
          visLeft: clip.left,
          visRight: clip.right,
        });
      }
    }

    const ellipses: { how: "text-overflow" | "pseudo"; rtl: boolean; overflowing: boolean; holdsFile: boolean }[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      const cs = getComputedStyle(el);
      const holdsFile = (el.textContent ?? "").includes(wholeFile);
      if (
        cs.textOverflow === "ellipsis" &&
        cs.display !== "inline" &&
        cs.overflowX !== "visible" &&
        cs.whiteSpace !== "normal"
      ) {
        ellipses.push({
          how: "text-overflow",
          rtl: cs.direction === "rtl",
          overflowing: el.scrollWidth > el.clientWidth,
          holdsFile,
        });
      }
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.display !== "none" && ps.content.includes("…")) {
          ellipses.push({ how: "pseudo", rtl: false, overflowing: true, holdsFile });
        }
      }
    }

    const lineRect = root.getBoundingClientRect();
    return {
      text: root.textContent ?? "",
      chars,
      card: cardBox,
      line: { left: lineRect.left, right: lineRect.right, top: lineRect.top, bottom: lineRect.bottom },
      ellipses,
    };
  }, file);
}

/** Fully drawn: a real box, inside the card and inside every clipping box. */
const drawn = (c: CharBox): boolean => c.width > 0 && c.left >= c.visLeft - TOL && c.right <= c.visRight + TOL;

/** Not drawn at all: no box, or wholly outside the window it could be drawn in. */
const hidden = (c: CharBox): boolean => c.width === 0 || c.right <= c.visLeft + TOL || c.left >= c.visRight - TOL;

/** At least partly drawn. */
const shown = (c: CharBox): boolean => c.width > 0 && !hidden(c);

const describeChar = (c: CharBox, i: number): string =>
  `#${String(i)} "${c.ch}" at [${c.left.toFixed(1)}, ${c.right.toFixed(1)}] in window [${c.visLeft.toFixed(1)}, ${c.visRight.toFixed(1)}]`;

function fileStart(g: Geometry, file: string): number {
  const at = g.text.indexOf(file);
  expect(at, `the running line "${g.text}" holds the whole file`).toBeGreaterThanOrEqual(0);
  return at;
}

/**
 * Each drawn character sits right of the drawn character before it on the
 * same line. Only characters on one line are compared: whether the line
 * wraps is the one-line check's claim, not this one's, so a wrap alone never
 * fails it — a `.` or `/` moved to the path's other end does.
 */
function expectInOrder(g: Geometry, label: string): void {
  const out: string[] = [];
  const mid = (c: CharBox): number => (c.top + c.bottom) / 2;
  let prev: { c: CharBox; i: number } | null = null;
  g.chars.forEach((c, i) => {
    if (!shown(c)) return;
    const sameLine = prev !== null && Math.abs(mid(c) - mid(prev.c)) <= Math.min(c.height, prev.c.height) / 2;
    if (prev !== null && sameLine && !(c.left > prev.c.left)) {
      out.push(`${describeChar(c, i)} is not right of ${describeChar(prev.c, prev.i)}`);
    }
    prev = { c, i };
  });
  expect.soft(out, `${label}: the drawn characters, left to right, are in the text's order`).toEqual([]);
}

function expectOneLineInsideTheCard(g: Geometry): void {
  const boxed = g.chars.filter((c) => c.width > 0);
  expect(boxed.length, "the running line has drawn characters").toBeGreaterThan(0);
  const first = boxed[0] as CharBox;
  const mid = (c: CharBox): number => (c.top + c.bottom) / 2;
  const tol = Math.min(...boxed.map((c) => c.height)) / 2;
  const offLine = g.chars
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.width > 0 && Math.abs(mid(c) - mid(first)) > tol)
    .map(({ c, i }) => `${describeChar(c, i)} top ${c.top.toFixed(1)} vs ${first.top.toFixed(1)}`);
  expect.soft(offLine, "every character of the running line sits on the line of its first").toEqual([]);
  expect.soft(g.line.left, "the line's left edge").toBeGreaterThanOrEqual(g.card.left - TOL);
  expect.soft(g.line.right, "the line's right edge").toBeLessThanOrEqual(g.card.right + TOL);
  expect.soft(g.line.top, "the line's top").toBeGreaterThanOrEqual(g.card.top - TOL);
  expect.soft(g.line.bottom, "the line's bottom").toBeLessThanOrEqual(g.card.bottom + TOL);
}

/** An `…` the line draws: a pseudo-element's, or a text-overflow box that overflows. */
const drawnEllipses = (g: Geometry): Ellipsis[] =>
  g.ellipses.filter((e) => e.how === "pseudo" || e.overflowing);

// ── setup ──────────────────────────────────────────────────────────────────

Step("the board's row density is {string}", async ({ page, world }, density: string) => {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [DENSITY_STORAGE_KEY, density],
  );
  world.density = density;
});

Step(
  "that run's first stream batch lands for agent {string} with {int} of {int} tests done, the last in the long file",
  async ({ request, world }, agentId: string, done: number, total: number) => {
    const runId = world.runId as string;
    let data = line({ event: "run-start", total });
    for (let i = 1; i <= done; i += 1) {
      data += line({
        event: "test-end",
        id: `${runId}-t${String(i)}`,
        name: `finishes step ${String(i)}`,
        suite: "LongFile",
        file: i === done ? LONG_FILE : `src/earlier-${String(i)}.test.ts`,
        status: "pass",
        duration_ms: 3,
      });
    }
    const res = await request.post(`/api/v2/runs/${runId}/stream`, {
      data: { projectKey: world.projectKey as string, agentId, codec: STREAM_CODEC, from: 0, data },
    });
    const body = (await res.json()) as { ok?: boolean; held?: number };
    expect(res.status(), JSON.stringify(body)).toBe(200);
    expect(body.held).toBe(Buffer.byteLength(data, "utf8"));
  },
);

Step(
  "an online agent {string} is registered on that project with one {int}-character token as its message",
  async ({ request, world }, agentId: string, length: number) => {
    const token = longToken(length);
    await registerAgent(request, world.projectKey as string, agentId, token);
    world.longToken = token;
  },
);

Step(
  "an online agent whose id is one {int}-character token is registered on that project",
  async ({ request, world }, length: number) => {
    const token = longToken(length);
    await registerAgent(request, world.projectKey as string, token, "standing by");
    world.longToken = token;
  },
);

Step("the project pane's agents are on screen", async ({ page }) => {
  const band = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--band").trim(),
  );
  if (band === "phone") {
    await page.getByTestId("project-band-foot").click();
    await expect(page.getByTestId("project-band-sheet")).toBeVisible();
  }
  await expect(projectPane(page).getByTestId("agent-row").first()).toBeVisible();
});

// ── what the line reads ────────────────────────────────────────────────────

Step(
  "the agent row for {string} reads {string} and then the whole long file within {int} seconds",
  async ({ page }, agentId: string, prefix: string, seconds: number) => {
    await expect(runningLine(page, agentId)).toHaveText(`${prefix}${LONG_FILE}`, {
      timeout: secondsToMs(seconds),
    });
    // The text keeps the path's start: the cut is drawn, never written.
    expect(await runningLine(page, agentId).textContent()).toBe(`${prefix}${LONG_FILE}`);
  },
);

Step(
  "the agent row for {string} reads that long token within {int} seconds",
  async ({ page, world }, agentId: string, seconds: number) => {
    await expect(runningLine(page, agentId)).toHaveText(world.longToken as string, {
      timeout: secondsToMs(seconds),
    });
  },
);

Step(
  "the agent row for {string} reads an idle line holding that long token within {int} seconds",
  async ({ page, world }, agentId: string, seconds: number) => {
    const msg = runningLine(page, agentId);
    await expect(msg).toHaveText(/^idle · /, { timeout: secondsToMs(seconds) });
    await expect(msg).toContainText(`last run ${world.longToken as string}`);
  },
);

Step("the project pane shows the card of that long-id agent within {int} seconds", async ({ page, world }, seconds: number) => {
  await expect(agentCard(page, world.longToken as string)).toHaveCount(1, { timeout: secondsToMs(seconds) });
});

Step("the board is drawn at density {string}", async ({ page }, density: string) => {
  // The root class is what the density's spacing rules key on (styles.css).
  await expect(page.locator("html")).toHaveClass(new RegExp(`(^|\\s)app-density-${density}(\\s|$)`));
});

// ── what the line draws ────────────────────────────────────────────────────

Step("the long file is wider than the card of {string}", async ({ page }, agentId: string) => {
  const g = await geometryOf(runningLine(page, agentId), LONG_FILE);
  const at = fileStart(g, LONG_FILE);
  const width = g.chars.slice(at, at + LONG_FILE.length).reduce((sum, c) => sum + c.width, 0);
  expect(width, "the long file's drawn width, every character set side by side").toBeGreaterThan(
    g.card.right - g.card.left,
  );
});

Step("the card of {string} draws {string} in full", async ({ page }, agentId: string, part: string) => {
  const g = await geometryOf(runningLine(page, agentId), LONG_FILE);
  const at = g.text.indexOf(part);
  expect(at, `the running line "${g.text}" holds "${part}"`).toBeGreaterThanOrEqual(0);
  const cut = g.chars
    .slice(at, at + part.length)
    .map((c, i) => ({ c, i: at + i }))
    .filter(({ c }) => !drawn(c))
    .map(({ c, i }) => describeChar(c, i));
  expect.soft(cut, `every character of "${part}" is drawn inside the card`).toEqual([]);
});

Step(
  "the card of {string} draws the long file's last character inside the card and none of its first characters",
  async ({ page }, agentId: string) => {
    const g = await geometryOf(runningLine(page, agentId), LONG_FILE);
    const at = fileStart(g, LONG_FILE);
    const lastIndex = at + LONG_FILE.length - 1;
    const last = g.chars[lastIndex] as CharBox;
    expect.soft(drawn(last), `the file's last character is drawn inside the card: ${describeChar(last, lastIndex)}`).toBe(
      true,
    );
    const firstShown = g.chars
      .slice(at, at + FIRST_CHARACTERS)
      .map((c, i) => ({ c, i: at + i }))
      .filter(({ c }) => !hidden(c))
      .map(({ c, i }) => describeChar(c, i));
    expect.soft(firstShown, `none of the file's first ${String(FIRST_CHARACTERS)} characters is drawn`).toEqual([]);
  },
);

Step(
  "the card of {string} draws a {string} at the long file's left edge",
  async ({ page }, agentId: string, mark: string) => {
    expect(mark).toBe("…");
    const g = await geometryOf(runningLine(page, agentId), LONG_FILE);
    const atLeft = drawnEllipses(g).filter((e) => e.holdsFile && (e.how === "pseudo" || e.rtl));
    expect.soft(
      atLeft.length,
      `a "…" is drawn at the left of the box holding the long file (found: ${JSON.stringify(g.ellipses)})`,
    ).toBeGreaterThanOrEqual(1);
  },
);

Step(
  "the card of {string} draws its running line's characters in their own order",
  async ({ page }, agentId: string) => {
    expectInOrder(await geometryOf(runningLine(page, agentId), LONG_FILE), "the running line");
  },
);

Step(
  "the card of {string} draws its running line as one line inside the card",
  async ({ page }, agentId: string) => {
    expectOneLineInsideTheCard(await geometryOf(runningLine(page, agentId), LONG_FILE));
  },
);

Step(
  "the card of {string} draws every character of its running line inside the card",
  async ({ page }, agentId: string) => {
    const g = await geometryOf(runningLine(page, agentId), LONG_FILE);
    const cut = g.chars
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.ch.trim() !== "" && !drawn(c))
      .map(({ c, i }) => describeChar(c, i));
    expect.soft(cut, `every character of "${g.text}" is drawn inside the card`).toEqual([]);
    expectInOrder(g, "the running line");
  },
);

Step("the card of {string} draws no {string} on its running line", async ({ page }, agentId: string, mark: string) => {
  expect(mark).toBe("…");
  const g = await geometryOf(runningLine(page, agentId), LONG_FILE);
  expect.soft(g.text).not.toContain("…");
  expect.soft(drawnEllipses(g), "no `…` is drawn on a line whose file fits").toEqual([]);
});

Step("the project pane has no horizontal overflow", async ({ page }) => {
  const pane = projectPane(page);
  await expect(pane).toHaveCount(1);
  const { scrollWidth, clientWidth } = await pane.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect.soft(scrollWidth, `the project pane's content (${String(scrollWidth)}px) fits its box (${String(clientWidth)}px)`).toBeLessThanOrEqual(
    clientWidth + 1,
  );
});

Step(
  "the file part of the running line of {string} carries the whole long file as its hover title",
  async ({ page }, agentId: string) => {
    const titled = await runningLine(page, agentId).evaluate((root) =>
      [root, ...Array.from(root.querySelectorAll("*"))]
        .filter((el) => el.hasAttribute("title"))
        .map((el) => ({ text: (el.textContent ?? "").trim(), title: el.getAttribute("title") ?? "" })),
    );
    expect.soft(titled, "the elements of the running line that carry a hover title").toEqual([
      { text: LONG_FILE, title: LONG_FILE },
    ]);
  },
);

// ── a long token on the card's other lines ─────────────────────────────────

Step("every character of that long token is drawn inside the card that holds it", async ({ page, world }) => {
  const token = world.longToken as string;
  const card = agentCard(page, token);
  await expect(card).toHaveCount(1);
  // The token's own element: the card line whose text holds it.
  const holder = card.locator(".app-agent-id, .app-agent-msg").filter({ hasText: token });
  await expect(holder).toHaveCount(1);
  const g = await geometryOf(holder, token);
  const at = g.text.indexOf(token);
  expect(at, `the card line "${g.text}" holds the token`).toBeGreaterThanOrEqual(0);
  const out = g.chars
    .slice(at, at + token.length)
    .map((c, i) => ({ c, i: at + i }))
    .filter(({ c }) => !drawn(c))
    .map(({ c, i }) => describeChar(c, i));
  expect.soft(out.length, `every character of the token is drawn inside the card: ${out.slice(0, 5).join("; ")}`).toBe(0);
});
