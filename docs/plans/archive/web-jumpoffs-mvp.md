# Web jump-offs — MVP delivery notes

> **Status: delivered.** Archived for historical context. The user-facing reference is [`../../web-jumpoffs.md`](../../web-jumpoffs.md); the architecture overview is in [`../../how-it-works.md`](../../how-it-works.md). What remains is captured in [`../future-ideas.md`](../future-ideas.md) (form-gated journeys) — and this document records what was built and why.

## What it does

Native (iOS + Android) prototypes link out to hosted web prototypes (NHS Prototype Kit apps on Heroku) for parts of the user journey — e.g. GP appointment booking, repeat prescriptions, 111 emergency-prescription flows. The tool now crawls those web journeys and splices them into the native flow map so the map reads as one continuous experience.

Opt-in via `--web-jumpoffs` (or `webJumpoffs.enabled: true` in `flow-map.config.yml`).

## Architecture summary

1. **Native parsers detect handoffs.** `src/swift-parser.js` and `src/kotlin-parser.js` identify URLs in `WebView`, `WebLink`, `UIApplication.shared.open`, `.webView(...)` covers, `enum X: ..., WebFlowConfig` enums (iOS) and `openTab`, `InAppBrowser`, `CustomTabsIntent.Builder`, `WebFlowConfig(url=...)` (Android). Cross-file resolution: Kotlin uses `const val BASE_URL` interpolation and `object Name { ... }` qualification; Swift uses two-pass parsing with project-wide `urlBindings` and `@State var foo: TypeName?` to qualify case-name lookups.

2. **Per-origin browser context.** `src/web-jumpoff-crawler.js` creates a separate Playwright `BrowserContext` per origin, with `addInitScript` injecting chrome-stripping CSS (mirrors what the production native InAppBrowser injects). Two layers of CSS — production-parity rules (`.hide-on-native { display: none }` + NHS prototype-kit padding tweaks) and belt-and-braces direct selectors for prototypes that don't wrap chrome in `.hide-on-native`.

3. **Two-phase BFS.** Phase 1 visits every seed across every origin (so each native handoff gets its root node + screenshot under tight budgets); Phase 2 round-robins BFS expansion across origin queues until `maxPages` is exhausted.

4. **Per-page disk cache.** `src/web-jumpoff-cache.js` keys entries by `sha256(canonicalUrl + configFingerprint)` where the fingerprint covers viewport, `hideNativeChrome`, `injectCss`, and screenshots-enabled (NOT `maxDepth`/`maxPages`/`timeoutMs`/`allowlist`, which only affect BFS shape). Cache lives at `$XDG_CACHE_HOME/prototype-flow-map/web-pages/`. 24h TTL, errors not cached.

5. **Hidden-link filtering.** When `hideNativeChrome` is true (the default), the BFS link extractor in `src/crawler.js` (`extractRuntimeLinks(..., { skipHidden: true })`) walks each `<a>`'s ancestor chain and skips links whose own or ancestor's computed `display`/`visibility` makes them invisible. Mirrors what the user can actually click inside the production InAppBrowser. Reduced edge counts on the Android smoke target from 460 → 152.

6. **Splice into native graph.** `src/splice-web-subgraphs.js` upgrades pre-existing `external` / `web-view` nodes in place: type becomes `web-page`, ID is normalised to canonical URL form, pre-existing edges are retargeted, `subgraphOwner` + `layoutRank` are BFS-propagated from each upgraded root to its descendants so the column-packed viewer layout places the whole web subgraph under its native handoff.

7. **Native screenshot phase runs after the splice** so iOS/Android crawlers never see web nodes.

## Key technical decisions and rationale

### Clip-at-capture for uniform aspect ratio

`page.screenshot({ clip: { x: 0, y: 0, width, height }, fullPage: false })` clips each web screenshot to the native viewport size (default 375 × 812, deviceScaleFactor 2 → 750 × 1624 PNG). Web thumbnails sit alongside native portrait screens without dominating rows.

Alternatives considered: full-page capture (rejected — tall thumbnails dominate the row visually); fixed thumbnail crop in the viewer (rejected — pushes complexity to the viewer for what is fundamentally a capture-time concern).

### CSS injection over UA matching for chrome stripping

Tested production-style UA strings (`NHSApp/native`, Android+suffix, iOS+suffix) against the deployed prototypes — none hid the chrome. The hosted apps don't actually sniff UA; the production InAppBrowser injects CSS post-load. Mirroring the CSS path is the same code path production uses, with belt-and-braces selectors to handle prototype variation (some wrap chrome in `.hide-on-native`, some don't).

