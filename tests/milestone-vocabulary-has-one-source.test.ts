// CR-CRU-130 §S5 — the accepted milestone vocabulary has ONE source, and the
// sites that need it READ it instead of holding a copy.
//
// ── What is broken today, measured ────────────────────────────────────────
//
// The vocabulary is written out, in full, in SEVEN places:
//
//   src/v2.ts:1168                     `MILESTONE_TYPES` — the validator
//   src/hints.ts:104                   the refusal's own `help[]`
//   clients/arduino-crucible.py:1408   `--type` help
//   clients/bun-crucible.py:2374       `--type` help
//   clients/mvn-crucible.py:2374       `--type` help
//   clients/python-crucible.py:1729    `--type` help
//   clients/rust-crucible.py:3020      `--type` help
//
// …and they have DISAGREED since CR-CRU-074 added `release`: the hint at
// src/hints.ts:104 still says "gap-analysis, design-review, stage-flip,
// custom, cr-merged" and omits it. A caller refused by the validator is handed
// a `help[]` naming a DIFFERENT set from the one the refusal's own message
// enumerates, in the same response. That live disagreement is what this file's
// scan must catch TODAY, and it is the proof the scan has teeth: a detector
// that missed a five-name literal sitting in the hint table would pass
// vacuously after GREEN too.
//
// ── What the scan asserts, and what it deliberately does not ──────────────
//
// It is a CONSTRUCTIONAL assertion: not "the copies agree" (they can agree and
// still be copies, and the next edit desynchronises them again) but "there is
// no copy". The instrument is a cluster detector over the READING sites named
// below: three or more DISTINCT accepted type names within one 240-character
// window of non-comment source is an enumeration, and an enumeration at a
// reading site is a copy.
//
// THREE is the threshold, and it is not arbitrary. The RESERVED pair —
// `release` and `cr-merged` — is server-owned and legitimately named in source
// (§S4: the server derives behaviour from those two names, so a `RESERVED`
// literal is a DEFINITION, not a copy). Two names is that definition; three is
// a vocabulary.
//
// The sites are scoped BY NAME, because a whole-tree scan is a false-positive
// machine: a doc, a fixture and a test may all enumerate types legitimately.
// These five files are the ones that must RESOLVE the vocabulary for a reader
// — the validator, the hint the validator hands back, the board's rendering
// and the five clients' `--type` help.
//
// `src/store.ts` is NOT scanned, and that is deliberate: §S4 makes the seeded
// vocabulary CONFIGURATION ("seeded from configuration so nothing that records
// them today breaks"), so the seed has exactly one home — the configuration
// seam that gives a project its defaults. A definition is not a copy. If GREEN
// leaves the seed in the route file instead, this scan fails, which is the
// intended pressure and not an accident of scoping.
//
// ── Non-vacuity ───────────────────────────────────────────────────────────
// The detector's own vocabulary is READ OFF A RUNNING SERVER (the refusal that
// publishes the accepted set), never typed here — so a scan comparing against
// an empty or two-name list fails its own guard before it can pass anything
// else. And `MUTATION` below plants a copy in a scratch file and proves the
// detector reports it, with its file and line.
//
// ── Safety ────────────────────────────────────────────────────────────────
// The only server here is `:memory:` on port 0. The live `data/crucible.db` is
// never opened and port 3849 is never touched. Every other case reads source
// files off disk and writes nothing.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

const ORCH = "cru130-c3-one-source";

/**
 * The sites that must RESOLVE the vocabulary rather than hold it — scoped by
 * name, for the reason in the header.
 */
const READING_SITES = [
  "src/v2.ts",
  "src/hints.ts",
  "public/app.js",
  "clients/arduino-crucible.py",
  "clients/bun-crucible.py",
  "clients/mvn-crucible.py",
  "clients/python-crucible.py",
  "clients/rust-crucible.py",
] as const;

/** An enumeration is three distinct names inside one window of source. */
const ENUMERATION_NAMES = 3;
const WINDOW_CHARS = 240;

