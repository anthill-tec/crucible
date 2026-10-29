// bun's console when a test file fails to load, as bun 1.4.2 (744846f84) wrote it,
// and the bun client's own reading of each — the oracle the board's reading
// of bun's load errors must equal.
//
// PROVENANCE. Every capture below is a REAL `bun test` 1.4.2 run, in both wire
// forms (plain under `NO_COLOR=1`, ANSI under `FORCE_COLOR=1`), over the very
// scratch files tests/client/test_bun_files_each_test_file_that_failed_to_load.py
// and ..._skips_a_tests_own_console_lines.py drive live (same names, same bodies),
// with `--reporter=junit`; the scratch directory in bun's `at` and `from` lines
// is normalised to /tmp/bun-fixture/ as tests/fixtures/bun-console-captures.ts
// already does (the reading never looks at it), and the JUnit's hostname to
// `host`. Each scenario carries the JUnit bun wrote for that run beside its console.
//
// CLIENT_LOAD_ERROR_READING is `_add_load_error_cases` (clients/bun-crucible.py)
// run over an empty tree with each capture, keyed "<capture>/<wire>": the files
// bun named, in order, each mapped to the one `?` case's failure {message, trace}.
// It was computed once, from the client as it stands, and is frozen here so the
// port is held to the client's rules after the client stops reading the console.

import type { Capture, WireForm } from "./bun-console-captures.ts";

/** A real bun run that left files unloaded: its console in each wire form and the JUnit bun wrote. */
export interface LoadErrorRun extends Capture {
  ansi: string;
  /** The JUnit bun wrote for this run (identical in both wire forms but for timings). */
  junit: string;
}

/** The one load-error case the client files for a file bun named. */
export interface LoadErrorCase {
  message: string;
  trace?: string;
}

