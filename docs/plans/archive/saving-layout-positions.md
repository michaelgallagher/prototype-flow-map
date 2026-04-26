# Saving layout positions

> **Status: Option 4 (server-side persistence) delivered.** Archived for historical context. The selected approach lives in `src/server.js` (Express, REST API for positions) and the viewer-side wiring in `src/build-viewer.js`. See [`../roadmap.md`](../roadmap.md) for what remains around the server (additional endpoints, viewer fallback UX, `--serve` flag exists but isn't yet auto-invoked).
>
> Options 1, 2, and 3 below were considered and rejected — kept here so the rationale is preserved.

## Current behaviour

The viewer already supports drag-to-reposition nodes. When a user drags a node:

1. The node's new `{ x, y }` position is saved to `localStorage` (keyed by page pathname)
2. On reload, saved positions are restored from `localStorage` and override the computed layout
3. A "Reset positions" button clears all manual positions and re-runs the layout

This works well for local use, but has limitations:

- **Browser-local** — positions don't transfer between devices or browsers
- **Not shareable** — sharing the HTML file doesn't include the recipient's localStorage
- **Lost on regeneration** — regenerating the map produces a new HTML file; the old localStorage entries may no longer match
- **No collaboration** — multiple people reviewing the same map can't share a canonical layout

## Goal

Allow users to save layout changes so they persist across sessions, devices, and regeneration cycles. Ideally, saved positions should be shareable and survive map updates.

---

## Options

### Option 1: Downloadable positions file

Add "Save layout" and "Load layout" buttons to the viewer. "Save layout" downloads a `positions.json` file containing manual position overrides. "Load layout" accepts a file (or drag-drop) and applies the positions.

```json
{
  "/dashboard": { "x": 400, "y": 60 },
  "/clinics/today": { "x": 200, "y": 280 },
  "/clinics/upcoming": { "x": 360, "y": 280 }
}
```

**Pros:**
- Works everywhere (no backend needed)
- File can be version-controlled alongside scenarios
- The tool could read positions on regeneration to preserve manual adjustments
- Human-readable, easy to inspect or edit
- Composes with existing localStorage for session-local tweaks

**Cons:**
- Manual save/load workflow (user must remember to export)
- File management overhead (where to put it, how to name it)

---

### Option 2: Encode positions in URL hash

Serialize position overrides into a compact URL fragment (e.g. `#positions=base64encodeddata`). Anyone opening the link gets the same layout.

**Pros:**
- Instantly shareable via URL
- No file management
- Works with static hosting

**Cons:**
- URL becomes very long with many nodes (19 nodes ~ 500+ characters)
- Fragile if node IDs change between regenerations
- Not version-controllable
- Browser URL length limits may be a concern for large maps

---

### Option 3: Bake positions into a downloaded HTML

Add a "Save as..." button that downloads a copy of the viewer HTML with position overrides embedded in `window.__GRAPH_DATA__` (merging `x`/`y` directly onto node objects).

**Pros:**
- Self-contained, shareable HTML file
- Recipient sees the exact layout without any setup
- Works offline

**Cons:**
- Creates a separate file that diverges from the generated output
- No way to carry positions forward on regeneration
- Large file size (full HTML + inline assets duplicated)

---

### Option 4: Server-side persistence (serve mode)

Add a `serve` command to the tool that starts a lightweight web server over the output directory. The server adds an API endpoint for saving positions, and the viewer sends position changes to it directly.

#### How it works

1. Run `prototype-flow-map serve` (or `npx prototype-flow-map serve`)
2. The tool starts an Express server serving the existing output directory
3. The viewer gets a "Save positions" button that sends a PUT request:

```
PUT /api/maps/:mapName/positions
Content-Type: application/json

{
  "/dashboard": { "x": 400, "y": 60 },
  "/clinics/today": { "x": 200, "y": 280 }
}
```

4. The server writes positions to a `positions.json` file alongside `graph-data.json`
5. On page load, the viewer fetches saved positions from the server and applies them

#### Deployment

This mode works anywhere a Node.js app can run:

- **Locally** — `npx prototype-flow-map serve` for local review sessions
- **Heroku** — deploy the tool as a web app; the output directory and positions persist on the filesystem (or use S3/database for durability)
- **Any Node.js host** — Render, Railway, a VM, etc.

#### Regeneration integration

When the tool regenerates a map, it checks for an existing `positions.json` and carries forward any manual positions where the node ID still exists in the new graph. This means layout tweaks survive re-runs.

**Pros:**
- Seamless save experience (click a button, done)
- Positions are shared across all viewers of the same deployment
- Survives regeneration when node IDs are stable
- No file management for end users
- Version-controllable (positions.json can be committed)

**Cons:**
- Requires a running server (not purely static)
- Needs deployment infrastructure for remote access
- Concurrent editors could overwrite each other (solvable but adds complexity)

---

## Recommendation

**Option 4 (serve mode)** is the strongest long-term approach. It provides the best user experience — save with a button click, positions are immediately shared with anyone viewing the same deployment, and they survive regeneration.

**Option 1 (downloadable file)** is a good complement for static/offline use cases, and is simpler to implement first.

A phased approach:

1. **Phase 1**: Add serve mode with file-based position persistence and a "Save positions" button in the viewer
2. **Phase 2**: On regeneration, merge existing `positions.json` so manual layout survives map updates
3. **Phase 3** (optional): Add download/upload positions for offline sharing; encode in URL hash for quick sharing of small maps

## Technical notes

### Existing infrastructure

The viewer already:
- Tracks manual positions in a `manualPositions` object (keyed by node ID)
- Persists them to `localStorage` on every drag
- Restores them on page load (applied after computed layout)
- Has a "Reset positions" button that clears them
- Computes connected edge positions in real-time during drag via `updateConnectedEdges()`

### What needs to change

- **Viewer JS**: Add a "Save positions" button that POSTs `manualPositions` to the server (when available) or downloads as a file (when static)
- **Serve command**: New CLI command that starts Express, serves output directory, adds the positions API endpoint
- **Regeneration**: `buildViewer` reads `positions.json` from the map output directory and merges saved positions into the initial layout
- **Detection**: The viewer should detect whether it's being served by the tool's server (e.g. check for `/api/health`) and show the appropriate save UI
