// CR-CRU-002 §S1 — JUnit codec: hand-rolled minimal XML → canonical RunSchema.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunSummary, SuiteNode, TestLeaf } from "../types.ts";
import type { DecodedRun } from "./index.ts";

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(source)) !== null) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Minimal XML parser: elements, attributes, text, CDATA, comments, prolog/DOCTYPE. */
function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;

  while (i < xml.length) {
    const current = stack[stack.length - 1];
    if (xml[i] === "<") {
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i + 4);
        if (end === -1) throw new Error("malformed XML: unterminated comment");
        i = end + 3;
      } else if (xml.startsWith("<![CDATA[", i)) {
        const end = xml.indexOf("]]>", i + 9);
        if (end === -1) throw new Error("malformed XML: unterminated CDATA section");
        current.text += xml.slice(i + 9, end);
        i = end + 3;
      } else if (xml.startsWith("<?", i)) {
        const end = xml.indexOf("?>", i + 2);
        if (end === -1) throw new Error("malformed XML: unterminated processing instruction");
        i = end + 2;
      } else if (xml.startsWith("<!", i)) {
        const end = xml.indexOf(">", i + 2);
        if (end === -1) throw new Error("malformed XML: unterminated declaration");
        i = end + 1;
      } else if (xml.startsWith("</", i)) {
        const end = xml.indexOf(">", i + 2);
        if (end === -1) throw new Error("malformed XML: unterminated closing tag");
        const name = xml.slice(i + 2, end).trim();
        const open = stack.pop();
        if (open === undefined || open === root || open.name !== name) {
          throw new Error(`malformed XML: unexpected closing tag </${name}>`);
        }
        i = end + 1;
      } else {
        const end = xml.indexOf(">", i + 1);
        if (end === -1) throw new Error("malformed XML: unterminated opening tag");
        let inner = xml.slice(i + 1, end);
        const selfClosing = inner.endsWith("/");
        if (selfClosing) inner = inner.slice(0, -1);
        const nameMatch = /^[^\s/>]+/.exec(inner.trim());
        if (nameMatch === null) throw new Error("malformed XML: empty tag name");
        const element: XmlElement = {
          name: nameMatch[0],
          attrs: parseAttrs(inner.slice(nameMatch[0].length)),
          children: [],
          text: "",
        };
        current.children.push(element);
        if (!selfClosing) stack.push(element);
        i = end + 1;
      }
    } else {
      const next = xml.indexOf("<", i);
      const chunk = next === -1 ? xml.slice(i) : xml.slice(i, next);
      current.text += decodeEntities(chunk);
      i = next === -1 ? xml.length : next;
    }
  }

  if (stack.length !== 1) {
    throw new Error(`malformed XML: unclosed tag <${stack[stack.length - 1].name}>`);
  }
  const rootElement = root.children.find((c) => c.name.length > 0);
  if (rootElement === undefined) throw new Error("malformed XML: no root element");
  return rootElement;
}

