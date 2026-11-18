# CR-CRU-264 — a bun route test reaches the board in process

**Status:** PENDING · filed 2026-11-18 (release fix; split from CR-CRU-262 at its gap analysis — user rulings
2026-11-18: the bun suite is its own CR; `src/server.ts` exports the board's request router, with no behaviour change)
**Type:** fix
**Points:** 8
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-262
**Labels:** tests, server, release
**Design reference:** `test-reports/work/cr262-gap-analysis.md` (the bun baseline); `startServer` and `handleV2` in
`src/server.ts` / `src/v2.ts`; the bun helpers `tests/helpers/run-stream-harness.ts`, `server-limits-fixture.ts`,
`served-app.ts`; the test pyramid; D1 (unit = no process, no socket)

## Problem

At `9aec9a5c`, 193 bun test files boot the real server in-process with `startServer` (a scratch store and a loopback
socket), directly or through three helpers (`run-stream-harness.ts` with 56 users, `server-limits-fixture.ts` 23,
`served-app.ts` 8). 143 of them only call HTTP routes — no SSE stream, no spawned process, no browser, no timer, no
listener or boot assertion — so the socket is incidental, and every one of them sits in `tests/integration/`. The
route handler cannot be called without the socket: `startServer` builds the whole router (`/api/health`,
`/api/stream`, `/api/v2/*` through `handleV2`, the 404 JSON, the static SPA) inline inside `Bun.serve`, and nothing
exports it.

## Design

- **The router is exported.** `src/server.ts` exports a board object — its store, a `fetch(req)` that is exactly the
  router `Bun.serve` runs today, and `stop()` — and `startServer` builds it and wraps its `fetch` in `Bun.serve`. No
  behaviour change: every route, header, body limit check and error path is the same code; `startServer`'s handle and
  boot disclosures are unchanged.
- **Route tests call it with no socket.** A test that only calls routes builds the board on a scratch store and sends
  `Request`s to its `fetch`, with no `Bun.serve`, no port and no `fetch` over the network. The three helpers are
  converted first (converting a helper converts its users); the remaining route-only files are rewritten mechanically
  (the base URL and the fetch callee), keeping their test names and assertions.
- **What keeps `startServer`.** A test of the listener, the SSE stream over a real connection, the boot path, the body
  size limit as `Bun.serve` enforces it, or a spawned client talking to the board keeps `startServer` and stays in
  `tests/integration/`.
- **Tier follows.** A converted file moves to `tests/unit/` when, measured, it no longer takes a socket, a process or a
  real wait (CR-CRU-261's rule); otherwise it stays in `tests/integration/`.

## Acceptance criteria

- [ ] **AC1 — one router.** `src/server.ts` exports the board's request router; `startServer` serves exactly that
  router; the existing server, health, listener and SSE tests pass unchanged.
- [ ] **AC2 — sparing.** At most 38 bun files call `startServer` (a quarter of the 2026-11-15 baseline); each remaining
  one tests the listener, the SSE stream, the boot path, the body limit or a spawned client.
- [ ] **AC3 — nothing lost.** Every converted test runs under its name, passes, and asserts what it did.
- [ ] **AC4 — the pyramid is measured (orchestrator check).** The bun census re-run after the change reports the class
  counts per file, recorded in the close-out; the converted files that took no socket, process or wait are in
  `tests/unit/`, and a hermetic run of `tests/unit/` alone records no event.
- [ ] **AC5 — suites green.** Both suites and the e2e suite pass; the pre-merge gate passes.

## Non-goals

- The python client suite's live boards (CR-CRU-262).
- Changing any route's behaviour or the client contract.
- New tests that test the tests (user ruling 2026-11-18).
