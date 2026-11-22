// CR-CRU-130 §S5 — the accepted milestone vocabulary has ONE source, and the
// sites that need it READ it instead of holding a copy.
//
// What is held here is the server's side of that: the vocabulary a refusal
// publishes, and that the refusal's own `help[]` names every type its message
// enumerates — one response, one vocabulary.
//
// ── Safety ────────────────────────────────────────────────────────────────
// The only server here is `:memory:` in process (no port). The live `data/crucible.db` is
// never opened and port 3849 is never touched.
import { describe, test, expect, afterEach } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, send as boardSend } from "../helpers/run-stream-harness.ts";

const ORCH = "cru130-c3-one-source";

/** More names than the reserved pair: a vocabulary, not just the definition. */
const ENUMERATION_NAMES = 3;

describe("CR-CRU-130 §S5 — one vocabulary, read everywhere", () => {
  let handle: BoardHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  /**
   * The accepted vocabulary, READ OFF A RUNNING SERVER'S OWN REFUSAL — the
   * channel that publishes it. Nothing in this file types the list.
   */
  async function publishedVocabulary(): Promise<string[]> {
    handle = bootInProcess();
    const send = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await boardSend(handle!, `${path}`, {
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
    "the refusal and its own `help[]` cannot disagree: every type the refusal enumerates is a " +
      "type the help describes, because both read the same source",
    async () => {
      const vocabulary = await publishedVocabulary();
      const created = await boardSend(handle!, `/api/v2/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "cru130-help-agrees" }),
      });
      const key = ((await created.json()) as { project: { key: string } }).project.key;
      await boardSend(handle!, `/api/v2/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectKey: key, agentId: ORCH, role: "ORCHESTRATOR" }),
      });
      const res = await boardSend(handle!, `/api/v2/milestones`, {
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
});
