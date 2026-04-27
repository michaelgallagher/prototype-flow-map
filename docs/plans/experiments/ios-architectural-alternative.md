# iOS architectural alternative — spike experiment

> **Status: experiment in progress.** A long-running investigation, NOT a committed workstream. Goal: validate whether an XCUITest-free architecture can deliver order-of-magnitude faster iOS runs (~1 min vs current ~13 min). The spike has confirmed the speed half of the hypothesis; the navigation-trigger half is partially blocked and needs more design work. Treated as an experiment until the blockers are overcome.
>
> The active iOS speed workstream in [`../roadmap.md`](../roadmap.md) (Phases 2+3 — parallelise + cache the build) remains the formal plan and is NOT being replaced until this experiment validates. If the experiment succeeds, it will replace Phases 2+3. If it stalls, Phases 2+3 stand.
>
> This doc is the handover for picking the experiment back up. Self-contained — a fresh contributor (human or AI) should be able to resume from here without prior context.

## Why this exists

### The diagnosis

Phase 1 instrumentation (delivered — see `src/phase-timer.js`, `src/last-run-cache.js`, and the timer wiring in `src/index.js`) measured the iOS pipeline phases on `~/Repos/nhsapp-ios-demo-v2`:

```
📊 Run summary
   Parse:       33ms
   Screenshots: 13m 30s
   Viewer:      28ms
   Total:       13m 31s
```

**99.94% of the iOS run time is inside the `Screenshots` phase** — i.e. the single `xcodebuild test` invocation. The Phase 2+3 plan in the roadmap was based on the assumption that "the build" was a big chunk of that time and could be parallelised with parse work or cached. But this spike's measurements reveal that the `xcodebuild build` step itself is only **13 seconds** — a tiny fraction of the 13m 30s. The remaining ~13 minutes is XCUITest's runtime overhead (test runner, per-test setUp/tearDown, capture mechanics).

This means **Phase 2 (parallelise the build) saves at most ~13 seconds**, not the 6-8 minutes the roadmap originally claimed. Phase 3 (build caching) saves up to that same ~13 seconds on warm runs.

### The alternative

Bypass XCUITest entirely:

1. **Build the app once** with `xcodebuild build` (no test target — just the app)
2. **Install + launch** via `simctl install` and `simctl launch`
3. **Trigger navigation** to each screen via some fast IPC mechanism (TBD — this is the open problem)
4. **Capture** via `simctl io <udid> screenshot out.png`
5. **Cleanup** as we do today

The screenshot capture is the bulk of the work in the current XCUITest pipeline. If we can make per-screenshot fast (~250ms), we get a 10-20× total speedup.

## What's been validated (Phase A)

Measured on `~/Repos/nhsapp-ios-demo-v2` against `iPhone 17 Pro` simulator (UDID found via `xcrun simctl list devices available | grep "iPhone 17 Pro"`).

| Operation | Time | Notes |
|---|---|---|
| `xcodebuild build` (app target only, fresh derived data) | **13.3s cold** / 4.2s incremental | Compares to `xcodebuild test` which is part of a 13m 30s run |
| Simulator boot (cold → ready) | 24.1s | One-time per session; ~10s if recently shut down |
| `simctl install` | 4.6s first time / 0.3s warm | |
| `simctl launch` | 0.25-1.3s | Returns once app process starts; UI render takes more |
| `simctl io screenshot` | **~250ms** | Avg of 5 captures; consistent |
| `simctl terminate + launch` cycle | ~340ms | If we go the launch-args route (see below) |

**Projected total iOS run time, assuming we solve the navigation-trigger problem:**

- Cold (fresh derived data, fresh boot, full build): ~75-95s, **8-10× faster than 13m 30s**
- Warm (Sim already booted, incremental build): ~50-65s, **12-15× faster**
- Hot (skip build entirely if sources unchanged — Phase 3-equivalent caching): ~30-45s, **20-25× faster**

These numbers assume ~250ms per screenshot + 0-1s per navigation. For 42 screens that's 10-50s of capture work, plus setup overhead.

