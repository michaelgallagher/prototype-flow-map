# Roadmap

> Active workstreams for prototype-flow-map. Each section is self-contained — a fresh contributor (human or AI) should be able to pick one up without reading the others. Recently delivered workstreams are in [`archive/`](archive/).

## Shared context

prototype-flow-map is a CLI tool that generates interactive flow maps from prototype projects. Three platforms (iOS, Android, Web), four execution modes (`scenario`, `record`, `static`, `audit`), and an opt-in web jump-off crawler that splices hosted web journeys into native flow maps. Output is a static HTML viewer (Dagre layout, vanilla JS) plus a JSON graph and screenshots. Optionally serve the output via the built-in Express server for shared persistence of layout positions and hidden-node state.

Code orientation:
- `bin/cli.js` — CLI entry point
- `src/index.js` — pipeline orchestration (`generate` for web, `generateNative` for iOS/Android)
- `src/build-viewer.js` — both the build-time HTML/CSS/JS generator and the viewer's runtime JS (embedded as a string template)
- `src/server.js` — Express server (`serve` subcommand and `--serve` flag), `/api/maps/:name/{positions,hidden}` REST endpoints
- `src/swift-parser.js` / `src/kotlin-parser.js` — native parsers
- `src/web-jumpoff-crawler.js` / `src/web-jumpoff-cache.js` / `src/splice-web-subgraphs.js` — the web jump-off pipeline
- `src/scenario-runner.js`, `src/recorder.js`, `src/crawler.js` — web pipeline

For full architecture see [`../how-it-works.md`](../how-it-works.md).

## Recently delivered (see archive)

| Workstream | Outcome |
|---|---|
| [Node hiding](archive/node-hiding.md) | Right-click context menu (hide node / hide subgraph), Show-hidden popover with per-node restore, persistence-key fix so state survives regeneration |
| [Tree-shaped layout — Part A](archive/tree-layout.md) | Replaced the centred-blob fallback with dagre's tree-shaped X positions; iOS and web maps without explicit tabs now look tree-shaped instead of clumped |
| [Server integration](archive/server-integration.md) | `/api/maps/:name/hidden` endpoint pair, viewer-side server detection with localStorage fallback, hidden-state carry-forward via `hidden.json`, `--serve` flag for one-shot generate-and-serve, plus `--port` UX rework (renamed prototype-kit port to `--prototype-port`) |

## Active

Just one workstream remains active. Tree-shaped layout Part B (virtual subgraph-owner inference) was deferred from WS2 and now sits in [`future-ideas.md`](future-ideas.md) — to be revisited if iOS maps still feel too clumped after a stretch of real use.

| Workstream | Why this position |
|---|---|
| [iOS speed](#workstream--ios-speed) | iOS runs take ~12-13 min vs Android's ~2 min. Phase 1 needed before any optimisation. |

---

## Workstream — iOS speed

### Context

iOS runs take ~12-13 minutes against typical prototypes; equivalent Android runs take ~2 minutes. The likely cause is `xcodebuild test`, which sequentially: (a) builds the test target, (b) boots the Simulator (if cold), (c) installs the app + test runner, (d) runs the XCUITest screenshot harness, all happening AFTER graph analysis completes. Android skips most of this by calling `am instrument` directly on an already-installed APK.

Three-phase approach: instrument first to confirm where time goes, then attack the biggest cost.

### Approach

#### Phase 1 — instrument

Add per-phase timing across the iOS pipeline. Print a summary at the end:

```
Run summary
  Parse:        12s
  Web jumpoffs: 18s (cache: 24 hit, 8 miss)
  Build:        3m 42s
  Test/capture: 5m 20s
  Pull/process: 1m 8s
  Viewer:       4s
  Total:        11m 4s   (last run: 12m 18s)
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

This Phase 1 work also delivers the "run-time counter and last-run duration" item from [`future-ideas.md`](future-ideas.md).

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
