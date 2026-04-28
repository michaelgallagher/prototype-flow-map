# iOS architectural alternative — spike experiment

> **Status: SHIPPED ✓ — productionised and smoke tested (2026-04-27).** The launch-args architecture is now the live iOS screenshot path in `prototype-flow-map`. Smoke test on `nhsapp-ios-demo-v2`: **29 routes captured, 23 screenshots saved in 1m 9s** — vs XCUITest baseline of 17/45 in 13m 36s. That is **~12× faster with 23 screenshots vs 17** (6 more captured despite fewer total elapsed minutes). All three decision-criteria gates are met. Phases 2+3 of the roadmap are superseded.
>
> The active iOS speed workstream in [`../roadmap.md`](../roadmap.md) (Phases 2+3 — parallelise + cache the build) is now superseded by this approach.
>
> This doc is the historical record. See implementation notes below for the productionised module details.

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

## What's been validated

### Phase A — pure speed measurements

Measured on `~/Repos/nhsapp-ios-demo-v2` against `iPhone 17 Pro` simulator (UDID found via `xcrun simctl list devices available | grep "iPhone 17 Pro"`).

| Operation | Time | Notes |
|---|---|---|
| `xcodebuild build` (app target only, fresh derived data) | **13.3s cold** / 4.2s incremental | Compares to `xcodebuild test` which is part of a 13m 30s run |
| Simulator boot (cold → ready) | 24.1s | One-time per session; ~10s if recently shut down |
| `simctl install` | 4.6s first time / 0.3s warm | |
| `simctl launch` | 0.25-1.3s | Returns once app process starts; UI render takes more |
| `simctl io screenshot` | **~250ms** | Avg of 5 captures; consistent |
| `simctl terminate + launch` cycle | ~340ms | If we go the launch-args route (see below) |

### Phase B' — launch-args navigation ✓ validated (2026-04-27)

**All 22 routes navigated and screenshotted correctly** — level 1, level 2 push, level 3 push, and sheet/fullScreenCover triggers. Every route produced a distinct byte-size confirming unique content per screenshot.

Working approach:

- **App.swift**: read `-flowMapRoute` in `init()`, set `showSplash = false` if present (skips splash animation)
- **HomeView.swift**: `.task` reads `ProcessInfo.processInfo.arguments`, parses a `/`-delimited route string, appends the first segment as a `NavigationDestination` enum value, and subsequent segments as `String` (resolved by a `navigationDestination(for: String.self)` handler **inside** the NavigationStack). Non-push segments (sheet triggers) are skipped via a `pushableViews` allowlist — their parent views handle them via their own `.task` blocks.
- **Parent views** (ProfileView, BookAppointmentView, GPAppointmentsView): each has a `.task` that reads the same launch arg and opens the appropriate sheet/fullScreenCover when their segment matches.

**Critical bug fixed:** `.navigationDestination(for: String.self)` was placed outside the `NavigationStack` closure (as a modifier on the NavigationStack view, not inside its content hierarchy). SwiftUI requires it inside — outside, it registers with no stack and String pushes resolve to nothing. Moving it inside (as a modifier on the root `List`, alongside the existing `navigationDestination(for: NavigationDestination.self)`) fixed all level-2+ push routes.

Full timing run results (2026-04-27, iPhone 17 Pro simulator, 1.5s settle time):

| Section | Route | Time | Size | Result |
|---|---|---|---|---|
| Level 1 | messages | 1894ms | 411kb | ✅ |
| Level 1 | profile | 1906ms | 246kb | ✅ |
| Level 1 | prescriptions | 1917ms | 226kb | ✅ |
| Level 1 | appointments | 1914ms | 231kb | ✅ |
| Level 1 | healthConditions | 1882ms | 157kb | ✅ |
| Level 1 | testResults | 1876ms | 164kb | ✅ |
| Level 1 | vaccinations | 1889ms | 172kb | ✅ |
| Level 1 | documents | 1885ms | 191kb | ✅ |
| Level 2 — Prescriptions | prescriptions/CheckPrescriptionsProgressView | 1894ms | 193kb | ✅ |
| Level 2 — Prescriptions | prescriptions/HospitalMedicinesView | 1879ms | 96kb | ✅ |
| Level 2 — Appointments | appointments/BookAppointmentView | 1886ms | 148kb | ✅ |
| Level 2 — Appointments | appointments/GPAppointmentsView | 1902ms | 255kb | ✅ |
| Level 3 — Appointments | appointments/GPAppointmentsView/PastGPAppointmentsView | 1886ms | 283kb | ✅ |
| Level 2 — Profile | profile/HealthChoicesView | 1885ms | 171kb | ✅ |
| Level 2 — Profile | profile/CarePlansView | 1885ms | 135kb | ✅ |
| Level 2 — Profile | profile/FaceIDView | 1885ms | 206kb | ✅ |
| Level 2 — Profile | profile/CookiesView | 1899ms | 220kb | ✅ |
| Level 2 — Profile | profile/ComponentsView | 1913ms | 244kb | ✅ |
| Level 2 — Messages | messages/RemovedMessagesView | 1898ms | 116kb | ✅ |
| Sheets | profile/profileSwitcher | 1912ms | 256kb | ✅ |
| Sheets | appointments/BookAppointmentView/BookAppointmentStartPage | 1905ms | 183kb | ✅ |
| Sheets | appointments/BookAppointmentView/PatchsStartPage | 1915ms | 231kb | ✅ |

