// CR-CRU-002 §S1 — JUnit codec: hand-rolled minimal XML → canonical RunSchema.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunSchema, RunSummary, SuiteNode, TestLeaf } from "../types.ts";

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

function toLeaf(testcase: XmlElement): TestLeaf {
  const failureEl = testcase.children.find((c) => c.name === "failure" || c.name === "error");
  const skipped = testcase.children.some((c) => c.name === "skipped");
  const leaf: TestLeaf = {
    name: testcase.attrs["name"] ?? "",
    status: failureEl !== undefined ? "fail" : skipped ? "pending" : "pass",
    duration_ms: toDurationMs(testcase.attrs["time"]),
  };
  if (failureEl !== undefined) {
    const trace = failureEl.text.trim();
    const firstLine = trace.split("\n").find((line) => line.trim().length > 0);
    leaf.failure = {
      message: failureEl.attrs["message"] ?? firstLine?.trim() ?? "test failed",
      ...(failureEl.attrs["type"] !== undefined ? { type: failureEl.attrs["type"] } : {}),
      ...(trace.length > 0 ? { trace } : {}),
    };
  }
  return leaf;
}

function toSuite(testsuite: XmlElement): SuiteNode {
  const children = testsuite.children.filter((c) => c.name === "testcase").map(toLeaf);
  return {
    name: testsuite.attrs["name"] ?? "",
    status: children.some((c) => c.status === "fail") ? "fail" : "pass",
    children,
  };
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

export function parseJunit(xml: string): RunSchema {
  const root = parseXml(xml);
  let suites: XmlElement[];
  if (root.name === "testsuites") {
    suites = root.children.filter((c) => c.name === "testsuite");
  } else if (root.name === "testsuite") {
    suites = [root];
  } else {
    throw new Error(`malformed JUnit XML: unexpected root element <${root.name}>`);
  }
  const tree = suites.map(toSuite);
  return { summary: summarize(tree), tree };
}

export async function parseJunitPath(path: string): Promise<RunSchema> {
  if (statSync(path).isFile()) {
    return parseJunit(readFileSync(path, "utf-8"));
  }
  const files = readdirSync(path)
    .filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no TEST-*.xml files found in ${path}`);
  }
  const tree: SuiteNode[] = [];
  for (const file of files) {
    const full = join(path, file);
    try {
      tree.push(...parseJunit(readFileSync(full, "utf-8")).tree);
    } catch (err) {
      console.warn(`skipping malformed JUnit file ${full}: ${String(err)}`);
    }
  }
  return { summary: summarize(tree), tree };
}