function toDurationMs(time: string | undefined): number {
  const seconds = Number.parseFloat(time ?? "0");
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/** A failure's message is cut to this many characters. */
const MESSAGE_LIMIT = 1000;
/** A failure's trace is cut to this many characters. */
const TRACE_LIMIT = 8000;

/** The value when it holds more than whitespace, else undefined. */
function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/** A suite or case name; a missing or blank one is `?`. */
function nameOf(el: XmlElement): string {
  return nonBlank(el.attrs["name"]) ?? "?";
}

/**
 * A failure's text: the message is the non-empty `message` attribute, else
 * the first non-empty line of the text; the trace is the text; the type is
 * the `type` attribute. Each part is present only when non-empty.
 */
function toFailure(failureEl: XmlElement): NonNullable<TestLeaf["failure"]> {
  const trace = failureEl.text.trim();
  const firstLine = trace.split("\n").find((line) => line.trim().length > 0)?.trim();
  const message = nonBlank(failureEl.attrs["message"]) ?? firstLine;
  const type = nonBlank(failureEl.attrs["type"]);
  return {
    ...(message !== undefined ? { message: message.slice(0, MESSAGE_LIMIT) } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(trace.length > 0 ? { trace: trace.slice(0, TRACE_LIMIT) } : {}),
  };
}

function toLeaf(testcase: XmlElement): TestLeaf {
  const failureEl = testcase.children.find((c) => c.name === "failure" || c.name === "error");
  const skipped = testcase.children.some((c) => c.name === "skipped");
  const leaf: TestLeaf = {
    name: nameOf(testcase),
    status: failureEl !== undefined ? "fail" : skipped ? "pending" : "pass",
    duration_ms: toDurationMs(testcase.attrs["time"]),
  };
  if (failureEl !== undefined) leaf.failure = toFailure(failureEl);
  return leaf;
}

function toNode(name: string, cases: XmlElement[]): SuiteNode {
  const children = cases.map(toLeaf);
  return {
    name,
    status: children.some((c) => c.status === "fail") ? "fail" : "pass",
    children,
  };
}

function casesOf(testsuite: XmlElement): XmlElement[] {
  return testsuite.children.filter((c) => c.name === "testcase");
}

/**
 * The file a case is counted under: its non-empty `file`, else its non-empty
 * `classname`, else its suite's name, with `\` read as `/`.
 */
function fileOf(testcase: XmlElement, suiteName: string): string {
  const file =
    nonBlank(testcase.attrs["file"]) ?? nonBlank(testcase.attrs["classname"]) ?? suiteName;
  return file.replace(/\\/g, "/");
}

/**
 * pytest's report grouped by class: one node per non-empty `classname` in
 * first-seen order; a case with none joins the node `pytest`.
 */
function groupByClassname(cases: XmlElement[]): SuiteNode[] {
  const groups = new Map<string, XmlElement[]>();
  for (const testcase of cases) {
    const key = nonBlank(testcase.attrs["classname"]) ?? "pytest";
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [testcase]);
    else group.push(testcase);
  }
  return [...groups].map(([name, grouped]) => toNode(name, grouped));
}

function summarize(tree: SuiteNode[]): RunSummary {
  const summary: RunSummary = { total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 0 };
  for (const suite of tree) {
    for (const leaf of suite.children) {
      summary.total += 1;
      if (leaf.status === "pass") summary.passed += 1;
      else if (leaf.status === "fail") summary.failed += 1;
      else summary.pending += 1;
      summary.duration_ms += leaf.duration_ms;
    }
  }
  return summary;
}

/**
 * CR-CRU-003 — recursive `.//testsuite` semantics (bun `--reporter=junit`
 * nests suites): every <testsuite> holding testcases directly, at any depth,
 * in document order; a suite holding none is not collected.
 */
function collectSuites(testsuite: XmlElement, out: XmlElement[]): void {
  if (casesOf(testsuite).length > 0) out.push(testsuite);
  for (const inner of testsuite.children.filter((c) => c.name === "testsuite")) {
    collectSuites(inner, out);
  }
}

/**
 * CR-CRU-038 §S2b — recursively collect run-level captured output:
 * <system-out>/<system-err> at the <testsuites> wrapper level AND aggregated
 * across nested <testsuite> elements. Text already has entities/CDATA decoded
 * by parseXml, so it is used verbatim.
 */
function collectRawOutput(el: XmlElement, out: string[]): void {
  for (const child of el.children) {
    if (child.name === "system-out" || child.name === "system-err") {
      const text = child.text.trim();
      if (text.length > 0) out.push(text);
    } else if (child.name === "testsuite" || child.name === "testsuites") {
      collectRawOutput(child, out);
    }
  }
}

/**
 * One JUnit reading for every stack: a node per suite holding testcases, the
 * distinct files its cases name, and — when `stack` is `python` and the
 * report's only suite is named `pytest` — its cases grouped by classname.
 */
export function parseJunit(xml: string, stack?: string): DecodedRun {
  const root = parseXml(xml);
  let suites: XmlElement[];
  if (root.name === "testsuites") {
    suites = root.children.filter((c) => c.name === "testsuite");
  } else if (root.name === "testsuite") {
    suites = [root];
  } else {
    throw new Error(`malformed JUnit XML: unexpected root element <${root.name}>`);
  }
  const holders: XmlElement[] = [];
  for (const suite of suites) {
    collectSuites(suite, holders);
  }
  const files = new Set<string>();
  for (const holder of holders) {
    const suiteName = nameOf(holder);
    for (const testcase of casesOf(holder)) files.add(fileOf(testcase, suiteName));
  }
  const isPytest = stack === "python" && suites.length === 1 && suites[0]!.attrs["name"] === "pytest";
  const tree = isPytest
    ? groupByClassname(holders.flatMap(casesOf))
    : holders.map((holder) => toNode(nameOf(holder), casesOf(holder)));
  const rawParts: string[] = [];
  collectRawOutput(root, rawParts);
  const result: DecodedRun = { summary: summarize(tree), tree, files: [...files] };
  if (rawParts.length > 0) result.raw = rawParts.join("\n");
  return result;
}

/**
 * A report file, or a directory of `TEST-*.xml` read in file-name order and
 * merged into one run. A malformed file in a directory is skipped and named
 * (by its file name) to `onSkip`; when no file decodes the read is refused.
 * Each file is read under the run's `stack`.
 */
export async function parseJunitPath(
  path: string,
  onSkip?: (report: string, error: string) => void,
  stack?: string,
): Promise<DecodedRun> {
  if (statSync(path).isFile()) {
    return parseJunit(readFileSync(path, "utf-8"), stack);
  }
  const files = readdirSync(path)
    .filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no TEST-*.xml files found in ${path}`);
  }
  const tree: SuiteNode[] = [];
  const rawParts: string[] = [];
  const caseFiles = new Set<string>();
  const skipped: string[] = [];
  let decodedCount = 0;
  for (const file of files) {
    const full = join(path, file);
    let report: DecodedRun;
    try {
      report = parseJunit(readFileSync(full, "utf-8"), stack);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      skipped.push(`${file}: ${error}`);
      if (onSkip !== undefined) onSkip(file, error);
      else console.warn(`skipping malformed JUnit file ${full}: ${error}`);
      continue;
    }
    decodedCount += 1;
    tree.push(...report.tree);
    for (const caseFile of report.files ?? []) caseFiles.add(caseFile);
    if (report.raw !== undefined) rawParts.push(report.raw);
  }
  if (decodedCount === 0) {
    throw new Error(`no TEST-*.xml file in ${path} could be decoded (${skipped.join("; ")})`);
  }
  const result: DecodedRun = { summary: summarize(tree), tree, files: [...caseFiles] };
  if (rawParts.length > 0) result.raw = rawParts.join("\n");
  return result;
}
