// CR-CRU-137 §S4 — the queue header names the release now being planned.
//
// Spec: docs/changes/CR-CRU-137-pipeline-defaults-are-chosen-not-inherited.md
// §S4 and its single acceptance criterion — "docs/changes/README.md's
// `**Target release:**` names the release now being planned".
//
// Measured on this branch before the fix: the header reads `0.2.0`, a release
// that has SHIPPED. The queue's own banner therefore names a release nobody is
// planning — the same shape as §S3's `License: none`: a load-bearing figure
// left at whatever it was last set to, owned by nobody.
//
// DERIVED, NOT FROZEN. The expected value is not the literal the queue happens
// to need today: it is READ from the table the header sits on top of. The
// `Wave` column's parenthetical qualifier is the ONLY place this queue has
// ever marked a release transition (§S4: "every prior release transition
// (0.1.0, 0.1.2, 0.1.3) is marked ONLY by the Wave column's own parenthetical
// qualifier — there has never been a separate boundary row"), so the table
// already states which release each row belongs to, and the header must simply
// agree with it. Retyping `0.2.2` here would re-create this very defect one
// release later, when the header is stale again and the test still passes.
//
// Rows whose qualifier is not a release number (`7 (post-0.2.0)`, the deferred
// backlog) are deliberately NOT candidates: `post-0.2.0` names an era, not a
// release anyone is cutting. Rows whose qualifier is ordering prose
// (`4 (after 011)`) are not either.
//
// §S4's originally-filed second AC — a "release-boundary row" — was CUT at gap
// analysis and is deliberately NOT asserted here: the queue has never used
// such a row, and inventing one would be a new format with no precedent and no
// reader.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const QUEUE_REL_PATH = "docs/changes/README.md";

function readQueue(): string {
  return readFileSync(join(REPO_ROOT, QUEUE_REL_PATH), "utf8");
}

/** The queue's own banner line, e.g. `**Target release:** 0.2.2`. */
const TARGET_RELEASE_PAT = /^\*\*Target release:\*\*[ \t]*(\S+)[ \t]*$/gm;

/** `| [CR-CRU-137](…) | title | type | STATUS | depends | WAVE |` */
const QUEUE_ROW_PAT =
  /^\|\s*\[(CR-CRU-\d+)\][^|]*\|[^|]*\|[^|]*\|\s*([^|]*?)\s*\|[^|]*\|\s*([^|]*?)\s*\|\s*$/gm;

/** A wave cell that names a release: `5 (0.2.0)`, `7 (0.2.2)` — and NOT
 *  `7 (post-0.2.0)` or `4 (after 011)`. */
const WAVE_RELEASE_PAT = /^\d+\s*\((\d+\.\d+\.\d+)\)$/;

interface QueueRow {
  cr: string;
  status: string;
  /** The release this row belongs to, or null when its wave names none. */
  release: string | null;
  /** Work the queue still expects someone to do. */
  pending: boolean;
}

function queueRows(markdown: string): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const match of markdown.matchAll(QUEUE_ROW_PAT)) {
    const [, cr, status, wave] = match as unknown as [string, string, string, string];
    const release = WAVE_RELEASE_PAT.exec(wave)?.[1] ?? null;
    rows.push({
      cr,
      status,
      release,
      pending: /^(PENDING|IN PROGRESS)/.test(status),
    });
  }
  return rows;
}

function compareRelease(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function targetReleaseHeaders(markdown: string): string[] {
  return [...markdown.matchAll(TARGET_RELEASE_PAT)].map((m) => m[1] as string);
}

describe("CR-CRU-137 §S4 the CR queue's Target release header", () => {
  test("names the highest release the queue still has PENDING rows for", () => {
    const markdown = readQueue();
    const rows = queueRows(markdown);

    // Parse guard, not a size pin: if the table shape ever changes under this
    // reader, the derivation below would quietly become vacuous and the
    // header would be free to say anything.
    expect(rows.length).toBeGreaterThan(100);

    const plannedReleases = rows
      .filter((row) => row.pending && row.release !== null)
      .map((row) => row.release as string);
    expect(plannedReleases.length).toBeGreaterThan(0);

    const planned = [...plannedReleases].sort(compareRelease).at(-1) as string;

    const headers = targetReleaseHeaders(markdown);
    // Exactly one banner — two would let a reader pick the convenient one.
    expect(headers.length).toBe(1);

    // POSITIVE — the header IS the release the table says is being worked on.
    expect(headers[0]).toBe(planned);

    // Bound — a release number, never an era (`post-0.2.0`) or a placeholder
    // (`TBD`), either of which would satisfy a looser presence check.
    expect(headers[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("never names a release whose every queue row is already closed", () => {
    const markdown = readQueue();
    const rows = queueRows(markdown);

    const releases = new Set(
      rows.map((row) => row.release).filter((r): r is string => r !== null),
    );
    const delivered = [...releases].filter(
      (release) => !rows.some((row) => row.release === release && row.pending),
    );

    // Guard — this repo has shipped releases, so the delivered set is never
    // empty; an empty one would make the assertion below vacuous.
    expect(delivered.length).toBeGreaterThan(0);

    // NEGATIVE — the failure this CR exists to catch: the banner left behind
    // on a release that is done. A release still mid-flight (some rows
    // closed, some PENDING) is deliberately NOT in `delivered`, so the
    // header may keep naming it while its last CRs land.
    const [header] = targetReleaseHeaders(markdown);
    expect(delivered).not.toContain(header);
  });
});
