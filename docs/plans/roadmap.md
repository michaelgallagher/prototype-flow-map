# Roadmap

> Active workstreams for prototype-flow-map. Each section is self-contained — a fresh contributor (human or AI) should be able to pick one up without reading the others.

## Shared context

prototype-flow-map is a CLI tool that generates interactive flow maps from prototype projects. Three platforms (iOS, Android, Web), four execution modes (`scenario`, `record`, `static`, `audit`), and an opt-in web jump-off crawler that splices hosted web journeys into native flow maps. Output is a static HTML viewer (Dagre layout, vanilla JS) plus a JSON graph and screenshots.

Code orientation:
- `bin/cli.js` — CLI entry point
- `src/index.js` — pipeline orchestration (`generate` for web, `generateNative` for iOS/Android)
- `src/build-viewer.js` — both the build-time HTML/CSS/JS generator and the viewer's runtime JS (embedded as a string template)
- `src/server.js` — Express server (cherry-picked from `build-a-server`, `serve` subcommand wired up)
- `src/swift-parser.js` / `src/kotlin-parser.js` — native parsers
- `src/web-jumpoff-crawler.js` / `src/web-jumpoff-cache.js` / `src/splice-web-subgraphs.js` — the web jump-off pipeline
- `src/scenario-runner.js`, `src/recorder.js`, `src/crawler.js` — web pipeline

For full architecture see [`../how-it-works.md`](../how-it-works.md).

## Sequencing

The four workstreams are roughly ordered by user value × ease of delivery:

