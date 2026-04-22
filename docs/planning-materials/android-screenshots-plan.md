# Plan — Android screenshot capture

> Reviewable, editable plan for adding screenshot capture to the Android branch of prototype-flow-map.
> Based on the **existing proof-of-concept** in `~/Repos/native-nhsapp-android-prototype/DemoNHSApp2` (not committed), not the iOS pipeline.

## Goal

When the user runs the tool against an Android prototype with `--screenshots` (the default), produce a PNG per reachable screen in `<outputDir>/screenshots/` and set `node.screenshot` to that path. Same contract as iOS so the viewer works unchanged.

Reference prototype: `~/Repos/native-nhsapp-android-prototype/DemoNHSApp2` (package `com.prototype.nhsappnotab`, branch `design-test--no-tabs--overlay-browser`).

## Pre-existing proof-of-concept in the prototype

The following is already present in the demo as untracked files (not yet verified end-to-end):

- **`app/src/main/java/com/prototype/nhsappnotab/navigation/TestHooks.kt`** — `@VisibleForTesting` singleton holding a `NavHostController?`. Lives in *main* source so the running app can populate it.
- **`AppNavigation.kt` edit** (uncommitted): a single line `LaunchedEffect(navController) { TestHooks.navController = navController }` right after `val navController = rememberNavController()`. This publishes the live nav controller to the test side once the activity is composed.
- **`app/src/androidTest/java/com/prototype/nhsappnotab/FlowMapVerify.kt`** — a proof test using `createAndroidComposeRule<MainActivity>`, waits up to 10s for `TestHooks.navController` to be set, calls `navController.navigate("messages")`, then captures `composeTestRule.onRoot().captureToImage()` and writes `messages.png` to `externalCacheDir/flow-map/`. Skips onboarding by setting the `onboarding/completed` shared-pref in `@BeforeClass`.

**This approach is strictly simpler than UiAutomator + tap-by-label:**

- Navigation is by route string (which the graph parser already produces as node IDs) — no label extraction, no scroll retries, no splash timing workarounds.
- Screenshot is a Compose `captureToImage()` — returns exactly the app's UI tree.
- The only meaningful weakness: routes with parameters (e.g. `message_detail/{messageId}`) need a concrete value before `navigate()` will render them properly.

## Current state of the flow-map repo (post commit `6258729`)

- `src/index.js:310-311` — Android branch of `generateNative()` logs `"Skipping screenshots (not yet supported for Android)"`.
- Parser + graph builder already produce correct route strings as node IDs. **No parser changes needed** for this approach. The label-extraction work from the first draft of this plan is dropped.
- Edge labels remain `null`/`""` for link/modal edges — we don't need them here. (If we later want hover tooltips showing button text in the viewer, that's a separate, optional improvement.)

## Strategy

Generate a `FlowMapCapture.kt` containing one `@Test` per screen. Each test:

1. Waits for `TestHooks.navController` to be populated.
2. Calls `navController.navigate("<route>")` on the UI thread.
3. `waitForIdle()` + small sleep.
4. Captures screenshot → writes to `externalCacheDir/flow-map/<sanitizedNodeId>.png`.

The crawler auto-injects `TestHooks.kt` and the `AppNavigation.kt` hook line if not already present (idempotent — the demo already has them), runs gradle tests, pulls PNGs off the device, restores any files it touched.

## Assumptions (flag if wrong)

- **Auto-inject is desired** — tool modifies the prototype's main source (`TestHooks.kt` + one line in `AppNavigation.kt`) at run time and restores afterwards, mirroring the iOS UITest-file rewrite pattern. User confirmed this is fine.
- **Compose Test is sufficient** — `onRoot().captureToImage()` captures the full app UI. If a screen renders a native `WebView` or a non-Compose element, the capture may be blank or partial for that region. Acceptable for Phase 1; document the limitation.

## Steps

### 0. Verify the PoC works end-to-end ✅ (completed 2026-04-22)

