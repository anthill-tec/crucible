# CR-CRU-122 — a loading delay deserves a spinner

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** feature
**Priority:** P3
**Depends on:** none
**Labels:** feature, ui, ux
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** none — a UX gap found live, not derived from an existing PRD/DN section

## Context

User-reported 2026-09-12: clicking a run mid-flight showed nothing (by design — `RunningCard` has
no `onclick`, confirmed correct behavior), but the moment right after — while `RunDetailBody`'s own
fetch (`GET /api/v2/events/:id?depth=suites`) is in flight — the only feedback is plain text,
`"loading run detail…"` (`app.js:5462`). The user's read: **the current load-time wait messages
don't show the correct picture; a dedicated circling animation should show data is loading, and it
should be used everywhere a loading delay comes from backend processing**, not only this one place.

**Audited every async fetch in `public/app.js` for its current feedback (2026-09-12):**

| site | trigger | current feedback |
|---|---|---|
| `RunDetailBody`'s initial fetch (`app.js:4807-4827`) | opening a run's drill-in | plain text, `"loading run detail…"` |
| `loadSuite` (`app.js:4832-4842`), triggered by a suite row's own toggle | expanding a collapsed suite | **none** — the row just sits at ▸ until leaves arrive |
| `loadSuite` again, triggered by `SynthHeatCell`'s click (`app.js:5009-5021`) | clicking a synthetic (unloaded) heat cell | **none** — same fetch, same silence |
| `postProjectLifecycle` (`app.js:1544-1556`) | confirming project archive/unarchive | **none** — the row sits inert during the POST |
| `save` (`app.js:1636-1672`), the project-settings edit form | saving project settings | **none** — the form sits inert during the PATCH, and nothing stops a second click mid-save |
| `submit` (`app.js:1865-1876`), the add-project form | adding a new project | **none** — same silence, same missing double-submit guard |

**Deliberately excluded** (confirmed with the user before scoping): `refetchCore`'s 5s background
poll and `watchdogTick`'s health check — neither is a user-initiated wait, and a spinner firing
every 5s would be noise, not signal. The CR-CRU-032/120 anchor-fetch (`anchorFetchRuns`) is also
excluded — it already has dedicated UX (scroll + locate-blink on success, explicit feedback text on
a confirmed-pruned failure) and typically resolves in well under 200ms (a 30×5ms retry budget plus
at most one fetch), so a spinner there risks a visible flash for something that is usually
instantaneous.

