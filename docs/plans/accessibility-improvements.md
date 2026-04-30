# Accessibility improvements for the flow-map viewer

Status: planning
Owner: tbd
Last updated: 2026-04-30

## Goal

Make the generated viewer (`src/build-viewer.js` → `index.html` + `viewer.js` + `styles.css`) usable by people who navigate by keyboard, by screen reader, in light/high-contrast environments, with reduced motion, and on small or low-precision pointing devices. Target WCAG 2.2 AA.

## Why this matters now

The current viewer is a single `<svg>` of `<g>` node groups with mouse-only handlers and a hardcoded dark theme. None of the interactive surfaces (nodes, edges, detail panel, context menu, hidden-list popover) have keyboard or assistive-technology affordances. Light-mode is requested by users with photosensitivity, daylight working conditions, or printing needs.

## Scope

In scope:
- The HTML viewer emitted by `src/build-viewer.js` for both web and native (iOS / Android) graphs
- The maps index page emitted by `src/build-index.js`

Out of scope (separate plans):
- Generated PDF accessibility (`src/export-pdf.js`)
- Mermaid sitemap (`src/build-mermaid.js`) — Mermaid's own a11y story
- Authoring-tool a11y (CLI, server logs)

## Standards we'll target

WCAG 2.2 AA, with attention to:

| Criterion | Relevance |
|---|---|
| 1.3.1 Info and relationships | Diagram needs a programmatic structure (list/tree/grid), not just visuals |
| 1.4.1 Use of colour | Edge types differ by colour today — ensure shape/dash also differs (largely already true) |
| 1.4.3 Contrast (text) | Light + dark themes must hit 4.5:1 for body text, 3:1 for large/UI |
| 1.4.11 Non-text contrast | Node strokes, focus rings, edges ≥ 3:1 against background |
| 1.4.12 Text spacing | No fixed-height containers that clip resized text |
| 1.4.13 Content on hover/focus | Hover-revealed info must also be reachable via focus and dismissible |
| 2.1.1 Keyboard | Every mouse interaction needs a keyboard equivalent |
| 2.1.2 No keyboard trap | Detail panel and popovers must release focus |
| 2.4.3 Focus order | Tab order: skip link → toolbar → graph → panel → legend |
| 2.4.7 Focus visible | All focusable elements need a visible, theme-aware focus ring |
| 2.4.11 Focus not obscured | Focused node must be scrolled into the visible viewport |
| 2.5.7 Dragging movements | Drag-to-reposition must have a single-pointer / keyboard alternative |
| 2.5.8 Target size | Toolbar buttons and the close-panel button ≥ 24×24 |
| 4.1.2 Name, role, value | Every custom widget gets correct ARIA |
| 4.1.3 Status messages | Filter/search/save outcomes via `aria-live` |

Plus: `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-contrast`, `forced-colors`.

## Current-state audit (one-line per gap)

- Theme: dark-only, hex literals throughout — no CSS custom properties to swap
- SVG: `<svg>` has no `role`, `aria-label`, or instructions
- Nodes: `<g class="node-group">` is not focusable; click/hover/drag/contextmenu are mouse-only
- Edges: no semantics; colour-only differentiation in some cases (most already use dash patterns)
- Toolbar: container has no `role="toolbar"`, no group label; toggle checkboxes/buttons lack `aria-pressed` parity
- Search: uses placeholder as label; no result-count live region
- Detail panel: slides in via CSS transform, no focus management, no `aria-modal`, no `Escape` handling beyond context menu, no focus return
- Context menu (right-click on node): div-based, no `role="menu"`, no arrow-key navigation, mouse-only invocation
- Hidden-list popover: same — no focus trap, no list semantics
- Legend: visual only; not announced
- Status: `#node-count` updates silently
- Reduced motion / forced colours / high-contrast: not honoured
- Skip link: none

## Phased plan

Five phases. Phase 1 unlocks the rest, so don't reorder. Each phase ends with a manual a11y pass (axe DevTools + VoiceOver/NVDA spot-check) before merging.

