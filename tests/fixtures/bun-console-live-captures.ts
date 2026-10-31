// bun's console, captured from a real `bun test` run, for the board's
// `bun-console` view codec: the live state a console fills, read batch by
// batch (CR-CRU-201 §S3, AC3).
//
// PROVENANCE. Both forms are copied byte for byte from one `bun test` 1.4.2
// (744846f84) run of the four scratch files below, in a scratch directory
// outside the repo, its output captured through a pipe (stdout and stderr
// combined, as the bun client reads it). The scratch directory in the `at`
// and load-error lines is normalised to /tmp/bun-fixture/, as
// tests/fixtures/bun-console-captures.ts normalises its own; nothing else was
// touched.
//  - PLAIN: run with NO_COLOR=1, so the result lines read `(pass)`, `(fail)`,
//    `(skip)` and `(todo)`.
//  - COLOURED: run with FORCE_COLOR=1 — bun 1.4.2 did not colour this pipe on
//    its own — so the result lines read `✓`, `✗`, `»` and `✎`, each wrapped
//    in SGR runs.
//  - CRLF: PLAIN with every "\n" written as "\r\n", as a console that ends its
//    lines with CRLF writes it. Derived, not a separate run.
//
// The scratch files, run as `bun test ./math.test.ts ./more-math.test.ts
// ./top.test.ts ./broken.test.ts`:
//
// math.test.ts:
//   import { describe, expect, test } from "bun:test";
//
//   describe("math", () => {
//     test("adds", () => {
//       expect(1 + 1).toBe(2);
//     });
//     test("divides", () => {
//       expect(6 / 3).toBe(3);
//     });
//     test.skip("rounds", () => {
//       expect(Math.round(1.5)).toBe(2);
//     });
//     test.todo("formats");
//   });
//
// more-math.test.ts:
//   import { describe, expect, test } from "bun:test";
//
//   describe("math", () => {
//     test("divides", () => {
//       expect(9 / 3).toBe(4);
//     });
//   });
//
// top.test.ts:
//   import { expect, test } from "bun:test";
//
//   test("stands alone", () => {
//     expect("a").toBe("a");
//   });
//   test("breaks alone", () => {
//     throw new Error("alone boom");
//   });
//
// broken.test.ts:
//   import { test } from "bun:test";
//   import { missing } from "./no-such-module.ts";
//
//   test("never runs", () => {
//     missing();
//   });

/** The run in bun's plain wire form. */
export const PLAIN_RUN: string =
  "bun test v1.4.2 (744846f84)\n\nmath.test.ts:\n(pass) math > adds [0.01ms]\n3 | describe(\"math\", () => {\n4 |   test(\"adds\", () => {\n5 |     expect(1 + 1).toBe(2);\n6 |   });\n7 |   test(\"divides\", () => {\n8 |     expect(6 / 3).toBe(3);\n                      ^\nerror: expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n\n      at <anonymous> (/tmp/bun-fixture/math.test.ts:8:19)\n(fail) math > divides [0.09ms]\n(skip) math > rounds\n(todo) math > formats\n\nmore-math.test.ts:\n1 | import { describe, expect, test } from \"bun:test\";\n2 | \n3 | describe(\"math\", () => {\n4 |   test(\"divides\", () => {\n5 |     expect(9 / 3).toBe(4);\n                      ^\nerror: expect(received).toBe(expected)\n\nExpected: 4\nReceived: 3\n\n      at <anonymous> (/tmp/bun-fixture/more-math.test.ts:5:19)\n(fail) math > divides [0.03ms]\n\ntop.test.ts:\n(pass) stands alone\n2 | \n3 | test(\"stands alone\", () => {\n4 |   expect(\"a\").toBe(\"a\");\n5 | });\n6 | test(\"breaks alone\", () => {\n7 |   throw new Error(\"alone boom\");\n                                  ^\nerror: alone boom\n      at <anonymous> (/tmp/bun-fixture/top.test.ts:7:31)\n(fail) breaks alone [0.03ms]\n\nbroken.test.ts:\n\n# Unhandled error between tests\n-------------------------------\nerror: Cannot find module './no-such-module.ts' from '/tmp/bun-fixture/broken.test.ts'\n-------------------------------\n\n\n 2 pass\n 1 skip\n 1 todo\n 4 fail\n 1 error\n 4 expect() calls\nRan 8 tests across 4 files. [3.00ms]\n";

