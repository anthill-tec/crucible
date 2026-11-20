// A go run's `go test -json` stream, read by the `go-test` record stream codec
// — at codec level (the codec as the registry holds it) and over real HTTP
// (the stream sent to `POST /api/v2/runs/<runId>/stream` under `go-test`, the
// close through `POST /api/v2/runs` naming `go-test` and sending no report).
//
// The streams are real Go output, captured under `tests/fixtures/go-test/`
// (see the README there) with a toolchain that writes `OutputType`. The text
// form an older toolchain writes is derived here (`textFormOf`): the same
// lines with `OutputType` deleted.
//
// The oracles (`terminalTestEvents`, `verboseResults`, `topLevelReached`) read
// a fixture's own lines, so a test's expected counts come from the captured
// run, never from a guess.
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codecs, type DecodedRun } from "../../src/codecs/index.ts";
import type { SuiteNode, TestLeaf } from "../../src/types.ts";
import { batchesOf, openRun, postJson, readyProject, sendBatch, storedEvent, type Answer, type StoredRun, type Booted } from "./run-stream-harness.ts";

/** The record stream codec a go run's stream is read under. */
export const GO_TEST_CODEC = "go-test";

export const GO_TEST_RUNS = join(import.meta.dir, "..", "fixtures", "go-test");

/** One captured file under `tests/fixtures/go-test/`, as Go wrote it. */
export function fixture(file: string): string {
  return readFileSync(join(GO_TEST_RUNS, file), "utf-8");
}

/** Each JSON line of `text` rewritten by `edit`; blank lines kept as they are. */
function eachLine(text: string, edit: (fields: Record<string, unknown>) => void): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) return line;
      const fields = JSON.parse(line) as Record<string, unknown>;
      edit(fields);
      return JSON.stringify(fields);
    })
    .join("\n");
}

/** The text form (Go 1.24–1.26): every line without its `OutputType` field. */
export function textFormOf(text: string): string {
  return eachLine(text, (fields) => {
    delete fields["OutputType"];
  });
}

/** The stream with no `Time` on any line (a cached result writes none). */
export function withoutTime(text: string): string {
  return eachLine(text, (fields) => {
    delete fields["Time"];
  });
}

/** Both forms a go stream reaches the board in: Go 1.27's typed output, and the text form before it. */
export const FORMS: ReadonlyArray<{ name: string; of: (text: string) => string }> = [
  { name: "typed (OutputType, Go 1.27)", of: (text) => text },
  { name: "text form (no OutputType, Go 1.26)", of: textFormOf },
];

interface GoEvent {
  Action?: string;
  Package?: string;
  ImportPath?: string;
  Test?: string;
  Output?: string;
  FailedBuild?: string;
}

function eventsOf(text: string): GoEvent[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GoEvent);
}

/** Strings in code-point order, as `Array#sort` orders them with no comparator. */
export function byCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Every terminal `pass` / `fail` / `skip` event carrying a `Test`, in stream order. */
export function terminalTestEvents(text: string): Array<{ suite: string; name: string; action: string }> {
  return eventsOf(text)
    .filter((e) => e.Test !== undefined && (e.Action === "pass" || e.Action === "fail" || e.Action === "skip"))
    .map((e) => ({ suite: e.Package ?? "", name: e.Test ?? "", action: e.Action ?? "" }));
}

/** The test names a `go test -v` run's `--- PASS/FAIL/SKIP:` lines report, sorted. */
export function verboseResults(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*--- (?:PASS|FAIL|SKIP): (\S+)/.exec(line);
    const name = match?.[1];
    if (name !== undefined) names.push(name);
  }
  return names.sort(byCodePoint);
}

/** The `build-output` lines whose `ImportPath` is `importPath`, joined as Go printed them. */
export function buildOutputOf(text: string, importPath: string): string {
  return eventsOf(text)
    .filter((e) => e.Action === "build-output" && e.ImportPath === importPath)
    .map((e) => e.Output ?? "")
    .join("");
}

/** The `FailedBuild` a package's `fail` event names. */
export function failedBuildOf(text: string, pkg: string): string | undefined {
  return eventsOf(text).find((e) => e.Action === "fail" && e.Package === pkg && e.Test === undefined)?.FailedBuild;
}

