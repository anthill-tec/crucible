# CR-CRU-227 — the current v2 API and its SSE stream are documented

**Type** docs · **Points** 3 (to be re-scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on** — · **Status**
PENDING. Filed 2026-10-31, on the user's instruction to document the current API as it is, with no redesign.

## Problem

The board's HTTP API (the routes under `/api/v2`, `/api/health` and the SSE stream `/api/stream`) is described nowhere in
one place. A consumer on another machine has to read `src/v2.ts` and `src/server.ts` to learn:
- the routes;
- their request and response shapes;
- their error codes;
- what an SSE frame carries.

## Design (user instruction 2026-10-31)

- **Document the API as it is.** No route, shape or behaviour changes.
- **One reference document** lists every route, grouped by resource. For each route it gives:
  - its method and path;
  - its request body or query;
  - its success answer;
  - its refusals (status and meaning);
  - the source symbol that handles it.
- **SSE** (`GET /api/stream`) is documented as it is:
  - the `hello` frame;
  - the change frames `{type: "projects" | "agents" | "events", projectKey}`, with what each kind means;
  - the keep-alives;
  - CR-CRU-200's throttled live frames;
  - the fact that consumers re-read the named slice over HTTP.

## Steps

Written at this CR's gap analysis: the document's place and format, and the check that keeps it in step with the router.

## Acceptance criteria

Made exact at the gap analysis. At least:

- [ ] Every route the router dispatches is documented, and a test fails when a route is added or removed without the
      document.
- [ ] The SSE stream's frames are documented as the server sends them.

## Non-goals

- Any change to a route, a shape or the SSE stream.
- A resource redesign, or data-carrying SSE streams.