/** a passing file beside a file importing a missing module, one throwing at import and one rejecting at import — bun's report holds only the passing case */
export const FOUR_FILES: LoadErrorRun = {
  plain: "bun test v1.4.2 (744846f84)\n\na_passes.test.ts:\n(pass) passes [0.03ms]\n\nb_imports_a_missing_module.test.ts:\n\n# Unhandled error between tests\n-------------------------------\nerror: Cannot find module './does-not-exist' from '/tmp/bun-fixture/b_imports_a_missing_module.test.ts'\n-------------------------------\n\n\nc_throws_at_import.test.ts:\n\n# Unhandled error between tests\n-------------------------------\n1 | import { test } from \"bun:test\";\n2 | throw new Error(\"boom at import\");\n              ^\nerror: boom at import\n      at /tmp/bun-fixture/c_throws_at_import.test.ts:2:11\n-------------------------------\n\n\nd_rejects_at_import.test.ts:\n\n# Unhandled error between tests\n-------------------------------\n1 | import { test } from \"bun:test\";\n2 | Promise.reject(new Error(\"rejected at import\"));\n                       ^\nerror: rejected at import\n      at /tmp/bun-fixture/d_rejects_at_import.test.ts:2:20\n-------------------------------\n\n\n 1 pass\n 2 fail\n 3 errors\n 1 expect() calls\nRan 3 tests across 4 files. [4.00ms]\n",
  ansi: "\u001b[0m\u001b[1mbun test \u001b[0m\u001b[2mv1.4.2 (744846f84)\u001b[0m\n\u001b[0m\na_passes.test.ts:\n\u001b[0m\u001b[32m✓\u001b[0m\u001b[0m\u001b[1m passes\u001b[0m \u001b[0m\u001b[2m[0.02ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\nb_imports_a_missing_module.test.ts:\n\u001b[0m\n\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m\n\u001b[2m-------------------------------\u001b[0m\n\u001b[31merror\u001b[0m\u001b[2m: \u001b[0m\u001b[1mCannot find module './does-not-exist' from '/tmp/bun-fixture/b_imports_a_missing_module.test.ts'\u001b[0m\n\u001b[0m\u001b[2m-------------------------------\u001b[0m\n\n\u001b[0m\nc_throws_at_import.test.ts:\n\u001b[0m\n\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m\n\u001b[2m-------------------------------\u001b[0m\n\u001b[0m\u001b[1m1 |\u001b[0m \u001b[0m\u001b[35mimport\u001b[0m { test } \u001b[0m\u001b[35mfrom\u001b[0m \u001b[0m\u001b[32m\"bun:test\"\u001b[0m\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m2 |\u001b[0m \u001b[0m\u001b[35mthrow\u001b[0m \u001b[0m\u001b[35mnew\u001b[0m \u001b[0m\u001b[1mError\u001b[0m(\u001b[0m\u001b[32m\"boom at import\"\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m\n              \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1mboom at import\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36mc_throws_at_import.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m2\u001b[0m\u001b[2m:\u001b[33m11\u001b[0m\n\u001b[0m\u001b[2m-------------------------------\u001b[0m\n\n\u001b[0m\nd_rejects_at_import.test.ts:\n\u001b[0m\n\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m\n\u001b[2m-------------------------------\u001b[0m\n\u001b[0m\u001b[1m1 |\u001b[0m \u001b[0m\u001b[35mimport\u001b[0m { test } \u001b[0m\u001b[35mfrom\u001b[0m \u001b[0m\u001b[32m\"bun:test\"\u001b[0m\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m2 |\u001b[0m Promise\u001b[0m\u001b[3m\u001b[1m.reject\u001b[0m(\u001b[0m\u001b[35mnew\u001b[0m \u001b[0m\u001b[1mError\u001b[0m(\u001b[0m\u001b[32m\"rejected at import\"\u001b[0m))\u001b[0m\u001b[2m;\u001b[0m\n                       \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1mrejected at import\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36md_rejects_at_import.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m2\u001b[0m\u001b[2m:\u001b[33m20\u001b[0m\n\u001b[0m\u001b[2m-------------------------------\u001b[0m\n\n\n\u001b[0m\u001b[32m 1 pass\u001b[0m\n\u001b[0m\u001b[31m 2 fail\u001b[0m\n \u001b[0m\u001b[31m3 errors\u001b[0m\n 1 expect() calls\nRan 3 tests across 4 files. \u001b[0m\u001b[2m[\u001b[1m2.00ms\u001b[0m\u001b[2m]\u001b[0m\n",
  junit: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites name=\"bun test\" tests=\"1\" assertions=\"1\" failures=\"0\" skipped=\"0\" time=\"0.004885121\">\n  <testsuite name=\"a_passes.test.ts\" file=\"a_passes.test.ts\" tests=\"1\" assertions=\"1\" failures=\"0\" skipped=\"0\" time=\"0.000669482\" hostname=\"host\">\n    <testcase name=\"passes\" classname=\"\" time=\"0.000026\" file=\"a_passes.test.ts\" line=\"2\" assertions=\"1\" />\n  </testsuite>\n</testsuites>\n",
};

