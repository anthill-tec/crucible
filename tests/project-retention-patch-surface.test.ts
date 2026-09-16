// §S2 — a cap can be CLEARED, and ZERO is a cap.
//
// `PATCH …/projects/<key>` is the only door to a project's own retention cap,
// and it refuses two values the MODEL accepts:
//
//   * `retention: null` — clear the override, so the project falls back on the
//     fleet default. Without it an override could only ever be MOVED to
//     another number: this board's own cap could be taken from its 200,000
//     incident stopgap down to 5000, but never handed back to the fleet
//     setting, so the fleet default governed only the projects nobody had
//     ever touched — exactly the projects nobody is thinking about.
//   * `retention: 0` — a cap of zero, which the STORE already implements:
//     `enforceRetention` resolves the cap with `??` rather than `||`
//     PRECISELY so a declared zero stays a cap of zero, and existing fold
//     fixtures depend on it. The model accepts 0; its only door does not.
//
// ── The defect this section could INTRODUCE while fixing another ──────────
//
// `null` must stay distinguishable from ABSENT FROM THE PATCH. A route that
// conflated them would let a PATCH of some unrelated field silently wipe a cap
// it never mentioned — a project renamed on the board would start keeping
// everything, or (with a fleet default set) start evicting to a number nobody
// chose for it. So the absent-vs-null pair below is asserted with the cap
// PROVEN in force beforehand and re-proven at the EVICTION SITE afterwards,
// twice: once for a positive cap, and once for a ZERO cap, which is the
// variant a truthiness test for "did this patch mention retention?" gets
// wrong while looking right.
//
// ── Every expectation is observed at the eviction site ────────────────────
//
// A cap is a fact about what the store KEEPS, so no test here reads a number
// back and calls it a proof: each one ingests past the cap and counts what
// survived. A read-back that echoed a value the enforcement path ignored would
// pass a wire-level assertion and still have shipped the defect. The fleet
// default is configured through the operator's own file (the shared limits
// fixture) and every count is derived from what this test configured — no
// limit VALUE is pinned here.
//
// ── Safety ────────────────────────────────────────────────────────────────
//
// Every server is `:memory:` on port 0 and every configuration file is written
// into a fresh OS tmpdir (never inside the checkout). The live board is never
// reached: no project of its is patched, `data/crucible.db` is never opened and
// port 3849 is never bound.
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { serverConfigPath, shippedLimits } from "../src/limits.ts";
import { retentionDisclosure } from "../src/server.ts";
import type { Store } from "../src/store.ts";
import {
  boot,
  declare,
  eventCount,
  ingest,
  restoreServerLimitsFixture,
  seedProject,
  serverConfigDir,
  writeConfig,
  type BootedServer,
} from "./helpers/server-limits-fixture.ts";

interface PatchResult {
  status: number;
  body: { ok?: boolean; changed?: boolean; error?: string };
}

interface ProjectRow {
  key: string;
  name: string;
  retention?: number;
  allowRunDeletion?: boolean;
}

