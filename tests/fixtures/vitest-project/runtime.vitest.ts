import { expect, test } from "vitest";

// The declared script launches Vitest with `--bun`; under Node `Bun` is
// undefined and this test fails.
test("vitest runs on the bun runtime", () => {
  expect(typeof globalThis.Bun).toBe("object");
  expect(typeof process.versions.bun).toBe("string");
});
