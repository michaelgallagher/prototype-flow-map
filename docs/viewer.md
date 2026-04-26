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
- **Save layout** (serve mode only): persist current positions to the server so anyone else viewing the same deployment sees the same layout. The button shows a dirty marker (`Save layout *`) when there are unsaved changes.

Position persistence priority (highest wins):
1. Server API (when running via `prototype-flow-map serve`)
2. `localStorage` (browser-local fallback when no server)
3. Embedded `__SAVED_POSITIONS__` (baked into HTML at generation time from `positions.json`, so previous saves carry forward across regenerations)
4. Computed layout (Dagre or grid)

## Hiding nodes

- Click a node, then use the **Hide this page** button in the detail panel
- Use **Show hidden** (toolbar button, appears when ≥1 node is hidden) to restore hidden nodes

Hidden state is saved to `localStorage`. Server-backed persistence for hidden nodes is on the [roadmap](plans/roadmap.md#workstream-3--server-integration).

## Layout

### Web (scenario mode)

Layout is computed as a grid:

- Nodes are arranged in horizontal rows by rank (visit order)
- Tab siblings (pages with mutual cross-links) are grouped on the same row
- The flow progresses top to bottom
- Each row is centred on a common axis

### Native (iOS / Android)

When the tool detects subgraph owners (e.g. Android bottom-nav tabs), the layout is **column-packed**: each detected tab/section gets its own column, ranks flow top-to-bottom within each column, and columns sit left-to-right in `startOrder`. This keeps each tab's content visually grouped.

When no subgraph owners are detected (currently happens on iOS prototypes without explicit tabs), the layout falls back to a centred-per-rank arrangement. This is a known issue tracked in [roadmap.md](plans/roadmap.md#workstream-2--tree-shaped-layout) — the fix is to use Dagre's tree-shaped X positions plus virtual subgraph-owner inference.

### Web (static mode)

Dagre handles the layout automatically based on graph structure.

## Web jump-off rendering

When a native run uses `--web-jumpoffs`, web pages are rendered with distinct visual styling so they read as part of the journey but are clearly distinguishable from native screens:

- **`web-page` nodes**: tinted fill and dashed stroke (versus solid stroke on native nodes)
- **Subgraph root** (the URL the native app handed off to): heavier stroke to mark the entry point
- **Column placement**: each web subgraph inherits the column position of the native handoff that introduced it, so the whole web journey sits in-column under the native screen that linked to it

See [`web-jumpoffs.md`](web-jumpoffs.md) for the full reference on what gets crawled and how.
