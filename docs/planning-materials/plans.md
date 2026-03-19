# Future Plans

## 1. iOS + web prototype joining
- The native iOS prototype accesses web prototype pages for specific journeys
- Goal: map both iOS and web parts together, so the flow map shows the full picture including web screens reached from the native app
- Will need to detect where the native app hands off to web views and continue crawling from there

## 2. Scenario-first runtime mapping (implemented)

Scenario-first mapping is now the primary mode for complex, seed-data-driven prototypes. See the README for full usage documentation.

### What's been built
- **`.flow` scenario DSL** (`src/flow-parser.js`) — plain-text scenario format that's easier to read and write than YAML. One file per scenario in a `scenarios/` directory. Flat structure with `--- Setup ---` / `--- Map ---` separators, no indentation required. Fragments in `scenarios/fragments/*.flow`, scenario sets in `scenarios/*.set`. No YAML config required.
- **Scenario runner** (`src/scenario-runner.js`) — Playwright-based execution with setup steps, scope filtering, and canonical dedup
- **Visit-driven mapping** — scenarios specify exact pages via `visit` steps; edges built from actual DOM links between visited pages
- **Snapshot steps** — `snapshot` captures session-dependent pages after interactive navigation (click, fill, check, select)
- **Sequential navigation edges** — automatic edges between consecutive snapshot pages, even through server-side redirects (e.g. clicking "Start this appointment" navigates via `/start` redirect to `/confirm-identity`)
- **Interactive workflow mapping** — walk through multi-step forms with `check`, `fill`, `select` steps; supports expandable sections, radio buttons, checkboxes, and conditional form fields
- **Redirect resolution** — probes unresolved link targets to discover redirects (e.g. `/clinics` → `/clinics/today`)
- **Layout ranks** — layer-cake arrangement with tab siblings side-by-side and flow progressing top to bottom; grid-based X/Y positioning computed independently of dagre, with all rows centred on a common axis
- **Combined scenario maps** — merges multiple scenarios with shared nodes at the top and each scenario's flow stacked below in separate rank ranges (preserving the order specified in `.set` files)
- **Desktop viewport** — `--desktop` flag for 1280x800 screenshots
- **Dynamic screenshot heights** — each node sized based on actual page height
- **Modal dismissal** — removes overlays before screenshots
- **Global nav edge upgrading** — non-global-nav links upgrade existing global-nav duplicates
- **Static enrichment** (`src/static-enrichment.js`) — enriches runtime graphs with template metadata

### Implementation details
For the original roadmap and design rationale, see `docs/scenario-first-runtime-mapping-roadmap.md`.

---

### Option A: Scenario-first runtime mapping (implemented)

**Idea**: Use runtime crawling, but make it **scenario-driven** rather than “crawl every known page”. Start from realistic user entry points, establish the required seeded/session state, and expand only through navigation that a real user can actually take from that state.

This keeps runtime behaviour as the source of truth, but makes the output representative of actual journeys instead of implementation detail.

#### How it should work
1. Start the prototype server
2. Define one or more realistic scenarios, each with:
   - a name
   - a start URL
   - optional setup steps to establish state
   - optional stop conditions or page limits
3. For each scenario:
   - create a fresh browser/session context
   - run setup steps
   - begin at the scenario start page
   - extract navigation from the rendered DOM
   - follow user-meaningful actions only
   - capture screenshots only for valid, in-context screens
4. Build a graph per scenario
5. Optionally merge scenario graphs into a wider “combined” map
6. Preserve static parsing as supporting metadata, not the primary source of truth

#### Why this is better than broad runtime crawling
A broad crawl answers:
- “What URLs exist or can be reached somehow?”

A scenario-first crawl answers:
- “What does this user actually experience?”

That distinction matters for prototypes with:
- seed data
- dynamic entities
- redirects
- guarded subflows
- routes that are only valid after prior actions

#### What counts as a scenario
Examples:
- receptionist flow
- clinic appointment workflow
- participant management flow
- image reading flow
- reporting flow
- admin/setup flow

A scenario does not need to be large. Even a lightweight setup sequence is enough to shift the map from “route dump” to “experience map”.

---

### Why Option A should still be hybrid

Static parsing is still useful, but it should play a supporting role.

#### Static analysis is still good for:
- route discovery
- conditional branch labels
- hints about templates and likely structure
- candidate scenario entry points
- identifying obvious dead ends or helper routes

#### Runtime mapping is better for:
- seed-data-driven links
- resolved dynamic routes
- actual rendered navigation
- session-dependent visibility
- realistic screenshots
- confirming what is truly reachable in context