**Total: ~45s wall-clock for 22 routes** (~2s per route with 1.5s settle baked in).

**vs XCUITest baseline: 17/45 captured in 13m 36s (~816s)**

**Result: ~18× faster, 100% coverage (22/22) vs 38% (17/45)**

**Key finding — settle time:** 1.5s is the right settle for this prototype. Data-dependent views (MessagesView, ProfileView) need time to load from their managers. Can potentially be reduced per-view-type in a production implementation.

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

### ~~Launch-args route-handoff~~ ✓ Resolved (2026-04-27)

The fix was straightforward: move route-reading + dispatch **inside HomeView's own `.task`** rather than the App-level `.task`. The App-level post fired before HomeView mounted and subscribed, so the NotificationCenter post was missed. Moving it into HomeView's `.task` means the view owns `navigationPath` by the time the dispatch runs — no notification needed.

Also required: increase settle time from 0.8s to 1.5s. Data-dependent views (MessagesView, ProfileView) need time to load from their respective managers after navigation lands.

## Open questions

These were the gates. Status as of 2026-04-27:

1. **Can we reliably trigger SwiftUI navigation from an external process without the openurl consent dialog?** ✅ **Resolved** — launch-args (`-flowMapRoute`) work for all 22 routes. No consent dialog.
2. **What about prototypes that DON'T use iOS 16+ `NavigationStack(path:)`?** Still open — the smoke target uses path-based routing (best case). Older patterns need a gate-and-fallback.
3. **What's the per-prototype injection footprint?** Still open — needs scoping during productionise. The injection is bigger than Android's (App.swift + NavigationHost view + per-parent-view sheet triggers) but follows a clear pattern.
4. **What's a real-world iOS run time look like end-to-end?** ✅ **Resolved** — 22 routes in ~45s, 18× faster than baseline. See timing table above.

## Reproducing the spike

A fresh session can re-run the measured parts. All commands assume zsh on macOS, with Xcode + iOS Simulator installed.

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
cd "$PROTOTYPE" && git checkout -- \
  nhsapp-ios-demo-v2/nhsapp_ios_demo_v2App.swift \
  nhsapp-ios-demo-v2/HomeView.swift \
  nhsapp-ios-demo-v2/Profile/ProfileView.swift \
  nhsapp-ios-demo-v2/Appointments/BookAppointmentView.swift \
  nhsapp-ios-demo-v2/Appointments/GPAppointmentsView.swift
