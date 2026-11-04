# CR-CRU-230 — a project registers itself on the board

**Type** feature · **Points** 5 (PROPOSED; scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING · Pre-review: due
- **Filed 2026-11-04** from Model B's CReq (Sandesh 1517, `Mainline - ModelB`), accepted by user ruling the same day. It
  gets its gap analysis when it comes up in the queue.

## Problem

- **No client verb creates a project.** Every verb works inside a project whose `CRUCIBLE_PROJECT_KEY` is already in
  `.env`, and exits "CRUCIBLE_PROJECT_KEY not found" without one. `register` registers an agent, not a project.
- **The board can already do it.** `POST /api/v2/projects {name, key?, type?, sutRoot?}` (`handleProjectCreate`,
  `src/v2.ts`) creates a project and returns it. It is idempotent only on a given `key`; a second post of the same
  name without a key makes a second project.
- **Model B waits on it.** `modelb-axi init --register` refuses ("live registration is not implemented in scaffold
  v1") until a client verb exists; a new project's key is made by hand (the case now: SoL-Pi).

## Design (the CReq's asks; the choices are settled at the gap analysis)

- **A `project-create` verb on every stack's client**, in the shared module:
  `<stack>-crucible.py project-create --name <display name> --token <token> [--acronym <ACRO>] [--project-dir <root>]`.
  It creates the project and returns `projectKey` in the envelope.
- **Idempotent.** Re-running it for a project that exists returns the existing key, never a duplicate. Open: what the
  project's identity is (token, name, or a key the client mints and keeps) and whether the route changes for it.
- **`--write-env`** writes `CRUCIBLE_PROJECT_KEY` into `<root>/.env` only when the line is empty or missing, and never
  overwrites a key already set.
- **Metadata in the same call.** It takes the registry's non-secret keys the way `project-meta --set` does.
- **Errors are envelopes.** An unreachable or refusing board returns `ok: false` with the reason.
- **Authority.** Open: what creating a project needs, given the caller has no key and so can't register an agent
  first.

## Acceptance criteria

To be written at the gap analysis, one per Design bullet.

## Non-goals

- Model B's `init --register` itself (a Model B CR, once this ships).
- Archiving or deleting a project (existing routes).