**No spinner component exists today.** The one established loading-style animation in the codebase
is `app-run-pulse` (`styles.css:1096-1100`, a border-color pulse on `RunningCard` — CR-CRU-017 §S3),
which is the right precedent to follow (a small, semantic CSS `@keyframes` rule, applied via a
class), not a pattern to reuse directly (it signals "this is happening live", not "wait, this is
loading").

## Scope

### §S1 One shared `Spinner` component and its CSS

A new `Spinner()` component (`data-testid="spinner"`, class `app-spinner`) and a matching CSS rule:
a small rotating ring via `@keyframes app-spin` (border-based, matching this codebase's existing
lightweight-animation convention — no new dependency, no SVG asset). Rendered inline wherever a
loading state below is `true`.

### §S2 Run detail's initial load gets the spinner

`RunDetailBody`'s loading branch (`app.js:5461-5462`) renders `Spinner()` in place of the bare text
(a caption may remain beside it — the CR does not mandate removing the words "loading run detail",
only that a circling animation accompanies them).

### §S3 Suite lazy-load gets the spinner, from either trigger path

A new per-suite loading flag (`van.state({})`, keyed by suite name — mirrors `suiteLeaves`'s own
shape) is set `true` when `loadSuite(name)` starts and `false` in a `finally` when it settles
(success or error), so it always clears. The suite's own row renders the spinner while its flag is
true — **one spinner per suite, regardless of which of the two call paths triggered the load**
(the row's own toggle, or `SynthHeatCell`'s click): both call the same `loadSuite`, so both are
covered by the same flag with no duplicated wiring.

### §S4 Project-manager actions get the spinner, and a same-action double-submit guard

`postProjectLifecycle`, `save`, and `submit` each gain a local `van.state(false)` pending flag, set
`true` before their fetch and reset in a `finally`. While `true`: the triggering control renders the
spinner (beside or in place of its label — implementation's choice, consistent within the file) and
is disabled, closing the double-submit gap this audit also found (nothing today stops a second
"confirm archive"/"save"/"add" click from firing a second in-flight request).

### Implementation note (2026-09-12, RED, cycle 430)

§S4's "the triggering control renders the spinner and is disabled until the fetch settles" is
unsatisfiable for two of the three actions as they stand, because each dismisses its own control
BEFORE its request returns:

- `manager-archive-confirm`'s onclick sets `managerArchivePending.val = null` first
  (`public/app.js:1588`), so the confirm control unmounts while the POST is still in flight.
- `save` sets `editing.val = false` before the PATCH settles (`public/app.js:1670`).

Both resets therefore MOVE into the settle path: the confirm control and the edit form stay mounted
— disabled and spinning — until their request completes. This is a real, intended behaviour change
beyond adding an animation (the UI stops dismissing optimistically), and it is what makes the
double-submit guard bite at all: a control that has already unmounted cannot refuse a second click.
VERIFY should read it as in-scope, not as scope creep.

Two further RED decisions, recorded so they are not re-litigated: §S3's `finally` requirement is
pinned STRUCTURALLY (whatever state `loadSuite` sets before its `try` must be re-assigned inside its
`finally`) because the DOM cannot distinguish a stuck flag from a correct reset — `loadSuite`'s
`catch` replaces the whole subtree with its error line either way; and the `disabled` assertion is
on the real `HTMLButtonElement.disabled` property, not `aria-disabled` or a class, because only a
genuinely disabled control suppresses the second click.

## Acceptance criteria

**§S1**
- [ ] `Spinner()` renders one DOM node with `data-testid="spinner"` and class `app-spinner`; the CSS
      rule `@keyframes app-spin` exists in `styles.css` and `.app-spinner` references it.
- [ ] The spinner is a single shared component (one function, one CSS rule) — asserted by grepping
      for exactly one `Spinner(` definition and confirming every site in §S2-§S4 calls it, never a
      per-site reimplementation.

**§S2**
- [ ] Mounting a run's drill-in before its fetch resolves renders `[data-testid="spinner"]`; once the
      fetch resolves (mocked), the spinner is gone and the suite tree renders in its place.

**§S3**
- [ ] Clicking a collapsed suite's own toggle renders `[data-testid="spinner"]` on that suite's row
      until its fetch resolves (mocked with a controllable delay), then the spinner is replaced by
      the loaded leaves.
- [ ] Clicking a `SynthHeatCell` for the SAME suite produces the identical spinner on the identical
      row — asserted by triggering both paths in separate test runs and confirming the same
      `data-testid`/class appears at the same row location.
- [ ] The per-suite flag clears on a FAILED fetch too (mocked rejection) — the spinner disappears and
      the existing error-surfacing behavior (whatever `loadSuite`'s catch does today) still fires;
      regression pin so a `finally` is used, not a bare success-path reset.
- [ ] Two different suites loading concurrently show independent spinners — one suite's fetch
      resolving does not clear the other's.

**§S4**
- [ ] Confirming archive/unarchive renders the spinner on the triggering control and disables it
      until the fetch settles; a second click on the disabled control fires no second request
      (asserted by mocking a slow fetch and counting calls).
- [ ] Clicking "save" in the project-settings edit form renders the spinner and disables the save
      control until the PATCH settles; a second click during that window fires no second PATCH.
- [ ] Clicking "add" in the add-project form renders the spinner and disables the add control until
      the POST settles; a second click during that window fires no second POST.
- [ ] All three flags reset on a FAILED fetch too (mocked rejection/network error) — the control
      re-enables and the spinner clears, matching each function's existing `catch`-and-continue
      behavior (none of the three today surfaces a failure to the user beyond staying silent — this
      CR does not change that; it only ensures the spinner/disable never gets stuck on).

## Estimated size

S — one cycle. One new component + one CSS rule, wired at 6 call sites via 4 new local loading flags
(one shared for suite loading, three local to their own forms/rows).

## Risk

- **Stuck-spinner risk is the one real failure mode**, and every AC above pairs a success case with
  a failure case specifically to guard against it — a flag set in a `try` and cleared only on the
  happy path is the textbook way to ship a permanently-spinning control.
- Low blast radius: no server change, no new dependency, touches only rendering code and CSS.

## Non-goals

- The CR-CRU-032/120 anchor-fetch flow — explicitly excluded per the design reference above.
- The 5s background poll (`refetchCore`) and the health-check watchdog — not user-initiated waits.
- Surfacing a NEW failure message where none exists today (the three project-manager actions
  currently swallow fetch errors silently) — this CR only ensures the spinner/disable state doesn't
  outlive the fetch; adding user-visible error surfacing to those three actions is a separate,
  larger UX decision outside this CR's scope.
- Any change to `RunningCard`'s deliberate non-clickability while a run is genuinely in progress —
  confirmed correct behavior, unrelated to this CR's subject.