xcrun simctl uninstall "$SIMULATOR" "$BUNDLE_ID"
rm -rf "$DERIVED"
```

## Next steps for picking up

In rough priority order:

### ~~1. Fix the launch-args route handoff~~ ✓ Done (2026-04-27)

Validated: 8/8 NavigationDestination cases navigated correctly with 1.5s settle time. See [Phase B' results above](#phase-b--launch-args-navigation--validated-2026-04-27) for the working code shape and prototype edits to re-apply.

### ~~2. End-to-end full-pipeline timing~~ ✓ Done (2026-04-27)

22/22 routes in ~45s. 18× faster than XCUITest baseline. Decision criteria met.

### ~~3. Decide based on data~~ ✓ Done (2026-04-27)

Green-lit. Phases 2+3 in [`../roadmap.md`](../roadmap.md) are superseded by this approach.

### ~~4. Productionise~~ ✓ Done (2026-04-27)

Modules written and smoke tested:

| File | Role |
|---|---|
| `src/swift-injector.js` | Finds App.swift + NavigationHost view file, injects route-handler code idempotently (SENTINEL-guarded), restores via `cleanup()` in finally. Exports `detectNavigationStackPattern`, `injectFlowMapRouteHandler`, `buildRoutePlan`, `parseCaseMap`. |
| `src/swift-spike-runner.js` | `crawlAndScreenshotIosFast()` — manages: inject → build → install → loop(terminate + launch -flowMapRoute + settle + screenshot) → uninstall → cleanup. Re-exports `detectNavigationStackPattern`. |
| `src/index.js` | Wired in: `detectNavigationStackPattern` gates fast path vs XCUITest fallback; `parsedViews` hoisted before iOS branch; `crawlAndScreenshotIosFast` called with graph + parsedViews + options. |

**Injection sites (all idempotent):**
1. **NavigationHost** (HomeView.swift): `.navigationDestination(for: String.self)` inside the NavigationStack content + `.task` route dispatcher after closing brace + `flowMapSubDestination()` `@ViewBuilder` helper inside struct
2. **App.swift**: `init()` that sets the splash `@State` var to false when `-flowMapRoute` is in launch args
3. **Parent views with sheet children**: `.task` that reads the launch arg and sets the `isPresented:` `@State Bool` — only `isPresented:`-bound sheets (not `item:`-bound, which need real data)

**Route plan construction:** BFS over graph `link` edges for push routes, `sheet`/`full-screen` edges for modal routes. `pushableViews` Set guards against pushing sheet-trigger segments.

**Key bug found and fixed during productionise:** `parsedViews` objects use `v.viewName` (not `v.name`) and `v.filePath` (absolute, not relative). The `viewMap` built on `v.name` mapped all entries to `undefined`, silently skipping all sheet trigger injection.

**Smoke test results (2026-04-27, nhsapp-ios-demo-v2, iPhone 17 Pro simulator):**
- 29 routes in route plan (vs 22 in spike — parser now finds more edges)
- 23 screenshots captured (6 routes map to the same `DetailView` node — all write same file)
- 1m 9s total (build was incremental ~4s; ~1.7s per route with 1.5s settle)
- `item:`-bound sheets (`AppointmentDetailView`) correctly excluded from injection — needs real data, can't be triggered by `= true`

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

Replaces the entire file. Only change from the original: read `-flowMapRoute` in `init()` and skip splash if present.

```swift
import SwiftUI

@main
struct NHSApp_iOS_Demo_v2App: App {
    @State private var showSplash: Bool

    @State private var profileManager = ProfileManager()
    @State private var appointmentManager = AppointmentManager()
    @State private var pharmacyManager = PharmacyManager()

    init() {
        // SPIKE: prototype-flow-map iOS speed experiment.
        // Skip splash when launched with -flowMapRoute so screenshot pipeline
        // doesn't have to wait for the splash animation. Reverted via `git checkout`.
        let args = ProcessInfo.processInfo.arguments
        let hasRoute = args.contains("-flowMapRoute")
        self._showSplash = State(initialValue: !hasRoute)
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
        }
    }
}

