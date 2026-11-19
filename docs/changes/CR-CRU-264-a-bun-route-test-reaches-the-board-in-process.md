# CR-CRU-264 — a bun route test reaches the board in process

**Status:** PENDING · filed 2026-11-18 (release fix; split from CR-CRU-262 at its gap analysis — user rulings
2026-11-18: the bun suite is its own CR; `src/server.ts` exports the board's request router, with no behaviour change)
· gap analysis 2026-11-19 · spec pre-review 2026-11-19 (CHANGES, F1–F7 folded)
**Type:** fix
**Points:** 13 (re-scored from 8 at the spec pre-review, 2026-11-19, user ruling)
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-262
**Labels:** tests, server, release
**Design reference:** `test-reports/work/cr264-gap-analysis.md`; `test-reports/work/prereview264-report.md`;
`startServer`, `healthPayload` and `maxRequestBodySize` in `src/server.ts`; `handleV2` and `readIngestBody` in
`src/v2.ts`; `handleStream`; the bun helpers `tests/helpers/run-stream-harness.ts`, `server-limits-fixture.ts`,
`served-app.ts`, `coverage-files-harness.ts`, `coverage-files-view.ts`; the test pyramid; D1 (unit = no process, no
socket); CR-CRU-131 (no environment seam); CR-CRU-139 (the listener disclosure is the real socket)

## Problem

At `f097a22b`, 228 bun test files reach the real server — 193 call `startServer` directly (a scratch store and a
loopback socket), the rest through five helpers (`run-stream-harness.ts`, `server-limits-fixture.ts`,
`served-app.ts`, `coverage-files-harness.ts`, `coverage-files-view.ts`). About 174 of them only call HTTP routes, so
the socket is incidental, and every one of them sits in `tests/integration/`. The route handler cannot be called
without the socket: `startServer` builds the whole router (`/api/health`, `/api/stream`, `/api/v2/*` through
`handleV2`, the 404 JSON, the static SPA) inline inside `Bun.serve`, and nothing exports it.

## Design

- **The router is exported, through one factory** (pre-review F2). `src/server.ts` exports
  `createBoard({ store, storeResolution, listener })`: the board's `fetch(req)` is exactly the router `Bun.serve` runs
  today; `listener` is a function returning the bound `ListenerResolution`, or `null` for a board with no socket.
  `startServer` resolves its store and listener as today, builds the board, and wraps `board.fetch` in `Bun.serve`,
  passing the bound listener — so its handle, boot disclosures and both health routes are unchanged. The factory takes
  an explicit store (a test opens it with `Store.open(path, opts)`, so it can inject a scheduler) and resolves nothing
  itself: no `resolveStore`, no `resolveListener`, no environment variable (CR-CRU-131).
- **An in-process board's health says it has no socket** (F2): `/api/health` and `/api/v2/health` carry
  `listener: null` and every other key unchanged. It never invents a port (CR-CRU-139).
- **`board.stop()` closes what the board opened** (F3): it disposes the store and closes every stream the board
  answered — `board.fetch` tracks an `AbortController` per request and aborts them on stop — so an in-process
  `/api/stream` leaves no interval and no `store.onChange` subscription behind. `startServer`'s stop keeps
  `server.stop(true)` then `store.dispose()`.
- **Native request classes** (F4): `board.fetch` builds or re-validates the `Request` from the native `Request`,
  `Response`, `URL`, `Headers`, `Blob` and `ReadableStream` captured when the module loads, so a test that has installed
  happy-dom's globals still drives the router on native objects, and a happy-dom `Response` returned by a handler is
  still refused. A handler that throws answers as `Bun.serve` does (a 500), never a rejected promise. Converted tests
  address the board at one constant origin, `http://board.invalid` (no route reads `url.origin`, host or port;
  checked), and `served-app.ts`'s shell uses it too.
- **The body limit.** The JSON 413 comes from the router (`readIngestBody`, per request, from `ingest_body_bytes`),
  so a test of the board's 413 converts like any route test (F1). Only a test of Bun's own refusal above
  `maxRequestBodySize()` — the backstop — or one that spies on `Bun.serve`'s options keeps `startServer`.
- **The five helpers get in-process variants** (F5), each with its own return type (a board, not a
  `ReturnType<typeof startServer>`): `bootOn` and `base`, `server-limits-fixture.boot` and `activeFlags`,
  `mountServedApp`, the coverage harnesses. Residue users call `startServer` explicitly. The new export does not reuse
  the name `Board` already taken in `coverage-files-view.ts`.
- **What keeps `startServer`** (the residue): a test of the listener, of Bun's body-limit backstop or the `Bun.serve`
  options, of SSE over a held connection, of the boot path, a real browser (chromium/playwright) driving the board, or
  a spawned client talking to it. The happy-dom shell is not a real browser: its reads are answered in process.
- **The residue is listed first**: per helper, which users call `fetch`, `base` or `.server` themselves; then every file
  that keeps `startServer`, one line each with its reason. A residue above AC2's cap goes to the user.
- **Tier follows.** A converted file moves to `tests/unit/` when, measured, it takes no socket, process or wait
  (CR-CRU-261's rule). The server's own timers (the SSE keep-alive, the store's deferred live frame) count as waits
  unless the test injects a fake scheduler, so SSE and streamed-batch files may stay in `tests/integration/`.

## Acceptance criteria

- [ ] **AC1 — one router.** `src/server.ts` exports `createBoard`; `startServer` serves exactly its `fetch`; the tests
  that keep `startServer` pass unchanged; an in-process board's two health routes carry `listener: null` with every
  other key as `startServer`'s; after `board.stop()`, an in-process `/api/stream` body is closed and no interval
  remains.
- [ ] **AC2 — sparing (orchestrator check).** At most 38 bun files record a `serve` event in the CR-CRU-261 bun census
  (an event charged to a helper is charged to every file using it); each remaining one is in the residue list with one
  of the Design's keep reasons.
- [ ] **AC3 — nothing lost (orchestrator check).** Each converted file has the same set of test names before and after
  (JUnit, by file stem); its diff changes no `expect(` line except those that read the port or `listener`, and those
  are listed in the close-out.
- [ ] **AC4 — the pyramid is measured (orchestrator check).** The bun census (`leak-census/run-dep-census-bun.sh` with
  `bun-dep-preload.ts`, CR-CRU-261's clone and namespace) re-run after the change reports the class counts per file,
  recorded in the close-out; the converted files that took no socket, process or wait are in `tests/unit/`; a run of
  `tests/unit/` alone records no spawn, serve, connect, fetch or wait event.
- [ ] **AC5 — suites green.** Both suites and the e2e suite pass; the pre-merge gate passes.

## Non-goals

- The python client suite's live boards (CR-CRU-262).
- Changing any route's behaviour or the client contract.
- New tests that test the tests (user ruling 2026-11-18).