describe("§S2 — the project retention surface: a cap can be cleared, and zero is a cap", () => {
  let configDir: string | undefined;

  afterEach(() => {
    configDir = undefined;
    restoreServerLimitsFixture();
  });

  /** The server's own configuration directory for THIS test — created once, so
   *  two writes inside one test edit the SAME file. */
  function serverDir(): string {
    configDir ??= serverConfigDir();
    return configDir;
  }

  /**
   * The FLEET default, set through the operator's own file. `min` is re-stated
   * beside the value because these fixtures ingest tens of rows while the
   * shipped floor is a supportability judgement for a real fleet, and the
   * validator reads `min` off the very table the operator edits — so a bound
   * moved in the file is configuration, not a bypass of it.
   */
  function configureFleetCap(chosen: number): void {
    writeConfig(serverDir(), {
      retention: declare(shippedLimits().retention!, chosen, { min: chosen }),
    });
  }

  /** Take the operator's file away entirely — which is what "configured
   *  NOTHING" means, and the one state that still resolves to NO cap. */
  function unconfigureFleetCap(): string {
    const file = path.join(serverDir(), "crucible.toml");
    fs.rmSync(file, { force: true });
    return file;
  }

  function url(handle: BootedServer, suffix: string): string {
    return `http://127.0.0.1:${String(handle.server.port)}/api/v2${suffix}`;
  }

  async function patchProject(
    handle: BootedServer,
    key: string,
    body: Record<string, unknown>,
  ): Promise<PatchResult> {
    const res = await fetch(url(handle, `/projects/${key}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as PatchResult["body"] };
  }

  /** The project as the board READS it — the real list route, not the store. */
  async function readBack(handle: BootedServer, key: string): Promise<ProjectRow> {
    const res = await fetch(url(handle, "/projects"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; projects: ProjectRow[] };
    expect(body.ok).toBe(true);
    const row = body.projects.find((p) => p.key === key);
    expect(row, `the project vanished from the board's own list: ${key}`).toBeDefined();
    return row!;
  }

  /** Ingest `n` telemetry rows and report what SURVIVED — the cap as the store
   *  enforces it, which is the only place a cap is real. */
  function survivingAfterIngesting(store: Store, key: string, n: number): number {
    ingest(store, key, n);
    return eventCount(store, key);
  }

  // ───────────────────────────────────────────────────────────────────────
  // AC — "`retention: null` clears the override; the project then inherits
  // the fleet default and a read back reports it as inherited rather than as
  // its own."
  //
  // NON-VACUITY: the project OWNS a cap first, and is proved to own it in
  // both channels — the read back carries its number, and the eviction site
  // honours THAT number rather than the fleet's. So the fleet count after the
  // clear cannot be mistaken for a cap that was never set.
  // ───────────────────────────────────────────────────────────────────────
  test("a null retention CLEARS the override: the project stops owning a cap and the fleet default is what evicts from then on", async () => {
    const FLEET = 6;
    const OWN = 3;
    configureFleetCap(FLEET);
    const handle = boot();
    const key = seedProject(handle.store, "inherits-after-clearing");

    const set = await patchProject(handle, key, { retention: OWN });
    expect(set.status).toBe(200);
    expect((await readBack(handle, key)).retention).toBe(OWN);
    // The project's OWN cap is what runs — not the fleet's, and not the
    // number of rows offered.
    expect(survivingAfterIngesting(handle.store, key, 12)).toBe(OWN);

    const cleared = await patchProject(handle, key, { retention: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.changed).toBe(true);

    // The read back reports it as INHERITED: the project no longer claims a
    // cap of its own, rather than echoing a number it does not own.
    const row = await readBack(handle, key);
    expect(row.retention).toBeUndefined();

    // …and the inheritance is BEHAVIOUR, not a wire detail: the fleet number
    // is what evicts now, and it is neither the cleared cap nor the row count.
    expect(survivingAfterIngesting(handle.store, key, 12)).toBe(FLEET);
  });

  // ───────────────────────────────────────────────────────────────────────
  // AC — "`retention: 0` is accepted and enforced as a cap of zero — the test
  // proves the ROUTE stopped refusing what the model accepts, since
  // `enforceRetention`'s `??` already implements it."
  //
  // NON-VACUITY: a fleet default is configured and is LARGER than the number
  // of rows ingested, so a refusal and a clear both leave every row standing.
  // Only a genuine cap of zero empties the project.
  // ───────────────────────────────────────────────────────────────────────
  test("a zero retention is ACCEPTED and enforced as a cap of zero — it evicts everything, and it is a cap rather than a clear", async () => {
    const FLEET = 5;
    configureFleetCap(FLEET);
    const handle = boot();
    const key = seedProject(handle.store, "capped-at-zero");

    const set = await patchProject(handle, key, { retention: 0 });
    expect(set.status).toBe(200);
    expect(set.body.changed).toBe(true);

    // A cap, not a clear: the project OWNS zero, so a later read cannot
    // mistake it for a project that inherits.
    expect((await readBack(handle, key)).retention).toBe(0);

    // What a zero cap DOES at the eviction site: nothing survives. Four rows
    // is under the fleet default, so anything other than a real zero — a
    // refusal, a clear, a `||` that read zero as absent — leaves all four.
    expect(survivingAfterIngesting(handle.store, key, 4)).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // AC — "A PATCH that does not mention `retention` leaves it untouched —
  // `null` and absent are distinguishable, proved by patching a different
  // field and re-reading the cap."
  //
  // THE HAZARD, and the strongest test in this file. The unrelated PATCH is
  // proved to have APPLIED (the field it names really changed), so a route
  // that refused the whole request cannot pass this by doing nothing.
  // ───────────────────────────────────────────────────────────────────────
  test("a PATCH naming a different field leaves an existing cap exactly as it was — absent is not the same as null", async () => {
    const FLEET = 9;
    const OWN = 2;
    configureFleetCap(FLEET);
    const handle = boot();
    const key = seedProject(handle.store, "cap-must-survive-an-unrelated-patch");

    expect((await patchProject(handle, key, { retention: OWN })).status).toBe(200);
    // PROVEN SET, before anything touches it: owned on the wire, and in force
    // at the eviction site.
    expect((await readBack(handle, key)).retention).toBe(OWN);
    expect(survivingAfterIngesting(handle.store, key, 6)).toBe(OWN);

    const renamed = "renamed-by-an-unrelated-patch";
    const unrelated = await patchProject(handle, key, { name: renamed });
    expect(unrelated.status).toBe(200);
    expect(unrelated.body.changed).toBe(true);

    const row = await readBack(handle, key);
    // The unrelated patch really did apply — this is what stops the
    // assertions below from passing on a request that changed nothing.
    expect(row.name).toBe(renamed);
    expect(row.retention).toBe(OWN);
    // And the cap is still in force where it counts: not the fleet's number,
    // not the row count.
    expect(survivingAfterIngesting(handle.store, key, 6)).toBe(OWN);
  });

  test("a PATCH naming a different field leaves a ZERO cap at zero — the variant a truthiness test for `did this mention retention?` gets wrong", async () => {
    const FLEET = 9;
    configureFleetCap(FLEET);
    const handle = boot();
    const key = seedProject(handle.store, "zero-cap-must-survive-an-unrelated-patch");

    expect((await patchProject(handle, key, { retention: 0 })).status).toBe(200);
    // PROVEN SET: a zero cap holds nothing, while an absent one would hold
    // all three rows under a fleet default of nine.
    expect(survivingAfterIngesting(handle.store, key, 3)).toBe(0);

    const unrelated = await patchProject(handle, key, { allowRunDeletion: true });
    expect(unrelated.status).toBe(200);
    expect(unrelated.body.changed).toBe(true);

    const row = await readBack(handle, key);
    expect(row.allowRunDeletion).toBe(true);
    // Still OWNED, and still zero. A route that tested the patched value for
    // truthiness would have wiped it here and inherited nine.
    expect(row.retention).toBe(0);
    expect(survivingAfterIngesting(handle.store, key, 3)).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // AC — "A negative, fractional or non-numeric value is still refused, and
  // the refusal names what is accepted, including `null` and `0`."
  //
  // The three shapes are the three the spec names, and they are genuinely
  // different facts about the request rather than three rows of one table: a
  // sign, a domain and a type. Each must be told what DOES exist — an
  // operator who sent `-1` learns that `null` and a non-negative integer are
  // the accepted forms, or the refusal has taught them only that they were
  // wrong.
  // ───────────────────────────────────────────────────────────────────────
  test("a negative, fractional or non-numeric cap is still refused, and each refusal names the forms that ARE accepted", async () => {
    const OWN = 4;
    configureFleetCap(9);
    const handle = boot();
    const key = seedProject(handle.store, "refuses-what-is-not-a-cap");
    expect((await patchProject(handle, key, { retention: OWN })).status).toBe(200);

    const notCaps: Array<[string, unknown]> = [
      ["a negative cap is not a cap", -1],
      ["a fractional cap is not a cap", 1.5],
      ["a non-numeric cap is not a cap", "200"],
    ];
    for (const [why, value] of notCaps) {
      const refused = await patchProject(handle, key, { retention: value });
      expect(refused.status, why).toBe(400);
      const message = String(refused.body.error);
      // It names what is accepted, both halves: the clear, and the domain.
      expect(message, `${why}: the refusal does not name the clear`).toContain("null");
      expect(message, `${why}: the refusal does not name the accepted domain`).toMatch(
        /non-negative integer/,
      );
    }

    // BOUND — a refusal changes nothing: the cap the project owned before the
    // refused requests is the cap still running after them.
    expect((await readBack(handle, key)).retention).toBe(OWN);
    expect(survivingAfterIngesting(handle.store, key, 12)).toBe(OWN);
  });

  // ───────────────────────────────────────────────────────────────────────
  // AC — precedence is TWO layers and only retention has both: the file's
  // value, then the per-project value in the store. Each proved to override
  // the one before it, and a cleared per-project value proved to fall through
  // to the FILE rather than to zero — and, with no file at all, to the
  // documented exception: NO cap, disclosed at boot by name.
  // ───────────────────────────────────────────────────────────────────────
  test("precedence: a project's own cap beats the fleet default, clearing it falls back to the file, and with no file there is no cap at all", async () => {
    const FLEET = 8;
    const OWN = 3;
    configureFleetCap(FLEET);
    const handle = boot();
    const key = seedProject(handle.store, "precedence-subject");

    // Layer 2 beats layer 1.
    expect((await patchProject(handle, key, { retention: OWN })).status).toBe(200);
    expect(survivingAfterIngesting(handle.store, key, 20)).toBe(OWN);

    // Clearing layer 2 falls through to layer 1 — the FILE, not zero and not
    // the cap just cleared.
    expect((await patchProject(handle, key, { retention: null })).status).toBe(200);
    expect(survivingAfterIngesting(handle.store, key, 20)).toBe(FLEET);

    // Take the file away and nothing is configured anywhere: no cap, and the
    // boot disclosure names the project and the file that would bound it.
    const file = unconfigureFleetCap();
    const before = eventCount(handle.store, key);
    expect(survivingAfterIngesting(handle.store, key, 20)).toBe(before + 20);
    const disclosure = retentionDisclosure(handle.store);
    expect(disclosure).not.toBeNull();
    expect(disclosure).toContain("precedence-subject");
    expect(disclosure).toContain(serverConfigPath());
    expect(serverConfigPath()).toBe(file);
  });
});
