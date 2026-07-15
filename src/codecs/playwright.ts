// CR-CRU-007 C5b (pulled forward from CR-CRU-015 §S2) — Playwright JSON
// reporter codec: `@playwright/test --reporter=json` (including the
// playwright-bdd flavor, whose Gherkin feature/scenario names arrive as
// ordinary suite/spec titles) → canonical feature → scenario → step
// RunSchema tree. One SuiteNode PER SCENARIO named
// "<Feature title> › <Scenario title>"; one TestLeaf PER STEP of the LAST
// attempt, in step order. Registry-only resolution (CR-CRU-010 §S1) — the
// only callers are the `codecs` map's "playwright" entry.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunSchema, RunSummary, SuiteNode, TestLeaf } from "../types.ts";

interface PwError {
  message?: string;
  stack?: string;
}

interface PwStep {
  title: string;
  duration: number;
  error?: PwError;
}

interface PwResult {
  status: string;
  duration?: number;
  steps?: PwStep[];
}

interface PwTest {
  results?: PwResult[];
}

interface PwSpec {
  title: string;
  tests?: PwTest[];
}

interface PwSuite {
  title: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

interface PwReport {
  suites?: PwSuite[];
}

function stepLeaf(step: PwStep): TestLeaf {
  const leaf: TestLeaf = {
    name: step.title,
    status: step.error !== undefined ? "fail" : "pass",
    duration_ms: Math.round(step.duration),
  };
  if (step.error !== undefined) {
    leaf.failure = {
      message: step.error.message ?? "step failed",
      ...(step.error.stack !== undefined ? { trace: step.error.stack } : {}),
    };
  }
  return leaf;
}

function scenarioStatus(status: string): SuiteNode["status"] {
  if (status === "passed") return "pass";
  if (status === "skipped" || status === "interrupted") return "pending";
  return "fail";
}

function specToNode(featureTitle: string, spec: PwSpec): SuiteNode {
  // The last attempt is the run's verdict (earlier attempts are retries).
  const results = spec.tests?.flatMap((t) => t.results ?? []) ?? [];
  const last = results[results.length - 1];
  return {
    name: `${featureTitle} › ${spec.title}`,
    status: last === undefined ? "pending" : scenarioStatus(last.status),
    children: (last?.steps ?? []).map(stepLeaf),
  };
}

function collectScenarios(suite: PwSuite, out: SuiteNode[]): void {
  for (const spec of suite.specs ?? []) {
    out.push(specToNode(suite.title, spec));
  }
  for (const inner of suite.suites ?? []) {
    collectScenarios(inner, out);
  }
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

export function parsePlaywright(data: string): RunSchema {
  const report = JSON.parse(data) as PwReport;
  if (report === null || typeof report !== "object" || !Array.isArray(report.suites)) {
    throw new Error("malformed Playwright JSON report: missing suites array");
  }
  const tree: SuiteNode[] = [];
  for (const suite of report.suites) {
    collectScenarios(suite, tree);
  }
  return { summary: summarize(tree), tree };
}

export function parsePlaywrightPath(path: string): RunSchema {
  if (statSync(path).isFile()) {
    return parsePlaywright(readFileSync(path, "utf-8"));
  }
  const reportPath = join(path, "report.json");
  if (!statSync(reportPath).isFile()) {
    throw new Error(`no report.json found in ${path}`);
  }
  return parsePlaywright(readFileSync(reportPath, "utf-8"));
}
