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

### 1. Native + web prototype joining — **MVP delivered**

Native (iOS + Android) prototypes link out to hosted web prototypes (NHS Prototype Kit apps on Heroku) for parts of the user journey — e.g. GP appointment booking, repeat prescriptions, 111 emergency-prescription flows. We now crawl those web journeys and splice them into the native flow map so the map reads as one continuous experience.

**What's live** (commits 1 → 3d → 4, opt-in via `--web-jumpoffs`):

- `src/kotlin-parser.js` / `src/swift-parser.js` detect the full set of native→web handoff patterns: `openTab`, `InAppBrowser`, `CustomTabsIntent.Builder`, `UIApplication.shared.open`. Kotlin also resolves `WebFlowConfig(url = "$BASE_URL/...", title = "...")` indirection (`const val` harvest + `object Name { ... }` qualification + `val X = WebFlowConfig(...)` binding → assignment resolution via `activeWebFlow = PrescriptionWebFlow.X`).
- `src/web-jumpoff-crawler.js` — Playwright BFS. Two-phase budget strategy: (1) every seed across every origin gets its root visited first, (2) round-robin BFS expansion across origin queues until `maxPages` exhausts. Prevents wide-branching origins from starving the rest.
- `src/splice-web-subgraphs.js` — upgrades existing native `external` / `web-view` nodes in place (type → `web-page`, id normalised to canonical form, pre-existing edges retargeted, `nativeHandoffType` preserved). Then BFS-propagates `subgraphOwner` + `layoutRank` from each upgraded root to its descendants so the column-packed viewer layout places the whole web subgraph under its native handoff.
- `src/build-viewer.js` — `.node-rect--web-page` styling, `.subgraph-root` heavier stroke on the handoff root, overflow column for any node that slips through without a rank (with `console.warn`, not silent).
- `src/flow-map-config.js` — `webJumpoffs` config block (enabled, maxDepth, maxPages, timeoutMs, sameOriginOnly, screenshots, allowlist).
- `bin/cli.js` — `--web-jumpoffs` / `--no-web-jumpoffs` tri-state override.

**Verified** on `~/Repos/native-nhsapp-android-prototype/DemoNHSApp2`: 12 native jump-offs upgraded, 28 BFS-discovered pages added, 460+ link edges, all with screenshots, all positioned in-column under their native handoff.

### 1a. Web journey tuning — **delivered**

The MVP rendered the full journey; this round polished how each web screen looks inside the map.

**Task 1 — uniform aspect ratio on web screenshots — done.** `src/web-jumpoff-crawler.js` now passes `clip: { x: 0, y: 0, width, height }` and `fullPage: false` to `page.screenshot`, with width/height drawn from the run's viewport (defaults to 375×812 at deviceScaleFactor 2 → 750×1624 PNG). Web thumbnails sit in a row alongside native portrait screens without visually dominating it.

