# CR-CRU-097 — project independence is claimed but never asserted

- **Type**: patch
- **Wave**: 5 (0.2.0) — one leak is a user-visible string in a shipped surface. Release membership
  is the user's call.
- **Depends on**: none — every change is local to a string, a help line, or a fixture.
- **Status**: COMPLETED (0.2.0) — filed 2026-09-02, shipped 2026-09-03
- **Found by**: the user, on reading CR-CRU-096's gap analysis. The analysis had reported the
  AC fixtures as *stale* (they decay on every merge) and filed that as a spec-update. The user
  named the actual defect: a project-INDEPENDENT product cannot take the dogfood project's backlog
  as its contract. Decay was the symptom; coupling is the disease.

## Problem

Crucible is developed to run against any project. Nothing enforces that, so our own CR namespace
has leaked into three surfaces — one of them user-visible.

### §S1 — the UI names our backlog to every project

`public/app.js:2354`, the BDD pane's empty state, renders verbatim:

```
BDD run results already stream into the Runs timeline —
the dedicated BDD surface lands in CR-CRU-015 (0.2.0)
```

Any project running Crucible is told about *our* unshipped CR and *our* release number. The
information is true of Crucible-the-project and meaningless — actively confusing — on any other
board. An empty state may say the surface is not built yet; it may not cite the builder's backlog.

**And it is not even true of Crucible.** `CR-CRU-015` is `PENDING`, **wave 6 (post-0.2.0)**
(`docs/changes/README.md:74`), and the PRD calls the BDD harness a *"later wave"*
(`docs/research/PRD-crucible-v2.md:409`). The string promises a release the plan does not hold, so
it is wrong on EVERY board rather than merely irrelevant on other ones. This is the second reason
an empty state may not cite a backlog: a plan moves, and a string does not move with it.

### §S2 — the CLI teaches our id namespace

`--cr` help reads `CR id, e.g. CR-CRU-008.` in **four** of the five clients
(`arduino-crucible.py:1079`, `bun-crucible.py:1963`, `mvn-crucible.py:1896`,
`python-crucible.py:1352`). A CR id is a free-text key the caller owns; the example tells every
user their ids should look like ours. `CR-<PROJECT>-<n>` is not a format Crucible validates, so the
example is not even documenting a constraint.

**The fifth client leaks a DIFFERENT project's namespace.** `rust-crucible.py:2413` reads
`CR id, e.g. CR-NAI-203.` — so the defect class is not "our ids" but "some real project's ids", and
a criterion naming the `CR-CRU-` literal would have shipped green over it. The rule is therefore
stated namespace-agnostically throughout (§S4, AC2, AC7): a help line teaches the SHAPE of a
caller-owned key, so it may not carry any project's actual namespace.

**Re-measured 2026-09-03 by DRIVING every verb's `--help`, not by grepping for the example
string — and `--cr` is a small fraction of it.** The gap analysis looked for `CR id, e.g.` and so
found one help line per client; enumerating what the CLI actually PRINTS finds **21
(client, verb) surfaces leaking 13 distinct real CR ids across FIVE namespaces**:

| leaked id | printed by |
| --- | --- |
| `CR-CRU-054` | `register` + `unregister` help — bun, mvn, python, rust |
| `CR-CRU-086` | `milestone` help (`--crs`/`--repair-provenance`) — **all five** |
| `CR-CRU-017` | `test`, `regression`, `pre-merge-gate` help — bun |
| `CR-CRU-008`, `CR-CRU-044`, `CR-SAN-013` | bun root help |
| `CR-CRU-030`, `CR-CRU-044`, `CR-CRU-056`, `CR-SAN-001` | python root help |
| `CR-ES-12`, `CR-SU-8` | mvn root help |
| `CR-NAI-203`, `CR-NAI-305` | rust root help, `pre-merge-gate` help |

Most are **provenance citations that happen to sit inside a `help=` string** rather than beside it
in a comment — `"… the repair is REFUSED (§S4, CR-CRU-086 §S2)."` is printed to every user of every
project. §S6 exempts provenance in **comments and docstrings**; text that argparse RENDERS is not a
comment, and the exemption does not reach it. The remedy keeps the rule and moves the citation: the
help states the behaviour, the adjacent code comment carries the lineage.

