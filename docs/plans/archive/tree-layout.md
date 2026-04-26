# Tree-shaped layout — Part A (WS2)

> **Status: Part A delivered. Part B parked in [`../future-ideas.md`](../future-ideas.md).**
>
> Reference docs: [`../../viewer.md#layout`](../../viewer.md#layout).

## Problem

When iOS prototypes lacked tab structure, the resulting map was a centred vertical blob — most nodes piled into one column instead of forming a tree. Web and Android prototypes didn't have this problem because the tool detects tab patterns (NavHost bottom-nav for Android, mutual cross-link tab siblings for web) and assigns `subgraphOwner` per tab; the viewer's column-packed layout then puts each tab's content under its own column.

Root cause was in `src/build-viewer.js` `layoutGraph()`. Three branches:
- `hasRanks=true, hasOwners=true` — column-packed (good; what Android/web with tabs use)
- `hasRanks=true, hasOwners=false` — fell through to "centre every rank row at same X" (the blob; what iOS hit)
- `hasRanks=false` — pure dagre TB layout (good; what very simple prototypes hit)

The ironic part: dagre's own TB layout was already computed, with sensible X positions reflecting tree structure. The `!hasOwners` branch was throwing those X positions away and replacing them with a global centre.

## What shipped

The `!hasOwners` else branch's ~25 lines of "rowWidths / maxWidth / centerX / walk-each-rank" logic was deleted, replaced with a comment explaining we now keep dagre's X positions. Y is still overridden by our rank-based stacking earlier in the same function, so the result is dagre's tree shape projected onto crisp rank rows.

## Files changed

| File | Change |
|---|---|
| `src/build-viewer.js` | Replaced ~25 lines in the `!hasOwners` branch of `layoutGraph()` with a no-op + comment |
| `docs/viewer.md` | Layout section rewritten — three branches now described accurately (with-owners, with-ranks-no-owners, no-ranks); replaced "known issue" note with forward-pointer to Part B |

## Verification

Smoke targets confirmed each branch goes the right way:
- **Android** (`~/Repos/native-nhsapp-android-prototype/DemoNHSApp2`): 45/45 nodes have `subgraphOwner` → column-packed branch unchanged
- **iOS** (`~/Repos/nhsapp-ios-demo-v2`): 0/63 nodes have `subgraphOwner`, 63/63 have `layoutRank` → modified else branch, now uses dagre X
- **Web scenario** (`~/Repos/manage-breast-screening-prototype` with `clinic-workflow`): 10 nodes, no `subgraphOwner`, all ranked → also benefits from the change

User confirmed the iOS map "looks better" after Part A. Sufficient improvement to defer Part B.

## Notable decisions

- **Trust dagre's X without re-normalisation.** Dagre's TB layout with `marginx: 30` produces sensible positive X values out of the box. Decided not to add a min-X clamp — would add complexity for an edge case that hasn't materialised.
- **Universal applicability via `!hasOwners` gating.** Part A applies wherever subgraph owners are missing. Web (scenario mode without explicit tab siblings) benefits as well as iOS. Android with tabs unchanged because it takes the `hasOwners` branch.
- **Part B deferred.** The original plan paired Part A (mechanical fix) with Part B (generalised virtual subgraph-owner inference for hub-shaped graphs). After Part A landed and looked good in real use, Part B was parked in [`../future-ideas.md`](../future-ideas.md) — to be revisited if iOS maps still feel too clumped after a stretch of usage.

## Out of scope (now in future-ideas)

- **Virtual subgraph-owner inference** — heuristic detection of hub-shaped graphs to assign `subgraphOwner` to top-level destinations even without explicit tabs. Would bring iOS-without-tabs and web-without-mutual-tabs into the column-packed layout.
- **Reingold-Tilford / proper subtree-width-aware tree layout** — bigger rewrite, only justified if Part A + (eventual) Part B aren't enough.
- **iOS-specific TabView detection** — would replace virtual inference for iOS apps that DO use TabView, producing a more accurate map.