**Task 2 — strip web chrome from web screenshots — done.** Implemented as a CSS init script (Playwright's `context.addInitScript({ content })`, equivalent to iOS's `WKUserScript(.atDocumentStart)` and stricter than Android's `onPageFinished` because chrome never paints). The injected stylesheet has two layers:

1. **Production parity rules** mirror the four CSS declarations the real native InAppBrowser injects (`.hide-on-native { display:none }`, plus three NHS prototype-kit padding/margin tweaks). On hosted prototypes that wrap their chrome in `<div class="hide-on-native">` (e.g. `native-nhsapp-prototype-web-test`), this is sufficient.
2. **Belt-and-braces selectors** target the well-known NHS prototype-kit chrome classes/ids directly (`.app-global-navigation-native`, `.app-bottom-navigation`, `#bottomNav`, `.nhsuk-header`, `.nhsuk-footer`, plus `#nhsuk-cookie-banner`/`.nhsuk-cookie-banner` for nhs.uk pages). Needed because some hosted prototypes (e.g. `nhsapp-prototype-prescriptions`) render the same chrome raw without the wrapper. Selector-only — safe no-op on prototypes that don't use these conventions.

Why CSS injection over UA matching: tested production-style UA strings (`NHSApp/native`, Android+suffix, iOS+suffix) against the deployed prototypes and none hid the chrome — the hosted apps don't actually sniff UA, the production InAppBrowser injects CSS post-load. Mirroring the CSS path is the same code path production uses, with the belt-and-braces additions to handle prototype variation.

One subtlety the implementation accounts for: chromium's init scripts fire before `document.documentElement` exists, so a naive `(document.head || document.documentElement).appendChild(style)` throws `Cannot read properties of null` and silently aborts. The implementation retries from `readystatechange`, `DOMContentLoaded`, and a `MutationObserver` on `document` until a target node is available.

Config knobs (`webJumpoffs.hideNativeChrome` defaults true, `webJumpoffs.injectCss` for project-specific extra rules) are validated in `src/flow-map-config.js`.

Verified on `~/Repos/native-nhsapp-android-prototype/DemoNHSApp2`: 40 web screenshots, all 750×1624, no visible header/bottom nav/cookie banner across the GP appointment, prescriptions, and `nhs.uk` mental-health pages.

### 1b. Follow-ups deferred from the MVP

- **iOS parser parity for enum-switched URL indirection — done.** `src/swift-parser.js` gained `parseSwiftProject(swiftFiles, projectPath)`, a two-pass entry point modelled on Kotlin's. Pass 1 walks every `.swift` file and populates a project-wide `urlBindings` map from `enum X: ..., WebFlowConfig { var url: URL { switch self { case .name: URL(string: "...")! } } }` declarations (both the implicit-return Swift 5.9+ form and explicit `return`); the optional `var title: String { switch self { ... } }` body supplies labels. Pass 2 calls the existing per-file parser with bindings threaded through to `extractWebLinks`, which now resolves `activeCover = .caseName` assignments — using `@State var foo: SomeEnum?` declarations to qualify the lookup so two enums sharing a case name don't collide. The `struct X: WebFlowConfig` form (e.g. `MessageWebFlow`) is still skipped because its URL is constructor-bound at runtime. Verified on `~/Repos/nhsapp-ios-demo-v2`: 7 previously-invisible URLs now land as subgraph roots (4 from `PrescriptionFlow`, 2 from `CheckPrescriptionFlow`, 1 from `PrototypeSettingsFlow`), bringing iOS native jump-offs from ~11 to 18 with no false positives.
- **Cross-map crawl caching — done.** New `src/web-jumpoff-cache.js` module with per-page granularity. Cache key is `sha256(canonicalUrl + config-fingerprint)`; the fingerprint covers viewport, `hideNativeChrome`, `injectCss`, and `screenshots` toggle (the fields that affect a single page's captured output) — `maxDepth`/`maxPages`/`timeoutMs`/`allowlist` are excluded because they only affect BFS shape. Cache lives at `$XDG_CACHE_HOME/prototype-flow-map/web-pages/` (default `~/.cache/...`); each entry is a small JSON of `{ label, urlPath, children, cachedAt }` plus a copy of the screenshot PNG. Per-page rather than per-origin because seed sets differ between platforms — this way any URL overlap is reused regardless of how the seeds differ. Errors aren't cached (they retry each run). 24h TTL by default. Best-effort `pruneExpired` housekeeping pass on every run. Wiring: `webJumpoffs.cache: { enabled, ttlMs, dir }` in config, `--no-web-cache` and `--clear-web-cache` CLI flags. Verified: warm-cache run is ~44× faster on screenshots-on (5.4s → 124ms in a 6-page benchmark) with byte-identical PNGs; cross-platform iOS→Android run hits the cache 27/40 times (67%) for shared NHS prototype origins. Stats line `Cache: N hit(s), M miss(es)` printed during the crawl phase.
- **Interactive crawl for form-gated journeys.** Shallow `<a href>` BFS misses content behind a form submit. If a journey turns out to be form-driven (e.g. "Start now" is a POST), layer a scenario-style driver on top of the crawler. Not a blocker today — the current MVP captures the structural skeleton.

### 2. Saving layout positions
Allow users to persist node layout adjustments across sessions and devices. See `saving-layout-positions.md` for the full design exploration.

### 3. Automated tests
- Tests for scenario runner, config validation, and `.flow` parser
- Improve error recovery when interactive steps fail mid-scenario

### 4. Run-time counter and last-run duration display

Show elapsed time in the terminal output while the tool is running, and report the duration of the last run at the start of a new one.

**Intent:**
- Running counter (e.g. `[12s]`) updated in-place on the terminal as the tool progresses through its phases — useful for spotting where time is spent without adding verbose logging.
- On subsequent runs, print something like `Last run: 4m 23s` at the top so the user can immediately see if the new run is faster or slower than the previous one.

**Implementation sketch:**
- Persist run duration to a small JSON sidecar (e.g. `~/.cache/prototype-flow-map/last-run.json`, keyed by prototype path so iOS and Android runs are tracked separately).
- Terminal in-place update via `process.stdout.write` with `\r` (or a lightweight `cli-progress` / `ora` spinner if we already have one in `devDependencies`).
- Phase-level timing would be most useful: show time spent in parse / screenshot / crawl / splice / build-viewer phases separately.

### 5. Build a server

Expose a local HTTP server for the flow map viewer so the browser has a real origin (enabling `localStorage`, `fetch`, future API calls) and positions can be saved persistently without relying on the file system from the viewer JS.

**What's already done (branch `build-a-server`):**
- `src/server.js` — 117-line Express server. Serves the output directory statically. REST API: `GET /api/health`, `GET /api/maps/:name/positions`, `PUT /api/maps/:name/positions`. Writes `positions.json` per map. Input-validated map name and positions payload. Port 3000.
- A second commit (`fix the spacing issue of multiple subgraphs in static analysis`) is also on this branch — needs pulling across to `main` independently.

**Still needed:**
- CLI wiring: `--serve` flag (or auto-launch after generation, with a `--no-serve` opt-out).
- Viewer-side: positions persistence currently lives in `localStorage`; needs to call `PUT /api/maps/:name/positions` when the server is up, fall back to `localStorage` when it's not.
- Decide on lifecycle: long-running foreground process (user `Ctrl-C`s when done) vs. background daemon with a `--stop-server` flag.
- Figure out how server mode interacts with `--web-jumpoffs` and other long-running phases (server probably starts after generation finishes).

### 6. Investigate Android vs iOS speed disparity

Android prototype runs complete noticeably faster than iOS runs, even on comparable prototypes. Understand why and identify whether the iOS path can be brought closer to Android speed.

**Hypotheses to explore:**
- `xcodebuild test` spin-up cost — Simulator boot, app build, and test runner launch are all sequential. Android uses `am instrument` directly on an already-installed APK, skipping the equivalent of `xcodebuild`. The build step alone may account for most of the gap.
- Screenshot capture mechanism — iOS uses XCUITest (`captureToImage()` via `onRoot()`), Android uses Compose's `captureToImage()` directly. Both are in-process, but XCUITest has heavier framework overhead.
- Per-screen navigation — iOS relies on SwiftUI's navigation stack (real UI state changes), Android uses `navController.navigate()` directly. UI-driven navigation may be slower and less reliable under test.
- Parallelism — iOS runs each screen sequentially inside a single XCUITest. Android does the same. Neither parallelises across screens. Parallelism may not be viable without multiple Simulator instances, which have their own cost.

**First step:** instrument the iOS path with per-phase timing (ties into item 4 above) to measure how much time is spent in: (a) `xcodebuild test` (including Simulator boot), (b) `adb pull` equivalent / XCTest attachment extraction, (c) graph building and viewer generation. Compare phase-by-phase with an Android run of similar size.

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