### Phase 1 — Theming foundation (light mode + tokens)

Goal: introduce CSS custom properties and a theme switch without changing any behaviour.

1. Replace every hex literal in `generateViewerCss()` with a `var(--token)` reference. Group tokens:
   - Surface: `--bg`, `--surface-1` (toolbar, panel, legend), `--surface-2` (popovers), `--border`
   - Text: `--text`, `--text-muted`, `--text-strong`
   - Accent: `--accent` (the cyan `#53d8fb`), `--accent-hover`
   - Node fills/strokes: one pair per node type (`--node-screen-fill`, `--node-screen-stroke`, …)
   - Edge strokes: one per edge type
   - Status: `--ok`, `--warn`, `--err`
   - Focus: `--focus-ring`
2. Default theme = current dark palette under `:root`.
3. Add `:root[data-theme="light"]` block with a tuned light palette. Constraints:
   - Body text ≥ 4.5:1 against `--bg`
   - Node strokes ≥ 3:1 against canvas; node label text ≥ 4.5:1 against node fill
   - Edge strokes ≥ 3:1 against canvas (light mode is the harder case — current pastel edges will need darker variants)
   - Run all node/edge colours through a contrast checker; record results in `docs/plans/accessibility-improvements-contrast.md` if many adjustments are needed
4. Theme selection:
   - On load: read `localStorage['flowmap-theme']`. If unset, follow `window.matchMedia('(prefers-color-scheme: light)')` and listen for changes.
   - Add a toolbar control: a single `<button id="theme-toggle" aria-pressed="false">Light mode</button>` that toggles `data-theme` on `<html>` and persists.
5. Add `<meta name="color-scheme" content="dark light">` so form controls pick up the right native palette.
6. Honour `@media (prefers-reduced-motion: reduce)` — disable the panel slide and any opacity transitions.
7. Honour `@media (forced-colors: active)` — set strokes/fills to `CanvasText`, `Highlight`, `LinkText` so Windows High Contrast is usable.

Files: `src/build-viewer.js` (`generateViewerCss`, `generateViewerHtml`, `generateViewerJs` toolbar wiring).

Definition of done: snapshot the dark map, toggle to light, snapshot again. Both pass axe contrast checks. Reduced-motion media query verified by toggling OS setting.

### Phase 2 — Toolbar, panel, and search semantics

Goal: get all chrome (non-canvas) UI announced and operable correctly. This is the cheap wins phase.

1. Add `<a class="skip-link" href="#flow-svg">Skip to flow map</a>` as the first focusable element; visually hide until focused.
2. Toolbar:
   - `<div id="toolbar" role="toolbar" aria-label="Flow map controls">`
   - Group related controls visually and with `<div role="group" aria-label="…">` (zoom, view, filters)
   - Convert toggle controls (`#toggle-labels`, `#toggle-screenshots`, `#toggle-thumbnail`, `#toggle-global-nav`) to `<button aria-pressed>` form for consistency, OR keep checkboxes but ensure each has a real `<label for>`. Pick one and apply uniformly.
   - Icon-only buttons (`Zoom +`, `Zoom −`, `✕`) get `aria-label`.
   - Ensure every button is at least 24×24 (target size). Most already are; verify.
3. Search input: replace `placeholder="Search pages..."` with a real `<label class="visually-hidden" for="search">Search pages</label>` plus a placeholder for sighted users.
4. `#node-count` becomes `aria-live="polite" aria-atomic="true"` so filter/search results announce.
5. `<select id="hub-filter">` and `<select id="provenance-filter">` get associated `<label>`s (visually hidden if needed for layout).
6. Detail panel:
   - Treat as a non-modal `complementary` region by default (does not trap focus): `<aside id="detail-panel" role="complementary" aria-labelledby="panel-title" tabindex="-1">`. Each opened panel updates `<h2 id="panel-title">`.
   - On open: move focus into the panel heading. Set `aria-expanded="true"` on the trigger node.
   - On close (`Escape`, click `✕`, click another node): return focus to the previous trigger.
   - Mark `aria-hidden="true"` while the panel is in `.hidden` state, otherwise screen readers still see stale content.
   - Close button: `aria-label="Close details"`.
