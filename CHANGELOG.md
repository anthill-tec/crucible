# Changelog

All notable changes to Crucible — the `@anthill-tec/crucible-server` npm package and the
`crucible-axi` PyPI package, which are released together under one version — are recorded here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release's section is
also the body of its [GitHub Release](https://github.com/anthill-tec/crucible/releases).
Releases before 0.3.0 are described only on GitHub Releases.

## [Unreleased]

## [0.3.0] - 2026-10-10

38 change requests (wave 7).

### Upgrading

- **The store migrates itself.** The first 0.3.0 boot upgrades a 0.2.x store from schema v13 to
  v20. Before migrating, it writes a recovery copy beside the store,
  `crucible.db.pre-upgrade-<epoch>`. Each step runs in its own transaction, and the boot log
  names the migration and the backup. A store written by a newer build is refused rather than
  touched.
- After upgrading the `crucible-axi` package, run `crucible-axi install` to lay the clients down
  again.

### Added

- **Workflow is two panes: Now and History.**
  - Now shows the work in flight, including a running gate as a live run whose held step reads
    "awaiting your decision".
  - History is told by release, with waves folded inside each release. It shows only the past,
    with a count of what is still pending.
  - A cycle's recorded change sits beneath its line.
- **A gate's decisions are recorded** beneath its step ladder, and a sealed gate summarises them
  in History.
- **Responsive layout.** The phone band is one column with nothing hidden, the tablet band stacks
  the pane while the main column stays, and every tab (Roadmap, Workflow, Runs, Coverage, Compile,
  BDD) reads at both sizes.
- **Analytics.** SCRUM velocity in the Project band, read per day or per week; a release burndown
  that fills its pane and draws the projection; velocity and the forecast follow the release so
  far.
- **BDD.** The tab is an index of runs, with one Gherkin renderer that reads as a specification.
  The e2e suite reaches the board with its scenarios intact.
- **Clients:**
  - `queue --fields` shows each CR's place in the plan, with a `warning` column; `--full` shows
    every column.
  - A new `history` verb, in all five clients, lists releases with their CRs and what is pending.
  - Test runs are filed per cycle with `--cycle`, and release verification under its release with
    `--release`.
  - A project can declare the gate steps it never runs in `crucible.toml` `[gate]`, so `gate-run`
    no longer needs `--skip` on every call.
- **A project carries its own metadata,** mirrored from the project's own settings.

### Changed

- **⚠ The connection is configuration now, not environment.**
  - `$CRUCIBLE_PORT` and `$CRUCIBLE_HOST` are no longer read. The server takes its listener from
    the `[server]` table of the `crucible.toml` beside its database, falling back to the shipped
    default (`127.0.0.1:3849`).
  - The clients no longer read `$CRUCIBLE_URL` (or arduino's `$CRUCIBLE_BASE`). They take the
    board from the project's `crucible.toml` `[client]` table.
  - If you set any of these variables, move the value into the file.
- **`status`** shows the work in flight, not the project's history.
- **Plans** grow only by fix cycles, and a skipped cycle is recorded as a failure.
- **Storage and reads.** A run's detail is stored as rows, not JSON text. A list read loads no
  run's detail, and a plan read is cheap enough that analytics need no cache.
- **Release process.** Every push to a `release/**` or `hotfix/**` branch is the TestPyPI and npm
  dry-run rehearsal (`scripts/release.sh checkpoint` only re-runs one), and a rehearsal is
  versioned as the release it rehearses (`0.3.0.devN`, not `0.2.3.devN`).

### Fixed

- **The board:**
  - The agent card tells the truth about the agent.
  - A heat-strip click brings its test into view.
  - A voided CR's row is struck through and names its state.
  - The phone Compile pane no longer collapses.
  - The history cycle row is clickable where it looks clickable.
  - The Projects manager drawer fits its width, and each setting says what it does.
  - A run's detail stays responsive while agents are running.
- **The clients:**
  - Interrupting `gate-run` (SIGINT/SIGTERM) always removes its run identity from the board, even
    when the signal lands while the identity is still being opened.
  - A closed output pipe (`| head`) no longer leaves a run open.
  - Each test run keeps its reports to itself, and a run nothing will file is closed at once.
- **CI passes on a clean runner again:**
  - the client tests no longer read a developer's configuration;
  - the e2e drive counts the phone feature once per browser engine;
  - the WebKit phone tap is engine-neutral.

[Unreleased]: https://github.com/anthill-tec/crucible/compare/0.3.0...HEAD
[0.3.0]: https://github.com/anthill-tec/crucible/compare/0.2.2...0.3.0
