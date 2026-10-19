// The idle-line composer, unit-tested on its own: the line an idle agent
// reads names its bound cycle by that cycle's PLACE in its plan, never by the
// board-wide cycle id the agent row stores.
//
//   bound, plan resolved   `idle · <role> · <CR> · cycle <n>/<m> · …`
//                          n = the cycle's 1-based place in its plan's cycle
//                          order, whatever its status; m = the plan's cycle
//                          count; <CR> = that plan's CR.
//   bound, plan unresolved `idle · <role> · cycle #<id> · …`
//   unbound                `idle · <role> · no cycle bound · …`
//
// The composer is `idleLine` (src/v2.ts). Its plan lookup is built ONCE per
// agents read and handed in, so these tests hand it in too: a map from a
// cycle id to the plan that holds it. A cycle id the map does not hold is a
// plan the read could not resolve — which no real board can be driven into
// over HTTP, so this file is where that branch is proved.
import { describe, test, expect } from "bun:test";
import * as v2 from "../src/v2.ts";
import type { LiveAgent } from "../src/store.ts";
import type { Plan, PlanCycle } from "../src/types.ts";

const NOW = 1_800_000_000_000;

/** The composer under test, read off the module per call so that each test,
 *  not the file, reports when it is missing. */
const idleLine = (
  agent: LiveAgent,
  lastRunAt: number | null,
  now: number,
  planOfCycle: ReadonlyMap<number, Plan>,
): string => v2.idleLine(agent, lastRunAt, now, planOfCycle);

function agentBoundTo(
  cycleId: number | undefined,
  overrides: Partial<LiveAgent> = {},
): LiveAgent {
  return {
    agentId: "composer-agent",
    projectKey: "11111111-2222-4333-8444-555555555555",
    status: "online",
    message: "4 ✓ 1 ✗ · ingested",
    identity: {},
    firstSeen: NOW - 3_600_000,
    lastSeen: NOW - 1_000,
    role: "GREEN",
    liveness: "online",
    ...(cycleId !== undefined ? { boundCycleId: cycleId } : {}),
    ...overrides,
  };
}

function cycle(id: number, status: PlanCycle["status"]): PlanCycle {
  return { id, label: `C${id}`, kind: "red-green", status };
}

function plan(planId: number, cr: string, cycles: PlanCycle[]): Plan {
  return { planId, projectKey: "11111111-2222-4333-8444-555555555555", cr, status: "open", cycles };
}

/** The lookup an agents read builds once: every cycle id → the plan holding it. */
function lookupOf(...plans: Plan[]): Map<number, Plan> {
  const byCycle = new Map<number, Plan>();
  for (const p of plans) for (const c of p.cycles) byCycle.set(c.id, p);
  return byCycle;
}

// A five-cycle subject plan whose ids (40..44) are nothing like their places
// (1..5), beside a neighbour plan whose ids interleave nowhere with it.
const SUBJECT = plan(7, "composer-subject", [
  cycle(40, "done"),
  cycle(41, "active"),
  cycle(42, "pending"),
  cycle(43, "pending"),
  cycle(44, "pending"),
]);
const NEIGHBOUR = plan(3, "composer-neighbour", [
  cycle(12, "done"),
  cycle(13, "done"),
  cycle(14, "active"),
]);

describe("idleLine — the composer names a bound cycle by its place in its plan", () => {
  test("an agent bound to the second of five cycles reads `<CR> · cycle 2/5`, with its last run and age", () => {
    const line = idleLine(agentBoundTo(41), NOW - 180_000, NOW, lookupOf(NEIGHBOUR, SUBJECT));
    expect(line).toBe("idle · GREEN · composer-subject · cycle 2/5 · last run 4 ✓ 1 ✗ · ingested, 3m ago");
    // NEGATIVE — never the board-wide id, never the neighbour plan's CR.
    expect(line).not.toMatch(/cycle 41\b/);
    expect(line).not.toContain("#41");
    expect(line).not.toContain("composer-neighbour");
  });

  test("the place is the cycle's position whatever its status — a done first cycle reads `cycle 1/5`, a pending last one `cycle 5/5`", () => {
    const lookup = lookupOf(SUBJECT, NEIGHBOUR);
    expect(idleLine(agentBoundTo(40), null, NOW, lookup)).toBe(
      "idle · GREEN · composer-subject · cycle 1/5 · seen just now",
    );
    expect(idleLine(agentBoundTo(44), null, NOW, lookup)).toBe(
      "idle · GREEN · composer-subject · cycle 5/5 · seen just now",
    );
    // The neighbour's own active cycle — third of three, in ITS plan.
    expect(idleLine(agentBoundTo(14, { role: "RED" }), null, NOW, lookup)).toBe(
      "idle · RED · composer-neighbour · cycle 3/3 · seen just now",
    );
  });

  test("a bound cycle whose plan cannot be resolved reads `cycle #<id>` — no CR segment, no invented place", () => {
    const line = idleLine(agentBoundTo(77), null, NOW, lookupOf(SUBJECT, NEIGHBOUR));
    expect(line).toBe("idle · GREEN · cycle #77 · seen just now");
    expect(line).not.toContain("no cycle bound");
    expect(line).not.toMatch(/cycle \d+\/\d+/);
    expect(line).not.toContain("composer-");
  });

  test("an unresolvable plan reads `cycle #<id>` beside a last run too, and against an empty lookup", () => {
    const line = idleLine(agentBoundTo(9), NOW - 7_200_000, NOW, new Map<number, Plan>());
    expect(line).toBe("idle · GREEN · cycle #9 · last run 4 ✓ 1 ✗ · ingested, 2h ago");
  });

  test("an unbound agent still reads `no cycle bound`, whatever plans the lookup holds", () => {
    const line = idleLine(
      agentBoundTo(undefined, { role: "ORCHESTRATOR", lastSeen: NOW - 7_200_000 }),
      null,
      NOW,
      lookupOf(SUBJECT, NEIGHBOUR),
    );
    expect(line).toBe("idle · ORCHESTRATOR · no cycle bound · seen 2h ago");
    expect(line).not.toContain("#");
    expect(line).not.toContain("composer-");
  });
});
