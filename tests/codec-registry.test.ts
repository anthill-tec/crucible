// CR-CRU-002 §S3 — Codec registry: `codecs: Map<string, Codec>` with `junit` registered.
// Ingest paths look up a codec by name so adding a codec never touches core (§S3, §S4).
import { describe, test, expect } from "bun:test";
import { codecs } from "../src/codecs/index.ts";
import { parseJunit } from "../src/codecs/junit.ts";
import type { RunSchema } from "../src/types.ts";

// A 2-case suite (1 pass, 1 fail w/ message="boom") — enough to prove the registry entry
// genuinely DELEGATES to the real junit parsing logic rather than being a stub.
const JUNIT_XML = [
  '<testsuite name="RegistrySuite" tests="2">',
  '<testcase name="a" time="0.1"/>',
  '<testcase name="b" time="0.2"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

describe("codecs registry — §S3", () => {
  test("codecs is a Map with a defined 'junit' entry", () => {
    expect(codecs).toBeInstanceOf(Map);
    expect(codecs.get("junit")).toBeDefined();
  });

  test("the junit codec entry parses an inline XML string to the SAME RunSchema parseJunit produces (delegate check)", async () => {
    const junitCodec = codecs.get("junit");
    expect(junitCodec).toBeDefined();

    const direct: RunSchema = parseJunit(JUNIT_XML);
    // Sanity: this fixture genuinely exercises pass+fail, not a trivial empty-tree case.
    expect(direct.summary).toEqual({ total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 300 });

    const viaRegistry = await junitCodec!.parse(JUNIT_XML);
    expect(viaRegistry).toEqual(direct);
  });

  test("looking up an unknown codec name returns undefined without throwing", () => {
    expect(() => codecs.get("not-a-real-codec")).not.toThrow();
    expect(codecs.get("not-a-real-codec")).toBeUndefined();
  });
});
