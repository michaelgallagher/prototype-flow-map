# Layout — screenshot overlap fixes

> **Status: planning. Gated on [`layout-subgraph-ownership.md`](layout-subgraph-ownership.md) shipping first.** Logical grouping (1a + 1b) reduces overlap pressure on its own; this plan addresses what's left.
>
> Reference docs: [`../viewer.md#layout`](../viewer.md#layout). Sibling: [`future-ideas.md`](future-ideas.md) "Layout polish → Node overlap in long linear chains".

## Problem

Screenshot thumbnails overlap visually in some maps. Most notable case as of writing: the `RemoveTrustedPerson*` chain in `nhsapp-ios-demo-v2`, where five linearly-chained views parented under `ProfileSwitcherView` end up packed into a narrow column.

Reasons overlap happens, ranked by likelihood after 1a/1b ship:

1. **`nodesep`/`ranksep` are tuned for label-only nodes.** `src/build-viewer.js` `layoutGraph()` sets `nodesep: 15` and `ranksep: 50` (also reused by per-subgraph dagre runs at line 1260–1261). Screenshot thumbnails in full mode are ~140 × ~360px (mobile aspect ratio); a 50px gap between rank rows is fine, but 15px horizontal gap between sibling nodes leaves no breathing room for the screenshot border + drop shadow.
2. **Dagre X positions don't match our Y assignments in the with-ranks-no-owners branch.** `assignLayoutRanks` in the platform graph builders (or 1b's virtual inference) can assign a node to a different `layoutRank` than dagre would have — most commonly when tab siblings or sibling tabs are forced to share a rank. Dagre's X was computed for *its* rank assignments, so when we override Y based on ours, two nodes dagre thought were vertically separated can land at the same Y with overlapping X.
3. **Long linear chains within a column.** Less of an issue (rank-based Y stacking handles vertical separation correctly), but worth verifying after 1a/1b — wider columns from the column-packed branch may make tall chains narrower.

After 1a/1b, iOS will hit the with-owners branch which computes X per-column from our ranks (line 1093–1121) — so cause (2) goes away for iOS. Causes (1) and (3) remain platform-agnostic.

Cause (2) still applies to any prototype that lands in the with-ranks-no-owners branch — small no-tabs maps where 1b's hub-shape gate doesn't fire.

## What we'll ship

Layered, smallest first. Each layer is independently mergeable and lets us stop early if overlap is gone.

**Layer 1 — Scale `nodesep`/`ranksep` with thumbnail height.** When `hasScreenshots && !thumbnailMode`, increase the dagre constants. Concrete proposal:

```js
const NODESEP_BASE = 15;
const RANKSEP_BASE = 50;
const nodesep = (hasScreenshots && !thumbnailMode) ? 32 : NODESEP_BASE;
const ranksep = (hasScreenshots && !thumbnailMode) ? 70 : RANKSEP_BASE;
```

Apply to both the main `setGraph` call and the per-subgraph one (line 1260–1261). One-line change at each site.

**Layer 2 — Tell dagre our ranks.** Use dagre's `rank` API to align dagre's rank computation with ours, so the X positions it produces honour our `layoutRank`. Two options to investigate during implementation:

- `g.setNode(id, { ..., rank: 'same:' + groupId })` — groups nodes that should share a rank. Doesn't directly take an integer rank but can be used to enforce sibling co-ranking.
- `g.graph().ranker = 'longest-path'` and use `minlen` on edges — coarse control.

The cleanest fix may be to NOT call `dagre.layout()` at all for our with-ranks branches and instead compute X ourselves directly from `layoutRank` (which we already do for the with-owners branch). The else branch at line 1137–1150 currently relies on dagre's X for the no-owners-but-has-ranks case; we'd replace that with a per-rank centering computation. This eliminates cause (2) entirely.

Decision deferred to implementation: try the `setNode({ rank })` approach first; fall back to "compute X ourselves" if dagre's rank constraint API doesn't reach the corners we need.

**Layer 3 — Post-layout overlap sweep (safety net).** After all positioning is done, run a single pass that detects overlapping bounding boxes and nudges positions apart. Pseudocode:

```js
function resolveOverlap(layoutNodes, padding = 8) {
  const nodes = Object.values(layoutNodes);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.userPlaced || b.userPlaced) continue; // respect user drags
      const overlapX = (a.width + b.width) / 2 + padding - Math.abs(a.x - b.x);
      const overlapY = (a.height + b.height) / 2 + padding - Math.abs(a.y - b.y);
      if (overlapX <= 0 || overlapY <= 0) continue;
      // Resolve along the smaller axis
      if (overlapX < overlapY) {
        const shift = overlapX / 2;
        if (a.x < b.x) { a.x -= shift; b.x += shift; } else { a.x += shift; b.x -= shift; }
      } else {
        const shift = overlapY / 2;
        if (a.y < b.y) { a.y -= shift; b.y += shift; } else { a.y += shift; b.y -= shift; }
      }
    }
  }
}
```

Iterate 2–3 passes (overlap can shift nodes into new overlaps). Naïve O(n²) is fine for current map sizes (< 200 nodes); upgrade to a spatial index only if/when needed.

Critical: respect any `userPlaced` flag on dragged nodes so the sweep doesn't undo manual layout. Need to check whether the existing position-persistence machinery (`/api/maps/:name/positions`, the drag handler in the viewer) marks nodes as user-placed; if not, add the flag.

## Files to change

| File | Layer | Change |
|---|---|---|
| `src/build-viewer.js` | 1 | Scale `nodesep`/`ranksep` based on `hasScreenshots && !thumbnailMode`. Two sites: main `setGraph` (line ~903) and per-subgraph `setGraph` (line ~1260). |
| `src/build-viewer.js` | 2 | Either pass our `layoutRank` to dagre via `setNode({ rank })`, or replace the with-ranks-no-owners else branch (line 1137–1150) with a self-computed per-rank X assignment. Decision during implementation. |
| `src/build-viewer.js` | 3 | New `resolveOverlap()` function called at the end of `layoutGraph()` after all branches finish. Honours `userPlaced` flag on drag-saved nodes. |
| `src/build-viewer.js` | 3 | Drag handler: set `userPlaced: true` on nodes the user moves, persist alongside position. |
| `docs/viewer.md` | 1–3 | Layout section: note new sep values + overlap pass behaviour. |

## Verification

Smoke targets — same set as 1a/1b's plan. For each:

1. **Layer 1 only.** Visually inspect; measure if overlap is gone. If yes, stop here — Layers 2 and 3 don't ship.
2. **Layer 2 added.** Verify the with-ranks-no-owners branch (small no-tabs map) lays out cleanly with no overlap.
3. **Layer 3 added.** Construct a pathological case (tight cluster, e.g. a hub with 8 leaves and short labels) and confirm the sweep separates them without disturbing user drags.

For each layer added, save before/after screenshots for the PR.

## Risks and open questions

- **Maps get taller after Layer 1.** Doubling `ranksep` from 50 → 70 makes long chains 40% taller. Acceptable — users zoom out — but worth flagging in the changelog so users notice their saved zoom levels feel different.
- **Layer 2 may not be needed after 1a/1b.** Most prototypes will land in the with-owners branch; the with-ranks-no-owners branch becomes the rare case. Worth re-measuring before investing in Layer 2.
- **`userPlaced` flag doesn't exist yet.** Need to check the position-persistence code in the viewer + server. If we add it as part of Layer 3, make sure existing saved positions don't all get `userPlaced: false` retroactively (users would lose their manual layouts to the overlap sweep). Mitigation: treat any node present in `positions.json` as `userPlaced: true` on load.
- **Overlap sweep oscillation.** Two-pass minimum, but pathological clusters can cycle. Cap at 5 iterations; log a warning if still overlapping after that.
- **Per-subgraph dagre runs (line 1232+).** Those have their own `nodesep: 15`, `ranksep: 50` constants that need the same Layer 1 treatment.

## Out of scope

- Reingold-Tilford / proper subtree-width-aware tree layout — parked in `future-ideas.md` behind this work.
- Dynamic thumbnail sizing (let users pick a node size). Different problem; would change the `getNodeDims` constants, not the layout algorithm.
- Force-directed post-layout (e.g. d3-force) — heavier than needed for the overlap we see.

## Sequencing

1. Land 1a + 1b first. Re-measure overlap in the smoke targets.
2. Layer 1: ship the sep scaling. Re-measure.
3. **Stop here if overlap is acceptable.**
4. Layer 2: only if a real prototype still overlaps in the with-ranks-no-owners branch.
5. Layer 3: only if Layer 2 isn't enough OR the overlap sweep is independently valuable for user-dragged layouts.

Strong bias toward stopping early. Each subsequent layer adds complexity that's only worth paying for if the simpler fix didn't work.