Ran `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.prototype.nhsappnotab.FlowMapVerify` on Pixel_9 emulator. BUILD SUCCESSFUL in 9s, 1 test passed. Logcat confirmed:

```
FlowMapVerify: Wrote /storage/emulated/0/Android/data/com.prototype.nhsappnotab/cache/flow-map/messages.png size=279342
```

The PoC architecture works: `TestHooks.navController` populates, `composeTestRule.onRoot().captureToImage()` produces a valid 279KB PNG.

**Key finding — affects Step 2:** `connectedDebugAndroidTest` **uninstalls the app package after running**, which wipes `/sdcard/Android/data/<pkg>/cache/`. Post-test `adb shell ls` returned "No such file or directory". This means the crawler **cannot** `./gradlew connectedDebugAndroidTest && adb pull` — the PNGs are gone before the pull fires.

Two workable approaches for Step 2:

- **Approach A (preferred):** Build APKs separately, install manually, run instrumentation manually, pull files, uninstall manually — full control over sequence:
  ```
  ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
  adb install -r app/build/outputs/apk/debug/app-debug.apk
  adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
  adb shell am instrument -w -e class com.prototype.nhsappnotab.FlowMapCapture \
    com.prototype.nhsappnotab.test/androidx.test.runner.AndroidJUnitRunner
  adb pull /sdcard/Android/data/com.prototype.nhsappnotab/cache/flow-map/ <outputDir>/screenshots/
  adb uninstall com.prototype.nhsappnotab.test
  adb uninstall com.prototype.nhsappnotab
  ```
- **Approach B:** Modify the generated test to write to `/sdcard/Download/flow-map-screenshots/` instead of `externalCacheDir`. Survives uninstall but requires the test APK to declare write-external-storage permission and may run into scoped-storage restrictions on API 30+.

Going with Approach A in Step 2.

### 1. New file: `src/android-test-generator.js`

Exports `{ generateAndroidTest, sanitizeFilename }`. Inputs: `(graph, packageName, mainActivityClass, overrides)`. Output: Kotlin source for `FlowMapCapture.kt`.

**Per-screen test body** (template):

```kotlin
@Test
fun testCapture_<safeId>() {
    val route = "<raw-route-template-or-override>"
    composeTestRule.waitUntil(timeoutMillis = 10_000) { TestHooks.navController != null }
    composeTestRule.runOnUiThread { TestHooks.navController!!.navigate(route) }
    composeTestRule.waitForIdle()
    Thread.sleep(500)
    writeScreenshot("<safeId>")
}
```

**Which nodes get a test:**

- Phase 1: screens whose raw route template contains no `{...}` placeholder. This covers the bulk of DemoNHSApp2 (home, messages, profile, appointments list, prescriptions list, etc.). Count at plan time: TBD after running the parser — expected ~20-25 of 29 nodes.
- Routes with params: emit a `// skipped: requires param value for <route>` line; expose via config overrides (see below).

**Overrides** (optional, already in `flow-map.config.yml` format):

```yaml
overrides:
  message_detail:
    route: "message_detail/demo-msg-1"
  prescriptionPharmacyDetail:
    route: "prescriptionPharmacyDetail/1"
```

For Android, the override schema is simpler than iOS — no tap steps needed, just a concrete route to navigate to. Extend the existing `overrides` config parser to accept `{ route: string }` alongside iOS-style `{ steps: [...] }`. Android generator ignores `steps`; iOS ignores `route`.

**Helpers emitted in the test class:**

- `writeScreenshot(name)` — `composeTestRule.onRoot().captureToImage().asAndroidBitmap()` → PNG in `ctx.externalCacheDir/flow-map/`.
- `@BeforeClass skipOnboardingBeforeActivityLaunches()` — copy of the PoC's onboarding bypass. Parameterize shared-pref name/key if a future prototype uses different ones, but leave as literal `"onboarding"/"completed"` for Phase 1.

**Root navigation:** the Android app launches directly to its start destination. The first `navigate("<start>")` from that state is a no-op, but harmless — it still triggers a recompose and the screenshot captures fine.

