# CR-CRU-207 — an ingest is bounded: its body size and the output a run keeps

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152 · **Status** PENDING — filed
2026-10-27 (split from CR-CRU-152 at its gap analysis, user ruling)

## Problem

**Measured 2026-10-27:** the server sets no request body limit, so Bun's default of 128 MiB applies,
and Bun answers a body over it with an empty 413 before the handler runs — no JSON, nothing a client
can name. A handler that refuses without reading the body leaves a Python client writing into a
closed socket: at 200 MB it reports `Broken pipe`, which reads as "board unreachable". The bun
JUnit reports on this disk reach 205 MB and 720 MB (one test name of 130 M characters), and a bun
gate's console log is about 1.6 MB. Today the clients cut failure text before posting; once they
send their runners' reports and output whole (CR-CRU-152, CR-CRU-204, CR-CRU-206), nothing bounds
what an ingest carries or what a run stores.

## Design (user rulings, 2026-10-27)

- **Two configurable limits**, declared like every other server limit.
- **The client refuses first:** health advertises the body limit, and a client does not send a body
  over it.
- **The board drains and refuses:** for any other caller, a body over the limit is read and
  discarded, then refused with a JSON 413 naming the limit. Bun's own limit sits above it.
- **`raw` is stored, capped.**

## Steps

### §S1 — two server limits

`src/crucible.toml` and `src/limits.ts` declare, with the RUNBOOK documenting each:

| Limit | description | recommended | min | max |
|---|---|---|---|---|
| `ingest_body_bytes` | the largest ingest body the server reads | 134217728 (128 MiB, Bun's default the server ran at before) | 1048576 | 1073741824 |
| `raw_output_chars` | the most captured runner output a run stores | 2000000 | 10000 | 50000000 |

`raw_output_chars` had no earlier value: a server with no operator file now caps raw output where it
stored all of it, and the file's header says so. Everything that counts the server's limits counts
five: the comments in `src/limits.ts` and `src/crucible.toml`, the RUNBOOK's prose, PRD §4.13's prose, the limit list
`tests/server-limits-are-configuration.test.ts` pins, and the "all three it owns" test title in
`tests/shipped-limits-ship-as-package-data.test.ts`.

### §S2 — the board refuses an oversized body with JSON

`Bun.serve`'s own `maxRequestBodySize` is fixed at boot to twice `ingest_body_bytes`' declared
`max` (2 GiB), a value the server module exports and passes to `Bun.serve`, so a value an operator sets live, up to that `max`, is always enforced by the
handler rather than by Bun. On `POST /api/v2/runs`, `/api/v2/runs/parsed` and
`/api/v2/runs/compile`, a body whose length passes `ingest_body_bytes` (read live, as every limit
is) — by its `Content-Length`, or by counting as it reads a body sent without one — is read to its
end and discarded, and answered with 413 and
`{ok: false, error}` naming `ingest_body_bytes` and its value; nothing is stored.

**Deliberate:** every other route's body limit is Bun's raised one (2 GiB) where it was 128 MiB; those
routes carry small JSON bodies from registered callers, and bounding them is a non-goal. A stored
run's names and tree are bounded only by `ingest_body_bytes` (failure text is cut by CR-CRU-152);
capping names is a non-goal.

### §S3 — health advertises the limit

Both health routes carry `limits: {ingest_body_bytes: <n>}`, so a client can refuse before sending.
The two tests that pin health's exact shape (`tests/server.test.ts`, `tests/v2-json-only-responses.test.ts`)
gain that key and nothing else, in their own commit (user-approved 2026-10-27).

### §S4 — the stored raw output is capped

A run's raw output (CR-CRU-152 §S1) longer than `raw_output_chars` Unicode code points is stored as
its first `floor(n/2)` code points, then `"\n… <k> characters cut …\n"`, then its last `ceil(n/2)`
code points, where `n` is the limit and `k` the number cut; the marker and its two newlines do not
count against `n`, and no code point is split. A codec reads the whole text before the cap. The parsed route applies
the same cap.

## Acceptance criteria

- [ ] **AC1 — the limits are declared.** Both limits resolve through `src/limits.ts` with §S1's
      values, appear in `src/crucible.toml`, PRD §4.13 and the RUNBOOK (the existing guard that every limit is
      documented passes), and an operator file can set each within its range.
- [ ] **AC2 — a JSON 413, on a real socket.** On each of the three ingest routes, a body over
      `ingest_body_bytes` (set small in the test), sent by Python's `urllib` over a real socket and
      larger than the socket buffers, receives a 413 whose JSON body names `ingest_body_bytes`;
      the same for a body sent chunked, with no `Content-Length`; nothing is stored; a body at the
      limit is accepted. The `maxRequestBodySize` the server passes to `Bun.serve` is 2 GiB, so with
      no operator file (the recommended 128 MiB) the board's own JSON 413 answers before Bun's empty
      one could (user ruling 2026-10-27: asserted on the value, no 128 MiB transfer in the suite).
- [ ] **AC3 — health.** Both health routes carry `limits.ingest_body_bytes` with the resolved value.
- [ ] **AC4 — the cap.** A raw text over a small `raw_output_chars` is stored exactly as §S4 states
      (asserted string, odd and even limits, a text with a surrogate pair at the cut); a text at the
      limit is stored whole; the codec saw the whole text (a bun console detail beyond the cap still
      marries).

## Non-goals

- What a client does with the advertised limit: CR-CRU-204 and CR-CRU-206.
- Bounding the read routes or the other write routes, or capping a stored test name.
