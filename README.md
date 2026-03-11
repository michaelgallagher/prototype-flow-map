# Prototype Flow Map

Generate interactive flow maps from Express/Nunjucks prototype kit projects (NHS Prototype Kit, GOV.UK Prototype Kit, etc.).

Analyses your prototype's templates, routes, and conditional logic to produce a visual map of every screen and the connections between them — with screenshots.

![Example flowmap screenshot showing a graph of pages and connections, with a detail panel open for one page showing its screenshot and metadata](docs/assets/example-nhsapp-map.png)

## Features

- **Scenario-first mapping** — define realistic user journeys and map what users actually experience, not every possible route
- **Visit-driven mapping** — specify exact pages to visit, or let the crawler discover pages via BFS; supports interactive steps (`click`, `fill`, `check`, `select`) and `snapshot` for capturing session-dependent pages
- **Combined scenario maps** — run multiple scenarios together and produce a merged side-by-side view with shared nodes (e.g. `/dashboard`)
- **Auto-discovers all pages** from Nunjucks templates (mirrors the prototype kit's auto-routing)
- **Extracts navigation** from `href` links, `<form action>` attributes, and JS redirects
- **Detects conditional branches** (`{% if data['...'] %}` blocks wrapping different links)
- **Parses Express route handlers** for explicit redirects and renders
- **Screenshots every page** using Playwright (headless Chromium), with dynamic height based on actual page content
- **Desktop mode** — capture screenshots at 1280x800 desktop viewport instead of mobile
- **Interactive web viewer** — pan, zoom, click nodes for detail, filter by provenance, toggle global nav, search
- **Layer-cake layout** — tab groups are arranged side-by-side at each level, with the flow progressing top to bottom following visit order
- **Shareable output** — a static HTML site you can open locally or deploy anywhere
- **PDF export** — optional `map.pdf`, with full-canvas layout as default

## Prerequisites

- Node.js 20+
- The prototype you want to map must be installable and runnable via `node app.js`

## Install

```bash
cd prototype-flow-map
npm install
npx playwright install chromium
```

## Mapping modes

The tool has three mapping modes:

| Mode | Purpose | Best for |
|---|---|---|
| `scenario` | Map realistic user journeys with setup steps and scoped crawling | Prototypes with seed data, stateful flows, or complex routing |
| `static` | Broad static analysis of all templates and routes | Simple prototypes without seed data |
| `audit` | Static analysis plus runtime crawl of every discoverable page | Debugging and coverage checks |

### Scenario mode (recommended for most prototypes)

Many prototypes use seed data — without the right user, site, or entity ID in the session, pages render as broken or empty screens. Scenario mode solves this by letting you define realistic user journeys with setup steps that establish the right state before crawling.

Instead of visiting every technically reachable URL, scenario mode:
1. Runs setup steps (login, select a user, navigate to a section)
2. Begins mapping from a meaningful start point
3. Either crawls via BFS within scope, or visits an explicit list of pages (visit-driven mode)
4. Supports interactive steps and snapshots for session-dependent pages
5. Captures screenshots of pages that are valid in context, with dynamic heights

The result is an experience map, not a route inventory.

#### Quick start with scenarios

```bash
# Run a single scenario
npx prototype-flow-map /path/to/prototype --scenario clinic-workflow

# Run a named set of scenarios
npx prototype-flow-map /path/to/prototype --scenario-set core-user-journeys

# List available scenarios
npx prototype-flow-map /path/to/prototype --list-scenarios
```

#### Writing a scenario config

Create a `flow-map.config.yml` file in your prototype's root directory:

```yaml
mode: scenario

# Reusable setup sequences
fragments:
  setup.clinician:
    - type: goto
      url: /choose-user
    - type: click
      selector: "a[href*='ae7537b3']"
    - type: waitForUrl
      url: /dashboard

# Scenario definitions
scenarios:
  # Visit-driven: explicit list of pages to map
  - name: clinic-workflow
    description: Reception/clinic operational flow
    startUrl: /clinics
    scope:
      includePrefixes: [/dashboard, /clinics, /events, /reports]
      excludePrefixes: [/prototype-admin, /api, /assets]
    limits:
      maxPages: 120
      maxDepth: 12
    steps:
      - use: setup.clinician
      - type: beginMap
      - type: visit
        url: /dashboard
      - type: visit
        url: /clinics/today
      - type: visit
        url: /clinics/upcoming
      # ... more visit steps
      - type: endMap

  # Interactive: click/snapshot for session-dependent pages
  - name: reading-workflow
    description: Image reading — batch creation, mammogram review, opinions
    startUrl: /reading
    scope:
      includePrefixes: [/reading, /dashboard]
      excludePrefixes: [/prototype-admin, /api, /assets]
    steps:
      - use: setup.clinician
      - type: beginMap
      - type: visit
        url: /reading
      - type: click
        selector: "a[href*='/create-batch']"
      - type: snapshot    # captures the page the browser landed on
      - type: click
        selector: "button:has-text('Normal')"
      - type: wait
        ms: 1000
      - type: snapshot
      # ... more interactive steps
      - type: endMap

# Named groups of scenarios to run together
scenarioSets:
  core-user-journeys:
    - clinic-workflow
    - reading-workflow
```

#### Scenario step types

Steps before `beginMap` are setup-only — they establish context but don't appear in the map. Steps after `beginMap` contribute to the mapped journey.

| Step type | Fields | Description |
|---|---|---|
| `goto` | `url` | Navigate directly to a URL |
| `click` | `selector` | Click an element by CSS selector |
| `fill` | `selector`, `value` | Fill an input field |
| `select` | `selector`, `value` | Choose an option in a select element |
| `check` | `selector` | Check a checkbox or radio button |
| `submit` | `selector` | Submit a form by selector |
| `waitForUrl` | `url` | Wait for navigation to a URL (prefix match) |
| `waitForSelector` | `selector` | Wait until a selector appears |
| `wait` | `ms` | Wait a fixed number of milliseconds |
| `visit` | `url` | Visit a page and add it to the map (visit-driven mode) |
| `snapshot` | — | Capture the current page as a map node (for session-dependent pages after click/navigation) |
| `beginMap` | — | Mark where the map starts (steps before this are setup-only) |
| `endMap` | — | Optional stop marker |
| `use` | fragment name | Include a reusable fragment (e.g. `use: setup.clinician`) |

#### Fragments

Fragments let you share common setup sequences across scenarios. Define them under the `fragments` key and reference them with `use`:

```yaml
fragments:
  setup.admin:
    - type: goto
      url: /choose-user
    - type: click
      selector: "a[href='/dashboard?currentUserId=e1945412']"
    - type: waitForUrl
      url: /dashboard

scenarios:
  - name: reporting
    steps:
      - use: setup.admin
      - type: beginMap
```

#### Visit-driven vs BFS crawl mode

Within a scenario, there are two mapping modes, chosen automatically based on your steps:

- **Visit-driven** (steps include `visit` or `snapshot`): You specify exactly which pages to map. Edges are built from the actual DOM links each page contains, but only to other visited pages. This gives precise control over what appears in the map.
- **BFS crawl** (no `visit` or `snapshot` steps): The tool crawls from `startUrl`, following every in-scope link. Good for broad discovery.

Visit-driven mode is recommended for prototypes with complex routing, tabs, or pages that require specific navigation sequences.

#### Snapshot steps

For pages that depend on session state (e.g. a batch reading page created by clicking "Start session"), you can't use `visit` because the URL is dynamic. Instead, use `click` to trigger navigation, then `snapshot` to capture whatever page the browser landed on:

```yaml
steps:
  - type: click
    selector: "a[href*='/create-batch']"
  - type: snapshot    # captures the dynamically-created batch page
  - type: click
    selector: "button:has-text('Normal')"
  - type: wait
    ms: 1000
  - type: snapshot    # captures the next opinion page
```

#### Combined scenario maps

When you run multiple scenarios together (via `--scenario-set`), the tool produces:
- Individual maps for each scenario
- A combined/merged map showing all scenarios side-by-side with shared nodes (e.g. `/dashboard` appears once, connecting to both flows)

Each scenario's pages are laid out independently in the merged map, so tall pages in one scenario don't affect spacing in the other.

#### Scenario sets

Group scenarios together so you can run them all with one command:

```yaml
scenarioSets:
  core-user-journeys:
    - clinic-workflow
    - reading-workflow
    - reporting
```

```bash
npx prototype-flow-map /path/to/prototype --scenario-set core-user-journeys
```

Each scenario produces its own map with screenshots, viewer, and metadata.

#### Scope and limits

Each scenario controls what gets crawled:

- **`scope.includePrefixes`** — only follow links matching these path prefixes
- **`scope.excludePrefixes`** — never follow links matching these prefixes
- **`limits.maxPages`** — hard cap on pages visited
- **`limits.maxDepth`** — maximum link depth from the start page

#### Canonical deduplication

The tool automatically deduplicates parameterised routes. URLs like `/participants/abc123` and `/participants/def456` are recognised as the same canonical pattern (`/participants/:id`), and the crawler visits at most 3 instances per pattern. This prevents the map from exploding when there are hundreds of entity pages.

#### Static enrichment

Runtime graphs are enriched with metadata from static template analysis:
- Page titles (from `{% set pageHeading %}` or `<title>`)
- File paths (which template serves each route)
- Node types (form, hub, page, start)
- Conditional branch labels

The runtime graph is always the primary source of truth — static data only supplements.

### Static mode

The original mapping mode. Analyses templates and route handlers without running the prototype server (unless screenshots are enabled).

```bash
# Basic static analysis
npx prototype-flow-map /path/to/prototype

# Scope to specific start points
npx prototype-flow-map /path/to/prototype --from "/pages/home-p9,/pages/messages-p9"
```

The `--from` flag sets the start point for the graph. You can give multiple comma-separated paths, and the tool will arrange them left to right in the output. This is useful for tab-based prototypes where you want to show multiple entry points together.

### Audit mode

Forces a runtime crawl on top of static analysis — visits every discoverable page from the start URL. Useful for debugging and coverage checks, but the output tends to be noisy for prototypes with seed data.

```bash
npx prototype-flow-map /path/to/prototype --mode audit
```

## Options

| Option | Default | Description |
|---|---|---|
| `-o, --output` | `./flow-map-output` | Output directory |
| `-p, --port` | `4321` | Port to start the prototype server on |
| `--width` | `375` | Screenshot viewport width (pixels) |
| `--height` | `812` | Screenshot viewport height (pixels) |
| `--desktop` | — | Use desktop viewport (1280x800) instead of mobile |
| `--no-screenshots` | — | Skip screenshotting (much faster) |
| `--mode` | `static` | Mapping mode: `static`, `scenario`, or `audit` |
| `--scenario` | — | Run a single named scenario (implies `--mode scenario`) |
| `--scenario-set` | — | Run a named set of scenarios (implies `--mode scenario`) |
| `--list-scenarios` | — | List available scenarios from the config file and exit |
| `--from` | — | Only show pages reachable from these paths (comma-separated) |
| `--base-path` | — | Only include pages under this path prefix |
| `--exclude` | — | Exclude pages matching these paths (comma-separated, supports globs) |
| `--start-url` | `/` | URL to begin crawling from (static/audit modes) |
| `--runtime-crawl` | `false` | Add runtime DOM link extraction to static mode |
| `--name` | prototype folder slug | Map folder slug (lowercase alphanumeric + hyphens) |
| `--title` | prototype folder name | Human-readable map title shown in index |
| `--export-pdf` | `false` | Generate a PDF of the flow map (`map.pdf`) |
| `--pdf-mode` | `canvas` | PDF mode: `canvas` (full-canvas) or `snapshot` (A3 fit-to-screen) |
| `--platform` | auto-detected | Project platform: `web` or `ios` |
| `--no-open` | — | Don't automatically open the viewer in a browser |

## Output

The tool generates a folder (default `./flow-map-output/`) containing:

```
index.html           # Collection index (lists all maps)
styles.css           # Shared styles
viewer.js            # Shared viewer JavaScript
maps/                # Subfolders for each generated map
  <map-name>/
    index.html       # Interactive viewer (open this)
    graph-data.json  # Raw graph data (nodes + edges with provenance)
    sitemap.mmd      # Mermaid text-based graph definition
    meta.json        # Map metadata
    map.pdf          # PDF export (if --export-pdf)
    screenshots/     # PNG screenshot of every page
```

## Viewer controls

- **Pan**: Click and drag the background
- **Zoom**: Scroll wheel, or use the + / − buttons
- **Fit to screen**: Reset the view to fit all nodes
- **Click a node**: Opens a detail panel with screenshot, metadata, incoming/outgoing edges, and provenance badges
- **Search**: Type to filter pages by name or URL path
- **Filter by hub**: Use the dropdown to show only pages in a specific section
- **Toggle labels**: Show/hide edge labels and conditions
- **Toggle global nav**: Show/hide global navigation edges (hidden by default in scenario mode to reduce clutter)
- **Provenance filter**: Filter edges by source — runtime only, static only, or both
- **Show/hide screenshots**: Toggle between screenshot view and compact node view
- **Thumbnail mode**: Switch between full-page screenshots and compact thumbnails
- **Drag nodes**: Click and drag any node to reposition it (positions are saved in your browser)
- **Hide nodes**: Click a node, then use the "Hide this page" button to remove it from view

## iOS / SwiftUI projects

The tool also supports native iOS prototypes built with SwiftUI. It auto-detects iOS projects (by looking for `.xcodeproj` / `.xcworkspace` files) or you can force it with `--platform ios`.

```bash
npx prototype-flow-map /path/to/your/ios-prototype --platform ios
```

It parses your Swift source files for navigation patterns (`NavigationLink`, `NavigationStack`, `TabView`, `.sheet()`, `.fullScreenCover()`, custom `RowLink` / `HubRowLink` components) and builds a graph of all screens. Screenshots are captured by generating a temporary XCUITest that launches the app in the simulator, navigates to each screen, and takes a screenshot.

### Requirements for iOS

- Xcode installed (with iOS Simulator)
- The project must have a UI Testing Bundle target (e.g. `MyAppUITests`)
- At least one `.swift` file in the UITest target (the tool temporarily replaces it)

### Config file (`.flow-map.json`)

For screens the auto-detection can't handle — data-dependent UI, custom button components, item-based sheets — you can place a `.flow-map.json` file in the prototype root. The tool picks it up automatically.

```json
{
  "exclude": [
    "SomeEmbeddedComponent",
    "AnotherNonScreen"
  ],
  "overrides": {
    "AppointmentDetailView": {
      "steps": [
        "tap:Appointments",
        "tap:Manage GP appointments",
        "tapContaining:Appointment on"
      ]
    }
  }
}
```

#### `exclude`

An array of view names to remove from the graph entirely. Use this for embedded components that the parser picks up as screens but aren't actually navigable destinations.

#### `overrides`

A map of view name to custom test steps. Each step is a string in the format `command:arguments`.

| Step | Example | Description |
|---|---|---|
| `tap:Label` | `tap:Appointments` | Tap a button or element matching this label |
| `tapTab:Label:index` | `tapTab:Messages:1` | Tap a tab bar button by label and index (zero-based) |
| `tapContaining:text` | `tapContaining:Appointment on` | Tap the first element whose label contains this text |
| `tapCell:index` | `tapCell:0` | Tap a list cell by index (zero-based) |
| `tapSwitch:index` | `tapSwitch:0` | Tap a toggle/switch by index |
| `swipeLeft:firstCell` | `swipeLeft:firstCell` | Swipe left on the first cell |
| `swipeLeft:index` | `swipeLeft:2` | Swipe left on a cell at a specific index |
| `wait:seconds` | `wait:1.5` | Wait for a number of seconds |

## How it works

### Web prototypes (static mode)

1. **Scans** `app/views/` for all `.html` template files
2. **Parses** each template for `href=`, `action=`, `location.href`, `{% set backLinkURL %}`, and `{% if %}` conditional blocks
3. **Parses** `routes.js` and `app.js` for explicit `res.redirect()` and `res.render()` calls
4. **Builds a directed graph** of pages (nodes) and navigation paths (edges)
5. **Starts the prototype**, crawls every page with Playwright, and takes screenshots
6. **Generates a static HTML viewer** with the graph and screenshots embedded

### Web prototypes (scenario mode)

1. **Loads scenario config** from `flow-map.config.yml` in the prototype root
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
   - Builds a runtime graph with layout ranks for layer-cake arrangement
5. **Enriches** the runtime graph with static analysis metadata (titles, file paths, node types)
6. **Generates** a viewer, Mermaid sitemap, and metadata per scenario
7. **Optionally merges** multiple scenario graphs into a combined side-by-side view

### iOS prototypes

1. **Scans** for all `.swift` files in the project
2. **Parses** each file for SwiftUI navigation patterns
3. **Builds a directed graph** of screens and navigation edges
4. **Generates a temporary XCUITest** that navigates to each screen and takes a screenshot
5. **Runs `xcodebuild test`** in the iOS Simulator, collects the PNG files
6. **Generates a static HTML viewer** with the graph and screenshots embedded
