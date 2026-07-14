# CR-CRU-002 — Codec translation layer

**Status:** PENDING
**Type:** feature
**Priority:** P0
**Depends on:** CR-CRU-001
**Labels:** codecs, ingest
**Phase:** Wave 1
**Design reference:** docs/research/PRD-crucible-v2.md §4.4–§4.5; docs/research/DN-crucible-api-reconstruction.md §3.4, §3.6

## Context
v1 was JUnit-spined; v2 normalizes every tool's output into the canonical RunSchema
through a codec registry. This CR ships the v0.1.0 codecs: junit + the four compile
codecs. Playwright/vitest/TAP land with the BDD wave.

## Scope

### §S1 JUnit codec (`src/codecs/junit.ts`)
Define and export `RunSchema {summary: RunSummary, tree: SuiteNode[], coverage?:
Coverage}` in `src/types.ts` (the canonical normalized-run shape; `Store.recordTestEvent`'s
run parameter adopts it as a type alias — no behavior change).
`parseJunit(xml: string): RunSchema` and `parseJunitPath(path: string):
Promise<RunSchema>`. Semantics (DN §3.4, byte-parity with the client parsers):
testcase with `<failure>` or `<error>` child → `fail`; `<skipped>` → `pending`; else
`pass`. `time` attribute (seconds, float) → `duration_ms` (rounded int). Root may be
`<testsuites>` or a bare `<testsuite>`. `parseJunitPath` accepts a single XML file OR
a directory (all `TEST-*.xml`, sorted, merged into one RunSchema; error if a directory
has none). Failed leaves carry `failure {message, type?, trace?}`: `message` from the
failure element's `message` attribute (fallback: first non-empty text line, fallback
`"test failed"`), `type` from its `type` attribute, `trace` = trimmed element text.
CDATA and XML entities decoded. A malformed testsuite file inside a directory is
skipped with a warning, not fatal.

### §S2 Compile codecs (`src/codecs/compile.ts`)
`parseCompile(errors: string, formatHint?: string): CompileReport` where
`CompileReport = {format, errorCount, warningCount, diagnostics: [{file?, line?,
col?, code?, message, level: "error"|"warning"}], raw}`.
- `rustc`: `error[EXXXX]: msg` / `error: msg` / `warning: msg` blocks with
  ` --> file:line:col` location; `code` = `EXXXX`.
- `javac`: `[ERROR] /path/File.java:[line,col] message` (+ `[WARNING]`).
- `python`: last `File "x", line N` + final `\w*(Error|Exception)` line.
- `tsc`: `file.ts(line,col): error TSnnnn: message`.
- `detectFormat(errors, hint?)`: hint wins (aliases: rust→rustc, java/maven→javac,
  py→python, ts/typescript→tsc); else pattern-detect; else `"raw"`.
- **Never rejects**: unknown input → `format: "raw"`, `diagnostics: []`, counts from
  conventional markers, full text in `raw`.

### §S3 Registry (`src/codecs/index.ts`)
`codecs: Map<string, Codec>` with `junit` registered; ingest paths look up by name so
adding a codec never touches core. Events recorded through a codec are stamped
`codec` (and `stack` when the caller provides it).

### §S4 Minimal ingest routes (the CR's production call path)
Extend `src/server.ts` with two v1-shaped routes (moved here from CR-CRU-003 so the
codecs have a real production seam; CR-CRU-003 hardens them to the full DN contract):
- `POST /api/ingest` `{projectKey, format: "junit", data | dataPath, agentId}` —
  UUID + known-project validation (400/404 with `{ok:false, error}`), codec looked up
  via the §S3 registry, result recorded via `Store.recordTestEvent` (codec stamped),
  response `{ok: true, summary}`.
- `POST /api/ingest/compile` `{projectKey, agentId, errors, format?}` → `parseCompile`,
  recorded via `Store.recordCompileEvent`, response `{ok: true, summary: {failed:
  <errorCount>, pending: <warningCount>}}` (v1 client convention).

## Acceptance criteria
- [x] `parseJunit` on a 3-case suite (1 failure w/ message="boom" type="AssertionError" body "line1\nline2", 1 skipped, 1 pass, times 0.5/0/0.084) → summary `{total: 3, passed: 1, failed: 1, pending: 1, duration_ms: 584}`; failed leaf `.failure` equals `{message: "boom", type: "AssertionError", trace: "line1\nline2"}`.
- [x] `parseJunit` accepts a bare `<testsuite>` root (no `<testsuites>`) and yields 1 suite node.
- [x] `parseJunitPath(dir)` with `TEST-a.xml` (2 pass) + `TEST-b.xml` (1 fail) → summary `{total: 3, passed: 2, failed: 1}` and 2 suite nodes; with a dir containing no `TEST-*.xml` it throws with a message naming the dir.
- [x] rustc fixture `"error[E0308]: mismatched types\n --> src/lib.rs:12:5\nwarning: unused import\n --> src/a.rs:1:1"` → `errorCount 1`, `warningCount 1`, first diagnostic `{code: "E0308", file: "src/lib.rs", line: 12, col: 5, level: "error"}`.
- [x] javac fixture `"[ERROR] /x/Foo.java:[42,13] cannot find symbol"` → diagnostic `{file: "/x/Foo.java", line: 42, col: 13, level: "error", message: "cannot find symbol"}`.
- [x] python fixture with a traceback ending `ImportError: no module named y` → 1 error diagnostic whose `message` is that line and `file`/`line` from the LAST `File "…", line n` frame.
- [x] tsc fixture `"src/x.ts(12,5): error TS2304: Cannot find name 'y'."` → `{file: "src/x.ts", line: 12, col: 5, code: "TS2304", level: "error"}`.
- [x] `parseCompile("total garbage ✈")` → `{format: "raw", diagnostics: []}` and does not throw; `detectFormat(x, "java") === "javac"`.
- [x] Integration: `POST /api/ingest` on the booted real server with an inline junit `data` fixture → `{ok: true, summary: {total: 3, passed: 2, failed: 1, …}}` AND the event appears in the store with `codec: "junit"` and preserved `failure.message` (integration test drives `startServer`, not a hand-wired store); `POST /api/ingest/compile` with the rustc fixture → `{ok: true, summary: {failed: 1, pending: 1}}`.
- [x] Caller-existence: grep of non-test src (`src/server.ts`) for `parseJunit`/`parseCompile`/registry lookup returns ≥ 2 callers.

## Estimated size
M.

## Risk
JUnit dialect drift (nextest vs surefire vs bun) — fixtures for each dialect are part
of the test suite.

## Non-goals
playwright/vitest/tap codecs (BDD wave); HTTP endpoints.