/** The same run in bun's coloured wire form. */
export const COLOURED_RUN: string =
  "\u001b[0m\u001b[1mbun test \u001b[0m\u001b[2mv1.4.2 (744846f84)\u001b[0m\n\u001b[0m\nmath.test.ts:\n\u001b[0m\u001b[32m\u2713\u001b[0m \u001b[0mmath\u001b[2m >\u001b[0m\u001b[1m adds\u001b[0m \u001b[0m\u001b[2m[0.02ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\u001b[1m3 |\u001b[0m describe(\u001b[0m\u001b[32m\"math\"\u001b[0m, () => {\n\u001b[0m\u001b[1m4 |\u001b[0m   test(\u001b[0m\u001b[32m\"adds\"\u001b[0m, () => {\n\u001b[0m\u001b[1m5 |\u001b[0m     expect(\u001b[0m\u001b[33m1\u001b[0m + \u001b[0m\u001b[33m1\u001b[0m)\u001b[0m\u001b[3m\u001b[1m.toBe\u001b[0m(\u001b[0m\u001b[33m2\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m6 |\u001b[0m   })\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m7 |\u001b[0m   test(\u001b[0m\u001b[32m\"divides\"\u001b[0m, () => {\n\u001b[0m\u001b[1m8 |\u001b[0m     expect(\u001b[0m\u001b[33m6\u001b[0m / \u001b[0m\u001b[33m3\u001b[0m)\u001b[0m\u001b[3m\u001b[1m.toBe\u001b[0m(\u001b[0m\u001b[33m3\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m\n                      \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1m\u001b[2mexpect(\u001b[0m\u001b[31mreceived\u001b[0m\u001b[2m).\u001b[0mtoBe\u001b[2m(\u001b[0m\u001b[32mexpected\u001b[0m\u001b[2m)\u001b[0m\n\nExpected: \u001b[32m3\u001b[0m\nReceived: \u001b[31m2\u001b[0m\n\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[2m<anonymous>\u001b[0m\u001b[2m (\u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36mmath.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m8\u001b[0m\u001b[2m:\u001b[33m19\u001b[0m\u001b[2m)\u001b[0m\n\u001b[0m\u001b[31m\u2717\u001b[0m \u001b[0mmath\u001b[2m >\u001b[0m\u001b[1m divides\u001b[0m \u001b[0m\u001b[2m[1.88ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\u001b[33m\u00bb\u001b[2m \u001b[0m\u001b[2mmath\u001b[2m >\u001b[0m\u001b[2m rounds\u001b[0m\n\u001b[0m\u001b[35m\u270e\u001b[0m \u001b[0m\u001b[2mmath\u001b[2m >\u001b[0m\u001b[2m formats\u001b[0m\n\u001b[0m\nmore-math.test.ts:\n\u001b[0m\u001b[1m1 |\u001b[0m \u001b[0m\u001b[35mimport\u001b[0m { describe, expect, test } \u001b[0m\u001b[35mfrom\u001b[0m \u001b[0m\u001b[32m\"bun:test\"\u001b[0m\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m2 |\u001b[0m \n\u001b[0m\u001b[1m3 |\u001b[0m describe(\u001b[0m\u001b[32m\"math\"\u001b[0m, () => {\n\u001b[0m\u001b[1m4 |\u001b[0m   test(\u001b[0m\u001b[32m\"divides\"\u001b[0m, () => {\n\u001b[0m\u001b[1m5 |\u001b[0m     expect(\u001b[0m\u001b[33m9\u001b[0m / \u001b[0m\u001b[33m3\u001b[0m)\u001b[0m\u001b[3m\u001b[1m.toBe\u001b[0m(\u001b[0m\u001b[33m4\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m\n                      \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1m\u001b[2mexpect(\u001b[0m\u001b[31mreceived\u001b[0m\u001b[2m).\u001b[0mtoBe\u001b[2m(\u001b[0m\u001b[32mexpected\u001b[0m\u001b[2m)\u001b[0m\n\nExpected: \u001b[32m4\u001b[0m\nReceived: \u001b[31m3\u001b[0m\n\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[2m<anonymous>\u001b[0m\u001b[2m (\u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36mmore-math.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m5\u001b[0m\u001b[2m:\u001b[33m19\u001b[0m\u001b[2m)\u001b[0m\n\u001b[0m\u001b[31m\u2717\u001b[0m \u001b[0mmath\u001b[2m >\u001b[0m\u001b[1m divides\u001b[0m \u001b[0m\u001b[2m[0.04ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\ntop.test.ts:\n\u001b[0m\u001b[32m\u2713\u001b[0m\u001b[0m\u001b[1m stands alone\u001b[0m\n\u001b[0m\u001b[1m2 |\u001b[0m \n\u001b[0m\u001b[1m3 |\u001b[0m test(\u001b[0m\u001b[32m\"stands alone\"\u001b[0m, () => {\n\u001b[0m\u001b[1m4 |\u001b[0m   expect(\u001b[0m\u001b[32m\"a\"\u001b[0m)\u001b[0m\u001b[3m\u001b[1m.toBe\u001b[0m(\u001b[0m\u001b[32m\"a\"\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m5 |\u001b[0m })\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m6 |\u001b[0m test(\u001b[0m\u001b[32m\"breaks alone\"\u001b[0m, () => {\n\u001b[0m\u001b[1m7 |\u001b[0m   \u001b[0m\u001b[35mthrow\u001b[0m \u001b[0m\u001b[35mnew\u001b[0m \u001b[0m\u001b[1mError\u001b[0m(\u001b[0m\u001b[32m\"alone boom\"\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m\n                                  \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1malone boom\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[2m<anonymous>\u001b[0m\u001b[2m (\u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36mtop.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m7\u001b[0m\u001b[2m:\u001b[33m31\u001b[0m\u001b[2m)\u001b[0m\n\u001b[0m\u001b[31m\u2717\u001b[0m\u001b[0m\u001b[1m breaks alone\u001b[0m \u001b[0m\u001b[2m[0.04ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\nbroken.test.ts:\n\u001b[0m\n\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m\n\u001b[2m-------------------------------\u001b[0m\n\u001b[31merror\u001b[0m\u001b[2m: \u001b[0m\u001b[1mCannot find module './no-such-module.ts' from '/tmp/bun-fixture/broken.test.ts'\u001b[0m\n\u001b[0m\u001b[2m-------------------------------\u001b[0m\n\n\n\u001b[0m\u001b[32m 2 pass\u001b[0m\n \u001b[0m\u001b[33m1 skip\u001b[0m\n \u001b[0m\u001b[35m1 todo\u001b[0m\n\u001b[0m\u001b[31m 4 fail\u001b[0m\n \u001b[0m\u001b[31m1 error\u001b[0m\n 4 expect() calls\nRan 8 tests across 4 files. \u001b[0m\u001b[2m[\u001b[1m5.00ms\u001b[0m\u001b[2m]\u001b[0m\n";

/** The plain run with CRLF line ends. */
export const CRLF_RUN: string = PLAIN_RUN.replace(/\n/g, "\r\n");