interface Offender {
  readonly site: string;
  readonly line: number;
  readonly names: string[];
}

/** Comment lines carry prose, and prose may name types legitimately. */
function stripComments(text: string, python: boolean): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (python ? trimmed.startsWith("#") : /^(\/\/|\*|\/\*)/.test(trimmed)) return "";
      return line;
    })
    .join("\n");
}

/**
 * Every enumeration of the vocabulary in `text`, as `file:line` plus the names
 * that made it one. Overlapping windows collapse into the FIRST of them, so a
 * six-line literal is reported once and not six times.
 */
function enumerationsIn(site: string, text: string, vocabulary: readonly string[]): Offender[] {
  const source = stripComments(text, site.endsWith(".py"));
  const hits: Array<{ at: number; name: string }> = [];
  for (const name of vocabulary) {
    let at = source.indexOf(name);
    while (at !== -1) {
      hits.push({ at, name });
      at = source.indexOf(name, at + 1);
    }
  }
  hits.sort((a, b) => a.at - b.at);

  const offenders: Offender[] = [];
  let reportedThrough = -1;
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i]!.at;
    if (start <= reportedThrough) continue;
    const names = new Set<string>();
    let end = start;
    for (let j = i; j < hits.length && hits[j]!.at - start <= WINDOW_CHARS; j += 1) {
      names.add(hits[j]!.name);
      end = hits[j]!.at;
    }
    if (names.size < ENUMERATION_NAMES) continue;
    reportedThrough = end;
    offenders.push({
      site,
      line: source.slice(0, start).split("\n").length,
      names: [...names].sort(),
    });
  }
  return offenders;
}

function report(offenders: readonly Offender[]): string {
  return offenders.map((o) => `  ${o.site}:${String(o.line)}  ${o.names.join(", ")}`).join("\n");
}

