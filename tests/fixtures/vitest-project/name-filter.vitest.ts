import { expect, test } from "vitest";

test("alpha matches the filter", () => {
  expect(1 + 1).toBe(2);
});

test("beta stays out of the filter", () => {
  expect(2 + 2).toBe(4);
});