/** a passing file beside a file rejecting twice at import — two `# Unhandled error between tests` blocks under one header */
export const TWO_BLOCKS: LoadErrorRun = {
  plain: "bun test v1.4.2 (744846f84)\n\na_passes.test.ts:\n(pass) passes [0.02ms]\n\ne_two_error_blocks.test.ts:\n\n# Unhandled error between tests\n-------------------------------\n1 | import { test } from \"bun:test\";\n2 | Promise.reject(new Error(\"first block\"));\n                       ^\nerror: first block\n      at /tmp/bun-fixture/e_two_error_blocks.test.ts:2:20\n-------------------------------\n\n\n# Unhandled error between tests\n-------------------------------\n1 | import { test } from \"bun:test\";\n2 | Promise.reject(new Error(\"first block\"));\n3 | Promise.reject(new Error(\"second block\"));\n                       ^\nerror: second block\n      at /tmp/bun-fixture/e_two_error_blocks.test.ts:3:20\n-------------------------------\n\n\n 1 pass\n 0 fail\n 2 errors\n 1 expect() calls\nRan 1 test across 2 files. [2.00ms]\n",
  ansi: "\u001b[0m\u001b[1mbun test \u001b[0m\u001b[2mv1.4.2 (744846f84)\u001b[0m\n\u001b[0m\na_passes.test.ts:\n\u001b[0m\u001b[32m✓\u001b[0m\u001b[0m\u001b[1m passes\u001b[0m \u001b[0m\u001b[2m[0.02ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\ne_two_error_blocks.test.ts:\n\u001b[0m\n\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m\n\u001b[2m-------------------------------\u001b[0m\n\u001b[0m\u001b[1m1 |\u001b[0m \u001b[0m\u001b[35mimport\u001b[0m { test } \u001b[0m\u001b[35mfrom\u001b[0m \u001b[0m\u001b[32m\"bun:test\"\u001b[0m\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m2 |\u001b[0m Promise\u001b[0m\u001b[3m\u001b[1m.reject\u001b[0m(\u001b[0m\u001b[35mnew\u001b[0m \u001b[0m\u001b[1mError\u001b[0m(\u001b[0m\u001b[32m\"first block\"\u001b[0m))\u001b[0m\u001b[2m;\u001b[0m\n                       \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1mfirst block\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36me_two_error_blocks.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m2\u001b[0m\u001b[2m:\u001b[33m20\u001b[0m\n\u001b[0m\u001b[2m-------------------------------\u001b[0m\n\n\u001b[0m\n\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m\n\u001b[2m-------------------------------\u001b[0m\n\u001b[0m\u001b[1m1 |\u001b[0m \u001b[0m\u001b[35mimport\u001b[0m { test } \u001b[0m\u001b[35mfrom\u001b[0m \u001b[0m\u001b[32m\"bun:test\"\u001b[0m\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m2 |\u001b[0m Promise\u001b[0m\u001b[3m\u001b[1m.reject\u001b[0m(\u001b[0m\u001b[35mnew\u001b[0m \u001b[0m\u001b[1mError\u001b[0m(\u001b[0m\u001b[32m\"first block\"\u001b[0m))\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m3 |\u001b[0m Promise\u001b[0m\u001b[3m\u001b[1m.reject\u001b[0m(\u001b[0m\u001b[35mnew\u001b[0m \u001b[0m\u001b[1mError\u001b[0m(\u001b[0m\u001b[32m\"second block\"\u001b[0m))\u001b[0m\u001b[2m;\u001b[0m\n                       \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1msecond block\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36me_two_error_blocks.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m3\u001b[0m\u001b[2m:\u001b[33m20\u001b[0m\n\u001b[0m\u001b[2m-------------------------------\u001b[0m\n\n\n\u001b[0m\u001b[32m 1 pass\u001b[0m\n\u001b[0m\u001b[2m 0 fail\u001b[0m\n \u001b[0m\u001b[31m2 errors\u001b[0m\n 1 expect() calls\nRan 1 test across 2 files. \u001b[0m\u001b[2m[\u001b[1m2.00ms\u001b[0m\u001b[2m]\u001b[0m\n",
  junit: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites name=\"bun test\" tests=\"1\" assertions=\"1\" failures=\"0\" skipped=\"0\" time=\"0.002368298\">\n  <testsuite name=\"a_passes.test.ts\" file=\"a_passes.test.ts\" tests=\"1\" assertions=\"1\" failures=\"0\" skipped=\"0\" time=\"0.000384497\" hostname=\"host\">\n    <testcase name=\"passes\" classname=\"\" time=\"0.000019\" file=\"a_passes.test.ts\" line=\"2\" assertions=\"1\" />\n  </testsuite>\n</testsuites>\n",
};

