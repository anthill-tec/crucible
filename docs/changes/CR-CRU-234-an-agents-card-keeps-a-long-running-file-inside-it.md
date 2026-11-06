# CR-CRU-234 — an agent's card keeps a long running file inside it

**Type** fix · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING · Pre-review: none — no
trigger
- **Filed 2026-11-06** by user ruling, as a bug fix in the current wave sequenced after CR-CRU-202, from a defect the
  user has been seeing on the dashboard: in the project pane, a streaming agent's card runs a long test path out past
  its right edge.

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
  line, inside the card, at every pane width and density.
- **§S2 — the whole path on hover.** The cut file carries its full path as its hover title, so nothing is lost.
- **§S3 — no line of the card runs out of it.** The card's other lines (the agent's id, its message, its idle line)
  wrap inside the card rather than run past it when they hold a token too long for the line.
- **§S4 — nothing else changes:** what the card reads (the live line's text, the message, the idle line), the line
  for a path that fits, the streaming highlight, and the Runs tab's running card.

## Acceptance criteria

- [ ] **AC1 (§S1).** A streaming agent's card whose current file is longer than the card shows `running N/M` in full
  and the file's end (its file name) visible behind a leading `…`; the line does not run past the card and the
  project pane has no horizontal overflow, in each of the board's densities.
- [ ] **AC2 (§S1, §S4).** A current file that fits is shown whole, with no `…`; the line's text is unchanged.
- [ ] **AC3 (§S2).** The file part's hover title is the full current file.
- [ ] **AC4 (§S3).** A card whose agent id, message or idle line holds one very long token keeps it inside the card.
- [ ] **AC5 (BDD).** A new e2e feature opens a project's board, opens a run against the real board for an agent,
  posts a stream batch whose current file is a long path, and checks in the browser that the card's live line keeps
  the count, ends in the file name, has the full path as its title, and stays within the card with no horizontal
  overflow of the pane.
- [ ] **AC6 (§S4).** Every existing test passes unchanged.

## Non-goals

- The Runs tab's running card, which already cuts its file at the end inside its own line.
- What the live line says, and when it shows.
