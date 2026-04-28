# iOS: missing screenshots — root view and sheet-owned NavigationStacks

> **Status: DELIVERED (2026-04-28).** `buildRoutePlan` extended with `hostViewName` + `subNavigationHosts`; `viewOwnsNavigationStack` detects sub-NS hosts; `injectIntoSubNavigationHost` injects `.navigationDestination(for: String.self)`, `.task`, and `flowMapSubNavDestination` into sheet children. Sheet trigger updated to `segments.contains()`. Result: 32 routes / 26 screenshots (up from 29/23). New: `HomeView.png`, `AddCareProfileView.png`, `AddTrustedPersonView.png`.

## Problem

Two categories of views have `screenshot: null` despite being reachable in the app:

### 1. The root view (HomeView)

`HomeView` owns the main `NavigationStack(path: $navigationPath)` and is always the
first screen the user sees. But it is never a `NavigationDestination` enum case — it
IS the navigation host. The BFS in `buildRoutePlan` starts from the 8 enum cases and
never generates a route for HomeView itself.

Fix: add a special "home" route (empty string `""`) that launches the app with no
`-flowMapRoute` argument and lets it settle to the default state.

Actually the cleaner approach: launch with `-flowMapRoute home` but have the `.task`
treat an unrecognised first segment as a no-op (don't push anything) — then the app
just shows HomeView after splash-skip. The key insight: we already inject an `init()`
that sets `showSplash = false` when `-flowMapRoute` is present, so launching with
`-flowMapRoute home` skips the splash and shows HomeView immediately.

### 2. Sub-NavigationStacks inside sheets

`ProfileSwitcherView` is opened as a sheet from `ProfileView`. It contains its own
`NavigationStack(path: $path)`. Inside it, via `RowLink` / `NHSNavigationButton`:

- `ProfileSwitcherPersonView` — push via RowLink
- `AddCareProfileView` — push via NHSNavigationButton
- `TrustedPersonDetailView` — push via RowLink
- `AddTrustedPersonView` — push via NHSNavigationButton

Currently the BFS stops at the `ProfileSwitcherView` sheet edge. These four views
have no route generated, so no screenshot is captured.

The fix has two parts:
- **BFS**: when a sheet child itself owns a `NavigationStack(path:)`, continue BFS
  through its push-reachable descendants and add them to `allRoutes` with a compound
  route like `profile/ProfileSwitcherView/ProfileSwitcherPersonView`.
- **Injection**: inject a `.task` + `navigationDestination(for: String.self)` into the
  sheet-child's NavigationStack, analogous to what we already do for the main
  NavigationHost.

## Implementation plan

### Step 1 — HomeView: add a "home" route

In `buildRoutePlan`, after the main BFS loop, add the NavigationHost node itself:

```js
// The NavigationHost (HomeView) is always the root — add it as a "home" route.
const hostNode = graph.nodes.find(n => n.filePath && n.filePath.includes(hostViewName));
// or: just look for the node whose id matches the view that owns NavigationStack(path:)
if (hostNode) {
  allRoutes.push({ route: "home", nodeId: hostNode.id });
}
```

The `.task` in HomeView already handles unrecognised routes gracefully (the switch
falls through to `default: level1 = nil`, then `guard let level1 else { return }` —
so no navigation happens and HomeView is shown).

`buildRoutePlan` doesn't currently know the NavigationHost view name. Pass it in:
- `injectFlowMapRouteHandler` already finds `hostInfo.filePath` — extract the view
  name from it and thread it to `buildRoutePlan`.
- Or: detect it inside `buildRoutePlan` by looking for the node that has no incoming
  edges and has outgoing `link` edges to all 8 NavigationDestination cases.

Simplest: pass the `hostViewName` (e.g. `"HomeView"`) explicitly from
`injectFlowMapRouteHandler` → `buildRoutePlan`.

### Step 2 — Detect sheet children that own NavigationStacks

In `buildRoutePlan`, when a sheet/full-screen edge is encountered, check whether the
target view file contains `NavigationStack(path:)`. If it does, treat it as a
sub-NavigationStack host and BFS its push-reachable descendants.

```js
function viewOwnsNavigationStack(nodeId, parsedViews, prototypePath) {
  const view = parsedViews.find(v => v.viewName === nodeId);
  if (!view) return false;
  const content = fs.readFileSync(view.filePath, 'utf-8');
  return content.includes('NavigationStack(path:');
}
```

When the BFS hits a sheet edge to `ProfileSwitcherView` and this returns true,
continue BFS through its push children, generating routes like:
```
profile/ProfileSwitcherView/ProfileSwitcherPersonView
profile/ProfileSwitcherView/AddCareProfileView
profile/ProfileSwitcherView/TrustedPersonDetailView
```

Add these to `allRoutes` with `nodeId` = the leaf view's id.

### Step 3 — Inject into sub-NavigationStack hosts

For each sheet child that owns a NavigationStack, inject the same three things we
inject into the main NavigationHost:

A. `.navigationDestination(for: String.self) { viewName in flowMapSubDestination(viewName) }`
   inside the NavigationStack content (after any existing `navigationDestination`)

B. `.task { ... }` that reads `-flowMapRoute`, finds the sub-host's segment in the
   route string, then pushes the subsequent segments as Strings

C. `flowMapSubDestination(_ viewName: String)` @ViewBuilder helper at the bottom of
   the struct

The `.task` for a sub-host needs to:
1. Check that the route contains `ProfileSwitcherView` (or whatever the sub-host is)
2. Find the segment AFTER `ProfileSwitcherView` in the route
3. Push that segment onto `path` as a String

The injection logic is largely the same as `injectIntoNavigationHost`, parameterised
differently. Consider extracting a shared `injectIntoNavigationStackHost(content,
subRoutes, subPushableViews)` function that both the main host and sub-hosts call.

### Step 4 — Thread parsedViews into buildRoutePlan

Currently `buildRoutePlan(graph, caseMap)` has no access to `parsedViews` or
`prototypePath`. These are needed for Step 2's file-content check. Add them as
parameters:

```js
function buildRoutePlan(graph, caseMap, parsedViews, prototypePath)
```

Update the call site in `injectFlowMapRouteHandler`.

### Step 5 — smoke test

Run against `nhsapp-ios-demo-v2`. Expect:
- `HomeView.png` shows the NHS App home screen (not splash)
- `ProfileSwitcherPersonView.png` shows a person's profile switcher detail
- `AddCareProfileView.png` shows the add care profile flow
- `TrustedPersonDetailView.png` shows the trusted person detail
- No regression on existing 23 screenshots
- Build succeeds

## Files changed

- `src/swift-injector.js` — `buildRoutePlan` signature, sub-NavigationStack detection
  and BFS, `injectSheetTriggers` extended to inject into sub-hosts, shared injection
  helper

## Risks

- **Sub-host `.task` timing**: the sheet needs to be open before the sub-host's `.task`
  fires. Both the parent's `.task` (opens the sheet) and the sub-host's `.task` (pushes
  within the sheet) fire on `.onAppear`. Order is not guaranteed. May need a short
  `Task.sleep` inside the sub-host's `.task` to let the sheet finish animating before
  pushing. Spike with 0.3s delay first; tune if screenshots show the wrong screen.

- **`navigationDestination(for: String.self)` placement**: same critical rule as the
  main host — must be INSIDE the NavigationStack content closure, not outside it.

- **Multiple sub-hosts**: if other sheets also have NavigationStacks, the same logic
  applies. The implementation should be general (detect all such sheets), not hardcoded
  to ProfileSwitcherView.