/** The text up to and including the first line holding `marker`. */
export function upToLine(text: string, marker: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes(marker));
  if (at === -1) throw new Error(`no line holds ${marker}`);
  return `${lines.slice(0, at + 1).join("\n")}\n`;
}

/** The text before the first line holding `marker`. */
export function beforeLine(text: string, marker: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes(marker));
  if (at === -1) throw new Error(`no line holds ${marker}`);
  return `${lines.slice(0, at).join("\n")}\n`;
}

/** The character index just after the first line holding `marker` (a batch cut at a line boundary). */
export function afterLine(text: string, marker: string): number {
  return upToLine(text, marker).length;
}

/**
 * A go stream decoded by the codec the registry holds under `go-test`,
 * synchronously, as the board decodes a held stream at its close.
 */
export function decodeGoTest(text: string, options: { cut?: boolean; startTotal?: number } = {}): DecodedRun {
  const codec = codecs.get(GO_TEST_CODEC);
  if (codec === undefined) throw new Error("no go-test codec is registered");
  const decoded = codec.parse(text, {
    cut: options.cut === true,
    ...(options.startTotal !== undefined ? { startTotal: options.startTotal } : {}),
  });
  if (decoded instanceof Promise) throw new Error("the go-test codec must decode a stream synchronously");
  return decoded;
}

/** A status as the board stores a go action: `skip` is pending. */
export function statusOf(action: string): TestLeaf["status"] {
  if (action === "pass") return "pass";
  if (action === "fail") return "fail";
  return "pending";
}

/** Each case of a decoded tree as `<suite> :: <name> = <status>`, sorted. */
export function casesOf(tree: readonly SuiteNode[]): string[] {
  return tree.flatMap((suite) => suite.children.map((leaf) => `${suite.name} :: ${leaf.name} = ${leaf.status}`)).sort(byCodePoint);
}

/** The one leaf named `name` under the suite `suite`; fails the test when there is not exactly one. */
export function leafOf(tree: readonly SuiteNode[], suite: string, name: string): TestLeaf {
  const found = tree.filter((s) => s.name === suite).flatMap((s) => s.children.filter((leaf) => leaf.name === name));
  expect(found.length, `cases named ${name} under ${suite}`).toBe(1);
  const [leaf] = found;
  if (leaf === undefined) throw new Error(`no case named ${name} under ${suite}`);
  return leaf;
}

// ── over HTTP ───────────────────────────────────────────────────────────────

/** `text` sent to the open run under `go-test`, cut at `cuts` (character indices); each batch answered 200. */
export async function streamGoTest(
  handle: Booted,
  runId: string,
  projectKey: string,
  agentId: string,
  text: string,
  cuts: readonly number[] = [],
): Promise<void> {
  for (const [index, batch] of batchesOf(text, cuts).entries()) {
    const res = await sendBatch(handle, runId, { projectKey, agentId, codec: GO_TEST_CODEC, from: batch.from, data: batch.data });
    expect(res.status, `go-test batch ${index} (from ${batch.from}): ${String(res.body.error ?? "")}`).toBe(200);
    expect(res.body.held).toBe(batch.heldAfter);
  }
}

/** The close of a go run: `POST /api/v2/runs` with the runId, the `go-test` codec, and no report. */
export function closeGoTest(handle: Booted, projectKey: string, agentId: string, runId: string): Promise<Answer> {
  return postJson(handle, "/api/v2/runs", { projectKey, agentId, runId, codec: GO_TEST_CODEC });
}

export interface ClosedGoTestRun {
  key: string;
  runId: string;
  answer: Answer;
  event: StoredRun;
}

/** A run opened (`go`, with the start total when given), its stream sent, and closed under `go-test`. */
export async function closedGoTestRun(
  handle: Booted,
  agentId: string,
  plan: { stream: string; cuts?: readonly number[]; startTotal?: number },
): Promise<ClosedGoTestRun> {
  const key = await readyProject(handle, [agentId], "go-test-run");
  const runId = await openRun(handle, key, agentId, {
    stack: "go",
    tier: "unit",
    ...(plan.startTotal !== undefined ? { total: plan.startTotal } : {}),
  });
  await streamGoTest(handle, runId, key, agentId, plan.stream, plan.cuts ?? []);
  const answer = await closeGoTest(handle, key, agentId, runId);
  expect(answer.status, String(answer.body.error ?? "")).toBe(200);
  const event = await storedEvent(handle, answer.body.event);
  return { key, runId, answer, event };
}