**A DOCSTRING IS NOT EXEMPT WHEN IT IS RENDERED — found in C3, and it is why four root surfaces
leaked nine ids at once.** `bun`, `mvn`, `python` and `rust` build their parser with
`description=__doc__`: the module docstring **IS** the root `--help`. §S6's exemption assumed a
docstring is a maintainer artefact that no user reads, and for these four it was the primary
user-facing text. The remedy preserves both: the docstring stays **byte-identical** (AC8 intact,
and it is the file's design record) and argparse is given a dedicated `_CLI_DESCRIPTION` that states
behaviour. `arduino` needed no change — it already passed a short literal. The general rule: the
exemption follows the **rendering**, never the syntax. A comment or docstring is exempt because
nobody renders it; the moment it is passed to a renderer it is a user-visible string.

**The classifier must not treat `//` inside a STRING as a comment (VERIFY, 2026-09-03).** The
lifted `extractCitableText`'s TS/JS branch extracts line comments with `/\/\/[^\n]*/g` over the raw
file, so it cannot tell a comment from a `//` inside a string literal. Proved as a pure function:
`extractCitableText("public/probe.js", 'const u = "http://board/CR-QQQ-9";')` returns `CR-QQQ-9`
as PROSE — so a shipped UI string carrying a URL beside a CR id is classified as provenance and
dropped from every tripwire dimension, since AC3 and AC7 both filter on `!isProse`. A regex
literal (`/a\/\//`) behaves the same. Nothing is red today (`public/` live count is 0), which is
exactly the problem: the CR's durability claim is that a future leak fails **on the day it is
written**, and this whole class — any string containing a URL, path or regex beside a CR id — is
invisible. The self-test did not reach it because it plants the literal in a bare string with the
comment on its own line, the easy case. The branch must respect string literals, and the self-test
must include the URL case.

**Detection subtlety worth keeping.** argparse wraps help text **after a hyphen**, so a leaked id
can arrive as `CR-CRU-` + newline + `086` and a naive per-line regex sees nothing. The check
un-wraps first (`joinWrapped`) and additionally drives every surface with `COLUMNS=200` — two
independent defences, because either alone can be defeated by a terminal width. Denominator matters
too: **21 of 159** driven surfaces leaked, so a spot check of a few verbs would have found nothing.

### §S3 — the regression contract replicates our live board

Three test files build fixtures that are not arbitrary ids but a **snapshot of our own queue**:

| file | `CR-CRU-` refs (at filing) | re-measured 2026-09-03 |
| --- | --- | --- |
| `tests/queue-canonical-order.test.ts` | 63 | **77** |
| `tests/queue-registration.test.ts` | 64 | **80** |
| `tests/queue-default-into-wave-block.test.ts` | 35 | **37** |

The coupling GREW by 32 refs between filing and this re-measurement, added by CR-095's later
cycles — which is the argument for §S6's tripwire rather than a one-time cleanup.

`queue-canonical-order.test.ts` encodes `CR-CRU-015 wave 6 seq 62`, `CR-CRU-090 wave 5 seq 81`,
`CR-CRU-095 seq 5022`, `096 → 5023`, `079 → 5024` — our authored positions, as the expected values.

**The distinction this CR draws, because it is the whole point:**

- A **reproduction** may use real data. CR-095's C1 RED had to reproduce "`next` recommends
  `CR-CRU-015`" — that WAS the reported defect, and a synthetic id would have made the
  reproduction a fiction. This is legitimate and stays.
- A **contract** may not. When the real ids become the asserted expectation, the product's
  guarantee is only true while our backlog holds that shape. CR-096's draft AC10 stated the
  contract as `095, 096, 079, 085, 093`; by the time it was read, 095 had merged and the fixture
  asserted the opposite of its own AC9.

The remedy is not to purge the ids. It is to make the reproduction SAY it is one: a real-board
fixture becomes a named, commented snapshot constant, and the assertions that state the product's
rule run on synthetic rows.

**The convention already exists and is already used** — `CR-A`, `CR-B`, `CR-NEW-5`, `CR-W1-A`,
`CR-AGG-1..5`, `CR-Q-n`, and `roadmap-graph.feature`'s `CR-RG-200`. Sub-agents reached for it
unprompted. Only orchestrator-authored specs and fixtures broke it.

## Scope

### §S4 — the two shipped strings

The empty state states the capability, not the plan: BDD results stream into the Runs timeline and
a dedicated surface does not exist yet. The `--cr` help example becomes namespace-neutral.

### §S5 — the board-replica fixtures

Per file: assertions that state a RULE move to synthetic rows; rows that exist to REPRODUCE a real
defect move into one named constant per file, commented with the board and **the date the snapshot
was taken** — not "the current board", which is a claim that expires — so a reader can tell a
reproduction from a requirement at a glance.

**The decay is no longer hypothetical; it happened while this CR sat in the queue.**
`queue-canonical-order.test.ts` pins `079→5024, 085→5025, 093→5026, 075→5027, 094→5028`. After
CR-CRU-097/099/100 were sequenced into wave 5 on 2026-09-03 the live board reads
`079→5027, 085→5028, 093→5029, 075→5030, 094→5031` — **five of nine pinned positions now
diverge, and every test still passes**, because the fixtures are self-contained. That is the exact
failure mode: the coupling does not announce itself with a red test, it silently turns a stated
contract into a description of a board that no longer exists.

### §S6 — a tripwire, so this cannot return silently

A test asserts that no project-namespace CR literal appears in a user-visible string or a CLI help
line in `public/` or `clients/`, and that no test file outside a named snapshot constant asserts on
one. Provenance comments and docstrings are exempt: they are how this codebase records design
lineage (CR-CRU-030, CR-CRU-056 and dozens more), and stripping them would destroy the record. The
tripwire targets **behaviour and contract**, never provenance.

**This EXTENDS an existing mechanism; it does not add a scanner.**
`tests/docs-retired-mirror-references.test.ts` already walks the tree with the right exclusions
(`:106-110` skips `__pycache__`, `node_modules`, `.git`) and already draws the comment-vs-text line
this tripwire needs: **`extractCitableText(relPath, text)` (`:463`)** handles Python docstrings and
TS comments and carries the carve-out concept. It is currently **file-local and not exported**, so
this CR lifts it into a shared test helper and consumes it — that lift is part of the work, not a
free assumption.

Writing a third comment stripper is specifically what to avoid: CR-CRU-096's C1 FIX round exists
because a hand-rolled one (`animatingSelectors`) never stripped comments, so a provenance comment
leaked into a selector string and a test asserted on it. A tripwire whose whole correctness rests
on "comments are exempt" must reuse the classifier that is already proven, not re-derive it.

## Acceptance criteria

- **AC1** — The BDD empty state names no CR and no release version; it states the capability and
  that the dedicated surface does not exist yet.
- **AC1b** — **No test asserts the removed string as a REQUIREMENT.**
  `tests/storyboard-fidelity.test.ts:1062-1080` did exactly that: *"BDD tab body text names the real
  landing CR (CR-CRU-015) and never CR-CRU-007"*, asserting `toContain("CR-CRU-015")` on the
  rendered body. It enshrined the coupling as the product contract, so AC1 could not be satisfied
  without it going red — and it did, in the full gate, after three cycles had passed.

  Its original defect (2026-07-15) was the tab naming the **wrong** CR (007 instead of 015), so its
  real content was "names the right thing, not a stale wrong thing". Post-AC1 the right thing is
  **no CR at all**, which `tests/project-independence-strings.test.ts` now asserts positively. The
  assertion is therefore **superseded, not deleted for convenience**, and is retired with narration
  naming its successor — the repo's retirement convention, which
  `tests/docs-retired-mirror-references.test.ts` enforces.

  **Lineage of the miss:** my gap analysis ran Dimension 6 ("enumerate ALL consumers") over
  `public/`, `clients/` and §S3's three test files, and never asked *which tests assert on the
  string being removed*. That is the third under-enumeration in this CR — the help surfaces (21,
  not 4), the runtime warning strings (AC3a), and now this. Enumerating a symbol's consumers means
  grepping for the **value**, not only the site.
- **AC2** — **No help string any client PRINTS** names any project's CR namespace — every verb's
  `--help` and each client's root help, not just `--cr`. Stated per-namespace, not per-literal, and
  measured by DRIVING the CLI rather than by grepping for an example: 21 (client, verb) surfaces
  leak 13 ids across five namespaces today (§S2's table). A `§`-citation inside a `help=` string is
  in scope precisely because it is rendered; the exemption in §S6 covers comments and docstrings
  only. Where a citation is load-bearing for a maintainer it moves to the adjacent comment, so the
  lineage survives (AC8) and the user-facing line states behaviour. Verified by DRIVING all
  **159** surfaces (5 root + every verb of every client) at `COLUMNS=200`: zero literals.
- **AC3** — No user-visible string in `public/` contains a `CR-CRU-` literal. (Comments exempt.)
- **AC3a** — No **runtime string a client emits** names any project's CR namespace: warning
  `detail`, error text and any other envelope prose, across `clients/**` including the shared
  `_crucible_axi.py`. This closes §S6's `clients/` clause, which AC2 (help output) and AC3
  (`public/` strings) between them leave open. Asserted over the classifier's live-code positions,
  so provenance comments and docstrings stay exempt and `.md` stays exempt by kind.
- **AC4** — In each of the **three files §S5 actually rewrote** — `queue-canonical-order.test.ts`,
  `queue-registration.test.ts`, `queue-default-into-wave-block.test.ts` — every assertion that
  states a product RULE runs on synthetic ids, and each is pinned at zero **BY NAME**. The by-name
  pin matters: membership of the generic residue table is a weaker guarantee, because adding an
  entry there would legally re-admit real board ids into a converted file's assertions.
- **AC5** — Rows kept for reproduction live in one named constant per file, commented with the
  source board and the date, and the tests reading it assert the reproduction, not the rule.
- **AC6** — CR-095's reproductions still reproduce: the `next`-recommends-a-deferred-CR case and
  the overlapping-seq case both still fail against pre-095 ordering. **Made observable (VERIFY
  ruled this PARTIAL: it rested on assertion, since "fails against pre-095" is only directly
  visible by reverting the fix).** The testable property is that the fixture is still
  DISCRIMINATING: `BOARD_SNAPSHOT_2026_09_02`'s naive/positional reading must differ from the
  published order it asserts, and the deferred CR must still sort ahead of the active release under
  that naive reading. A fixture whose two readings have converged no longer reproduces anything,
  and would pass for the wrong reason.
- **AC7** — The tripwire is **namespace-agnostic** (`CR-[A-Z]{2,}-\d+`, not `CR-CRU-`) and fails
  when such a literal is introduced into a user-visible string, a CLI help line, or an assertion
  outside a snapshot constant; it passes on provenance comments and docstrings. It consumes the
  lifted `extractCitableText` (§S6) rather than a new comment stripper.
- **AC7a** — The four files holding another project's ids as fixtures — `tests/f13-fidelity.test.ts`
  (21 `CR-NAI-` refs), `tests/milestone-merge-rows.test.ts` (18),
  `tests/gate-milestone-server.test.ts` (10), `tests/client/test_bun_crucible_gates.py` (4) — are
  carved out **by name, with the reason in the carve-out itself**, never by a regex that quietly
  excludes them. An implicit exclusion is indistinguishable from a gap in the tripwire.
- **AC8** — Provenance is intact, **stated reproducibly** (VERIFY found it was not). The quantity
  is the count of `/CR-[A-Z]{2,}-\d+/` matches — the same namespace-agnostic pattern AC7 uses, NOT
  `CR-CRU-` — in the prose positions `extractCitableText` reports, over `src/`, `public/` and
  `clients/`, excluding `__pycache__`. Both numbers are recorded: the baseline at `develop` and the
  value at HEAD, because C3 legitimately ADDS provenance comments (citing CR-CRU-054 and CR-CRU-097)
  and a single figure cannot be both.

  **MEASURED 2026-09-03 in C4, with the classifier, namespace-agnostic** — `src/` / `public/` /
  `clients/`: `develop` **512 / 378 / 601**, HEAD **512 / 379 / 619**. Only the HEAD triple is
  ASSERTED. The `develop` triple is recorded in the test as a comment with the command that
  produced it (`git ls-tree -r develop` + `git show develop:<path>`, classified file by file),
  because asserting it live would rot the instant this branch merges: `develop` would then BE this
  tree and the "baseline" would silently become the HEAD figure — the exact class of
  self-satisfying assertion this CR exists to remove.

  `clients/` moved **615 → 619** in C4: AC3a's two runtime strings lost their citations to their
  adjacent comments, and each move also carries a C4 citation, so lineage GREW. Under
  `/CR-CRU-\d+/` instead, `clients/` is `develop` **588** and HEAD **605** (615 → 601 pre-C4). Note
  the collision, because it is what made the mis-measurement plausible: `develop`'s
  namespace-agnostic `clients/` count is **601** — the very number this AC once reported as HEAD's
  `CR-CRU-`-only count. Two different measurements of two different trees coincided. The extra 14
  agnostic-vs-`CR-CRU-` references are `CR-NAI-*`/`CR-SAN-*` provenance, mostly in
  `rust-crucible.py`. `src/` and `public/` reproduce under either pattern because those trees carry
  no foreign namespace — which is why the mismatch was invisible on two of three figures.
  **A test pins this** (`tests/project-namespace-tripwire.test.ts`, the AC8 block); it was
  UNASSERTED, living only in spec prose.
- **AC8-legacy** — the original wording, kept for the record: the count of `CR-CRU-` references in
  comments and docstrings
  across `src/`, `public/` and `clients/` is unchanged by this CR, **measured by the §S6
  `extractCitableText` classifier** (the AC is otherwise unmeasurable — nothing else in the repo
  separates a comment from a string). Baseline measured 2026-09-03, excluding `__pycache__`:
  the classifier itself, post-CR: prose (comments + docstrings) `src/` **512**, `public/` **379**,
  `clients/` **615**. The earlier figures in this AC (517/379/618) were **totals**, not prose counts
  — a mis-specified baseline, corrected here: a criterion about provenance must be measured with the
  provenance classifier, not with a raw grep.

  Two consequences the raw total hid. First, `clients/` legitimately drops 5 raw references, because
  at five sites the citation stood in BOTH the `help=` string and the adjacent comment; deleting the
  rendered copy loses no lineage, and `git diff` confirms every removal is from a `help=` string and
  every addition is a `#` comment. Second, the classifier reports 12 "live-code" references in
  `clients/` that are all in `clients/STATUS-CONTRACT.md`: **markdown has no comment syntax**, so
  documentation prose reads as code to any classifier. `.md` is therefore exempt BY KIND, not by
  pattern. Measured live-code references carrying a CR id: `public/` **0** (AC3) and `src/` **0** quoted — no
  server response string names a CR.

  **CORRECTED 2026-09-03 by VERIFY: there IS a further leaking surface, and this AC previously
  denied it.** Of the 12 live-code `clients/` references, **10** are in `STATUS-CONTRACT.md` and
  **two are live string literals in shipped client code**, emitted to the user at runtime in the
  AXI envelope on any project's board:
  - `clients/bun-crucible.py:889` — the `run-left-open` warning detail: *"POST
    /api/v2/runs/<id>/abort is CR-CRU-017 §S2 and does not exist yet"*. This is §S1's defect
    verbatim, one level deeper: it names OUR unshipped CR to every project.
  - `clients/_crucible_axi.py:1513` — the `missing-seq` warning detail: *"CR-CRU-091 declares one
    on every entry"*. It lives in the SHARED module, so all five clients emit it — the widest
    single leak in this CR.

  I asserted "no fourth leaking surface" after re-deriving only the `src/` half and accepting the
  `clients/` half as reported. §S6 already required this surface ("no `CR-CRU-` literal appears in
  a user-visible string … in `public/` **or `clients/`**") — but the shipped tripwire covers
  `public/` strings (AC3) and `clients/` **help** (AC2), and a runtime message is reached by
  neither. A §S clause with no AC is a wish (CR-CRU-078's lesson); AC3a is that AC.

## Non-goals

- **Validating CR id format.** A CR id is caller-owned free text and stays that way.
- **Purging provenance.** Design lineage in comments is the record; it is exempt by AC8.
- **Renaming our own CRs or board data.** The dogfood board is a real board; that is the point of
  dogfooding.
- **Purging another project's ids from test FIXTURES.** `rust-crucible.py:2413`'s help line is in
  scope (AC2) because a help line teaches. The 53 `CR-NAI-` fixture refs in the four files named in
  AC7a are NOT: they cannot decay the way our own ids do — our board cannot move them, and decay
  through our own authoring is the mechanism §S3 objects to. Churning four otherwise-untouched
  files would also contradict CR-CRU-096's own finding that a REPRODUCTION may use real data. The
  tripwire still covers them namespace-agnostically going forward; today's refs are carved out by
  name so the exemption is visible rather than implied.
- **Auditing the specs in `docs/changes/`.** Those describe Crucible-the-project and may name its
  CRs freely. Only ACs — the product's guarantees — must be synthetic, and CR-096 AC29 states that
  rule for CRs authored from now on.

## Notes

**Every check was green and none of them looked for this.** Gates are green on both stacks, CR-095
ran a four-cycle VERIFY that read the fixtures line by line, and its FIX round amended three of
them — while the coupling was the thing to see. The checks all asked "does the code match the
spec?"; nothing asked "does the spec describe a product, or a project?" Identical shape to CR-096's
own root cause, one level up: there, every check tested the implementation against the spec, and
the spec was what had drifted.

**The orchestrator wrote the coupled fixtures; the sub-agents wrote synthetic ones.** Agents given
"write failing tests for this contract" reached for `CR-A`/`CR-NEW-5` unprompted, because a
contract stated abstractly invites an abstract fixture. The coupled ones came from ACs that handed
them a concrete list to encode. A fixture inherits the abstraction level of the criterion above it.
