# Layout — subgraph ownership for iOS + virtual inference fallback

> **Status: planning.** Promotes two items out of [`future-ideas.md`](future-ideas.md) ("Layout polish" → "Virtual subgraph-owner inference") plus a new sibling change for iOS tab detection.
>
> Reference docs: [`../viewer.md#layout`](../viewer.md#layout), [`archive/tree-layout.md`](archive/tree-layout.md) (Part A — what shipped before).

## Problem

The viewer has three layout branches in `layoutGraph()` (`src/build-viewer.js`):

1. `hasRanks=true, hasOwners=true` — column-packed (each `subgraphOwner` becomes a column, ranks stack top-to-bottom). Used by Android and by web maps with detected tab patterns. Looks logical and clean.
2. `hasRanks=true, hasOwners=false` — uses dagre's tree X projected onto our rank rows. Used by iOS today. "Looks better than a blob" but ranks across the whole graph fight each other: a screen 3 levels under `HomeView` ends up visually closer to a screen under `MessagesView` than to its own parent, because dagre globally minimises crossings instead of respecting logical groupings.
3. `hasRanks=false` — pure dagre TB. Rare; very small prototypes only.

Why iOS is in branch 2: `src/swift-graph-builder.js` parses `TabView` tab edges (and forces tab siblings to share a rank) but never assigns `subgraphOwner` / `isStartNode` / `startOrder`. So the viewer can't promote each tab to its own column. The `nhsapp-ios-demo-v2` demo has `MainTabView → HomeView / MessagesView / ProfileView` — three obvious columns sitting in the data, never used.

Beyond iOS-with-tabs, there's the broader case: any prototype rooted at a hub with several mostly-independent branches (web "static" maps, iOS apps without `TabView`, Android apps without bottom nav) currently has no way to express logical grouping. The future-ideas doc has had the heuristic for this parked for months ("virtual subgraph-owner inference").

Today's screenshot-overlap complaint is partly a downstream symptom of this: when 60+ nodes pile into one global dagre layout with no grouping, ranksep tuning can't compensate.

## What we'll ship

Two changes that share infrastructure, landed together:

**1a — iOS tab targets become subgraph owners.** When a Swift view has `tabChildren.length >= 2`, each tab target becomes a primary start node (`isStartNode: true`, `startOrder` set from tab index). Descendants are claimed by the nearest tab via multi-source BFS. The TabView host itself (e.g. `MainTabView`) is marked `isStructuralHost: true` and filtered out of the rendered graph — it has no UI of its own, only contains tabs. Mirrors how Android's `kotlin-graph-builder.js` already handles bottom-nav.

**1b — Virtual subgraph-owner inference (platform-agnostic fallback).** When no real subgraph owners are present after platform parsing, run a heuristic to infer them:

1. Find the root: a node with `isStartNode === true`, or the unique zero-in-degree node (excluding lateral/back edges).
2. Take the root's direct outbound forward edges (excluding nav edges and self-edges).
3. If there are ≥2 such edges and each target has ≥2 descendants of its own, treat each target as a virtual subgraph owner.
4. Multi-source BFS from each virtual owner; nodes reachable from multiple owners go to the closest, tiebreak on `startOrder`.
5. Skip the pass entirely if any node already has `subgraphOwner` (1a fired, or web scenario set it).

To avoid duplicating the BFS-with-ownership machinery three times (Android already has it; iOS needs it; virtual inference needs it), extract it into a shared helper as part of this work.

### Shared helper

`src/layout-ranks.js` (new) — exports a generic `assignSubgraphLayout({ nodes, edges, primaryStarts, lateralEdgePairs })`. Returns nothing; mutates nodes to set `layoutRank`, `subgraphOwner`, `isStartNode`, `startOrder`, and `isOrphanRoot`. Behaviour matches `assignLayoutRanks` in `kotlin-graph-builder.js` (lines 219–357) — multi-source BFS over forward edges with back-edges removed, FIFO ties go to lower `startOrder`, orphan roots become extra columns to the right.

### iOS-specific glue (1a)

`src/swift-graph-builder.js`:
- New helper `findTabHosts(parsedViews)` returns views with `tabChildren.length >= 2`.
- For each tab host, mark its node `isStructuralHost: true` and exclude it from the rendered graph during a final pass (or set `hidden: true` so the viewer's existing hidden-node machinery skips it — pick whichever is less invasive).
- Build `primaryStarts = [{ id: tabTarget, order: tabIndex }, ...]` from the first tab host found. Multiple tab hosts (rare) → use the first; warn in console.
- `lateralEdgePairs` = the existing `tabSiblingPairs` Set.
- Call the shared helper. Drop the existing `assignLayoutRanks` function.

When no tab host exists (iOS apps without `TabView`), 1b will fire later in the pipeline to fill the gap.

### Android (no behaviour change)

`src/kotlin-graph-builder.js` — refactor `assignLayoutRanks` to delegate to the shared helper. `primaryStarts` are still computed from `bottomNavItems`; `lateralEdgePairs` is still built the same way. Verification step: for `DemoNHSApp2`, `subgraphOwner`/`startOrder`/`layoutRank` values must be byte-identical before and after.

### Virtual inference (1b)

New module `src/infer-subgraph-owners.js` — exports `inferVirtualSubgraphOwners(graph)`. Called from `src/index.js` after platform parsing finishes (and after web jump-off splice, before screenshots) for both `generate` and `generateNative`. Implementation:

```js
function inferVirtualSubgraphOwners(graph) {
  if (graph.nodes.some(n => n.subgraphOwner !== undefined)) return; // skip — owners already set

  const root = findRoot(graph);                    // isStartNode, or unique zero-in-degree
  if (!root) return;

  const candidates = directForwardChildren(root, graph)
    .filter(child => descendantCount(child, graph) >= 2);

  if (candidates.length < 2) return;               // not hub-shaped enough

  const primaryStarts = candidates.map((id, idx) => ({ id, order: idx }));
  assignSubgraphLayout({ nodes: graph.nodes, edges: graph.edges, primaryStarts, lateralEdgePairs: new Set() });
}
```

Exact ordering of children: by edge order in `graph.edges` (matches source-file order, gives stable column ordering across runs).

### Viewer (no change)

`src/build-viewer.js` already has the with-owners column-packing branch. Once iOS / virtual-inferred maps populate `subgraphOwner`, they fall straight into that branch.

## Files to change

| File | Change |
|---|---|
| `src/layout-ranks.js` | NEW. Shared `assignSubgraphLayout({ nodes, edges, primaryStarts, lateralEdgePairs })`. |
| `src/infer-subgraph-owners.js` | NEW. `inferVirtualSubgraphOwners(graph)`. |
| `src/swift-graph-builder.js` | Replace `assignLayoutRanks` with primary-start computation from tab hosts + delegate to shared helper. Mark tab hosts `isStructuralHost`. |
| `src/kotlin-graph-builder.js` | Refactor existing `assignLayoutRanks` to delegate to shared helper. Behaviour unchanged. |
| `src/index.js` | Invoke `inferVirtualSubgraphOwners(graph)` after parsing/splice, before screenshots, in both `generate` and `generateNative`. |
| `src/build-viewer.js` | Filter `isStructuralHost` nodes from the rendered graph before layout, or rely on existing hidden-nodes machinery — TBD during implementation. |
| `docs/viewer.md` | Layout section: update branch 2 description to note iOS-with-tabs and virtual inference now flow into branch 1. |
| `docs/plans/future-ideas.md` | Move "Virtual subgraph-owner inference" entry into "Recently delivered" once shipped. |

## Verification

Smoke targets — must pass before merging:

1. **iOS, has tabs (`~/Repos/nhsapp-ios-demo-v2`).** Expect: `MainTabView` not in rendered graph; `HomeView`/`MessagesView`/`ProfileView` are start nodes with `startOrder` 0/1/2; descendants visibly stack under their respective tab columns. Compare against current screenshot of the map.
2. **iOS, no tabs.** Construct a tiny synthetic project (or find an existing test fixture) where no `TabView` is parsed. Expect: 1a sets nothing; 1b fires; root's qualifying children become virtual owners.
3. **Android (`~/Repos/native-nhsapp-android-prototype/DemoNHSApp2`).** Expect: byte-identical `subgraphOwner` / `startOrder` / `layoutRank` values vs current main. Compare via `git diff` of the generated `graph.json`.
4. **Web scenario (`~/Repos/manage-breast-screening-prototype`, `clinic-workflow`).** Expect: scenario already sets `layoutRank` and (where applicable) `subgraphOwner`; 1b's "skip if owner exists" guard fires; no behaviour change.
5. **Web static map.** Pick a small static-mode prototype (one without scenarios). Currently lands in branch 2; should now flow into branch 1 if hub-shaped. Verify the map is readable and grouping makes sense; if not, the heuristic guards in 1b need tuning.

For each smoke target, save a before/after screenshot of the viewer for the PR description.

## Risks and open questions

- **Filtering `MainTabView` changes node count.** `nhsapp-ios-demo-v2` drops from 63 → 62 nodes. Cosmetic but worth flagging in the run summary so users aren't surprised.
- **Multiple `TabView` hosts.** The demo has one. Some apps may have nested or multiple tab containers. Plan: handle the first one, warn on additional ones, defer the multi-host case until we hit it.
- **Orphan explosion on iOS.** Android's helper makes every zero-in-degree non-tab node its own column. iOS may have many such orphans (sheet-rooted helpers, dead-code views). Mitigation: in the shared helper, optionally require orphans to have ≥2 descendants before granting them a column; lone orphans go to a single overflow column. Worth a flag (`requireDescendantsForOrphan: true`) so Android's existing behaviour stays the default.
- **Virtual inference mis-classifies wide hubs.** A settings hub with 10 leaf children (each a single screen) currently meets the "≥2 outbound edges" gate but each child fails the "≥2 descendants" gate, so the pass aborts cleanly. Good — no regression for those graphs.
- **`isStructuralHost` filtering location.** Filter inside `src/swift-graph-builder.js` (don't add the node at all) vs. inside the viewer (set a flag, hide at render time). The latter preserves auditability ("show structural nodes" toggle) but adds complexity. Default: filter at build time; add the toggle only if asked for.
- **Tab-sibling lateral edges across columns.** With each tab now in its own column, the existing tab-sibling lateral edges (bidirectional pairs between every tab pair) become cross-column edges. The viewer's `lateralEdges` array already collects and renders these; verify they don't make the map noisy. If they do, treat them as `nav` edges (already filterable via "show global nav" toggle).

## Out of scope

- Screenshot overlap (`ranksep` tuning, post-layout overlap pass) — separate workstream. Logical grouping should reduce overlap pressure first; revisit overlap after these two ship.
- Reingold-Tilford-style proper subtree-width-aware layout — the future-ideas doc keeps it parked behind this work.
- iOS native tab-pattern detection beyond `TabView` (custom tab containers, paged scroll views) — covered by 1b's fallback for now.
- Hidden-node persistence interaction with `isStructuralHost`. Existing hidden-state machinery is per-user; structural hosts are determined at build time from source. Treat them as separate concerns.

## Sequencing

Recommended order — each step independently mergeable:

1. Extract shared helper (`src/layout-ranks.js`); refactor `kotlin-graph-builder.js` to use it. Verification: Android `graph.json` byte-identical.
2. Add 1a (iOS tab → subgraph owners). Verification: iOS demo shows three columns.
3. Add 1b (virtual inference). Verification: representative web static map and a no-tabs iOS fixture both flow into branch 1.
4. Doc updates + future-ideas archive move.

Each step is one PR. Stop and re-evaluate between (2) and (3) — (2) may already cover the immediate need.
