#!/usr/bin/env bun
// CR-CRU-126 §S2a — the k-readers contention curve, reproducible.
//
// WHY A SCRIPT AND NOT A TEST. The claim this CR makes is end-to-end and about
// a LIVE board: latency is `k × per-request cost`, so cutting the cost collapses
// the queue with it. Proving that needs a running server and real data, which is
// exactly what `pre-merge-gate` must not depend on. So this is a harness you run
// deliberately — before the fix and after it — and quote in the merge note.
//
// IT IS GET-ONLY. Every request below is a `fetch` with no method, no body: the
// plans list, the health check and one run detail. It creates nothing, patches
// nothing and deletes nothing.
//
// PRECONDITION — NO ACTIVE CYCLE. A plans read is NOT a pure read (§S1a): an
// ACTIVE cycle checkpoints `active_ms_accumulated` through `toPlan` at a ≤60s
// cadence, so hammering `/plans` while a cycle is active drives real writes on
// the board you are measuring. The harness checks for one and REFUSES, unless
// you pass --allow-active-cycle, in which case it states the added writes in its
// own output. The zero-risk way to measure a busy board is a `sqlite3 .backup`
// replica served on a second port.
//
// Usage:
//   bun scripts/plans-contention-curve.ts --base http://localhost:PORT \
//       [--project <key>] [--readers 0,1,2,4,8] [--samples 3] [--allow-active-cycle]

interface Options {
  base: string;
  project?: string;
  readers: number[];
  samples: number;
  allowActiveCycle: boolean;
}

interface ProjectBrief {
  key: string;
  name: string;
}

interface CycleBrief {
  id: number;
  status: string;
}

interface PlanBrief {
  cr: string;
  status: string;
  cycles: CycleBrief[];
}

interface Row {
  readers: number;
  healthMs: number;
  detailMs: number | null;
  loaderP50Ms: number | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    base: "http://localhost:3851",
    readers: [0, 1, 2, 4, 8],
    samples: 3,
    allowActiveCycle: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--base" && value !== undefined) options.base = value.replace(/\/$/, "");
    else if (flag === "--project" && value !== undefined) options.project = value;
    else if (flag === "--readers" && value !== undefined) {
      options.readers = value.split(",").map((part) => Number(part.trim()));
    } else if (flag === "--samples" && value !== undefined) options.samples = Number(value);
    else if (flag === "--allow-active-cycle") options.allowActiveCycle = true;
  }
  return options;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Elapsed wall time of one GET, body fully drained. */
async function timedGet(url: string): Promise<number> {
  const started = performance.now();
  const res = await fetch(url);
  await res.arrayBuffer();
  return performance.now() - started;
}

function quantile(samples: number[], fraction: number): number | null {
  if (samples.length === 0) return null;
  const sorted = samples.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function resolveProject(options: Options): Promise<ProjectBrief> {
  const body = await getJson<{ projects: ProjectBrief[] }>(`${options.base}/api/v2/projects`);
  if (options.project !== undefined) {
    const found = body.projects.find((project) => project.key === options.project);
    if (found === undefined) throw new Error(`no project ${options.project} on this board`);
    return found;
  }
  const first = body.projects[0];
  if (first === undefined) throw new Error("this board holds no projects");
  return first;
}

/** The §S1a precondition, checked read-only and reported either way. */
async function activeCycles(options: Options, key: string): Promise<number[]> {
  const body = await getJson<{ plans: PlanBrief[] }>(
    `${options.base}/api/v2/projects/${key}/plans`,
  );
  return body.plans
    .flatMap((plan) => plan.cycles)
    .filter((cycle) => cycle.status === "active")
    .map((cycle) => cycle.id);
}

/** One run id to probe the detail route with, or null on an empty board. */
async function probeRunId(options: Options, key: string): Promise<string | null> {
  const body = await getJson<{ events: Array<{ id: string }> }>(
    `${options.base}/api/v2/events?project=${key}&limit=1`,
  );
  return body.events[0]?.id ?? null;
}

async function measure(options: Options, key: string, runId: string | null, readers: number): Promise<Row> {
  const plansUrl = `${options.base}/api/v2/projects/${key}/plans`;
  const loaderSamples: number[] = [];
  let running = true;
  const loaders: Array<Promise<void>> = [];
  for (let index = 0; index < readers; index += 1) {
    loaders.push(
      (async () => {
        while (running) {
          loaderSamples.push(await timedGet(plansUrl));
        }
      })(),
    );
  }

  // Let the loaders establish the queue before probing behind it.
  if (readers > 0) {
    while (loaderSamples.length === 0) await Bun.sleep(25);
  }

  const healthSamples: number[] = [];
  const detailSamples: number[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    healthSamples.push(await timedGet(`${options.base}/api/v2/health`));
    if (runId !== null) {
      detailSamples.push(await timedGet(`${options.base}/api/v2/events/${runId}?depth=suites`));
    }
  }

  running = false;
  await Promise.all(loaders);

  return {
    readers,
    // Best of N, as the CR's own table reports it.
    healthMs: Math.min(...healthSamples),
    detailMs: detailSamples.length > 0 ? Math.min(...detailSamples) : null,
    loaderP50Ms: quantile(loaderSamples, 0.5),
  };
}

function render(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} ms`;
}

async function main(): Promise<number> {
  const options = parseOptions(Bun.argv.slice(2));
  console.log(`# plans contention curve — ${options.base}`);
  console.log("# GET-only: plans list, health, one run detail. Nothing is written by this harness.");

  const project = await resolveProject(options);
  console.log(`# project: ${project.name} (${project.key})`);

  const active = await activeCycles(options, project.key);
  if (active.length === 0) {
    console.log("# precondition OK: no ACTIVE cycle on this project — this run adds no writes.");
  } else if (options.allowActiveCycle) {
    console.log(
      `# precondition WAIVED (--allow-active-cycle): cycle(s) ${active.join(", ")} are ACTIVE, so ` +
        `every plans read below ALSO drives a real active_ms_accumulated checkpoint write ` +
        `(CR-CRU-023 §S3(a), ≤60s cadence). The numbers are still valid; the board is not read-only.`,
    );
  } else {
    console.error(
      `# REFUSED: cycle(s) ${active.join(", ")} are ACTIVE. A plans read checkpoints an active ` +
        `cycle's attention timer, so this harness would write to the board it measures. Run it ` +
        `against a sqlite3 .backup replica on a second port, or pass --allow-active-cycle to ` +
        `accept (and state) the added writes.`,
    );
    return 2;
  }

  const runId = await probeRunId(options, project.key);
  if (runId === null) console.log("# no events on this board — the run-detail column is omitted.");

  const rows: Row[] = [];
  for (const readers of options.readers) {
    rows.push(await measure(options, project.key, runId, readers));
  }

  console.log("");
  console.log("| concurrent plans readers | GET /health | run detail (?depth=suites) | loader p50 |");
  console.log("|---|---|---|---|");
  for (const row of rows) {
    console.log(
      `| ${row.readers} | ${render(row.healthMs)} | ${render(row.detailMs)} | ${render(row.loaderP50Ms)} |`,
    );
  }
  return 0;
}

process.exit(await main());