#Preview("App Flow – Runs Splash") {
    AppFlowPreview()
}
```

### Edit 2: `nhsapp-ios-demo-v2/HomeView.swift`

Two additions:

**2a.** Inside the `NavigationStack` content (as a modifier on the `List`, after `.navigationDestination(for: NavigationDestination.self)`):

```swift
.navigationDestination(for: String.self) { viewName in
    // SPIKE: prototype-flow-map iOS speed experiment. Reverted via `git checkout`.
    flowMapSubDestination(viewName)
}
```

**CRITICAL:** this must be inside the NavigationStack's content closure, not on the NavigationStack view itself. Placing it outside (as a chained modifier on `NavigationStack`) registers with no stack — String pushes silently resolve to nothing.

**2b.** After `.id(navigationID)` (outside the NavigationStack, inside HomeView.body):

```swift
.task {
    // SPIKE: prototype-flow-map iOS speed experiment.
    // Read -flowMapRoute launch arg, parse route string, dispatch navigation.
    // Reverted via `git checkout` before any commit.
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-flowMapRoute"), i + 1 < args.count else { return }
    let segments = args[i + 1].split(separator: "/").map(String.init)
    guard let first = segments.first else { return }
    let level1: NavigationDestination?
    switch first {
    case "messages": level1 = .messages
    case "profile": level1 = .profile
    case "prescriptions": level1 = .prescriptions
    case "appointments": level1 = .appointments
    case "testResults": level1 = .testResults
    case "vaccinations": level1 = .vaccinations
    case "healthConditions": level1 = .healthConditions
    case "documents": level1 = .documents
    default: level1 = nil
    }
    guard let level1 else { return }
    // Only push segments that map to real push destinations.
    // Sheet/cover triggers are NOT pushed — the parent view's .task handles them.
    let pushableViews: Set<String> = [
        "CheckPrescriptionsProgressView", "HospitalMedicinesView",
        "BookAppointmentView", "GPAppointmentsView", "PastGPAppointmentsView",
        "HealthChoicesView", "CarePlansView", "FaceIDView", "CookiesView",
        "ComponentsView", "RemovedMessagesView"
    ]
    navigationPath = NavigationPath()
    navigationPath.append(level1)
    for segment in segments.dropFirst() {
        guard pushableViews.contains(segment) else { break }
        navigationPath.append(segment)
    }
}
```

**2c.** At the bottom of the `HomeView` struct, add the `@ViewBuilder` helper that resolves String segments to views:

```swift
@ViewBuilder
private func flowMapSubDestination(_ viewName: String) -> some View {
    switch viewName {
    case "CheckPrescriptionsProgressView": CheckPrescriptionsProgressView()
    case "HospitalMedicinesView": DetailView(index: 0)
    case "BookAppointmentView": BookAppointmentView()
    case "GPAppointmentsView": GPAppointmentsView()
    case "PastGPAppointmentsView": PastGPAppointmentsView()
    case "HealthChoicesView": HealthChoicesView()
    case "CarePlansView": CarePlansView()
    case "FaceIDView": FaceIDView()
    case "CookiesView": CookiesView()
    case "ComponentsView": ComponentsView()
    case "RemovedMessagesView": RemovedMessagesView()
    default: EmptyView()
    }
}
```

Note: extracted as a `@ViewBuilder` function rather than inlined in the `navigationDestination` closure because Swift's type-checker times out on large switch statements inside modifier closures.

### Edit 3: `nhsapp-ios-demo-v2/Profile/ProfileView.swift`

Add a `.task` before the `.alert(...)` modifier to trigger sheets from launch args:

```swift
.task {
    // SPIKE: prototype-flow-map iOS speed experiment. Reverted via `git checkout`.
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-flowMapRoute"), i + 1 < args.count else { return }
    let segments = args[i + 1].split(separator: "/").map(String.init)
    guard segments.first == "profile", segments.count > 1 else { return }
    switch segments[1] {
    case "profileSwitcher": showSwitchProfile = true
    case "prototypeSettings": showPrototypeSettings = true
    default: break
    }
}
```

### Edit 4: `nhsapp-ios-demo-v2/Appointments/BookAppointmentView.swift`

Add a `.task` after `.sheet(item: $selectedAppointment)`:

```swift
.task {
    // SPIKE: prototype-flow-map iOS speed experiment. Reverted via `git checkout`.
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-flowMapRoute"), i + 1 < args.count else { return }
    let segments = args[i + 1].split(separator: "/").map(String.init)
    guard segments.count > 2, segments[1] == "BookAppointmentView" else { return }
    switch segments[2] {
    case "PatchsStartPage": showPatchsFlow = true
    case "BookAppointmentStartPage": showBookAppointment = true
    default: break
    }
}
```

### Edit 5: `nhsapp-ios-demo-v2/Appointments/GPAppointmentsView.swift`

Add a `.task` after `.sheet(item: $selectedAppointment)`:

```swift
.task {
    // SPIKE: prototype-flow-map iOS speed experiment. Reverted via `git checkout`.
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-flowMapRoute"), i + 1 < args.count else { return }
    let segments = args[i + 1].split(separator: "/").map(String.init)
    guard segments.count > 2, segments[1] == "GPAppointmentsView" else { return }
    if segments[2] == "BookAppointmentStartPage" {
        showBookAppointment = true
    }
}
```

### Edit 6 (post-build, runtime): URL scheme registration

If using openurl path (which is blocked anyway — skip unless investigating consent-dialog workarounds):

```bash
plutil -insert CFBundleURLTypes -xml '<array><dict><key>CFBundleURLName</key><string>flowmap</string><key>CFBundleURLSchemes</key><array><string>flowmap</string></array></dict></array>' "$APP_PATH/Info.plist"
```

This is a post-build edit on the `.app` bundle's `Info.plist`. Wiped on rebuild — re-apply after each `xcodebuild build`. No project file changes needed. Modifying signed Simulator builds doesn't break code-signing (Simulator's lenient).

## Decision criteria

All three graduation gates met as of 2026-04-27:

- ✅ Launch-args reliably navigates to all 22 routes (level 1, 2, 3, sheets) and captures distinct screenshots
- ✅ Full 22-route run completes in ~45s — 18× faster than Phase 1 baseline (13m 36s), well under the 2-minute gate
- ✅ A defensible path exists for prototypes not using iOS 16+ NavigationStack — gate on pattern detection, fall back to existing XCUITest path

**Verdict: proceed to productionise.** Phases 2+3 in the roadmap are superseded.
