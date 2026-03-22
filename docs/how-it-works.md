# How it works

## Web prototypes — record mode

1. **Starts the prototype server** and launches a headed (visible) browser
2. **Injects a toolbar** into every page via `page.addInitScript()` for phase control and interaction capture
3. **Setup phase**: the user clicks through login/setup steps, which are recorded as `Goto` and interaction steps
4. **Map phase** (after clicking "Begin mapping"): each page navigation triggers a real-time capture:
   - Hides the toolbar, dismisses modals, repositions fixed elements
   - Takes a full-page screenshot
   - Extracts all links from the rendered DOM
   - Builds a graph node for the page
5. **On finish** (toolbar button or browser close):
   - Builds edges between pages from extracted links, using canonical-to-raw URL mapping to match link targets to visited nodes
   - Groups tab siblings (pages with mutual cross-links) into the same layout rank
   - Generates the viewer, Mermaid sitemap, and metadata
   - Saves a `.flow` script (with dynamic URLs converted to `Snapshot` steps for replay robustness)

Key files: `src/recorder.js`, `src/recorder-inject.js`, `src/flow-serializer.js`

## Web prototypes — static mode

1. **Scans** `app/views/` for all `.html` template files
2. **Parses** each template for `href` links, `<form action>` attributes, JS redirects, and `{% if %}` conditional blocks
3. **Parses** route handlers (`routes.js`, `app.js`) for explicit `res.redirect()` and `res.render()` calls
4. **Builds a directed graph** of pages (nodes) and navigation paths (edges)
5. **Starts the prototype**, crawls every page with Playwright, and takes screenshots
6. **Generates a static HTML viewer** with the graph and screenshots embedded

## Web prototypes — scenario mode

1. **Loads scenario config** from the `scenarios/` directory (`.flow` scenarios, `fragments/` for shared steps, `.set` files for groups) and optional `flow-map.config.yml`
2. **Runs static analysis** — scans templates and route handlers for enrichment metadata
3. **Starts the prototype server** and launches a headless browser
4. **For each scenario:**
   - Creates a fresh browser context (isolated cookies/session)
   - Executes setup steps (login, navigate, fill forms)
   - Maps pages via visit-driven steps or BFS crawl within scope
   - Handles interactive steps (`click`, `check`, `select`) and `snapshot` for session-dependent pages
   - Dismisses modals/overlays before capturing screenshots
   - Captures dynamically-sized screenshots (height based on actual page content)
   - Resolves redirects (e.g. `/clinics` → `/clinics/today`) to preserve edge connections
   - Computes layout ranks for grid arrangement
5. **Enriches** the runtime graph with static analysis metadata (titles, file paths, node types)
6. **Generates** a viewer, Mermaid sitemap, and metadata per scenario
7. **Optionally merges** multiple scenario graphs into a combined view

## iOS prototypes

1. **Scans** for all `.swift` files in the project
2. **Parses** each file for SwiftUI navigation patterns
3. **Builds a directed graph** of screens and navigation edges
4. **Generates a temporary XCUITest** that navigates to each screen and takes a screenshot
5. **Runs `xcodebuild test`** in the iOS Simulator, collects the PNG files
6. **Generates a static HTML viewer** with the graph and screenshots embedded

## Canonical deduplication

The tool automatically deduplicates parameterised routes. URLs like `/participants/abc123` and `/participants/def456` are recognised as the same canonical pattern (`/participants/:id`), and the crawler visits at most 3 instances per pattern. This prevents the map from exploding when there are hundreds of entity pages.

## Static enrichment

Runtime graphs are enriched with metadata from static template analysis:

- Page titles (from `{% set pageHeading %}` or `<title>`)
- File paths (which template serves each route)
- Node types (form, hub, page, start)
- Conditional branch labels

The runtime graph is always the primary source of truth — static data only supplements.
