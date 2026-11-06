# CR-CRU-234 — an agent's card keeps a long running file inside it

**Type** fix · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING · Pre-review: none — no
trigger
- **Filed 2026-11-06** by user ruling, as a bug fix in the current wave sequenced after CR-CRU-202, from a defect the
  user has been seeing on the dashboard: in the project pane, a streaming agent's card runs a long test path out past
  its right edge.
- **Gap analysis 2026-11-07** (user rulings): the cut is visual only; the layout is checked at three screen sizes in
  three densities; re-scored 2 → 3 because every layout claim needs a real browser across that matrix.
- **Widened 2026-11-07 at the pre-merge gate** (user ruling): the new feature is the suite's first Scenario Outline,
  and the board's own check that a real e2e drive reaches the board reads no outline (§S5, AC8); re-scored 3 → 5.

## Problem

- **The line runs out of the card.** While an agent's run streams, its card in the project pane reads
  `running <done>/<total> · <current file>`. A long path has no break point, so the line runs past the card's right
  edge, is cut by the pane, and the pane gains a horizontal scrollbar. Seen on the DEV board on 2026-11-06, with the
  card of a GREEN agent reading `running 1516/1943 · tests/client/test_mvn_exits_and_files_on_its_runners_exit…`.
- **Why.** The card's message line (`.app-agent-msg`) sets no wrapping or clipping, and the live line is one text run,
  so the count and the file cannot be treated apart.
- **The part lost is the useful one.** The end of a path (its file name) tells two files apart; the start
  (`tests/client/`) is mostly shared.

## Design

- **§S1 — the count stays, the file is cut from its start** (user ruling 2026-11-06). The streaming card's live line
  shows `running <done>/<total>` whole, always; the current file fills the rest of the line and, when it does not fit,
  loses characters from its start behind a leading `…`, so its end (the file name) stays visible. The line stays one
  line, inside the card, at every pane width and density. The project pane has no resizer, so its widths are the
  board's three screen bands (phone, tablet, desktop); its densities are comfortable, compact and ultra.
- **§S1a — the cut is visual only** (user ruling 2026-11-07). The line's text stays `running <done>/<total> ·
  <current file>` with the whole path, whether or not the file is cut on screen; only what is drawn loses the path's
  start. The path's characters keep their order on screen: a `/` or `.` is never moved to the other end of the path by
  the cut.
- **§S2 — the whole path on hover.** The cut file carries its full path as its hover title, so nothing is lost.
- **§S3 — no line of the card runs out of it.** The card's other lines (the agent's id, its message, its idle line)
  wrap inside the card rather than run past it when they hold a token too long for the line.
- **§S4 — nothing else changes:** what the card reads (the live line's text, the message, the idle line), the line
  for a path that fits, the streaming highlight, and the Runs tab's running card.
- **§S5 — the suite's drive check reads a Scenario Outline** (user ruling 2026-11-07). The check that a real client
  drive of the e2e suite reaches the board reads the feature files as its expectation, and today knows only
  `Scenario:`; an outline's example is "declared by no feature file", and an outline's steps are counted to the
  scenario above it. The board's storing stays as it is: the Playwright reporter names a test's suite by its whole
  describe chain, so an outline's examples are tests under the suite `<feature> › <outline title>`, each named by its
  example's title. The check expands each outline's Examples rows into its scenarios — the title and step lines with
  each row's values put in for their `<name>` — and expects each under that suite, with its steps, in order. A plain
  scenario is expected as before.

## Acceptance criteria

- [ ] **AC1 (§S1, §S1a — in a real browser).** A streaming agent's card whose current file is longer than the card,
  at each of the three screen bands in each of the three densities: `running N/M` is drawn in full; the file's last
  character is drawn inside the card and its first characters are not; a `…` is drawn at the file's left edge; the
  path's characters are drawn in their own order; the line is one line inside the card, and the project pane has no
  horizontal overflow.
- [ ] **AC2 (§S1, §S1a, §S4).** The line's text is `running N/M · <whole current file>` for a file that is cut and for
  one that fits; a file that fits is drawn whole, with no `…`.
- [ ] **AC3 (§S2).** The file part's hover title is the full current file.
- [ ] **AC4 (§S3 — in a real browser).** A card whose agent id, message or idle line holds one very long token keeps
  it inside the card, and the project pane has no horizontal overflow.
- [ ] **AC5 (BDD).** A new e2e feature opens a project's board, opens a run against the real board for an agent,
  posts a stream batch whose current file is a long path, and checks AC1 across the three bands and three densities
  (a scenario outline), AC3's title, and AC4 for an agent whose message is one long token.
- [ ] **AC6 (§S4).** Every existing test passes unchanged, except the drive check §S5 changes.
- [ ] **AC8 (§S5).** The drive check, with the suite holding outlines: every example of every outline is found under
  `<feature> › <outline title>` by its filled-in title, with its filled-in steps by name and status in order; no stored
  test is "declared by no feature file"; a plain scenario after an outline holds only its own steps. Its reader is
  pinned on its own by a fixture feature file holding an outline with two Examples rows beside a plain scenario.
- [ ] **AC7 (VERIFY findings, user ruling 2026-11-07).** The comment over the card's live line describes what it
  returns now (the line's parts, or nothing). The namespace tripwire test's prose names the streaming highlight's
  keyframes block by its name, not by a `styles.css` line number; the test's checks are unchanged.

## Non-goals

- The Runs tab's running card, which already cuts its file at the end inside its own line.
- What the live line says, and when it shows.
