// The fixture's step definitions and its one Before hook. None touches `page`.
//
// The scenario that passes on its second attempt fails while
// `$testInfo.retry` is 0, so its retry (retry 1) passes.
import { createBdd } from "playwright-bdd";

const { Given, When, Then, Before } = createBdd();

Before({ name: "a Before hook that fails", tags: "@before-hook-fails" }, () => {
  throw new Error("the Before hook failed on purpose");
});

Given("the background is laid", () => undefined);

Given("a passing step", () => undefined);

When("another passing step runs", () => undefined);

Then("the scenario passes", () => undefined);

When("a step fails on purpose", () => {
  throw new Error("the step failed on purpose");
});

Then("a step that never runs", () => {
  throw new Error("a step after a failing step ran");
});

Given("a step that fails on the first attempt only", ({ $testInfo }) => {
  if ($testInfo.retry === 0) throw new Error("the first attempt failed on purpose");
});

Given("the setup fails", () => {
  throw new Error("the setup failed on purpose");
});
