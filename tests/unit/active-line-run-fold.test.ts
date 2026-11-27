// `foldRepeatedRuns` — the Now pane's active-cycle line folds consecutive
// repeated settled runs into one chip, tested DIRECTLY over in-memory run lists.
//
// Contract: the function takes a cycle's settled test-run events in time order
// (oldest first) and returns, in the same order, one chip `{ run, count }` per
// sequence of consecutive repeats — `run` is the LATEST run of that sequence
// (the very object passed in) and `count` is how many runs the sequence holds.
// Two consecutive runs repeat when they share an agent and either neither is
// aborted and their passed/failed/total are all equal, or both are aborted
// (whatever their figures). An aborted run never folds with a finished one.
//
// The function is imported BY NAME, so the type check fails unless
// `public/app-logic.d.mts` declares it. The active line's rendering of the
// chips (and the `window.CrucibleLogic` bridge) is the integration tier's.
// Every run here is synthetic.
import { describe, test, expect } from "bun:test";
import { foldRepeatedRuns } from "../../public/app-logic.mjs";

/** A settled run event, shaped like the board's event brief. */
interface RunEvent {
  id: number;
  agentId: string;
  passed: number;
  failed: number;
  total: number;
  timestamp: string;
  status?: "aborted";
}

let nextId = 1;
/** Builds a finished run; each call takes the next id and a later timestamp. */
function finished(agentId: string, passed: number, failed: number, total: number): RunEvent {
  const id = nextId++;
  return {
    id,
    agentId,
    passed,
    failed,
    total,
    timestamp: new Date(Date.UTC(2026, 9, 28, 10, 0, id)).toISOString(),
  };
}

/** Builds an aborted run with the given (possibly partial) figures. */
function aborted(agentId: string, passed: number, failed: number, total: number): RunEvent {
  return { ...finished(agentId, passed, failed, total), status: "aborted" };
}

/** Reads the chips as `[runId, count]` pairs, so a whole fold is one assertion. */
function shape(chips: ReadonlyArray<{ run: { id: number }; count: number }>): Array<[number, number]> {
  return chips.map((chip) => [chip.run.id, chip.count]);
}

describe("foldRepeatedRuns — consecutive equal finished runs fold into one chip", () => {
  test("three consecutive runs by one agent with equal figures fold to one chip carrying the latest run and count 3", () => {
    const first = finished("verify-agent", 14, 0, 14);
    const second = finished("verify-agent", 14, 0, 14);
    const third = finished("verify-agent", 14, 0, 14);

    const chips = foldRepeatedRuns([first, second, third]);

    expect(chips).toHaveLength(1);
    expect(chips[0].count).toBe(3);
    // The chip IS the latest run — the same object, not a copy and not the first.
    expect(chips[0].run).toBe(third);
    expect(chips[0].run).not.toBe(first);
    expect(chips[0].run.id).toBe(third.id);
  });

  test("two consecutive equal runs fold to one chip with count 2", () => {
    const first = finished("verify-agent", 7, 0, 7);
    const second = finished("verify-agent", 7, 0, 7);

    const chips = foldRepeatedRuns([first, second]);

    expect(shape(chips)).toEqual([[second.id, 2]]);
    expect(chips[0].run).toBe(second);
  });
});

