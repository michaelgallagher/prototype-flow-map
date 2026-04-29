# Layout — subgraph ownership for iOS + virtual inference fallback

> **Status: delivered 2026-04-29.** Planning doc: [`../layout-subgraph-ownership.md`](../layout-subgraph-ownership.md) (kept for reference; the follow-up overlap-fix plan is at [`../layout-overlap-fixes.md`](../layout-overlap-fixes.md)).

## What shipped

### Shared layout helper (`src/layout-ranks.js`)

Extracted the per-owner multi-source BFS machinery from `kotlin-graph-builder.js` into a shared `assignSubgraphLayout({ nodes, edges, primaryStarts, lateralEdgePairs })`. Produces `layoutRank`, `subgraphOwner`, `isStartNode`, `startOrder`, `isOrphanRoot` on each node. Android output byte-identical before and after the extraction.

### iOS tab targets as subgraph owners (`src/swift-graph-builder.js`)

When a Swift view has `tabChildren.length >= 2` (TabView host), each tab target becomes a primary start node. The tab host itself is filtered from the rendered graph (structural container with no UI). Falls through to `assignLayoutRanksOnly` when no TabView is present, leaving `subgraphOwner` unset so virtual inference can run.

### Virtual subgraph-owner inference (`src/infer-subgraph-owners.js`)

Platform-agnostic fallback wired into `generateNative` (`src/index.js`). Skips if any node already has `subgraphOwner`. Algorithm:

1. Find root candidates (prefer `isStartNode`, else zero-in-degree nodes).
2. Iterate candidates; pick the first where ≥2 direct children each have ≥2 reachable descendants.
3. Include root as column 0; virtual owners as columns 1, 2, 3…
4. Call shared `assignSubgraphLayout`.

**Not** wired into `generate` (web static) — form-gated web prototypes produce too many disconnected orphan pages for the heuristic to fire correctly. Coverage-guard approach noted in `future-ideas.md`.

## Outcome on nhsapp-ios-demo-v2

Before: one global dagre tree, all 63 nodes interleaved.  
After: 4 logical columns (HomeView, PrescriptionsView, AppointmentsView, ProfileView) + 4 orphan columns for dead-code views unreachable from the main navigation.

## Files changed

| File | Change |
|---|---|
| `src/layout-ranks.js` | New. Shared BFS helper. |
| `src/infer-subgraph-owners.js` | New. Virtual inference pass. |
| `src/swift-graph-builder.js` | TabView host detection + filter; shared helper; `assignLayoutRanksOnly` fallback. |
| `src/kotlin-graph-builder.js` | Refactored to use shared helper. Behaviour unchanged. |
| `src/index.js` | Wired `inferVirtualSubgraphOwners` into `generateNative`. |
