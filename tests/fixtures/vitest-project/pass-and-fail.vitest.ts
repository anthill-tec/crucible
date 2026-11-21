import { expect, test } from "vitest";

test("a passing case", () => {
  expect(1 + 1).toBe(2);
});

test("a deliberately failing case", () => {
  expect(1 + 1).toBe(3);
});
