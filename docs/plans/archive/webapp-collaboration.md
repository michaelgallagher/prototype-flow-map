# Web App & Collaboration Plan

> **Status: Phase 1 partially delivered, Phases 2–5 still future work.** Archived for historical context. The Phase 1 server (Express + positions API, `serve` subcommand, `Procfile`, position carry-forward at build time, `__SAVED_POSITIONS__` injection, dirty/saved button states) landed via cherry-pick from the `build-a-server` branch. Still outstanding from Phase 1: Heroku deployment hasn't been validated end-to-end. Phases 2–5 (comments, identity/SQLite, real-time, web-triggered generation) have been folded into [`../future-ideas.md`](../future-ideas.md).
>
> Original plan retained below for context.

## Current State

The tool is a CLI pipeline that generates self-contained static HTML to `flow-map-output/`. There is no server at view time — everything is files on disk. The viewer is vanilla JS with pan/zoom, search, drag-to-reposition (localStorage only), and screenshot panels. Multi-map mode provides a collection index page linking to individual viewers.

## Goals

1. **Deployable web app** — a running server with stable URLs, not just local HTML files
2. **Shareable URLs** — copy a link and anyone on the team can see the map
3. **Shared layout positions** — when someone repositions nodes and saves, everyone sees the new layout
4. **Comments and annotations** — users can leave notes on maps and individual nodes
5. **Lightweight identity** — know who made a change or left a comment

## Constraints & Decisions

| Question | Decision |
|---|---|
| **Hosting** | Heroku (Node.js) |
| **Access control** | None for now — maps are generated locally, committed, and deployed via CI on merge to main |
| **Identity** | Not needed yet; simple name prompt in a later phase |
| **Real-time collaboration** | Not a must now; will revisit later |
| **Map generation** | Users run the CLI locally, commit output, open a PR. Auto-redeploy on merge to main. |
| **Scale** | ~20–40 maps, small number of teams |
| **Persistence** | JSON files for now; upgrade to SQLite later if needed |

## Architecture

### Phase 1 — Serve Mode + Shared Positions ✦ current
**Effort: Small. Unlocks: shareable URLs, shared node layouts.**

This is the foundation. It gets us a deployable app with stable URLs.

1. **New `serve` CLI command** — Express serves `flow-map-output/` with a REST API
2. **Positions API** — `GET/PUT /api/maps/:name/positions` reads/writes `positions.json`
3. **Viewer changes** — detect serve mode, add "Save layout" button, load positions from API on startup instead of only from localStorage
4. **Regeneration merge** — when `buildViewer` runs, read existing `positions.json` and carry forward positions for nodes that still exist
5. **Heroku deployment** — `Procfile`, `start` script in `package.json`

**Stable URLs:** Each map gets a URL like `https://<app>.herokuapp.com/maps/clinic-workflow/`. Shareable immediately.

**API endpoints:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check; also used by the viewer to detect serve mode |
| `GET` | `/api/maps/:name/positions` | Read saved positions (returns `{}` if none) |
| `PUT` | `/api/maps/:name/positions` | Write positions; body is `{ "/url": { "x": N, "y": N }, ... }` |

**Position loading priority (highest wins):**
1. API response (serve mode only)
2. localStorage (browser-local, session cache)
3. Embedded `__SAVED_POSITIONS__` (baked into HTML at generation time from `positions.json`)
4. Computed layout (dagre or grid)

### Phase 2 — Comments
**Effort: Medium. Unlocks: annotation and discussion.**

1. **Comments API** — `GET/POST /api/maps/:name/comments`, with optional `nodeId` to attach comments to specific nodes
2. **Comment data model** — `{ id, nodeId?, text, author, createdAt, resolved }` stored in `comments.json`
3. **Viewer UI** — comment icon on nodes, comment thread in the detail panel, general comments panel, simple "author name" prompt (stored in localStorage or a cookie)
4. **Comment indicators** — nodes with comments get a badge/dot on the map

### Phase 3 — Lightweight Identity + SQLite
**Effort: Medium. Unlocks: knowing who did what, concurrent safety.**

1. **Switch from JSON files to SQLite** — positions, comments, and map metadata in a single `.sqlite` file
2. **Simple identity** — "What's your name?" prompt on first visit, stored as a cookie. No passwords, no OAuth.
3. **Change attribution** — positions and comments record who and when
4. **Audit trail** — optional "last edited by X, 2 hours ago" on nodes

### Phase 4 — Real-Time Sync
**Effort: Large. Unlocks: live collaboration.**

1. **WebSocket layer** — Socket.IO or plain `ws` alongside Express
2. **Broadcast position changes** — dragging a node moves it for everyone
3. **Broadcast new comments** — comments appear for everyone immediately
4. **Presence** — show who's currently viewing the map
5. **Conflict resolution** — last-write-wins for positions; comments are append-only

### Phase 5 — Web-Triggered Generation (Optional)
**Effort: Large. Unlocks: non-developers can generate maps.**

1. **Upload/configure UI** — point at a Git repo URL or upload a prototype zip
2. **Background job runner** — generation runs in a worker process
3. **Progress feedback** — WebSocket-based progress updates
4. **Scheduled regeneration** — re-run on Git push via webhook

## What Stays The Same

- **The `.flow` DSL, scenario runner, static analysis, recorder** — untouched. Generation is still CLI-driven.
- **The viewer's core rendering** — pan/zoom, layout, search, screenshots, detail panel. The viewer just gains save/comment UI and talks to an API when available.
- **The output structure** — `flow-map-output/maps/<name>/` with `graph-data.json`, `screenshots/`, etc.
- **Offline/static use** — the viewer still works as a standalone HTML file. API features gracefully degrade when there's no server (fall back to localStorage, hide save/comment UI).

## File Changes (Phase 1)

| File | Change |
|---|---|
| `src/server.js` | **New.** Express server with static file serving and positions API |
| `bin/cli.js` | Add `serve` subcommand |
| `src/build-viewer.js` | Read `positions.json` on build; embed as `__SAVED_POSITIONS__`; add save button to toolbar; add serve-mode detection + API calls to viewer JS; add save button styles to CSS |
| `package.json` | Add `start` script for Heroku |
| `Procfile` | **New.** Heroku process definition |