// CR-CRU-052 §S3 RED (contract 4) — see non-ephemeral.playwright.config.ts.
// No server listens on this config's baseURL at all: seedProject is
// expected to reject BEFORE attempting any network call, so the absence of
// a live listener is itself part of the proof — a connection-refused error
// would mean the guard either ran too late (after the network attempt) or
// didn't run at all.
//
// TODAY (pre-GREEN): seedProject has no ephemeral guard, so it genuinely
// tries to connect to :48231, gets ECONNREFUSED, and rejects with THAT
// message — the assertions below (which require an "ephemeral"-mentioning,
// port-naming message and explicitly forbid a connection-refused message)
// therefore fail for a real, non-vacuous reason. Verified live: a RED-phase
// smoke probe against this exact repo/toolchain combination reproduced
// precisely this `apiRequestContext.post: connect ECONNREFUSED` failure
// mode when posting to an unlistened port through Playwright's `request`
// fixture.
import { test, expect } from "@playwright/test";
import { seedProject } from "../steps/harness.ts";

test("seedProject against a non-ephemeral target fails loudly with an actionable message, before any network attempt", async ({
  request,
}) => {
  let thrown: unknown;
  try {
    await seedProject(request, "should-never-be-created");
    throw new Error("seedProject was expected to reject but resolved successfully");
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;

  // POSITIVE — loud + actionable: names WHY (non-ephemeral) and WHAT was
  // expected (the e2e port), not a bare "failed". A human hitting this
  // message in a copy-pasted ad-hoc script must be able to act on it
  // immediately, which is the entire point of §S3.
  expect(message).toMatch(/ephemeral/i);
  expect(message).toContain("39877");

  // NEGATIVE / bound — must NOT be a connection-refused error. That would
  // mean the guard let the network call through and only the transport
  // layer complained, which is exactly the "impossible mistake" the CR's
  // Risk section says must not be possible: the harness ought never even
  // attempt to talk to a target it hasn't first confirmed is ephemeral.
  expect(message).not.toMatch(/ECONNREFUSED|apiRequestContext\.post: connect/i);
});