/** a passing file beside a file whose test ran and passed before an afterAll rejection — bun's report holds a suite for that file */
export const RAN_THEN_REJECTED: LoadErrorRun = {
  plain: "bun test v1.4.2 (744846f84)\n\na_passes.test.ts:\n(pass) passes [0.02ms]\n\nf_ran_then_rejected.test.ts:\n(pass) ran first [0.02ms]\n\n# Unhandled error between tests\n-------------------------------\n1 | import { test, expect, afterAll } from \"bun:test\";\n2 | test(\"ran first\", () => { expect(1).toBe(1); });\n3 | afterAll(() => { Promise.reject(new Error(\"rejected after its test ran\")); });\n                                        ^\nerror: rejected after its test ran\n      at <anonymous> (/tmp/bun-fixture/f_ran_then_rejected.test.ts:3:37)\n-------------------------------\n\n\n 2 pass\n 0 fail\n 1 error\n 2 expect() calls\nRan 2 tests across 2 files. [2.00ms]\n",
  ansi: "\u001b[0m\u001b[1mbun test \u001b[0m\u001b[2mv1.4.2 (744846f84)\u001b[0m\n\u001b[0m\na_passes.test.ts:\n\u001b[0m\u001b[32m✓\u001b[0m\u001b[0m\u001b[1m passes\u001b[0m \u001b[0m\u001b[2m[0.02ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\nf_ran_then_rejected.test.ts:\n\u001b[0m\u001b[32m✓\u001b[0m\u001b[0m\u001b[1m ran first\u001b[0m \u001b[0m\u001b[2m[0.02ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\n\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m\n\u001b[2m-------------------------------\u001b[0m\n\u001b[0m\u001b[1m1 |\u001b[0m \u001b[0m\u001b[35mimport\u001b[0m { test, expect, afterAll } \u001b[0m\u001b[35mfrom\u001b[0m \u001b[0m\u001b[32m\"bun:test\"\u001b[0m\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m2 |\u001b[0m test(\u001b[0m\u001b[32m\"ran first\"\u001b[0m, () => { expect(\u001b[0m\u001b[33m1\u001b[0m)\u001b[0m\u001b[3m\u001b[1m.toBe\u001b[0m(\u001b[0m\u001b[33m1\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m })\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m3 |\u001b[0m afterAll(() => { Promise\u001b[0m\u001b[3m\u001b[1m.reject\u001b[0m(\u001b[0m\u001b[35mnew\u001b[0m \u001b[0m\u001b[1mError\u001b[0m(\u001b[0m\u001b[32m\"rejected after its test ran\"\u001b[0m))\u001b[0m\u001b[2m;\u001b[0m })\u001b[0m\u001b[2m;\u001b[0m\n                                        \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1mrejected after its test ran\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[2m<anonymous>\u001b[0m\u001b[2m (\u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36mf_ran_then_rejected.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m3\u001b[0m\u001b[2m:\u001b[33m37\u001b[0m\u001b[2m)\u001b[0m\n\u001b[0m\u001b[2m-------------------------------\u001b[0m\n\n\n\u001b[0m\u001b[32m 2 pass\u001b[0m\n\u001b[0m\u001b[2m 0 fail\u001b[0m\n \u001b[0m\u001b[31m1 error\u001b[0m\n 2 expect() calls\nRan 2 tests across 2 files. \u001b[0m\u001b[2m[\u001b[1m2.00ms\u001b[0m\u001b[2m]\u001b[0m\n",
  junit: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites name=\"bun test\" tests=\"2\" assertions=\"2\" failures=\"0\" skipped=\"0\" time=\"0.002412954\">\n  <testsuite name=\"a_passes.test.ts\" file=\"a_passes.test.ts\" tests=\"1\" assertions=\"1\" failures=\"0\" skipped=\"0\" time=\"0.000388475\" hostname=\"host\">\n    <testcase name=\"passes\" classname=\"\" time=\"0.000018\" file=\"a_passes.test.ts\" line=\"2\" assertions=\"1\" />\n  </testsuite>\n  <testsuite name=\"f_ran_then_rejected.test.ts\" file=\"f_ran_then_rejected.test.ts\" tests=\"1\" assertions=\"1\" failures=\"0\" skipped=\"0\" time=\"0.000228829\" hostname=\"host\">\n    <testcase name=\"ran first\" classname=\"\" time=\"0.000017\" file=\"f_ran_then_rejected.test.ts\" line=\"2\" assertions=\"1\" />\n  </testsuite>\n</testsuites>\n",
};