## What's blocked

### `simctl openurl` is gated by iOS's consent dialog

The first attempt at navigation-triggering used a deep-link scheme — register `flowmap://` in `Info.plist`, add `.onOpenURL` handler in `App.swift`, drive navigation via `simctl openurl flowmap://goto/<route>`.

**Result: every `simctl openurl` triggers an iOS SpringBoard dialog: "Open in 'nhsapp-ios-demo-v2'?" with Cancel / Open buttons.** The dialog blocks the URL from reaching the app's `.onOpenURL` handler. Screenshots captured the dialog overlay, not the navigated screen.

What was tested:
- `xcrun simctl privacy <udid> grant ...` — doesn't cover URL schemes
- `xcrun simctl ui ...` — has limited UI control, no alert-handling commands
- Repeated `openurl` calls — dialog appears every time; consent is not cached

What might unblock it (untested):
- A one-shot helper test (XCUITest or `simctl` UI control via `idb`) that sits in parallel and dismisses the alert when it appears. Adds back some XCUITest overhead, but only a single lightweight harness rather than per-screenshot tests.
- Universal Links (`https://flowmap.example.com/...` routed via Apple App Site Association) — bypasses the dialog because they're treated as continuations of web navigation. But requires a real domain + AASA hosting + entitlements. Probably too much complexity.

### Launch-args partially worked but route-handoff didn't reach the subscriber

Second attempt: pass `-flowMapRoute messages` to `simctl launch`. App reads `ProcessInfo.arguments` on init, posts a `Notification.Name.flowMapNavigate` notification. HomeView subscribes via `.onReceive` and updates `navigationPath`.

**Result: the launch + screenshot cycle works fast (~1.1s per route).** Screenshots have varied byte sizes (ruling out splash-screen capture). But manual visual inspection of the screenshots showed the HomeView, faded — not the navigated views (Messages, Profile, etc.). The notification didn't reach HomeView's subscriber.

Likely causes (any of these):
1. The `.task` modifier on the WindowGroup fires before HomeView mounts and subscribes. NotificationCenter posts aren't buffered for late subscribers.
2. The 100ms `Task.sleep` before posting wasn't long enough.
3. The fade visible in screenshots suggests SwiftUI was still mid-transition — settle time of 600ms wasn't enough.

What might fix it:
- Move route reading + dispatch INSIDE HomeView's own `.task { ... }` rather than the App level. Once HomeView's `.task` fires, its `.onReceive` is already wired up.
- Use a shared `@Observable` model (`NavigationCoordinator`) instead of NotificationCenter — values are observable from the moment they're set, no missed-post problem.
- Increase settle time to 1.5s+ to rule out animation timing.

This problem is **tractable** — just needs more iteration. It's not a fundamental block like the openurl consent dialog.

## Open questions

These are what need to be answered to decide whether to commit to the architectural replacement:

1. **Can we reliably trigger SwiftUI navigation from an external process without the openurl consent dialog?** Three candidate mechanisms:
    a. **Launch arguments + `@Observable` coordinator** — simplest; needs the route-handoff design fix above
    b. **Embedded debug-only HTTP server in the app** (Network framework) — listens on `localhost:54321` for `GET /goto?route=X`; ~50 lines of Swift; no per-call relaunch needed (~50ms per call)
    c. **A one-shot XCUITest dialog-dismisser running alongside `openurl` calls** — keeps the openurl scheme but adds back some XCUITest overhead
2. **What about prototypes that DON'T use iOS 16+ `NavigationStack(path:)`?** The smoke target uses path-based routing — best-case scenario. Older patterns (`NavigationView` + `NavigationLink(isActive:)`) don't have a clean programmatic-navigation API. Either we gate the new approach on a detected pattern + fall back to XCUITest for older prototypes, or we skip those prototypes entirely.
3. **What's the per-prototype injection footprint?** The Android pipeline injects `TestHooks.kt` + a `LaunchedEffect` line, restored via `finally`. The iOS equivalent is bigger — at minimum a coordinator + arg-parsing in App.swift, plus per-pattern handler logic in the navigation host view. Might need more app-specific overrides.
4. **What's a real-world iOS run time look like end-to-end?** The 8-25× projections are extrapolations from per-step measurements. Worth running the full pipeline once we have working navigation, to compare against the Phase 1 baseline (13m 31s).