| Order | Workstream | Why this position |
|---|---|---|
| 1 | [Node hiding](#workstream-1--node-hiding) | Unblocks the user immediately on web-jump-off-heavy maps; viewer-only, no dependencies |
| 2 | [Tree-shaped layout (Part A)](#workstream-2--tree-shaped-layout) | Quick win, fixes a long-standing iOS issue, ~20-line change |
| 3 | [Server integration](#workstream-3--server-integration) | Upgrades WS1's localStorage persistence to shared/durable; server module already exists |
| 4 | [iOS speed (Phases 1-2)](#workstream-4--ios-speed) | High value, Phase 1 needed before any optimisation |
| 5 | Tree-shaped layout (Part B) | Deeper, needs iOS graph structure analysis |
| 6 | iOS speed (Phase 3) | Only if Phases 1-2 are insufficient |

---

## Workstream 1 — Node hiding

### Context

Web jump-offs surface dozens of pages from hosted NHS prototypes. Many of them are technically reachable but contextually irrelevant for what the user is reviewing — and the relevance is something only the user knows (it depends on what's being tested in the prototype, which is invisible from code structure). The user wants to right-click → hide a node so the map shows only the journey they care about.

The viewer already has a `hiddenNodes` Set used by `layoutGraph()` in `src/build-viewer.js`:

```js
const filteredNodes = graph.nodes.filter(n => {
  if (hiddenNodes.has(n.id)) return false;
  // ...
});
```

So the in-memory infrastructure is in place. What's missing: (a) a user gesture to add to the set, (b) persistence so it survives reload, (c) a UI to restore hidden nodes.

### Approach

Right-click any node → context menu with two options:

1. **Hide node** — adds the single node ID to `hiddenNodes` and re-renders.
2. **Hide subgraph** (only shown if the node has descendants) — BFS down the forward edges, adds every reachable descendant, re-renders. Show count: "Hide subgraph (12 descendants)".

A toolbar badge shows hidden count: `Show hidden (0)` (already present in the viewer; currently hidden via `style="display:none"`). Clicking opens a popover listing hidden nodes by label, each with a "Restore" button, plus a "Restore all" button.

Persist to `localStorage` keyed by `flow-map:hidden:<mapName>` where `mapName = window.__MAP_NAME__` (already in scope after the server cherry-pick).

### Files to change

| File | Change |
|---|---|
| `src/build-viewer.js` | Add right-click handler to node `<g>` elements (currently no right-click behaviour). Add context-menu HTML/CSS/JS. Add restore-all popover. Wire `hiddenNodes` to localStorage with key `flow-map:hidden:<mapName>`. Update the existing `Show hidden` button to open the popover instead of just toggling. |

No backend, no pipeline changes, no new files.

### Implementation details

**Subgraph descendant collection.** The viewer already builds forward adjacency for subgraph assignment (around line 890 of `build-viewer.js`). Reuse it:

```js
function collectDescendants(rootId) {
  const out = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    if (out.has(id)) continue;
    out.add(id);
    (forwardAdj[id] || []).forEach(t => queue.push(t));
  }
  out.delete(rootId);  // caller adds the root explicitly
  return out;
}
```

**localStorage shape.** Single key per map:

```json
{ "/some/path/id1": true, "node-id-2": true }
```

Object instead of array so adds/removes are O(1) and shape matches the in-memory `Set` semantics. Load on viewer init, write on every change.

**Context menu.** Use a single floating `<div id="node-context-menu">` positioned at the click coordinates. CSS `position: absolute`, `z-index: 1000`. Hide on outside click. Disable browser default context menu via `e.preventDefault()` on the `contextmenu` event.

**Re-render on change.** Call `layoutGraph()` then `render()` after any change. The existing `resetPositions()` and `showAllNodes()` paths already do this — match their pattern.

### Verification

1. Generate a map with `--web-jumpoffs` against the Android smoke target.
2. Right-click a node → "Hide node" → confirm node disappears, edges to it are hidden, layout reflows.
3. Right-click a subgraph root → "Hide subgraph (N descendants)" → confirm whole subtree disappears.
4. Reload → confirm hidden state persists.
5. Click `Show hidden (N)` → popover lists hidden nodes by label → click "Restore" → confirm node returns and layout reflows.
6. Click `Restore all` → confirm all hidden nodes return.
7. Open the same map in a different browser → confirm hidden set is empty there (localStorage is per-browser; server-backed persistence comes in WS3).

### Out of scope

- Server-backed persistence — covered by [Workstream 3](#workstream-3--server-integration).
- Hide-by-pattern (e.g. "hide all `nhs.uk` pages") — useful but a separate workstream.
- Sharing hidden-node sets via URL — separate workstream.

---

## Workstream 2 — Tree-shaped layout

### Context

When iOS prototypes are run through the tool, the resulting map is a centred blob: most nodes pile vertically into one column instead of forming a proper tree. Web and Android prototypes don't have this problem because the tool detects tab patterns (NavHost bottom-nav for Android, mutual cross-link tab siblings for web), assigns `subgraphOwner` per tab, and the viewer's column-packed layout puts each tab's content under its own column. iOS doesn't have an equivalent tab pattern detector.

The root cause is in `src/build-viewer.js` `layoutGraph()`. Three branches:
- `hasRanks=true, hasOwners=true` — column-packed (good; what Android/web use)
- `hasRanks=true, hasOwners=false` — falls to "center every rank row at same X" (the blob; what iOS hits)
- `hasRanks=false` — pure dagre TB layout (good; what very simple prototypes hit)

Dagre's own TB layout is already computed (line 714 — `dagre.layout(g)`); the bug is that the `!hasOwners` branch throws away dagre's X positions and replaces them with a global centre.

### Approach

**Two parts.** Part A is a small, mechanical fix that immediately improves iOS maps. Part B is the deeper inference layer that brings iOS toward parity with tab-detected platforms. Ship Part A first.

#### Part A — use dagre's X positions when `!hasOwners`

In the `!hasOwners` branch (around line 863 of `build-viewer.js`), keep our rank-based Y stacking but trust dagre's X positions instead of computing a global centre. Dagre laid out the actual edges with `rankdir: 'TB'`, so its X positions reflect tree structure.

```js
} else {
  // No subgraph owners — use dagre's X positions (which reflect tree structure)
  // and only override Y to match our rank stacking. Keeping dagre's X means
  // children sit under their parents instead of all at the same global centre.
  // Y was already set per rank earlier in this function.
  // (no-op for X — dagre's positions are already on layoutNodes from g.node(id))
}
```

The current "compute rowWidths, find maxWidth, set centerX, walk each rank, divide and centre" logic gets deleted. Y has already been set per-rank earlier in the same function (around line 765-776), so we just leave X alone and the result is dagre's X with our Y.

This is gated on `!hasOwners`, so platforms that DO detect owners (Android with bottom-nav, web with tab siblings) are unaffected.

#### Part B — generalised virtual subgraph-owner inference

A platform-agnostic pass in `src/graph-builder.js` (or a new `src/virtual-subgraph-inference.js`) detects hub-shaped graphs and assigns virtual subgraph owners.

Heuristic:
1. Identify the root node (`isStartNode === true`, or the unique node with zero incoming non-nav edges).
2. Collect the root's direct outbound forward edges (excluding nav edges, excluding edges to itself).
3. If there are 2+ such edges and each target has 2+ descendants of its own, treat each target as a virtual subgraph owner.
4. Run BFS from each virtual owner, assigning `subgraphOwner` to each reachable descendant. Where a node is reachable from multiple owners, pick the closest by edge count; tiebreak by `startOrder`.
5. Skip the pass if any node already has `subgraphOwner` set (i.e. a real platform tab pattern was detected — don't override).

After this pass, iOS maps without tabs get the same column-packed treatment as Android maps with tabs.

### Files to change

| File | Change |
|---|---|
| `src/build-viewer.js` | Part A: replace ~25 lines in the `!hasOwners` branch of `layoutGraph()` with a comment explaining we keep dagre's X. |
| `src/graph-builder.js` | Part B: new exported function `inferVirtualSubgraphOwners(graph)`, called from `src/index.js` for all platforms after platform-specific parsing finishes but before splicing/screenshot phases. Skips if any node has `subgraphOwner`. |
| `src/index.js` | Part B: invoke the new pass at the right point in both `generate` and `generateNative`. |

### Verification

**Part A:**
1. Run iOS smoke target (`~/Repos/nhsapp-ios-demo-v2`) without web jump-offs. Open the viewer.
2. Confirm: nodes form a tree shape — children sit under their parents, siblings spread horizontally.
3. Run the Android smoke target. Confirm: layout is unchanged (still column-packed by tabs).
4. Run a web scenario test (e.g. `manage-breast-screening-prototype`). Confirm: layout is unchanged.
5. Inspect three iOS run viewers' `graph-data.json` and node X positions to confirm dagre's X positions came through.

**Part B:**
1. Run iOS smoke target. Confirm: top-level iOS views (e.g. `PrescriptionsView`, `AppointmentsView`, `MessagesView`) each get their own column. Their descendants sit under them.
2. Run Android smoke target. Confirm: layout is unchanged (skip-pass triggered because `subgraphOwner` was already set by Kotlin parser).
3. Inspect `graph-data.json` to confirm virtual `subgraphOwner` values appear on iOS nodes.

### Out of scope

- Reingold-Tilford / proper subtree-width-aware layout — bigger rewrite, only justified if Part A+B aren't enough.
- Hierarchical clustering for very large graphs (>200 nodes) — separate workstream.
- Auto-detecting tab patterns in iOS code (`TabView`, custom tab containers) — would replace virtual inference for iOS specifically; useful but not blocking.

---

## Workstream 3 — Server integration

### Context

`src/server.js` (Express, REST API) and the `serve` subcommand landed via cherry-pick from the `build-a-server` branch. Currently:
- `GET /api/health` works
- `GET/PUT /api/maps/:name/positions` works (positions persisted to `positions.json` per map)
- `Save layout` button exists in the toolbar but isn't yet wired to call the API
- The viewer reads `__SAVED_POSITIONS__` from disk at build time but doesn't fetch from the server at viewer load time
- `--serve` is NOT yet an option on the main generate command — you have to run `prototype-flow-map serve <output-dir>` as a separate step

For Workstream 1 (node hiding) to graduate from localStorage-only to shared/durable, the server needs a `/hidden` endpoint and the viewer needs server-fallback logic.

### Approach

Three pieces:

1. **`/hidden` endpoint pair.** Mirror the `positions` endpoints. Validation: hidden is `{ [nodeId]: true }`. Persist to `hidden.json` per map.

2. **Viewer-side server detection + fallback.** On viewer init, `fetch('/api/health')` with a short timeout (1500ms). On success, set `isServeMode = true` and fetch positions + hidden via the API; on failure or timeout, fall back to `localStorage`. Saves go to whichever persistence is active. (Position-loading priority is already documented in `archive/webapp-collaboration.md` — implement that.)

3. **`--serve` flag on the main command.** Adds `--serve` (default `false`) to the main generate command. When set, after generation completes, the tool:
   - Starts the Express server in-process via `startServer({ outputDir, port })`
   - Opens the browser to the server URL
   - Logs `"Press Ctrl+C to stop"` and waits for SIGINT

Optionally `--no-open` already exists and should be respected.

### Files to change

| File | Change |
|---|---|
| `src/server.js` | Add `GET /api/maps/:name/hidden` and `PUT /api/maps/:name/hidden` endpoints. Mirror the positions endpoints' validation pattern. |
| `src/build-viewer.js` | Viewer JS: add `detectServeMode()` doing `fetch('/api/health', { signal: timeoutSignal })`. Add `loadFromServer()` and `saveToServer()` for positions and hidden. Update the existing `Save layout` button — show only in serve mode (already gated via `style="display:none"` initially, just unhide on serve detect). Update `hiddenNodes` localStorage save to also call `saveToServer` if in serve mode. |
| `bin/cli.js` | Add `--serve` option to the main generate command. After generation, if set, call `startServer(...)` and open browser. |

### Implementation details

**`/hidden` endpoint validation.** The hidden payload is simpler than positions — just `{ nodeId: true }`. Add an `isValidHidden` helper next to the existing `isValidPositions`:

```js
function isValidHidden(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  for (const [key, value] of Object.entries(data)) {
    if (typeof key !== "string" || value !== true) return false;
  }
  return true;
}
```

**Viewer fetch with timeout.** Use `AbortController`:

```js
async function detectServeMode() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch('/api/health', { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
```

**`--serve` lifecycle.** The simplest approach: foreground process, blocks on `process.on('SIGINT')` until the user hits Ctrl+C. No daemon mode in this workstream — that's a future-ideas item if it turns out to be needed.

### Verification

1. With server NOT running: open a viewer file directly (file://). Hide a node, drag a node. Reload. Confirm: both persist via localStorage.
2. Run `prototype-flow-map serve <output-dir>` against an existing output. Open `http://localhost:3000/maps/<name>/`. Hide a node, drag a node. Reload. Confirm: both persist via API (check `<output-dir>/maps/<name>/hidden.json` and `positions.json`).
3. Stop the server. Reload. Confirm: hidden + positions are still applied (localStorage fallback or `__SAVED_POSITIONS__` carry-forward).
4. Open the same map in a second browser while the server runs. Confirm: hidden + positions match the first browser (because both fetch from the server).
5. Run `prototype-flow-map <prototype> --serve`. Confirm: generation completes, server starts, browser opens to the map.
6. Hit Ctrl+C in the terminal. Confirm: server stops cleanly.

### Out of scope

- Comments (Phase 2 of `archive/webapp-collaboration.md`) — see [`future-ideas.md`](future-ideas.md).
- Identity / author attribution (Phase 3) — see [`future-ideas.md`](future-ideas.md).
- Real-time sync (Phase 4) — see [`future-ideas.md`](future-ideas.md).
- Background daemon mode — only if foreground turns out to be inconvenient.
- Heroku / production deployment — `Procfile` exists from the cherry-pick but hasn't been validated end-to-end. Pursue when there's a real deployment target.

---

## Workstream 4 — iOS speed

### Context

iOS runs take ~12-13 minutes against typical prototypes; equivalent Android runs take ~2 minutes. The likely cause is `xcodebuild test`, which sequentially: (a) builds the test target, (b) boots the Simulator (if cold), (c) installs the app + test runner, (d) runs the XCUITest screenshot harness, all happening AFTER graph analysis completes. Android skips most of this by calling `am instrument` directly on an already-installed APK.

Three-phase approach: instrument first to confirm where time goes, then attack the biggest cost.

### Approach

#### Phase 1 — instrument

Add per-phase timing across the iOS pipeline. Print a summary at the end:

```
Run summary
  Parse:       12s
  Web jumpoffs: 18s (cache: 24 hit, 8 miss)
  Build:       3m 42s
  Test/capture: 5m 20s
  Pull/process: 1m 8s
  Viewer:      4s
  Total:       11m 4s   (last run: 12m 18s)
```

A small `src/phase-timer.js` module:

```js
function createTimer() {
  const phases = [];
  let active = null;
  return {
    start(name) { active = { name, t0: Date.now() }; },
    stop() { if (active) { active.dt = Date.now() - active.t0; phases.push(active); active = null; } },
    summary() { /* formatted output */ },
    durations() { return phases; }
  };
}
```

Persist last-run total to `~/.cache/prototype-flow-map/last-run.json` keyed by prototype path so iOS and Android are tracked separately. On startup, if a previous run exists for this prototype, print "Last run: 12m 18s" before doing anything.

This Phase 1 work also delivers the "run-time counter and last-run duration" item from `future-ideas.md`.

#### Phase 2 — parallelise the build

Spawn `xcodebuild build-for-testing -destination ...` as a background child process **as soon as the prototype path is known and test files are injected**. Run graph analysis, web jumpoff crawling, and other CPU-bound work concurrently. When ready to capture screenshots, await the build, then run `xcodebuild test-without-building`.

Pseudocode:

```js
async function generateNativeIos(opts) {
  injectTestFiles(opts.prototypePath);

  // Kick off build in the background immediately
  const buildPromise = startBackgroundBuild(opts.prototypePath);

  // Concurrent foreground work
  const swiftFiles = await scanSwiftFiles(opts.prototypePath);
  const graph = parseSwiftProject(swiftFiles, opts.prototypePath);
  if (opts.config.webJumpoffs.enabled) {
    await crawlWebJumpoffs(graph, opts);
    spliceWebSubgraphs(graph);
  }

  // Synchronise — wait for build before screenshot phase
  await buildPromise;

  await runScreenshotPhase(opts);
  await pullScreenshots(opts);
  await buildViewer(graph, opts);
}
```

Critical: the test file injection MUST happen before `build-for-testing` starts, otherwise the build won't include the screenshot harness. Cleanup-on-failure must still restore the prototype to its original state.

Expected gain: ~6-8 min saved on a 12 min run, since build (~6-8 min) and graph analysis (~30s) currently run sequentially.

#### Phase 3 — build caching

Hash the injected test file content + key source files (Swift source modification time / hash). If hash matches a previous run for this prototype, skip `build-for-testing` entirely and reuse cached derived data.

Cache layout:

```
~/.cache/prototype-flow-map/ios-build/
  <prototype-hash>/
    derived-data-path.txt   # absolute path to xcodebuild's derived data dir
    source-fingerprint.txt  # hash of injected test file + Swift sources
```

When the source fingerprint matches, set `xcodebuild`'s `-derivedDataPath` to the cached path and use `test-without-building`. When it doesn't match, do a full build and update the cache.

Expected gain: a warm-cache iOS run skips the build entirely → ~5-6 min total (limited by Simulator boot + test execution + screenshot pull).

### Files to change

| File | Change |
|---|---|
| `src/phase-timer.js` | **New.** Timer utility per the Phase 1 sketch. |
| `src/index.js` | Phase 1: wrap each phase with `timer.start()` / `timer.stop()`. Print summary at end. Phase 2: restructure `generateNativeIos` to run build in parallel with graph work. |
| `src/swift-build-runner.js` | **New** (Phase 2). Manages the background `xcodebuild build-for-testing` child process: launch, error capture, await, cleanup. |
| `src/swift-build-cache.js` | **New** (Phase 3). Hash sources, look up derived-data path, return either "cached, use this path" or "miss, do a fresh build". |
| `bin/cli.js` | Phase 1: print last-run duration on startup if available. |

### Verification

**Phase 1:**
1. Run iOS smoke target. Confirm: phase summary appears at end with sensible numbers.
2. Confirm: `~/.cache/prototype-flow-map/last-run.json` is written and readable.
3. Run again. Confirm: "Last run: Xm Ys" prints at startup.
4. Confirm: Android run also gets timing summary; key is per-prototype-path so iOS and Android last-run values don't collide.

**Phase 2:**
1. Time a baseline iOS run (Phase 1 timing data is the baseline).
2. Apply Phase 2. Run again. Confirm: total run time drops by roughly the smaller of (build time, graph-analysis-plus-jumpoffs time).
3. Force a build error (introduce a Swift syntax error in an injected test file). Confirm: error surfaces clearly, prototype is restored to clean git state by the cleanup handler, no orphaned `xcodebuild` processes left running.

**Phase 3:**
1. Run iOS twice in a row with no source changes. Confirm: second run skips the build phase entirely (≥ 5 min saved).
2. Modify a Swift file. Run again. Confirm: cache miss, full build runs, cache is updated.
3. Inspect `~/.cache/prototype-flow-map/ios-build/`. Confirm: cache size is bounded (we may need a prune step like the web jump-off cache has).

### Out of scope

- **Replacing XCUITest with `simctl io` direct screenshots.** Bigger architectural change. Worth pursuing only if Phases 2-3 don't get iOS within 2× of Android. Tracked in [`future-ideas.md`](future-ideas.md).
- **Parallel Simulator instances.** Each Simulator boot is heavy; running two in parallel may not actually be faster for screenshot capture. Requires investigation, not in this workstream.
- **Skipping Simulator boot entirely** (e.g. running tests on a physical device). Faster boot but adds device-management overhead and doesn't scale to CI.