#### Revised hybrid model
- **Runtime scenario graphs** become the primary product
- **Static parsing** enriches those graphs with labels and supporting structure
- A broad static or runtime crawl can still exist, but only as a debug or audit mode

---

### Required enhancement 1: Canonicalization and route hygiene

Even in scenario mode, URL normalization is still essential.

#### Canonicalization strategy
- Normalize slashes and trailing slash policy
- Strip or normalize ignorable query params
- Replace volatile path segments with placeholders where appropriate:
  - numeric IDs → `:id`
  - UUID-like tokens → `:uuid`
  - date-like segments → `:date`
- Collapse unresolved template-like path fragments into stable parameter forms
- Keep both raw and canonical path metadata where useful

#### Why this still matters
Without canonicalization:
- graphs explode in size
- the same screen appears many times
- scenario graphs become noisy and hard to read

---

### Required enhancement 2: Navigation classification and filtering

Not every rendered link should be treated as a journey edge.

#### We should distinguish between:
- **journey edges** — primary task flow
- **global navigation** — section switching
- **utility links** — accessibility, contact, legal, logout
- **debug/admin links** — prototype-only tools
- **internal/framework links** — assets, internal routes, helper paths

#### Why this matters
A user-representative map should not be dominated by:
- header/footer links on every page
- admin utilities
- internal support routes
- framework or asset requests

The system should either:
- suppress those by default, or
- keep them tagged and hidden by default in the viewer

---

### Required enhancement 3: Validity-aware screenshot capture

Black screens are not just a screenshot problem. They are a signal that a page was visited out of context.

#### We should treat these as:
- invalid standalone pages
- routes requiring prior state
- evidence that the crawl has gone outside realistic user flow

#### Therefore:
- avoid visiting pages that are not discovered from valid in-scenario navigation
- do not treat “all known routes” as screenshot candidates
- prefer screenshots captured only from reachable scenario states

This should reduce misleading screenshots substantially.

---

### Concrete scenario configuration proposal

The tool needs a scenario format that is:
- simple enough to write by hand
- explicit enough to be deterministic
- flexible enough to support seeded/stateful setup
- stable enough to become the primary interface for realistic maps

#### Preferred format: YAML
Scenario configuration should use **YAML as the preferred authoring format**.

Why YAML:
- it is much easier for humans to read and edit than JSON
- ordered step lists are natural to express
- nested scenario, fragment, and filter structures stay readable
- it works well for version-controlled, hand-authored files
- it leaves open the possibility of evolving toward a more script-like DSL later

JSON can still remain supported for legacy or machine-oriented config if needed, but **scenario-first authoring should be YAML-first**.

#### Proposed config location
Add scenario support to a prototype-level YAML config file, for example:

- `flow-map.config.yml`
- or `.flow-map.yml`

Preferred default:
- **`flow-map.config.yml`**

#### Proposed top-level shape

```/dev/null/plans-scenario-config.yml#L1-43
mode: scenario

staticAnalysis:
  enabled: true
  useForLabels: true
  useForAudit: true

runtimeMapping:
  enabled: true
  canonicalization:
    collapseNumericSegments: true
    collapseUuidSegments: true
    collapseDateSegments: true
    collapseTemplateExpressions: true
    dropIgnoredQueryParams: true
  filters:
    suppressGlobalNav: true
    suppressUtilityLinks: true
    suppressDebugRoutes: true

scenarioSets:
  core-user-journeys:
    - clinic-workflow

scenarios:
  - name: clinic-workflow
    description: Start a clinic appointment journey from a realistic seeded state
    startUrl: /dashboard
    tags: [clinic, appointment, core]
    steps: []
    crawl:
      maxPages: 80
      maxDepth: 12
      includePaths: [/clinics, /events, /participants]
      excludePaths: [/prototype-admin]
```

#### Proposed scenario object shape

Each scenario should support:

- `name`  
  Stable identifier used in output filenames, CLI selection, and metadata.

- `description`  
  Human-readable explanation of what this scenario represents.

- `startUrl`  
  The real entry page for the scenario after setup has completed.

- `tags`  
  Optional grouping labels such as `clinic`, `reading`, `reporting`, `core`.

- `steps`  
  Ordered actions to establish context and optionally mark where the map begins.

- `crawl`  
  Controls to bound and shape the crawl for that scenario.

#### Why `steps` should be ordered
A scenario is fundamentally a sequence of intentional actions. YAML expresses ordered steps naturally and cleanly, which is one of the main reasons it is a better fit than JSON.

---

### Proposed `steps` action model

The first version should support a small, explicit action language.

