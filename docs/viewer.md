# Using the viewer

The tool generates an interactive HTML viewer for each map. Open `index.html` in a browser to explore — or run `prototype-flow-map serve <output-dir>` to view it via a local server (which adds shared layout-position persistence).

## Navigation

- **Pan**: click and drag the background
- **Zoom**: scroll wheel, or use the + / - buttons
- **Fit to screen**: reset the view to fit all nodes

## Inspecting pages

- **Click a node** to open the detail panel showing:
  - Full screenshot
  - Page metadata (URL path, file path, node type, hub)
  - Incoming and outgoing edges with labels
  - Provenance badges (runtime vs static, where applicable)
  - **Hide this page** button (see [Hiding nodes](#hiding-nodes))
- **Search** to filter pages by name or URL path

## Filters and toggles

- **Filter by hub**: show only pages in a specific section
- **Toggle labels**: show/hide edge labels and conditions
- **Toggle global nav**: show/hide global navigation edges (hidden by default in scenario mode)
- **Provenance filter**: filter edges by source — runtime only, static only, or both
- **Show/hide screenshots**: toggle between screenshot view and compact node view
- **Thumbnail mode**: switch between full-page and compact thumbnail screenshots

## Repositioning nodes

- **Drag nodes**: click and drag any node to reposition it.
- **Reset positions**: clear all manual positions and return to the computed layout.
- **Save layout** (serve mode only): persist current positions to the server so anyone else viewing the same deployment sees the same layout. The button shows a dirty marker (`Save layout *`) when there are unsaved changes; turns to `Layout saved ✓` after a successful PUT.

Position persistence priority (highest wins):
1. Server API (when the viewer detects it's being served via `prototype-flow-map serve` or `--serve`)
2. `localStorage` (browser-local fallback when no server is reachable)
3. Embedded `__SAVED_POSITIONS__` (baked into HTML at generation time from `positions.json`, so previous saves carry forward across regenerations even on file://)
4. Computed layout (Dagre or grid)

## Hiding nodes

Three ways to hide content the user knows is irrelevant:

- **Right-click a node** → "Hide node" hides just that node
- **Right-click a node with descendants** → "Hide subgraph (N descendants)" hides the node and everything reachable below it via forward edges
- **Click a node** → "Hide this page" button in the detail panel (single-node hide, same as right-click → Hide node)

When ≥1 node is hidden, the toolbar shows a **Show hidden (N)** button. Click it to open a popover listing all hidden nodes by label. Each row has a **Restore** button to bring that single node back; the header has a **Restore all** button to clear the entire hidden set.

Hidden state persistence priority (highest wins):
1. Server API (when in serve mode — every hide/restore auto-saves; no manual Save button needed)
2. `localStorage` (browser-local fallback when no server is reachable; keyed by pathname, NOT by generation ID, so hidden state survives regeneration)
3. Embedded `__SAVED_HIDDEN__` (baked into HTML at generation time from `hidden.json`, so previous saves carry forward even on file://)

Stale entries for node IDs that no longer exist in the current graph are inert — at carry-forward time the build dropped them; in the viewer they simply don't match any node and have no effect.

## Layout

The layout has three branches depending on what metadata the graph carries:

### With subgraph owners — column-packed

When the tool detects subgraph owners (e.g. Android bottom-nav tabs, or web jump-off subgraphs propagated from a native handoff), the layout is **column-packed**: each detected tab/section gets its own column, ranks flow top-to-bottom within each column, and columns sit left-to-right in `startOrder`. This keeps each tab's content visually grouped.

### With ranks but no owners — Dagre tree shape on rank rows

When nodes carry `layoutRank` but no `subgraphOwner` (typical for iOS prototypes without explicit tabs, and for many web scenarios), the tool keeps Dagre's computed X positions — Dagre laid out the actual edges with `rankdir: 'TB'`, so its X reflects tree structure (children sit horizontally under their parents). Y is overridden with rank-based stacking so rank rows align cleanly.

A future improvement (Part B in [roadmap.md](plans/roadmap.md#workstream-2--tree-shaped-layout)) will infer virtual subgraph owners from hub-shaped graphs, bringing iOS-without-tabs and web-without-mutual-tabs into the column-packed layout. For now this rank-row tree shape replaces what was previously a centred-blob fallback.

### Without ranks — pure Dagre

For very simple prototypes where no rank metadata is present, Dagre handles the layout end-to-end based on graph structure.

## Web jump-off rendering

When a native run uses `--web-jumpoffs`, web pages are rendered with distinct visual styling so they read as part of the journey but are clearly distinguishable from native screens:

- **`web-page` nodes**: tinted fill and dashed stroke (versus solid stroke on native nodes)
- **Subgraph root** (the URL the native app handed off to): heavier stroke to mark the entry point
- **Column placement**: each web subgraph inherits the column position of the native handoff that introduced it, so the whole web journey sits in-column under the native screen that linked to it

See [`web-jumpoffs.md`](web-jumpoffs.md) for the full reference on what gets crawled and how.