### Init-script null-deref defensive pattern

Chromium's init scripts fire before `document.documentElement` exists. A naive `(document.head || document.documentElement).appendChild(style)` throws `Cannot read properties of null (reading 'appendChild')` and silently aborts — no chrome is hidden, but the run otherwise succeeds, so the bug is invisible until a user notices the chrome in screenshots. The implementation defers via `readystatechange` / `DOMContentLoaded` / `MutationObserver` on `document` until a target node is available.

### Per-page caching, not per-origin

Per-page granularity rather than per-origin: seed sets differ between platforms (iOS jumps to one set of URLs from a hosted prototype, Android jumps to a different set). Per-page caching means any URL overlap is reused regardless of how the seeds differ. Cross-platform iOS→Android run hits the cache 27/40 times (67%) for shared NHS prototype origins.

### Skip-hidden as opt-in, not default-on

The recorder and scenario runner deliberately drive prototypes; a hidden link the user later reveals (collapsed details, conditional UI) is still legitimate for them to know about. Static `crawlAndScreenshot` doesn't inject chrome-stripping CSS, so the filter has nothing to act on. Web jump-offs are the one context where we actively hide DOM elements via injected CSS, so that's the only crawler that opts in via `{ skipHidden: hideNativeChrome }`.

### iOS enum-switched URL indirection — two-pass parsing

`enum X: ..., WebFlowConfig { var url: URL { switch self { case .a: URL(...)! } } }` requires resolution across files: the enum body lives in one file, the call site (`activeCover = .repeatPrescription`) in another. Pass 1 walks every `.swift` file harvesting `urlBindings`; pass 2 calls the existing per-file parser with bindings threaded through `extractWebLinks`, which uses `@State var foo: SomeEnum?` declarations to qualify case-name lookups so two enums sharing a case name don't collide. The `struct X: WebFlowConfig` form (e.g. `MessageWebFlow`) is still skipped because its URL is constructor-bound at runtime.

Verified on `~/Repos/nhsapp-ios-demo-v2`: 7 previously-invisible URLs now land as subgraph roots (4 from `PrescriptionFlow`, 2 from `CheckPrescriptionFlow`, 1 from `PrototypeSettingsFlow`), bringing iOS native jump-offs from ~11 to 18 with no false positives.

## Verification benchmarks

- **Android smoke target** (`~/Repos/native-nhsapp-android-prototype/DemoNHSApp2`): 12 native jump-offs upgraded, 28 BFS-discovered pages added, 460+ link edges before hidden-link filtering, 152 after. All screenshots 750×1624, no visible header/bottom nav/cookie banner.
- **iOS smoke target** (`~/Repos/nhsapp-ios-demo-v2`): 18 native jump-offs (up from ~11 pre-enum-resolution).
- **Cache warm-run benchmark**: ~44× faster on screenshots-on (5.4s → 124ms in a 6-page benchmark) with byte-identical PNGs.

## Key files

- `src/swift-parser.js` — iOS native handoff detection, two-pass enum URL resolution
- `src/kotlin-parser.js` — Android native handoff detection, `WebFlowConfig` resolution
- `src/web-jumpoff-crawler.js` — Playwright BFS, two-phase budget, chrome-stripping injection
- `src/web-jumpoff-cache.js` — per-page disk cache
- `src/splice-web-subgraphs.js` — in-place native node upgrade + rank/owner propagation
- `src/crawler.js` — `extractRuntimeLinks` with `skipHidden` opt-in
- `src/flow-map-config.js` — `webJumpoffs` config block validation
- `bin/cli.js` — `--web-jumpoffs`, `--no-web-jumpoffs`, `--no-web-cache`, `--clear-web-cache` flags
- `src/build-viewer.js` — `.node-rect--web-page` styling, `.subgraph-root` heavier stroke

## Out of scope (deferred)

- **Form-gated journeys.** Shallow `<a href>` BFS misses content behind `<form method="post">` submission. Workaround pending a scenario-style driver layered on top of the crawler. See [`../future-ideas.md`](../future-ideas.md).
- **Authenticated pages.** Each crawl creates a fresh browser context per origin with no cookies. Pages behind a login form are unreachable. (Hosted NHS prototypes are typically auth-free, so this hasn't blocked anything yet.)
- **JS-only navigation.** Links that exist only as click handlers (no `<a href>`) are not extracted.