7. Legend: wrap items in a `<ul>` with `role="list"`; the colour swatches are decorative — already accompanied by text, so add `aria-hidden="true"` on the swatches themselves so SR doesn't read empty spans.

Files: `src/build-viewer.js` (mostly `generateViewerHtml` and `generateViewerCss`; small JS additions for focus return).

Definition of done: tab through the page from the top with a screen reader; every control announces a sensible name and role; search filtering produces a polite announcement.

### Phase 3 — Keyboard navigation across the graph

This is the largest piece of work. We expose the diagram as a structured, navigable widget.

Recommended pattern: **listbox with roving tabindex**, single-select.

Rationale: a listbox is a closer match than a tree (we don't want users tabbing between every level) or a grid (we don't have rows × columns). Treating the graph as a flat selectable list, with arrow keys mapped to spatial neighbours, gives intuitive movement without overloading expectations.

Implementation:

1. Wrap rendered nodes in `<g role="listbox" aria-label="Screens (NN total)" aria-activedescendant="…">` or, alternatively, manage focus directly on each node with roving tabindex (preferred for SVG — `aria-activedescendant` on SVG is patchy in JAWS).
2. Per node `<g class="node-group" role="option" tabindex="-1" aria-label="…" aria-selected="false">`. Compose `aria-label` from:
   - The label
   - Type ("Screen", "Web view", "External")
   - Outgoing edge summary ("3 outgoing links, 1 sheet")
   - File path
   - Hint suffix: "Press Enter to open details"
3. Roving tabindex: exactly one node has `tabindex="0"` at any time — the "current" one. On arrow-key navigation, swap tabindex.
4. Initial focus target: first start node, else first node by `layoutRank` then `visitOrder`, else first by `id`.
5. Key bindings (when a node has focus):
   - `Tab` / `Shift+Tab` → leaves the listbox (does not cycle inside)
   - `Enter` / `Space` → open detail panel for current node
   - `Arrow Up/Down/Left/Right` → move to nearest neighbour by **layout coordinates** (use the existing dagre output). Algorithm: filter remaining visible nodes by direction half-plane; pick the smallest weighted distance `dx² + 4·dy²` (vertical bias) for up/down, mirror for left/right. This gives users the spatial movement they expect even though the underlying structure is a graph.
   - `Home` / `End` → first / last by visit order (or layout rank)
   - `Ctrl/Cmd+F` is left to the browser; our search input still works
   - `Escape` → close panel if open; else clear selection
   - `Shift+Arrow` → in "move mode" (see Phase 4), nudge node position
6. Auto-pan: when focus moves to a node outside the viewport, animate (or jump, with reduced motion) the SVG transform to centre the focused node. Reuses the existing zoom/pan transform.
7. Focus indicator: add `.node-rect--focused` class with a 3px outline using `--focus-ring`, distinct from `:hover`. Must be visible in light, dark, and forced-colors.
8. `highlightConnections(node.id)` should fire on **focus** as well as `mouseenter`, and clear on `blur`.
9. Hidden / filtered nodes are excluded from focus traversal automatically because the wrapper is rebuilt on each layout.

Files: `src/build-viewer.js` (`generateViewerJs` — node rendering, key handlers, neighbour-finding, transform helpers).

Definition of done: a sighted keyboard user can reach every visible node, open its details, traverse to any neighbour, and the focused node is always visible. NVDA / VoiceOver announce label + role + selected state on each move.

### Phase 4 — Pointer-free equivalents for power features

Cover the features that are currently mouse-only.

1. **Zoom & pan keyboard shortcuts** (when focus is on the canvas / a node):
   - `+` / `=` → zoom in; `-` / `_` → zoom out; `0` → fit to screen
   - When nothing is selected, arrow keys pan; when a node is selected they navigate (above)
   - Document the bindings in a help dialog opened via `?` or a `Keyboard shortcuts` toolbar button