## Reproducing the spike

A fresh Claude Code session can re-run the measured parts. All commands assume zsh on macOS, with Xcode + iOS Simulator installed.

### Setup

```bash
# Find an iPhone 17 Pro simulator UDID (or pick whatever's available)
xcrun simctl list devices available | grep "iPhone 17 Pro"

# Set as a variable for the rest of the session
SIMULATOR=ABB2C3EF-0722-4FEF-B632-F6E1B5C585F9   # replace with your UDID

# iOS prototype path
PROTOTYPE=~/Repos/nhsapp-ios-demo-v2

# Verify clean git state in the prototype before any modifications
cd "$PROTOTYPE" && git status
```

### Phase A — pure speed measurements (no app changes needed)

```bash
DERIVED=/tmp/spike-derived-$$
echo "Derived data: $DERIVED"

# 1. Build the app (no test target)
cd "$PROTOTYPE"
{ time xcodebuild build \
  -project nhsapp-ios-demo-v2.xcodeproj \
  -scheme nhsapp-ios-demo-v2 \
  -destination "platform=iOS Simulator,id=$SIMULATOR" \
  -derivedDataPath "$DERIVED" \
  -quiet ; } 2>&1
# Expect: ~13s cold

APP_PATH="$DERIVED/Build/Products/Debug-iphonesimulator/nhsapp-ios-demo-v2.app"
BUNDLE_ID=$(plutil -extract CFBundleIdentifier raw "$APP_PATH/Info.plist")

# 2. Boot simulator (one-time per session)
{ time xcrun simctl boot "$SIMULATOR" ; } 2>&1 || echo "may already be booted"
{ time xcrun simctl bootstatus "$SIMULATOR" -b ; } 2>&1
# Expect: ~24s cold

# 3. Install app
{ time xcrun simctl install "$SIMULATOR" "$APP_PATH" ; } 2>&1
# Expect: ~4.6s first time, ~0.3s warm

# 4. Launch app
{ time xcrun simctl launch "$SIMULATOR" "$BUNDLE_ID" ; } 2>&1
# Expect: ~1.3s

sleep 3   # wait for splash to dismiss

# 5. Time 5 screenshot captures
for i in 1 2 3 4 5; do
  { time xcrun simctl io "$SIMULATOR" screenshot /tmp/shot-$i.png ; } 2>&1
done
# Expect: ~250ms each
```

### Phase B (openurl) — DON'T BOTHER, you'll hit the consent dialog

If you want to reproduce the openurl block specifically:

```bash
# Add URL scheme to the built app's Info.plist (post-build, no project edits)
plutil -insert CFBundleURLTypes -xml '<array><dict><key>CFBundleURLName</key><string>flowmap</string><key>CFBundleURLSchemes</key><array><string>flowmap</string></array></dict></array>' "$APP_PATH/Info.plist"
xcrun simctl uninstall "$SIMULATOR" "$BUNDLE_ID"
xcrun simctl install "$SIMULATOR" "$APP_PATH"
xcrun simctl launch "$SIMULATOR" "$BUNDLE_ID"
sleep 3
xcrun simctl openurl "$SIMULATOR" "flowmap://goto/messages"
sleep 1
xcrun simctl io "$SIMULATOR" screenshot /tmp/openurl-test.png
```

Read the screenshot — you'll see the home screen with an "Open in 'nhsapp-ios-demo-v2'?" dialog overlay. The URL didn't reach the app.

### Phase B' (launch args) — partial; needs the route-handoff fix

