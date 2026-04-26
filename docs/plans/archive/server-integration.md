# Server integration (WS3)

> **Status: delivered.** Phase 1 of the broader server roadmap (positions API + viewer wiring + `--serve` flag). Phases 2–5 (comments, identity/SQLite, real-time, web-triggered generation) remain in [`../future-ideas.md`](../future-ideas.md).
>
> Reference docs: [`../../cli-reference.md#serve-subcommand`](../../cli-reference.md#serve-subcommand), [`../../viewer.md#repositioning-nodes`](../../viewer.md#repositioning-nodes), [`../../viewer.md#hiding-nodes`](../../viewer.md#hiding-nodes). Original plan context in [`webapp-collaboration.md`](webapp-collaboration.md).

## Problem

The cherry-pick from `build-a-server` brought in `src/server.js` (Express + REST endpoints for positions) and a `serve` subcommand, but the wiring was incomplete:

- The viewer had a "Save layout" button but no code to actually call the API
- `__SAVED_POSITIONS__` carry-forward existed but no equivalent for hidden nodes
- No `--serve` flag on the main generate command — users had to run two commands
- WS1's hide state was localStorage-only, with no shared/durable persistence path

For WS1 (node hiding) to graduate from localStorage-only to shared/durable, the server needed a `/hidden` endpoint and the viewer needed server-fallback logic.

## What shipped

**`/hidden` endpoint pair** mirroring `/positions`:
- `GET /api/maps/:name/hidden` — read saved hidden set, returns `{}` on missing/malformed
- `PUT /api/maps/:name/hidden` — validate + persist to `<output>/maps/<name>/hidden.json`
- Validation: `{ [nodeId]: true }` (any non-true value rejects)

**Build-time carry-forward for hidden state.** `src/build-viewer.js` reads `hidden.json` on regenerate, drops entries for node IDs that no longer exist in the graph, embeds the rest as `window.__SAVED_HIDDEN__`. Mirrors the existing `positions.json` → `__SAVED_POSITIONS__` carry-forward.

**Viewer-side server detection + fallback.** `detectServeMode` IIFE on viewer init:
1. `fetch('/api/health')` with 1.5s `AbortController` timeout — file:// loads fail-fast instead of hanging
2. On success: set `isServeMode = true`, show the Save layout button, fetch positions and hidden from API in parallel, re-render if either changed
3. On failure: fall back to localStorage + embedded values

Position-loading priority chain: API > localStorage > embedded > computed. Hidden-loading priority: API > localStorage > embedded.

**Fire-and-forget hidden auto-save.** Every hide / restore action calls `saveHiddenToServer()` in addition to `saveHiddenNodes()` (localStorage). No Save button for hidden state — users expect immediate persistence on hide actions, not a stage-and-commit workflow. Failures log to console; localStorage remains the source of truth on next load until the next successful API write.

**`--serve` flag on the main generate command.** Generation completes → server starts in-process → browser opens to served URL → process waits for SIGINT. If server fails to start (e.g. port in use), the error surfaces and the process exits. SIGINT prints "Server stopped." and exits cleanly.

**Bonus: pre-existing `--port` collision bug fixed.** The cherry-picked `serve` subcommand defined `-p, --port` but commander silently let the outer command's `-p, --port` (prototype kit port, default 4321) win — so `prototype-flow-map serve --port 3777` actually used the default 3000. Fixed via `program.enablePositionalOptions()` + `serve.passThroughOptions()`.

**Bonus: flag UX rework.** With the collision fix in place, the next discoverable issue was that `prototype-flow-map <p> --serve --port 3777` silently bound `--port` to the prototype-kit port (because `--port` is the natural flag to try, not `--serve-port`). Renamed: outer command's `-p, --port` → `-p, --prototype-port` (prototype kit, rarely changed). The freed `--port` now consistently means "the local server's port" across both `--serve` mode and the `serve` subcommand.

## Files changed

| File | Change |
|---|---|
| `src/server.js` | Added `GET/PUT /api/maps/:name/hidden` endpoints with `isValidHidden` validation |
| `src/build-viewer.js` | Build-time `hidden.json` carry-forward + `__SAVED_HIDDEN__` embed; viewer-side `embeddedHidden` baseline; `saveHiddenToServer` fire-and-forget; `detectServeMode` extended to fetch hidden + use 1.5s timeout |
| `bin/cli.js` | `enablePositionalOptions()` + `passThroughOptions()` to fix --port collision; `--serve` and `--port` (server port) on the outer command; `-p, --prototype-port` rename for prototype-kit port; `--serve` action: in-process server start + browser open + SIGINT wait |
| `docs/cli-reference.md` | Options table updated; `serve` subcommand section expanded with hidden endpoints, persistence priority, file:// fallback explanation; new combined-mode example |
| `docs/viewer.md` | Position priority chain expanded to four levels; new three-level priority for hidden state; "Layout saved ✓" indicator note |
| `docs/recording.md` | `--port` → `--prototype-port` in the custom-port example |
| `docs/plans/archive/webapp-collaboration.md` | Status banner updated: Phase 1 fully delivered, with both cherry-pick and WS3 contributions noted |

## Verification

API endpoints exercised via curl: GET-empty → PUT → GET-with-data → invalid PUT (rejected). `hidden.json` file appears on disk with correct content. Stale-entry filter at carry-forward verified by injecting a fake `nonexistent-node` ID into `hidden.json`, regenerating, and confirming it was dropped from `__SAVED_HIDDEN__`. End-to-end `--serve` confirmed: generation, server start on chosen port, health endpoint responds, no server on the default port, SIGINT clean shutdown. UI verification done by user in browser.

## Notable decisions

- **Auto-save for hidden, manual save for positions.** Hide actions are deliberate ("I know this is irrelevant; remove it"), so immediate persistence matches user mental model. Drag positions are exploratory ("let me try arranging this differently"), so a stage-and-commit workflow gives the user control over when to share their layout.
- **Fire-and-forget server saves.** Auto-saving on each hide click means we'd otherwise need a spinner per click. Silent + localStorage fallback is less noisy and degrades gracefully if the server flakes.
- **1.5s health-check timeout.** file:// loads have no server, so we want to fail-fast. 1.5s comfortably exceeds local server startup time (typically <100ms) but fails fast when there's nothing to talk to.
- **In-process server for `--serve`.** Considered a daemon mode with a stop subcommand. Rejected for v1 — foreground process is simpler, clear lifecycle, easy to understand.

## Out of scope (now in future-ideas)

- Comments / annotations (Phase 2)
- Identity attribution + SQLite (Phase 3)
- Real-time WebSocket sync (Phase 4)
- Web-triggered generation (Phase 5)
- Heroku deployment validation — `Procfile` exists from cherry-pick, `package.json` has the `start` script, but no production deploy has been smoke-tested
