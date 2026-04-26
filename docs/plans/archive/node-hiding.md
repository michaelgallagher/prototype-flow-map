# Node hiding (WS1)

> **Status: delivered.** User-driven hide/show with localStorage persistence. The follow-on server-backed persistence is also delivered, see [`server-integration.md`](server-integration.md).
>
> Reference docs: [`../../viewer.md#hiding-nodes`](../../viewer.md#hiding-nodes).

## Problem

Web jump-offs surface dozens of pages from hosted NHS prototypes. Many are technically reachable but contextually irrelevant for what the user is reviewing — and the relevance is something only the user knows (it depends on what's being tested in the prototype, which is invisible from code structure). The viewer needed a way for users to right-click → hide a node so the map shows only the journey they care about.

A pre-existing detail-panel "Hide this page" button existed, but: (a) it required two clicks (open panel, click button), (b) it could only hide one node at a time, (c) clicking the toolbar's "Show hidden (N)" cleared all hidden nodes with no per-node restore, (d) the localStorage key included `__GENERATION_ID__` so hidden state was silently lost on every regeneration.

## What shipped

**Stable persistence key.** `hiddenStorageKey` changed from `flowmap-hidden-<pathname>-<genId>` to `flowmap-hidden-<pathname>`. Hidden state now survives regeneration. Stale entries for nodes that no longer exist are inert (Set membership check just doesn't match anything).

**Right-click context menu** on every node group, with two items:
- "Hide node" — single-node hide
- "Hide subgraph (N descendants)" — only shown when descendants > 0; BFS down the global forward adjacency to collect every reachable descendant, then hide all of them in one action

**Show-hidden popover** replacing the old "click to clear all" behaviour. Shows a list of all hidden nodes by label with a per-node Restore button, plus a Restore all button at the top.

**Module-scope `globalForwardAdj`** built once at viewer init from all non-nav graph edges. Used by the right-click handler's `collectDescendants(rootId)` BFS. Distinct from the per-render forward adjacency built inside `layoutGraph()` (which is filtered by current visibility).

## Files changed

| File | Change |
|---|---|
| `src/build-viewer.js` | Persistence key change, right-click handler, context menu DOM/CSS/JS, show-hidden popover, `hideSubgraph` / `restoreNode` / `collectDescendants` functions, dismiss-on-outside-click + Escape-key handlers |
| `docs/viewer.md` | "Hiding nodes" section rewritten |

## Notable decisions

- **Right-click as the primary gesture.** Tested against simply expanding the detail panel button — right-click is faster and discoverable. Browser default context menu suppressed only on node groups; canvas right-click still shows browser default (no surprises).
- **Per-node Restore + Restore-all** instead of single "show all" action. The original behaviour conflated "see what's hidden" with "unhide everything", which made experimenting with hide combinations annoying.
- **`escapeHtml` for attribute values inside the embedded viewer JS.** The build-time helper `escapeHtmlForAttr` lives outside the viewer JS string template; using it from inside would have been a `ReferenceError`. The runtime `escapeHtml` (defined inside the template) already handles `& < > "` which is sufficient.

## Verification

Smoke target: `~/Repos/native-nhsapp-android-prototype/DemoNHSApp2` generated with `--no-screenshots --no-web-jumpoffs`. UI verification done in browser by user. All seven acceptance steps from the original WS1 plan passed (right-click menu, single hide, subgraph hide, popover open, per-node restore, restore-all, persistence across reload + regeneration).