2. **Drag-to-reposition alternative** (WCAG 2.5.7):
   - Per focused node: pressing `M` enters "move mode" — visual indicator on the node, status announcement "Move mode for X. Use arrow keys to nudge, Enter to commit, Escape to cancel."
   - Arrow keys nudge by 8px (Shift+Arrow by 32px). Enter commits → calls existing position save. Escape reverts.
   - Persist via the existing `manualPositions` machinery.
3. **Context menu**:
   - Trigger via `Shift+F10`, `ContextMenu` key, or the existing right-click. Also reachable via a "More actions" button that appears on focus, for users without those keys.
   - Convert the menu to `role="menu"` with `<button role="menuitem">` items; arrow keys to move; Enter/Space to activate; Esc to close; focus returns to the originating node.
   - Trap focus inside the menu while open.
4. **Hidden-list popover**:
   - Same conversion: `role="dialog" aria-modal="true" aria-labelledby"…"` with focus trap; or non-modal `role="region"` with focus management. Modal is simpler given its small surface.
   - First focus → first restorable item; Esc → close and return focus to "Show hidden" button.
5. **Layout-save / reset** announcements: route messages through the live region added in Phase 2.

Definition of done: every action available from the right-click menu and drag interaction can be performed with the keyboard alone; documented in the help dialog.

### Phase 5 — Screen reader-friendly outline view

Goal: even with all the SVG ARIA, complex diagrams remain hard for screen-reader users to mentally model. Provide an alternative.

1. Toolbar toggle: `View as outline` (button, `aria-pressed`).
2. When enabled, hide the SVG (`aria-hidden="true"`, `display:none`) and reveal `<nav id="flow-outline">` containing:
   - A heading `<h2>Screens (NN)</h2>`
   - A `<ul>` of nodes grouped by `layoutRank` (or hub)
   - Each item: link/button with the node label + type; nested `<ul>` of outgoing edges (target + edge type, e.g. "Sheet to AppointmentDetail")
   - Activating an item opens the existing detail panel (so the same data view is shared)
3. The outline is also rendered (visually hidden, still in the DOM) when the SVG view is active, so search engines and screen readers always have a navigable text representation. Use a `.visually-hidden` pattern (clip + 1px), not `display:none`, so it is reachable.

This is the highest-leverage screen-reader improvement and should not be skipped even if Phases 3–4 land.

Files: `src/build-viewer.js` (new outline render function reusing graph data).

Definition of done: with the SVG hidden, a screen-reader user can still find any screen, see what it links to, and open its details.

## Cross-cutting items

- **Documentation**: a short "Accessibility" section in `docs/README.md` describing the keyboard shortcuts, screen reader recommendations, and known limitations
- **Index page** (`src/build-index.js`): apply the same theme tokens and skip link
- **Per-map ID stability**: roving tabindex assumes node IDs are stable across renders — they are, per the regenerate-merge logic in `buildViewer`

## Open questions

1. Should arrow-key neighbour traversal be **spatial** (nearest by coordinates) or **graph-structural** (next by edge)? Spatial is more intuitive when zoomed out; structural is more useful when exploring a flow. Proposal: spatial by default, with `Tab`/`Shift+Tab` (or `]`/`[`) for "next outgoing target / previous source" once a node is focused. Decide before Phase 3 starts.
2. Detail panel as `<dialog>` (modal) or non-modal `<aside>`? Today it coexists with the canvas, which suggests non-modal. We'll keep non-modal but ensure focus management — this is the assumption above.
3. Do we add an end-to-end a11y test (axe-core via Playwright over a generated map) or rely on manual passes? Cheap to add later; defer for now unless the user wants it bundled.

## Suggested first PR

Phase 1 + the skip link + toolbar role + search label from Phase 2. This delivers light mode and the first axe-passing pass without touching the SVG interaction model. Ships in a day; everything else builds on the tokens.