/** a passing file beside two files that each print a flush-left `results:` line of their own before rejecting/throwing */
export const CONSOLE_LINE: LoadErrorRun = {
  plain: "bun test v1.4.2 (744846f84)\n\na_passes.test.ts:\n(pass) passes [0.03ms]\n\ng_logs_then_rejected.test.ts:\nresults:\n(pass) logs then passes [0.02ms]\n\n# Unhandled error between tests\n-------------------------------\n1 | import { test, expect, afterAll } from \"bun:test\";\n2 | test(\"logs then passes\", () => { console.log(\"results:\"); expect(1).toBe(1); });\n3 | afterAll(() => { Promise.reject(new Error(\"rejected after the log\")); });\n                                        ^\nerror: rejected after the log\n      at <anonymous> (/tmp/bun-fixture/g_logs_then_rejected.test.ts:3:37)\n-------------------------------\n\n\nh_logs_then_throws_at_import.test.ts:\nresults:\n\n# Unhandled error between tests\n-------------------------------\n1 | import { test } from \"bun:test\";\n2 | console.log(\"results:\");\n3 | throw new Error(\"boom after a console line\");\n              ^\nerror: boom after a console line\n      at /tmp/bun-fixture/h_logs_then_throws_at_import.test.ts:3:11\n-------------------------------\n\n\n 2 pass\n 1 fail\n 2 errors\n 2 expect() calls\nRan 3 tests across 3 files. [2.00ms]\n",
  ansi: "\u001b[0m\u001b[1mbun test \u001b[0m\u001b[2mv1.4.2 (744846f84)\u001b[0m\n\u001b[0m\na_passes.test.ts:\n\u001b[0m\u001b[32m✓\u001b[0m\u001b[0m\u001b[1m passes\u001b[0m \u001b[0m\u001b[2m[0.02ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\ng_logs_then_rejected.test.ts:\nresults:\n\u001b[0m\u001b[32m✓\u001b[0m\u001b[0m\u001b[1m logs then passes\u001b[0m \u001b[0m\u001b[2m[0.03ms\u001b[0m\u001b[2m]\u001b[0m\n\u001b[0m\n\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m\n\u001b[2m-------------------------------\u001b[0m\n\u001b[0m\u001b[1m1 |\u001b[0m \u001b[0m\u001b[35mimport\u001b[0m { test, expect, afterAll } \u001b[0m\u001b[35mfrom\u001b[0m \u001b[0m\u001b[32m\"bun:test\"\u001b[0m\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m2 |\u001b[0m test(\u001b[0m\u001b[32m\"logs then passes\"\u001b[0m, () => { console\u001b[0m\u001b[3m\u001b[1m.log\u001b[0m(\u001b[0m\u001b[32m\"results:\"\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m expect(\u001b[0m\u001b[33m1\u001b[0m)\u001b[0m\u001b[3m\u001b[1m.toBe\u001b[0m(\u001b[0m\u001b[33m1\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m })\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m3 |\u001b[0m afterAll(() => { Promise\u001b[0m\u001b[3m\u001b[1m.reject\u001b[0m(\u001b[0m\u001b[35mnew\u001b[0m \u001b[0m\u001b[1mError\u001b[0m(\u001b[0m\u001b[32m\"rejected after the log\"\u001b[0m))\u001b[0m\u001b[2m;\u001b[0m })\u001b[0m\u001b[2m;\u001b[0m\n                                        \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1mrejected after the log\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[2m<anonymous>\u001b[0m\u001b[2m (\u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36mg_logs_then_rejected.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m3\u001b[0m\u001b[2m:\u001b[33m37\u001b[0m\u001b[2m)\u001b[0m\n\u001b[0m\u001b[2m-------------------------------\u001b[0m\n\n\u001b[0m\nh_logs_then_throws_at_import.test.ts:\nresults:\n\u001b[0m\n\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m\n\u001b[2m-------------------------------\u001b[0m\n\u001b[0m\u001b[1m1 |\u001b[0m \u001b[0m\u001b[35mimport\u001b[0m { test } \u001b[0m\u001b[35mfrom\u001b[0m \u001b[0m\u001b[32m\"bun:test\"\u001b[0m\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m2 |\u001b[0m console\u001b[0m\u001b[3m\u001b[1m.log\u001b[0m(\u001b[0m\u001b[32m\"results:\"\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m\n\u001b[0m\u001b[1m3 |\u001b[0m \u001b[0m\u001b[35mthrow\u001b[0m \u001b[0m\u001b[35mnew\u001b[0m \u001b[0m\u001b[1mError\u001b[0m(\u001b[0m\u001b[32m\"boom after a console line\"\u001b[0m)\u001b[0m\u001b[2m;\u001b[0m\n              \u001b[31m\u001b[1m^\u001b[0m\n\u001b[0m\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1mboom after a console line\u001b[0m\n\u001b[0m      \u001b[2mat \u001b[0m\u001b[0m\u001b[36m\u001b[2m/tmp/bun-fixture/\u001b[0m\u001b[36mh_logs_then_throws_at_import.test.ts\u001b[0m\u001b[2m:\u001b[0m\u001b[33m3\u001b[0m\u001b[2m:\u001b[33m11\u001b[0m\n\u001b[0m\u001b[2m-------------------------------\u001b[0m\n\n\n\u001b[0m\u001b[32m 2 pass\u001b[0m\n\u001b[0m\u001b[31m 1 fail\u001b[0m\n \u001b[0m\u001b[31m2 errors\u001b[0m\n 2 expect() calls\nRan 3 tests across 3 files. \u001b[0m\u001b[2m[\u001b[1m2.00ms\u001b[0m\u001b[2m]\u001b[0m\n",
  junit: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites name=\"bun test\" tests=\"2\" assertions=\"2\" failures=\"0\" skipped=\"0\" time=\"0.002449584\">\n  <testsuite name=\"a_passes.test.ts\" file=\"a_passes.test.ts\" tests=\"1\" assertions=\"1\" failures=\"0\" skipped=\"0\" time=\"0.00040684\" hostname=\"host\">\n    <testcase name=\"passes\" classname=\"\" time=\"0.000028\" file=\"a_passes.test.ts\" line=\"2\" assertions=\"1\" />\n  </testsuite>\n  <testsuite name=\"g_logs_then_rejected.test.ts\" file=\"g_logs_then_rejected.test.ts\" tests=\"1\" assertions=\"1\" failures=\"0\" skipped=\"0\" time=\"0.000239369\" hostname=\"host\">\n    <testcase name=\"logs then passes\" classname=\"\" time=\"0.000023\" file=\"g_logs_then_rejected.test.ts\" line=\"2\" assertions=\"1\" />\n  </testsuite>\n</testsuites>\n",
};

