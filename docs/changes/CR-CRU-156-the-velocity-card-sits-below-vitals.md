# CR-CRU-156 — the Velocity card sits below Vitals

**Type** fix · **Points** 1 (planning game 2026-09-27) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-09-27, gap analysis locked 2026-09-27

## Problem

**User defect (2026-09-27):** in the workspace's Project pane, the Velocity card should come after
the Vitals card. Today `ProjectPane` (`public/app.js`) renders, top to bottom: the Project card,
`VelocityCard()`, the agent rows, then `VitalsRail()`. Velocity sits between the Project card and
the agents, above Vitals.

## Gap analysis (2026-09-27)

- **One pane at every band.** `Workspace` mounts one `ProjectPane()`. The phone sheet, the tablet
  stack and the relocated project band (CR-CRU-018) move that one element with CSS; no rule in
  `public/styles.css` sets `order:` on the pane's children. So the DOM order is the order at every
  band, and one assertion covers all of them.
- **Nothing pins today's order.** No test reads the Velocity card's position (`project-velocity`,
  `velocity-bars` and `velocity-flow` are asserted for content only). The phone band's velocity on
  the foot strip (`project-band-velocity`) is a separate element and is untouched.
- **Spacing follows for free.** Velocity and Vitals are both `app-rail-section`; the existing
  `.app-rail-section + .app-rail-section` rule puts the same 16px gap between them.
- **The collapsed rail's label** reads `Project · Vitals`, the pane's two *named* sections
  (`VelocityCard`'s own comment: its heading is deliberately not a `pane-section-title` handle). It
  stays as it is.
- **The storyboard.** F16's mock Project pane draws the Project card then Velocity, with no Vitals.
  **F18 §1** (drawn 2026-09-27, before RED) is the visual contract for the new order.
- **Cost.** 1 point holds: a reorder, a comment and one test.

## Scope

### §S1 — the pane's order

`ProjectPane` renders the Project card, the agent rows, Vitals (`VitalsRail`), then Velocity
(`VelocityCard`). The comment above `ProjectPane` names the new order. Nothing else about either card
changes: content, reads, and behaviour at every band.

## Acceptance criteria

- [ ] **AC1** — In the workspace Project pane, `vitals-rail` precedes `project-velocity` in document
      order, and the agent rows precede both, asserted on the rendered DOM.
- [ ] **AC2** — Every existing Project-pane, velocity and responsive-band test passes unchanged.
- [ ] **AC3** — The live pane matches storyboard **F18 §1** (Project card, agents, Vitals, Velocity),
      checked in a real browser at VERIFY.

## Cycles

C1 RED → GREEN (AC1, AC2); C2 VERIFY.