describe("CR-CRU-130 §S5 — one vocabulary, read everywhere", () => {
  let handle: ServerHandle | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  /**
   * The accepted vocabulary, READ OFF A RUNNING SERVER'S OWN REFUSAL — the
   * channel that publishes it. Nothing in this file types the list.
   */
  async function publishedVocabulary(): Promise<string[]> {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const base = `http://localhost:${String(handle.server.port)}`;
    const send = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as Record<string, unknown>;
    };
    const created = await send("/api/v2/projects", { name: "cru130-vocabulary-source" });
    const key = (created.project as { key: string }).key;
    await send("/api/v2/agents/register", { projectKey: key, agentId: ORCH, role: "ORCHESTRATOR" });
    const refused = await send("/api/v2/milestones", {
      projectKey: key,
      agentId: ORCH,
      type: "__definitely-not-a-milestone-type__",
    });
    const match = /type must be one of:\s*(.+)$/.exec(String(refused.error ?? ""));
    if (match === null) {
      throw new Error(
        `CR-CRU-130 §S5: the server publishes no accepted set to scan for — POST ` +
          `/api/v2/milestones answered ${JSON.stringify(refused.error)}. The scan's instrument ` +
          `is the server's own vocabulary; it is never typed into this file.`,
      );
    }
    return match[1]!
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  test(
    "GUARD — the scan's instrument is the server's own published vocabulary, and it names more " +
      "than the reserved pair (a two-name list would make every enumeration check pass vacuously)",
    async () => {
      const vocabulary = await publishedVocabulary();
      expect(vocabulary.length).toBeGreaterThanOrEqual(ENUMERATION_NAMES);
      // The reserved pair is IN the published set — it is accepted, it is just
      // not the project's to declare. Without this the scan could be reading a
      // set that excludes exactly the names a copy would carry.
      expect(vocabulary).toContain("release");
      expect(vocabulary).toContain("cr-merged");
      expect(vocabulary).toContain("custom");
    },
  );

  test(
    "MUTATION — a planted enumeration is reported with its file and line, and the RESERVED pair " +
      "alone is not: two server-owned names are a definition, three are a vocabulary",
    async () => {
      const vocabulary = await publishedVocabulary();
      const dir = mkdtempSync(join(tmpdir(), "cru130-c3-scan-"));
      scratchDirs.push(dir);

      const copy = join(dir, "mutant.ts");
      writeFileSync(
        copy,
        `const ACCEPTED = new Set([\n  "gap-analysis",\n  "design-review",\n  "stage-flip",\n]);\n`,
      );
      const caught = enumerationsIn("mutant.ts", readFileSync(copy, "utf8"), vocabulary);
      expect(caught.length).toBe(1);
      expect(caught[0]!.line).toBe(2);
      expect(caught[0]!.names).toEqual(["design-review", "gap-analysis", "stage-flip"]);

      const reserved = join(dir, "reserved.ts");
      writeFileSync(reserved, `const RESERVED = new Set(["release", "cr-merged"]);\n`);
      expect(enumerationsIn("reserved.ts", readFileSync(reserved, "utf8"), vocabulary)).toEqual([]);

      // …and a COMMENT naming three types is prose, not a copy.
      const prose = join(dir, "prose.ts");
      writeFileSync(
        prose,
        `// gap-analysis, design-review and stage-flip used to be server constants.\nexport const x = 1;\n`,
      );
      expect(enumerationsIn("prose.ts", readFileSync(prose, "utf8"), vocabulary)).toEqual([]);
    },
  );

  test(
    "no reading site holds a literal copy of the vocabulary — not the validator, not the hint " +
      "the validator hands back, not the board, and not one of the five clients' `--type` help",
    async () => {
      const vocabulary = await publishedVocabulary();
      const offenders = READING_SITES.flatMap((site) =>
        enumerationsIn(site, readFileSync(join(process.cwd(), site), "utf8"), vocabulary),
      );
      expect(report(offenders)).toBe("");
      expect(offenders).toEqual([]);
    },
  );

  test(
    "the hint the refusal hands back holds no copy — the site whose stale five-name list has " +
      "disagreed with the validator since `release` was accepted",
    async () => {
      const vocabulary = await publishedVocabulary();
      const offenders = enumerationsIn(
        "src/hints.ts",
        readFileSync(join(process.cwd(), "src", "hints.ts"), "utf8"),
        vocabulary,
      );
      expect(report(offenders)).toBe("");
    },
  );

  test(
    "the refusal and its own `help[]` cannot disagree: every type the refusal enumerates is a " +
      "type the help describes, because both read the same source",
    async () => {
      const vocabulary = await publishedVocabulary();
      const base = `http://localhost:${String(handle!.server.port)}`;
      const created = await fetch(`${base}/api/v2/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "cru130-help-agrees" }),
      });
      const key = ((await created.json()) as { project: { key: string } }).project.key;
      await fetch(`${base}/api/v2/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectKey: key, agentId: ORCH, role: "ORCHESTRATOR" }),
      });
      const res = await fetch(`${base}/api/v2/milestones`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectKey: key, agentId: ORCH, type: "__nope__" }),
      });
      const refused = (await res.json()) as { error?: string; help?: string[] };
      const help = (refused.help ?? []).join("\n");

      // TODAY: the help omits `release`, which the message right beside it
      // names — one response, two vocabularies.
      const missing = vocabulary.filter((type) => !help.includes(type));
      expect({ missing, help }).toEqual({ missing: [], help });
    },
  );

  test(
    "GUARD — the RESERVED pair is declared exactly ONCE across the server, the board and the " +
      "clients: a second literal naming both is a second reserved set",
    () => {
      const searched = [
        ...READING_SITES,
        "src/store.ts",
        "src/types.ts",
        "clients/_crucible_axi.py",
      ];
      const declarations: string[] = [];
      for (const site of searched) {
        const text = readFileSync(join(process.cwd(), site), "utf8");
        for (const match of text.matchAll(/\[[^[\]]*\]/gs)) {
          const body = match[0];
          if (!/["']release["']/.test(body) || !/["']cr-merged["']/.test(body)) continue;
          declarations.push(`${site}:${String(text.slice(0, match.index).split("\n").length)}`);
        }
      }
      expect(declarations.length).toBe(1);
    },
  );
});