```/dev/null/plans-scenario-setup.yml#L1-18
steps:
  - type: goto
    url: /choose-user

  - type: click
    selector: "[data-testid='user-receptionist']"

  - type: waitForUrl
    url: /dashboard

  - type: goto
    url: /settings

  - type: click
    selector: "[data-testid='seed-profile-custom']"

  - type: waitForSelector
    selector: "[data-testid='seed-profile-loaded']"

  - type: beginMap
```

#### Initial supported step types
- `goto`
  - navigate directly to a URL
- `click`
  - click an element by selector
- `fill`
  - fill an input field
- `select`
  - choose an option in a select element
- `check`
  - check a checkbox or radio
- `submit`
  - submit a form by selector
- `waitForUrl`
  - wait for navigation to a specific URL or URL pattern
- `waitForSelector`
  - wait until a selector appears
- `wait`
  - explicit timeout in milliseconds if needed
- `beginMap`
  - mark the point where the scenario should begin contributing screens/edges to the output
- `endMap`
  - optional stop marker
- `use`
  - include a reusable fragment
- `setStorage` *(optional later)*
  - set session/local storage values for prototypes that rely on them
- `evaluate` *(optional later, debug-only)*
  - run small controlled client-side scripts where absolutely necessary

#### VHS-inspired behavior
A useful design lesson here is to separate:
- **setup**
- from **captured journey output**

That means:
- steps before `beginMap` establish context
- steps after `beginMap` are part of the mapped journey

This is similar to the way scripted recording tools distinguish hidden setup from visible output.

---

### Reusable fragments

To avoid repeating common setup across scenarios, support reusable fragments.

```/dev/null/plans-scenario-fragments.yml#L1-16
fragments:
  setup.receptionist:
    - type: goto
      url: /choose-user
    - type: click
      selector: "[data-testid='user-receptionist']"
    - type: waitForUrl
      url: /dashboard

scenarios:
  - name: clinic-workflow
    startUrl: /dashboard
    steps:
      - use: setup.receptionist
      - type: beginMap
```

This gives you:
- shared login/setup flows
- less duplication
- easier maintenance
- more readable scenarios

---

### Proposed `crawl` controls

```/dev/null/plans-scenario-crawl.yml#L1-12
crawl:
  maxPages: 80
  maxDepth: 12
  includePaths: [/clinics, /events, /participants]
  excludePaths: [/prototype-admin, /settings, /contact]
  followNavigationCategories:
    - journey
    - entry
  allowRedirects: true
  captureScreenshots: true
```

#### Meaning of crawl controls
- `maxPages`
  Hard cap to avoid runaway expansion.
- `maxDepth`
  Keeps the crawl focused on the scenario.
- `includePaths`
  Optional allowlist to keep the graph within the scenario’s domain.
- `excludePaths`
  Explicitly block noisy or irrelevant routes.
- `followNavigationCategories`
  Decide whether the crawler follows only `journey` links, or also `global-nav`, `utility`, etc.
- `allowRedirects`
  Whether redirected pages are accepted into the scenario graph.
- `captureScreenshots`
  Useful if some scenarios are run in fast/no-screenshot mode.

---

### Initial scenario set proposal for `manage-breast-screening-prototype`

The breast screening prototype already suggests a good first set of scenarios.

#### 1. `login-and-dashboard`
Purpose:
- show how a user reaches the main working area

Likely shape:
- start at `/choose-user`
- select a realistic seeded user
- land on `/dashboard`

Why:
- useful as the shared entry scenario
- good for validating setup mechanics

#### 2. `clinic-workflow`
Purpose:
- represent appointment/clinic activity from a realistic state

Likely scope:
- `/clinics`
- `/events`
- participant steps encountered during clinic workflow

Why:
- likely one of the most important operational journeys
- should surface the real in-clinic sequence, not all event routes

#### 3. `participant-management`
Purpose:
- show how staff browse and manage participant details

Likely scope:
- `/participants`
- questionnaire
- personal details
- relevant participant-specific event transitions

Why:
- this area appears highly stateful and seed-data-driven

#### 4. `reading-workflow`
Purpose:
- represent the image reading journey

Likely scope:
- `/reading`
- batch/workflow routes
- priors
- review/opinion/normal/abnormal steps

Why:
- likely a distinct journey family that deserves its own readable map

#### 5. `reporting`
Purpose:
- show the reports path without clinic/participant clutter

Likely scope:
- `/reports`
- screening reports
- report drill-downs that are valid in context

Why:
- this seems top-level enough to stand alone cleanly

---

### Proposed CLI direction

Scenario-first mode should eventually become the default, but not immediately.

