# Plans

## Current state

The tool generates interactive flow maps from prototype projects. It supports three platforms and four execution modes.

### Platforms

- **Web (scenario mode)** — scenario-driven runtime mapping with Playwright. The primary mode for complex, seed-data-driven prototypes. Produces maps that reflect actual user journeys rather than route inventories.
- **Web (record mode)** — interactive recording via a headed browser. The user clicks through the prototype while the tool captures screenshots, links, and interactions in real-time. Outputs a flow map viewer and a `.flow` script for replay/editing.
- **Web (static mode)** — static analysis of Nunjucks templates and Express route handlers. Useful for simple prototypes without seed data or session state.
- **iOS** — static analysis of SwiftUI navigation patterns. Generates XCUITests for screenshots.

### Execution modes

| Mode | Trigger | What it does |
|---|---|---|
| `record` | `--record` | Headed browser, real-time capture, builds map on finish |
| `scenario` | `--scenario` or `--scenario-set` | Headless Playwright, runs `.flow` scripts, visit-driven or BFS |
| `static` | Default (no config) | Template + route parsing, broad screenshot crawl |
| `audit` | `--mode audit` | Broad discovery / exhaustive crawl for debugging |

### Scenario authoring format

Scenarios evolved from an initial YAML-only proposal to a **`.flow` DSL** as the primary authoring format. The `.flow` format is flat, readable, and version-control friendly:

```
# scenarios/clinic-workflow.flow
# Reception/clinic operational journey

Start /dashboard

--- Setup ---

Use setup.clinician

--- Map ---

Visit /dashboard
Visit /clinics/today
Click "a[href*='/events/']"
Snapshot
```

- One `.flow` file per scenario in a `scenarios/` directory
- Fragments in `scenarios/fragments/*.flow`
- Scenario sets in `scenarios/*.set`
- Optional `flow-map.config.yml` for global settings (canonicalization, filters)
- A sample config is in `docs/planning-materials/flow-map.config.sample.yml`

Full documentation: [scenarios.md](../scenarios.md), [recording.md](../recording.md), [cli-reference.md](../cli-reference.md)

---

## Design rationale

### Why scenario-first runtime mapping

Testing on `manage-breast-screening-prototype` showed that broad runtime crawling produced:
- too many technically reachable but contextually invalid screens
- black/empty screenshots from pages visited without required session state
- global-nav noise dominating the graph
- output that looked like a route inventory, not a user journey map

Scenario-first mapping solves this by:
- starting from realistic entry points with real session/seed state
- crawling only from valid in-scenario navigation
- building one focused map per scenario
- optionally merging scenarios into combined views

### Why static analysis is still useful

Static parsing plays a supporting role:
- route discovery and template metadata (titles, file paths, node types)
- conditional branch labels from `{% if %}` blocks
- enrichment of runtime graphs via `src/static-enrichment.js`
- standalone mode for simple prototypes that don't need scenarios

### Why the `.flow` DSL replaced YAML-only scenarios

The initial design used YAML for everything. In practice:
- YAML's indentation requirements made step sequences verbose
- One-file-per-scenario in `.flow` format is easier to scan and review in diffs
- The flat `Goto`/`Click`/`Visit`/`Snapshot` syntax reads more naturally than nested YAML
- YAML config remains useful for global settings, but scenarios themselves are better as `.flow`

---

## Delivery history

All six phases of the original roadmap have been completed:

1. **Scenario-first design** — scenario model, config format, mode separation
2. **Canonicalization and noise reduction** — ID/UUID/date collapse, global nav classification, edge upgrading
3. **Scenario execution engine** — `.flow` parser, scenario runner, visit-driven + BFS modes, snapshot steps, redirect resolution, grid-based layout
4. **Viewer experience** — rank-stacked layout, combined maps, provenance filter, global nav toggle
5. **Broad crawl as debug mode** — `audit` mode preserved for engineering investigation
6. **Validation** — six scenarios tested against `manage-breast-screening-prototype`

Additionally:
- **Interactive recording** — `--record` mode with headed browser, toolbar UI, real-time capture, `.flow` script output
- **iOS support** — SwiftUI parser, XCUITest screenshot generation, native viewer with edge/node type styling

---

## Key files

- `bin/cli.js` — CLI with `--record`, `--scenario`, `--scenario-set`, `--desktop`, `--list-scenarios`, `--platform`
- `src/index.js` — orchestration: scenario pipeline, multi-scenario merging, output generation
- `src/recorder.js` — interactive recording orchestrator: headed browser, real-time capture, graph building, `.flow` output
- `src/recorder-inject.js` — browser-side script: toolbar UI, interaction capture, step type resolution
- `src/flow-serializer.js` — converts recorded steps to `.flow` file text (inverse of `flow-parser.js`)
- `src/scenario-runner.js` — Playwright-based scenario execution: setup steps, visit-driven mapping, snapshot, BFS crawl, redirect resolution, layout rank computation
- `src/crawler.js` — DOM link extraction, canonicalization, global nav classification, screenshot capture, modal dismissal, server lifecycle
- `src/static-enrichment.js` — enriches runtime graphs with static template metadata
- `src/flow-parser.js` — `.flow` DSL parser: scenarios, fragments, scenario sets
- `src/flow-map-config.js` — config loading (YAML/JSON + `.flow` files), scenario/fragment/step validation
- `src/build-viewer.js` — HTML viewer with grid-based layout, per-scenario row heights, edge filtering
- `src/graph-builder.js` — static graph construction, provenance metadata
- `src/swift-scanner.js` — iOS: scans `**/*.swift`, excludes test files
- `src/swift-parser.js` — iOS: parses SwiftUI views for navigation patterns
- `src/swift-graph-builder.js` — iOS: builds graph from parsed view data

---

## Future plans

### 1. iOS + web prototype joining
The native iOS prototype accesses web prototype pages for specific journeys (via `WebView` and `CustomWebView`). The goal is to map both iOS and web parts together, showing the full picture including web screens reached from the native app.

Phases:
- Extract WebView URLs as cross-prototype entry points
- Stitch native + web graphs when a WebView URL matches a web prototype page

### 2. Saving layout positions
Allow users to persist node layout adjustments across sessions and devices. See `saving-layout-positions.md` for the full design exploration.

### 3. Automated tests
- Tests for scenario runner, config validation, and `.flow` parser
- Improve error recovery when interactive steps fail mid-scenario

---

## Open design questions

- Should the tool auto-detect visit-driven vs BFS mode, or should it be explicit in config?
- Should merged maps support more than two scenarios side-by-side?
- Should there be a way to define shared "anchor" nodes across scenarios beyond automatic dedup?
- How should cross-prototype stitching work when a WebView URL in the iOS app matches a web prototype page?

---

## Success criteria

The scenario-first approach is successful if:
- Maps look like real user journeys, not route dumps
- Screenshots are mostly valid and meaningful
- Seed-data-driven flows are visible without graph explosion
- Global-nav links no longer dominate the graph
- Scenario outputs are understandable by product/design/engineering stakeholders