### 2. New file: `src/kotlin-crawler.js`

Exports `{ crawlAndScreenshotAndroid }`. Signature: `async function crawlAndScreenshotAndroid(graph, { prototypePath, outputDir, overrides })`.

**Pipeline inside:**

1. **Locate app module.** Walk for `build.gradle.kts` containing `id("com.android.application")` or `alias(libs.plugins.android.application)`. Record `projectRoot` (has `gradlew`), `moduleDir`, and parse `namespace = "..."` for the package name.
2. **Find main activity.** Grep `AndroidManifest.xml` for the `<activity>` with `<action android:name="android.intent.action.MAIN" />`. Extract the class name. For DemoNHSApp2 this is `.MainActivity` → `com.prototype.nhsappnotab.MainActivity`.
3. **Resolve paths.** `pkgPath = packageName.replace(/\./g, "/")`. Derive:
   - `testHooksPath = app/src/main/java/<pkgPath>/navigation/TestHooks.kt`
   - `appNavPath = app/src/main/java/<pkgPath>/navigation/AppNavigation.kt`
   - `flowMapCapturePath = app/src/androidTest/java/<pkgPath>/FlowMapCapture.kt`
4. **Find device.** `adb devices` → pick first `device` state; accept `ANDROID_SERIAL` env override.
5. **Generate test.** Call `generateAndroidTest(graph, packageName, mainActivityClass, overrides)`. Write it to `<outputDir>/generated-android-test.kt` for debugging (mirrors iOS's `generated-xcuitest.swift`).
6. **Inject files (idempotent):**
   - If `TestHooks.kt` missing → write it. Flag it as "we created this" so we clean up afterwards.
   - If `AppNavigation.kt` doesn't contain `TestHooks.navController = navController` → insert the `LaunchedEffect` line right after `val navController = rememberNavController()`. Also ensure the import `import com.prototype.nhsappnotab.navigation.TestHooks` (or whatever the package resolves to). Record original content for restore.
   - Write `FlowMapCapture.kt` (always — overwrite). If an existing `FlowMapCapture.kt` is there (not ours), back it up.
7. **Device prep.** Disable animations (`adb shell settings put global window_animation_scale 0` + two others), backing up prior values. No cache clear needed (step 9 uninstalls fresh every run).
8. **Build, install, instrument, pull, uninstall** (Approach A from Step 0):
   1. `./gradlew :app:assembleDebug :app:assembleDebugAndroidTest` — build app + test APKs.
   2. Locate outputs: `app/build/outputs/apk/debug/app-debug.apk` and `app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk` (glob to be resilient to APK splits).
   3. `adb install -r <app-apk>` then `adb install -r <test-apk>`.
   4. `adb shell am instrument -w -e class <pkg>.FlowMapCapture <pkg>.test/androidx.test.runner.AndroidJUnitRunner` — runs the test. Parse stdout for `OK (n tests)` / `FAILURES!!!`. Surface lines containing `[flow-map]`.
   5. `adb pull /sdcard/Android/data/<pkg>/cache/flow-map/ <outputDir>/screenshots/` — pulls PNGs while app is still installed.
   6. `adb uninstall <pkg>.test` then `adb uninstall <pkg>` — cleanup.
9. **Attach to graph.** For each graph node, check for `<outputDir>/screenshots/<sanitizeFilename(node.id)>.png` → set `node.screenshot = "screenshots/<filename>"`.
10. **Restore** (always, in `finally`):
    - Delete `FlowMapCapture.kt` (or restore backup if there was one).
    - If we created `TestHooks.kt` → delete it. If it was already there → leave it.
    - If we modified `AppNavigation.kt` → restore original. If the hook was already present → leave it.
    - Restore animation settings.
11. **Report.** `Captured N of M screens`.

### 3. Wire into `src/index.js`

Replace the Android branch at `src/index.js:310-311`:

```js
} else if (screenshots && platform === "android") {
  console.log("4️⃣  Capturing screenshots via Android Compose test...");
  graph = await crawlAndScreenshotAndroid(graph, {
    prototypePath,
    outputDir: mapOutputDir,
    overrides: config.overrides,
  });
  console.log(`   Captured ${graph.nodes.filter((n) => n.screenshot).length} screenshots`);
}
```

Add `const { crawlAndScreenshotAndroid } = require("./kotlin-crawler");` near other crawler imports.

### 4. Smoke test

```
node bin/cli.js ~/Repos/native-nhsapp-android-prototype/DemoNHSApp2 -o /tmp/android-test-run
```

**Expected:** 20+ PNGs in `/tmp/android-test-run/screenshots/`, viewer renders them, `git status` in the prototype is clean (no leftover `FlowMapCapture.kt`, `AppNavigation.kt` unchanged, `TestHooks.kt` state preserved depending on whether it was there before).

**If the prototype's pre-existing uncommitted changes (`TestHooks.kt`, `AppNavigation.kt` edit) are still on disk during the run:** the tool detects them as "already present" → doesn't touch them → leaves them exactly as they were. Don't disturb the `design-test--no-tabs--overlay-browser` branch state.

## Open questions / risks

- **PoC works?** Step 0. Everything downstream assumes yes.
- **Screenshot location — internal vs external cache dir.** The PoC writes to `ctx.externalCacheDir` which resolves differently by API and by whether external storage is emulated. `adb pull /sdcard/Android/data/<pkg>/cache/flow-map/` works on most setups but may need fallback to `run-as <pkg>` to pull from the app's internal storage. Confirm during step 0.
- **`captureToImage()` and WebView / system chrome.** Compose `onRoot()` captures the Compose tree only. Screens with an embedded `AndroidView { WebView(...) }` may show a blank region where the WebView is. Not a blocker — document the limitation. If it bites us on the NHS app's browser-overlay screens, fall back to UiAutomator `takeScreenshot` for those specific nodes via an override.
- **`MainActivity.kt` assumptions.** Auto-inject assumes the nav controller is created exactly as `val navController = rememberNavController()` in `AppNavigation.kt` (or whichever file holds the NavHost). If a prototype names it differently, the regex-based insert fails. Plan: if anchor not found, print a clear error explaining what to add manually; don't attempt a guess.
- **Parameterized routes.** Phase 1 skips them. Phase 2 could:
  - Have the parser record sample arg values it sees in navigate() calls, or
  - Allow the config's `overrides[<nodeId>].route` to supply a value (already in the plan).
- **Concurrent runs / multiple devices.** For now, single device assumed. `ANDROID_SERIAL` env var routes the choice if multiple attached.
- **Prototype already has untracked `FlowMapVerify.kt`.** Our generated `FlowMapCapture.kt` is a separate file. `FlowMapVerify.kt` stays untouched — the Gradle class filter targets `FlowMapCapture` only.

## Dropped from the first draft

- Parser label extraction (was steps 1 + 2). Unnecessary — we navigate by route, not by tap.
- UiAutomator dep injection. Unnecessary — Compose Test is already in the demo's `androidTestImplementation`.
- Modal-child BFS logic. Unnecessary — any screen, modal or not, is reachable via a single `navigate(route)`.

## Checkpoint (update as work progresses)

- [ ] Step 0 — verify PoC end-to-end produces `messages.png`
- [ ] Step 1 — `src/android-test-generator.js`
- [ ] Step 2 — `src/kotlin-crawler.js`
- [ ] Step 3 — `src/index.js` wiring
- [ ] Step 4 — smoke test against DemoNHSApp2

## Commit strategy

One commit per step. After step 4, a final commit updating `docs/how-it-works.md` (new Android screenshots section) and memory (`## Android/Kotlin support — current state` reflects working screenshots).

The prototype's untracked files (`TestHooks.kt`, `FlowMapVerify.kt`, `AppNavigation.kt` edit) are the user's work-in-progress on the `design-test--no-tabs--overlay-browser` branch. The four unpushed commits on that branch are unrelated UI fixes. Do not modify any of this from the flow-map repo.