#### Near-term
Keep broad crawl available, but add scenario-focused options such as:

```/dev/null/plans-cli-examples.txt#L1-4
prototype-flow-map <prototype-path> --scenario clinic-workflow
prototype-flow-map <prototype-path> --scenario participant-management
prototype-flow-map <prototype-path> --scenario-set core-user-journeys
prototype-flow-map <prototype-path> --debug-broad-crawl
```

#### Recommended semantics
- `--scenario <name>`
  Run exactly one scenario
- `--scenario-set <name>`
  Run a named subset of scenarios
- `--debug-broad-crawl`
  Keep current “discover everything possible” behavior, clearly labeled as debug mode
- broad crawl should no longer be the implied default success path

---

### Why YAML is the right first step

A YAML-based model is the best starting point because it is:
- inspectable in-repo
- versionable
- easy to review in pull requests
- deterministic across runs
- easy to adapt per prototype
- much friendlier to humans than JSON

If later needed, higher-level tooling can be added on top:
- scenario recorder
- reusable setup fragments
- shared scenario libraries
- UI for selecting scenarios
- eventually a more script-like DSL

But the first implementation should stay explicit and boring.

---

### Option B: Seed data awareness in static parsing

**Idea**: Load seed data files and resolve template variables during static analysis.

#### How it would work
1. Find seed/session data files
2. Parse them into JS objects
3. Resolve `{{ variable }}` and `{% for ... %}` against that data
4. Expand loops and interpolated URLs into concrete routes
5. Attempt to infer links/screens from those expansions

#### Pros
- Works without running the prototype
- Preserves static conditional information
- Deterministic given fixed inputs

#### Cons
- Still does not model runtime validity well
- Still does not solve session/state progression
- Requires building and maintaining a partial template/data evaluator
- Fragile across prototype conventions
- Likely to produce routes that exist on paper but are not meaningful user experiences

#### Verdict
Useful only as a supplementary technique or fallback when runtime execution is impossible. It should not be the primary strategy.

---

## Current architecture

The tool now implements **scenario-first runtime mapping, with static analysis as supporting metadata.**

### Primary output
- **One map per scenario** (e.g. `clinic-workflow`, `reading-workflow`)
- **Merged multi-scenario maps** when running scenario sets (e.g. `clinic-and-reading`)

### Secondary output
- Static-only mode for simple prototypes without seed data
- Audit mode for debug/coverage checks

---

## Delivery status

All five phases of the original delivery plan have been completed:

1. ✓ **Runtime extraction** — DOM link extraction, runtime-discovered edges, static metadata merge
2. ✓ **Canonicalization and filtering** — ID/UUID/date collapse, global nav classification, edge upgrading
3. ✓ **Scenario-first crawling** — YAML config, setup steps, visit-driven and BFS modes, snapshot steps
4. ✓ **Viewer experience** — grid-based layout with rank stacking, per-scenario positioning, combined maps, nav toggles
5. ✓ **Validation** — tested with 5 scenarios against `manage-breast-screening-prototype`

### Remaining work
- Add automated tests for scenario runner and config validation
- Improve error recovery for interactive step failures
- Consider scenario recorder for generating `.flow` files from user interaction

---

## Key files

- `src/scenario-runner.js` — Playwright-based scenario execution: setup steps, visit-driven mapping, snapshot, BFS crawl, redirect resolution, layout rank computation
- `src/crawler.js` — DOM link extraction, canonicalization, global nav classification, screenshot capture, modal dismissal
- `src/static-enrichment.js` — enriches runtime graphs with static template metadata (titles, file paths, node types)
- `src/flow-parser.js` — `.flow` DSL parser: scenarios, fragments (`scenarios/fragments/*.flow`), and scenario sets (`scenarios/*.set`)
- `src/flow-map-config.js` — config loading (YAML/JSON + `.flow` files), scenario/fragment/step validation
- `src/index.js` — orchestration: scenario pipeline, multi-scenario merging, output generation
- `src/build-viewer.js` — HTML viewer with grid-based layout for ranked nodes (dagre used only for unranked/static maps), per-scenario row heights, edge filtering
- `src/graph-builder.js` — static graph construction, provenance metadata
- `bin/cli.js` — CLI with `--scenario`, `--scenario-set`, `--desktop`, `--list-scenarios`

---

## Summary

Scenario-first runtime mapping is now fully implemented and validated. The approach produces maps that are:
- readable
- trustworthy
- representative of user experience
- useful for design and analysis

The key insight remains:

> **Runtime crawling should be guided by realistic scenarios, not by the desire to visit every discoverable page.**