describe("foldRepeatedRuns — a difference breaks the fold", () => {
  test("A · B · A with equal figures and two agents stays three chips of count 1, in order", () => {
    const a1 = finished("agent-a", 14, 0, 14);
    const b = finished("agent-b", 14, 0, 14);
    const a2 = finished("agent-a", 14, 0, 14);

    const chips = foldRepeatedRuns([a1, b, a2]);

    expect(shape(chips)).toEqual([
      [a1.id, 1],
      [b.id, 1],
      [a2.id, 1],
    ]);
    expect(chips[0].run).toBe(a1);
    expect(chips[1].run).toBe(b);
    expect(chips[2].run).toBe(a2);
  });

  test("one agent's 14/14 then 13/14 stays two chips", () => {
    const green = finished("verify-agent", 14, 0, 14);
    const red = finished("verify-agent", 13, 1, 14);

    const chips = foldRepeatedRuns([green, red]);

    expect(shape(chips)).toEqual([
      [green.id, 1],
      [red.id, 1],
    ]);
  });

  test("a later repeat after a break starts its own chip: 14/14 ×2, 13/14, 14/14 ×2 gives counts 2, 1, 2", () => {
    const g1 = finished("verify-agent", 14, 0, 14);
    const g2 = finished("verify-agent", 14, 0, 14);
    const r = finished("verify-agent", 13, 1, 14);
    const g3 = finished("verify-agent", 14, 0, 14);
    const g4 = finished("verify-agent", 14, 0, 14);

    const chips = foldRepeatedRuns([g1, g2, r, g3, g4]);

    expect(shape(chips)).toEqual([
      [g2.id, 2],
      [r.id, 1],
      [g4.id, 2],
    ]);
    // Each chip is its own sequence's latest run — the later repeat is never
    // merged back into the first chip.
    expect(chips[0].run).toBe(g2);
    expect(chips[1].run).toBe(r);
    expect(chips[2].run).toBe(g4);
  });

  test("a difference in failed alone breaks the fold", () => {
    const one = finished("verify-agent", 12, 1, 14);
    const two = finished("verify-agent", 12, 2, 14);

    expect(shape(foldRepeatedRuns([one, two]))).toEqual([
      [one.id, 1],
      [two.id, 1],
    ]);
  });

  test("a difference in total alone breaks the fold", () => {
    const smaller = finished("verify-agent", 12, 0, 12);
    const larger = finished("verify-agent", 12, 0, 13);

    expect(shape(foldRepeatedRuns([smaller, larger]))).toEqual([
      [smaller.id, 1],
      [larger.id, 1],
    ]);
  });

  test("a difference in passed alone breaks the fold", () => {
    const fewer = finished("verify-agent", 11, 1, 14);
    const more = finished("verify-agent", 12, 1, 14);

    expect(shape(foldRepeatedRuns([fewer, more]))).toEqual([
      [fewer.id, 1],
      [more.id, 1],
    ]);
  });
});

describe("foldRepeatedRuns — empty, single and unusable input", () => {
  test("an empty list gives no chips", () => {
    expect(foldRepeatedRuns([])).toEqual([]);
  });

  test("a single run gives exactly one chip carrying that run with count 1", () => {
    const only = finished("verify-agent", 14, 0, 14);

    const chips = foldRepeatedRuns([only]);

    expect(shape(chips)).toEqual([[only.id, 1]]);
    expect(chips[0].run).toBe(only);
  });

  test("non-array input reads as no runs and gives no chips", () => {
    expect(foldRepeatedRuns(undefined)).toEqual([]);
    expect(foldRepeatedRuns(null)).toEqual([]);
    expect(foldRepeatedRuns("14/14")).toEqual([]);
  });

});

describe("foldRepeatedRuns — aborted runs fold only with aborted runs", () => {
  test("two consecutive aborted runs by one agent with different figures fold to one chip: the latest, count 2", () => {
    const early = aborted("verify-agent", 0, 0, 0);
    const late = aborted("verify-agent", 9, 2, 14);

    const chips = foldRepeatedRuns([early, late]);

    expect(shape(chips)).toEqual([[late.id, 2]]);
    expect(chips[0].run).toBe(late);
  });

  test("an aborted 0/0/0 run then a finished 0/0/0 run by one agent stay two chips", () => {
    const stopped = aborted("verify-agent", 0, 0, 0);
    const empty = finished("verify-agent", 0, 0, 0);

    expect(shape(foldRepeatedRuns([stopped, empty]))).toEqual([
      [stopped.id, 1],
      [empty.id, 1],
    ]);
  });

  test("a finished 0/0/0 run then an aborted 0/0/0 run by one agent stay two chips", () => {
    const empty = finished("verify-agent", 0, 0, 0);
    const stopped = aborted("verify-agent", 0, 0, 0);

    expect(shape(foldRepeatedRuns([empty, stopped]))).toEqual([
      [empty.id, 1],
      [stopped.id, 1],
    ]);
  });

  test("an aborted 14/14 run (partial, streamed) then a finished 14/14 run by one agent stay two chips", () => {
    const partial = aborted("verify-agent", 14, 0, 14);
    const done = finished("verify-agent", 14, 0, 14);

    expect(shape(foldRepeatedRuns([partial, done]))).toEqual([
      [partial.id, 1],
      [done.id, 1],
    ]);
  });

  test("a finished 14/14 run then an aborted 14/14 run by one agent stay two chips", () => {
    const done = finished("verify-agent", 14, 0, 14);
    const partial = aborted("verify-agent", 14, 0, 14);

    expect(shape(foldRepeatedRuns([done, partial]))).toEqual([
      [done.id, 1],
      [partial.id, 1],
    ]);
  });

  test("two consecutive aborted runs by different agents stay two chips", () => {
    const a = aborted("agent-a", 0, 0, 0);
    const b = aborted("agent-b", 0, 0, 0);

    expect(shape(foldRepeatedRuns([a, b]))).toEqual([
      [a.id, 1],
      [b.id, 1],
    ]);
  });
});