This requires modifying the prototype temporarily. Apply the diff in the [Reference: prototype edits to re-apply](#reference-prototype-edits-to-re-apply) section, rebuild, then:

```bash
xcrun simctl shutdown "$SIMULATOR"   # clear any leftover SpringBoard dialogs
xcrun simctl boot "$SIMULATOR"
xcrun simctl bootstatus "$SIMULATOR" -b

# Rebuild after the Swift edits
cd "$PROTOTYPE"
xcodebuild build -project nhsapp-ios-demo-v2.xcodeproj -scheme nhsapp-ios-demo-v2 \
  -destination "platform=iOS Simulator,id=$SIMULATOR" -derivedDataPath "$DERIVED" -quiet

# Re-install
xcrun simctl install "$SIMULATOR" "$APP_PATH"

# Loop
for route in messages profile prescriptions appointments healthConditions; do
  T0=$(date +%s%N)
  xcrun simctl terminate "$SIMULATOR" "$BUNDLE_ID" 2>/dev/null
  xcrun simctl launch "$SIMULATOR" "$BUNDLE_ID" -flowMapRoute "$route" >/dev/null
  sleep 0.6
  xcrun simctl io "$SIMULATOR" screenshot "/tmp/$route.png" >/dev/null
  T1=$(date +%s%N)
  echo "$route: $(((T1-T0)/1000000))ms"
done
```

When you read `/tmp/messages.png` etc., **expect to see HomeView (faded), not the navigated screens.** That's the route-handoff bug. See [the launch-args fix candidates above](#launch-args-partially-worked-but-route-handoff-didnt-reach-the-subscriber).

### Don't forget to revert

```bash
cd "$PROTOTYPE" && git checkout -- nhsapp-ios-demo-v2/HomeView.swift nhsapp-ios-demo-v2/nhsapp_ios_demo_v2App.swift
xcrun simctl uninstall "$SIMULATOR" "$BUNDLE_ID"
rm -rf "$DERIVED"
```

## Next steps for picking up

In rough priority order:

### 1. Fix the launch-args route handoff (1-2 hour effort)

This is the smallest unblock. Replace the App-level `.task` notification post with route-reading inside HomeView. Likely working code shape:

```swift
// HomeView.swift body, near the existing .onReceive handlers:
.task {
    let args = ProcessInfo.processInfo.arguments
    if let i = args.firstIndex(of: "-flowMapRoute"), i + 1 < args.count {
        let route = args[i + 1]
        let dest: NavigationDestination? = switch route {
            case "messages": .messages
            case "profile": .profile
            case "prescriptions": .prescriptions
            case "appointments": .appointments
            case "testResults": .testResults
            case "vaccinations": .vaccinations
            case "healthConditions": .healthConditions
            case "documents": .documents
            default: nil
        }
        if let dest = dest {
            navigationPath = NavigationPath()
            navigationPath.append(dest)
        }
    }
}
```

This puts the read-and-dispatch in the same view that owns `navigationPath`, eliminating the cross-view notification race.

Verify by re-running the launch-args loop. Read `/tmp/messages.png` etc. Should now show MessagesView, ProfileView, etc.

### 2. End-to-end full-pipeline timing (1-2 hour effort)

Once #1 works for 5 routes, extend to all 42 routes (the same node count the XCUITest baseline used). Compare total wall-clock against Phase 1's `13m 30s` baseline. This is the data point that decides whether to commit to the architectural replacement.

### 3. Decide based on data (15 min)

If #2 shows total < 2 minutes: green-light replacing Phases 2+3 with this approach. Update [`../roadmap.md`](../roadmap.md) accordingly.

If #2 shows total > 5 minutes: something else dominates. Profile further or step back to the Phase 2+3 plan.

### 4. Productionise (1-2 weeks once green-lit)

Modules to write:

| File | Role |
|---|---|
| `src/swift-deeplink-injector.js` | Find App.swift / NavigationHost view file, inject route-handler code (analogous to Android's `LaunchedEffect` + `TestHooks.kt` injection), restore via finally |
| `src/swift-spike-runner.js` | Replace `crawlAndScreenshotIos` in `src/swift-crawler.js`. Manages: build → install → launch → loop(navigate + screenshot) → uninstall |
| New screenshot harness | Replaces `src/xctest-generator.js` for the new path |
| Pattern detection in `src/swift-parser.js` | Identify whether prototype uses iOS 16+ NavigationStack — gate the new approach; fall back to existing XCUITest path for older patterns |

### 5. (Optional) Solve the consent-dialog problem for openurl

If the launch-args path works, openurl is moot. But if you want to revisit: the cleanest answer is probably **embedded HTTP server in the app for debug builds**. ~50 lines of Swift using Network framework. No SpringBoard involvement. Per-call ~50ms. See [option 2 in the open questions section](#open-questions).

## Files involved

### In `prototype-flow-map` (this repo)

- This document: [`docs/plans/experiments/ios-architectural-alternative.md`](.) (you're reading it)
- Existing iOS speed plan: [`../roadmap.md`](../roadmap.md) — Phases 2+3 (still the formal plan until this experiment validates)
- The architectural alternative was originally sketched in [`../future-ideas.md`](../future-ideas.md) under "Replace XCUITest with `simctl io` direct screenshots" — that entry should eventually be updated to point here
- iOS pipeline implementation: `src/swift-crawler.js` (current XCUITest path), `src/swift-parser.js`, `src/xctest-generator.js`
- Phase 1 instrumentation that exposed the diagnosis: `src/phase-timer.js`, `src/last-run-cache.js`

### In the iOS prototype (`~/Repos/nhsapp-ios-demo-v2`)

- App entry point: `nhsapp-ios-demo-v2/nhsapp_ios_demo_v2App.swift` — where `.onOpenURL` and launch-args handling go
- Navigation host: `nhsapp-ios-demo-v2/HomeView.swift` — owns `navigationPath`, has `.onReceive` handlers, where the route-handoff should land per [next step #1](#1-fix-the-launch-args-route-handoff-1-2-hour-effort)
- Navigation enum: `nhsapp-ios-demo-v2/Components/NavigationDestination.swift` — `Hashable` enum with 8 cases (prescriptions, appointments, testResults, vaccinations, healthConditions, documents, profile, messages)

The prototype uses `NavigationStack(path:)` with `.navigationDestination(for: NavigationDestination.self)` — the iOS 16+ best-case routing pattern. Programmatic navigation is just `navigationPath.append(NavigationDestination.X)`.

### Simulator artifacts (per-machine, discover at runtime)

- Simulator UDID: `xcrun simctl list devices available | grep "iPhone 17 Pro"`
- Bundle ID: `com.davidhunter.nhsapp-ios-demo-v2-overlays` (extract via `plutil -extract CFBundleIdentifier raw "$APP_PATH/Info.plist"`)
- Built `.app` bundle: `$DERIVED/Build/Products/Debug-iphonesimulator/nhsapp-ios-demo-v2.app`

## Reference: prototype edits to re-apply

These are the temporary modifications that were applied during the spike and reverted via `git checkout`. Re-apply them when picking up Phase B'. **All edits go in `~/Repos/nhsapp-ios-demo-v2/`. Revert with `git checkout` before any commit in that repo.**

### Edit 1: `nhsapp-ios-demo-v2/nhsapp_ios_demo_v2App.swift`

Replaces the entire file:

```swift
import SwiftUI

// SPIKE: temporary deep-link bridge for prototype-flow-map iOS speed spike.
// Will be reverted via `git checkout` before commit. See spike notes in
// prototype-flow-map repo: docs/plans/experiments/ios-architectural-alternative.md
extension Notification.Name {
    static let flowMapNavigate = Notification.Name("flowMapNavigate")
}

@main
struct NHSApp_iOS_Demo_v2App: App {
    @State private var showSplash: Bool

    @State private var profileManager = ProfileManager()
    @State private var appointmentManager = AppointmentManager()
    @State private var pharmacyManager = PharmacyManager()

    // SPIKE: read launch arguments
    private let pendingRoute: String?

    init() {
        let args = ProcessInfo.processInfo.arguments
        var route: String? = nil
        if let i = args.firstIndex(of: "-flowMapRoute"), i + 1 < args.count {
            route = args[i + 1]
        }
        self.pendingRoute = route
        // Skip splash if launched with a route arg
        self._showSplash = State(initialValue: route == nil)
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if showSplash {
                    SplashView {
                        withAnimation(.easeOut(duration: 0.8)) {
                            showSplash = false
                        }
                    }
                    .ignoresSafeArea()
                    .transition(.opacity)
                } else {
                    HomeView()
                        .transition(.opacity)
                }
            }
            .environment(profileManager)
            .environment(appointmentManager)
            .environment(pharmacyManager)
            .animation(.easeOut(duration: 0.8), value: showSplash)
            .onOpenURL { url in
                // SPIKE: flowmap://goto/<route>
                guard url.scheme == "flowmap", url.host == "goto" else { return }
                let route = url.pathComponents.dropFirst().first ?? ""
                if showSplash { showSplash = false }
                NotificationCenter.default.post(name: .flowMapNavigate, object: route)
            }
            .task {
                // SPIKE: dispatch the launch-arg route once HomeView is mounted.
                // KNOWN BUG: this fires before HomeView's .onReceive subscribes.
                // FIX (per next-steps #1): move this read-and-dispatch INSIDE
                // HomeView's own .task, not at the App level.
                if let route = pendingRoute {
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    NotificationCenter.default.post(name: .flowMapNavigate, object: route)
                }
            }
        }
    }
}

#Preview("App Flow – Runs Splash") {
    AppFlowPreview()
}
```

### Edit 2: `nhsapp-ios-demo-v2/HomeView.swift`

Insert a new `.onReceive` handler immediately after `.id(navigationID)` (currently around line 397):

```swift
.id(navigationID)
.onReceive(NotificationCenter.default.publisher(for: .flowMapNavigate)) { note in
    // SPIKE: deep-link routing for prototype-flow-map iOS speed spike.
    // Will be reverted via `git checkout` before commit.
    guard let route = note.object as? String else { return }
    let dest: NavigationDestination?
    switch route {
    case "messages": dest = .messages
    case "profile": dest = .profile
    case "prescriptions": dest = .prescriptions
    case "appointments": dest = .appointments
    case "testResults": dest = .testResults
    case "vaccinations": dest = .vaccinations
    case "healthConditions": dest = .healthConditions
    case "documents": dest = .documents
    default: dest = nil
    }
    if let dest = dest {
        navigationPath = NavigationPath()
        navigationPath.append(dest)
    }
}
.onReceive(NotificationCenter.default.publisher(for: .willSwitchProfile)) { _ in
    // ... existing handler ...
```

### Edit 3 (post-build, runtime): URL scheme registration

If using openurl path (which is blocked anyway — skip unless investigating consent-dialog workarounds):

```bash
plutil -insert CFBundleURLTypes -xml '<array><dict><key>CFBundleURLName</key><string>flowmap</string><key>CFBundleURLSchemes</key><array><string>flowmap</string></array></dict></array>' "$APP_PATH/Info.plist"
```

This is a post-build edit on the `.app` bundle's `Info.plist`. Wiped on rebuild — re-apply after each `xcodebuild build`. No project file changes needed. Modifying signed Simulator builds doesn't break code-signing (Simulator's lenient).

## Decision criteria

This experiment graduates to a committed workstream when:

- Launch-args (or HTTP server, or a fixed openurl) reliably navigates to all 8 NavigationDestination cases AND captures distinct screenshots
- Full 42-screen run completes in < 2 minutes wall-clock (5× faster than Phase 1 baseline of 13m 31s)
- A defensible path exists for prototypes that don't use iOS 16+ NavigationStack (gate-and-fallback or scope explicit)

This experiment gets shelved (back to Phase 2+3) when:

- All three navigation mechanisms (launch-args, HTTP server, openurl-with-dismiss) prove unreliable
- The full-run timing turns out to be much worse than Phase A's per-step measurements suggest
- The required injection footprint per prototype is too large to manage idempotently