export const CLIENT_LOAD_ERROR_READING: Record<string, Record<string, LoadErrorCase>> = {
  "FOUR_FILES/plain": {
    "b_imports_a_missing_module.test.ts": {
      "message": "Cannot find module './does-not-exist' from '/tmp/bun-fixture/b_imports_a_missing_module.test.ts'",
      "trace": "error: Cannot find module './does-not-exist' from '/tmp/bun-fixture/b_imports_a_missing_module.test.ts'"
    },
    "c_throws_at_import.test.ts": {
      "message": "boom at import",
      "trace": "1 | import { test } from \"bun:test\";\n2 | throw new Error(\"boom at import\");\n              ^\nerror: boom at import\n      at /tmp/bun-fixture/c_throws_at_import.test.ts:2:11"
    },
    "d_rejects_at_import.test.ts": {
      "message": "rejected at import",
      "trace": "1 | import { test } from \"bun:test\";\n2 | Promise.reject(new Error(\"rejected at import\"));\n                       ^\nerror: rejected at import\n      at /tmp/bun-fixture/d_rejects_at_import.test.ts:2:20"
    }
  },
  "FOUR_FILES/ansi": {
    "b_imports_a_missing_module.test.ts": {
      "message": "Cannot find module './does-not-exist' from '/tmp/bun-fixture/b_imports_a_missing_module.test.ts'",
      "trace": "error: Cannot find module './does-not-exist' from '/tmp/bun-fixture/b_imports_a_missing_module.test.ts'"
    },
    "c_throws_at_import.test.ts": {
      "message": "boom at import",
      "trace": "1 | import { test } from \"bun:test\";\n2 | throw new Error(\"boom at import\");\n              ^\nerror: boom at import\n      at /tmp/bun-fixture/c_throws_at_import.test.ts:2:11"
    },
    "d_rejects_at_import.test.ts": {
      "message": "rejected at import",
      "trace": "1 | import { test } from \"bun:test\";\n2 | Promise.reject(new Error(\"rejected at import\"));\n                       ^\nerror: rejected at import\n      at /tmp/bun-fixture/d_rejects_at_import.test.ts:2:20"
    }
  },
  "TWO_BLOCKS/plain": {
    "e_two_error_blocks.test.ts": {
      "message": "first block",
      "trace": "1 | import { test } from \"bun:test\";\n2 | Promise.reject(new Error(\"first block\"));\n                       ^\nerror: first block\n      at /tmp/bun-fixture/e_two_error_blocks.test.ts:2:20\n\n1 | import { test } from \"bun:test\";\n2 | Promise.reject(new Error(\"first block\"));\n3 | Promise.reject(new Error(\"second block\"));\n                       ^\nerror: second block\n      at /tmp/bun-fixture/e_two_error_blocks.test.ts:3:20"
    }
  },
  "TWO_BLOCKS/ansi": {
    "e_two_error_blocks.test.ts": {
      "message": "first block",
      "trace": "1 | import { test } from \"bun:test\";\n2 | Promise.reject(new Error(\"first block\"));\n                       ^\nerror: first block\n      at /tmp/bun-fixture/e_two_error_blocks.test.ts:2:20\n\n1 | import { test } from \"bun:test\";\n2 | Promise.reject(new Error(\"first block\"));\n3 | Promise.reject(new Error(\"second block\"));\n                       ^\nerror: second block\n      at /tmp/bun-fixture/e_two_error_blocks.test.ts:3:20"
    }
  },
  "RAN_THEN_REJECTED/plain": {
    "f_ran_then_rejected.test.ts": {
      "message": "rejected after its test ran",
      "trace": "1 | import { test, expect, afterAll } from \"bun:test\";\n2 | test(\"ran first\", () => { expect(1).toBe(1); });\n3 | afterAll(() => { Promise.reject(new Error(\"rejected after its test ran\")); });\n                                        ^\nerror: rejected after its test ran\n      at <anonymous> (/tmp/bun-fixture/f_ran_then_rejected.test.ts:3:37)"
    }
  },
  "RAN_THEN_REJECTED/ansi": {
    "f_ran_then_rejected.test.ts": {
      "message": "rejected after its test ran",
      "trace": "1 | import { test, expect, afterAll } from \"bun:test\";\n2 | test(\"ran first\", () => { expect(1).toBe(1); });\n3 | afterAll(() => { Promise.reject(new Error(\"rejected after its test ran\")); });\n                                        ^\nerror: rejected after its test ran\n      at <anonymous> (/tmp/bun-fixture/f_ran_then_rejected.test.ts:3:37)"
    }
  },
  "CONSOLE_LINE/plain": {
    "g_logs_then_rejected.test.ts": {
      "message": "rejected after the log",
      "trace": "1 | import { test, expect, afterAll } from \"bun:test\";\n2 | test(\"logs then passes\", () => { console.log(\"results:\"); expect(1).toBe(1); });\n3 | afterAll(() => { Promise.reject(new Error(\"rejected after the log\")); });\n                                        ^\nerror: rejected after the log\n      at <anonymous> (/tmp/bun-fixture/g_logs_then_rejected.test.ts:3:37)"
    },
    "h_logs_then_throws_at_import.test.ts": {
      "message": "boom after a console line",
      "trace": "1 | import { test } from \"bun:test\";\n2 | console.log(\"results:\");\n3 | throw new Error(\"boom after a console line\");\n              ^\nerror: boom after a console line\n      at /tmp/bun-fixture/h_logs_then_throws_at_import.test.ts:3:11"
    }
  },
  "CONSOLE_LINE/ansi": {
    "g_logs_then_rejected.test.ts": {
      "message": "rejected after the log",
      "trace": "1 | import { test, expect, afterAll } from \"bun:test\";\n2 | test(\"logs then passes\", () => { console.log(\"results:\"); expect(1).toBe(1); });\n3 | afterAll(() => { Promise.reject(new Error(\"rejected after the log\")); });\n                                        ^\nerror: rejected after the log\n      at <anonymous> (/tmp/bun-fixture/g_logs_then_rejected.test.ts:3:37)"
    },
    "h_logs_then_throws_at_import.test.ts": {
      "message": "boom after a console line",
      "trace": "1 | import { test } from \"bun:test\";\n2 | console.log(\"results:\");\n3 | throw new Error(\"boom after a console line\");\n              ^\nerror: boom after a console line\n      at /tmp/bun-fixture/h_logs_then_throws_at_import.test.ts:3:11"
    }
  }
};

export const LOAD_ERROR_WIRES: WireForm[] = ["plain", "ansi"];
