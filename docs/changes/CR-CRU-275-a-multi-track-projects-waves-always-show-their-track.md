# CR-CRU-275: a multi-track project's waves always show their track

**Status:** PENDING. Filed 2026-11-24 on a CReq from Parti; the user took it into 0.5.0 wave 9, right after
CR-CRU-269, with Parti's optional no-track warning included.
**Type:** feature
**Points:** 3
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** ui, roadmap, lanes
**Design reference:** CR-CRU-085 (the wave's track lanes; AC2/AC6 the flat list, §S3/AC9 the implicit solo lane,
AC18a the loose group); CR-CRU-108 (`declaredTracks` in `src/store.ts`, the one rule for which tracks count);
`docs/research/DN-model-b-language.md` ("`track` absent = implicit solo lane").

## Problem

The roadmap decides a wave's lanes from that wave alone. The view model (`public/app-logic.mjs`, the wave box's
lane partition) lanes a wave only when its own CRs declare more than one track. A wave whose CRs all sit on one track
is drawn as a flat list, with no track label. That is the same look as a solo project's implicit solo lane.

In a project that runs several tracks, such a wave reads as Mainline's own work, and Mainline never develops. Parti
runs four tracks, and its owner read its single-track waves that way. Parti merged those waves into neighbouring ones
as a workaround, though a wave may rightly hold one track (a release's opening chain, a closing hygiene CR).

A CR that declares no track in such a project falls to Mainline, and the roadmap gives no sign of it.

## Behaviour

### S1: a multi-track project lanes every wave

A project is **multi-track** when the tracks its whole queue declares, counted by `declaredTracks`, number more than
one. That is the same count `next` uses for "this project declares more than one lane". The roadmap keeps no second
rule for it.

In a multi-track project, every wave box publishes a lane for each track its own CRs declare. A wave whose CRs declare
one track publishes one lane, and its body draws the lane grid with that track's label. Its header carries
`· 1 track`; two or more tracks keep `· N tracks`.

### S2: a solo project is unchanged

In a project whose queue declares one track or none, nothing changes. A wave publishes lanes only when its own CRs
declare more than one track, as today. So CR-CRU-085's AC2/AC6 (flat list, no lane chrome) hold for it.

### S3: a CR with no track is flagged in a multi-track project

In a multi-track project, a roadmap row whose CR declares no track carries a warning marker. The marker reads
`no track`, and its title says the CR falls to Mainline because it has no track.

The row stays where it is drawn today: in a wave's `soloRows`, outside the lane grid, or in the loose group (`wave:
null`), which is still never laned (CR-CRU-085 AC18a). A solo project's rows never carry the marker.

## Acceptance criteria

- [ ] **AC1 (S1).** In a project whose queue declares `track-1` and `track-2`, a wave whose CRs all declare
  `track-1` publishes `lanes` of exactly one entry, `{ track: "track-1", rows: <all the wave's rows> }`, and an empty
  `soloRows`.
- [ ] **AC2 (S1).** Rendered, that wave shows `[data-testid="roadmap-wave-lanes"]` with one lane labelled `track-1`
  that holds all its rows, and the header reads `Wave <n> · 1 track`.
- [ ] **AC3 (S1).** In the same project, a wave whose CRs declare `track-1` and `track-2` still publishes two lanes,
  and its header reads `· 2 tracks`.
- [ ] **AC4 (S2).** In a project whose queue declares only `track-1`, and in one that declares no track, every wave
  publishes no lanes, draws a flat list with no `[data-testid="roadmap-wave-lanes"]`, and its header carries no track
  count.
- [ ] **AC5 (S3).** In a multi-track project, a wave's CR with no track is published in `soloRows`, and its row shows
  a `no track` marker whose title names Mainline. A CR in the loose group with no track shows the same marker, and the
  loose group publishes no lanes.
- [ ] **AC6 (S3).** In a project whose queue declares one track or none, no row shows the `no track` marker.
- [ ] **AC7 (S1).** Whether a project is multi-track is decided from `declaredTracks` over the project's whole queue,
  not from the focused release or wave. A project whose second track appears only in another release is still
  multi-track, so a single-track wave in the focused release is laned.
- [ ] **AC8 (wiring).** The wave box's lane partition in `public/app-logic.mjs` receives the project's declared
  tracks from the data the roadmap already loads, and the renderer in `public/app.js` draws the lanes and the marker
  from what that partition publishes. VERIFY confirms the call path.

## Non-goals

- No change to `next`, `queue` or any client: the warning is on the roadmap only.
- No change to how a track is stored or normalised (`normalizeTrack`).
- The loose group stays unlaned.
