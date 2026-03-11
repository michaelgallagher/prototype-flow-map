# Scenario-First Runtime Mapping Roadmap

## Objective

Shift the web mapping strategy from **broad route crawling** to **scenario-first runtime mapping** so the output reflects what users actually experience.

The goal is no longer to inventory every technically reachable route. The goal is to produce maps that are:

- representative of real journeys
- valid in runtime context
- readable by humans
- resilient to seed-data-driven navigation

---

## Why this change is needed

The earlier runtime-crawl approach improved discovery, but it also surfaced a major product problem:

- too many technically reachable screens appear in the map
- many direct URL visits are not valid user states
- some pages render as black/empty screens because they require prior context
- repeated layout/global-nav links create graph noise
- the output trends toward a **route inventory**, not an **experience map**

For prototypes like `manage-breast-screening-prototype`, the important thing is not “what URLs exist?” but:

- what screens a real user can reach
- in what order
- under what seeded/stateful conditions

That means the primary mode should be **scenario-driven runtime crawling**.

---

## New recommendation

Proceed with a **hybrid static + runtime architecture**, but make **scenario-first runtime mapping** the main output mode.

### Static analysis remains useful for
- broad route awareness
- template intent
- conditional labels
- fallback/debug visibility

### Runtime mapping becomes the primary source for
- actual user-visible navigation
- seed-data-driven links
- valid in-context screenshots
- stateful flow discovery

### Broad crawl becomes
- a debug/audit mode
- useful for engineering investigation
- not the default user-facing map mode

---

## Delivery model

### Primary outputs
- one map per realistic scenario
- optional merged map across selected scenarios

### Secondary/debug outputs
- full discovered route graph
- canonicalization diagnostics
- runtime-only edge report
- suppressed-nav/debug report

---

## Scenario definition format

The first implementation should use a simple, explicit scenario format that is easy to author by hand and easy to run deterministically.

### Format decision
Use **YAML** for scenario definitions.

Why YAML:
- more human-readable than JSON
- easier to scan and review
- better for ordered step lists
- better for reusable fragments
- a cleaner bridge toward a future lightweight scripting syntax if needed

### Preferred config file
Use:

- `flow-map.config.yml`

You may still support older JSON config files for legacy/basic configuration, but the scenario system should be designed **YAML-first**.

### Proposed config shape

```/dev/null/scenario-example.yml#L1-37
mode: scenario

runtimeMapping:
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
    - login-and-dashboard
    - clinic-workflow
    - participant-management
    - reading-workflow
    - reporting

scenarios:
  - name: clinic-workflow
    description: Reception/clinic user flow from dashboard into appointment handling
    enabled: true
    startUrl: /dashboard
    tags: [clinic, appointment, core]
    scope:
      includePrefixes: [/dashboard, /clinics, /events, /participants]
      excludePrefixes: [/prototype-admin, /api, /assets]
    limits:
      maxPages: 120
      maxDepth: 12
    steps:
      - type: goto
        url: /choose-user
      - type: click
        selector: "text=Receptionist"
      - type: waitForUrl
        url: /dashboard
      - type: beginMap
```

### Required scenario fields
- `name`
- `description`
- `startUrl`

### Strongly recommended fields
- `enabled`
- `scope.includePrefixes`
- `scope.excludePrefixes`
- `steps`

### Optional fields
- `tags`
- `limits.maxPages`
- `limits.maxDepth`
- `assertions`
- `context`
- `scenarioSet`

---

## Proposed setup action format

The setup phase should be intentionally small and composable.

### Supported actions
- `goto`
- `click`
- `fill`
- `select`
- `check`
- `submit`
- `waitForUrl`
- `waitForSelector`
- `wait`
- `visit` — visit a page and add it to the map (visit-driven mode)
- `snapshot` — capture the current page after interactive navigation (for session-dependent pages)
- `beginMap`
- `endMap`
- `use`

### Example action shapes

```/dev/null/scenario-actions.yml#L1-19
steps:
  - type: goto
    url: /choose-user

  - type: click
    selector: "text=Receptionist"

  - type: fill
    selector: "input[name='search']"
    value: HITCHIN

  - type: submit
    selector: form

  - type: waitForUrl
    url: /dashboard

  - type: waitForSelector
    selector: "text=Reports"
```

### Reusable fragment example

```/dev/null/scenario-fragments.yml#L1-21
fragments:
  setup.receptionist:
    - type: goto
      url: /choose-user
    - type: click
      selector: "text=Receptionist"
    - type: waitForUrl
      url: /dashboard

scenarios:
  - name: clinic-workflow
    description: Reception/clinic operational journey
    startUrl: /dashboard
    steps:
      - use: setup.receptionist
      - type: beginMap
```

### Rules for setup actions
- Keep them deterministic
- Prefer visible user interactions over injecting state directly
- Use state injection only when the prototype cannot realistically be driven there
- Keep setup short; a scenario is not a test suite
- Setup should establish context, not exhaustively simulate an end-to-end journey

---

## Scenario execution rules

### Each scenario should
- run in a fresh browser/session context
- apply setup steps before crawl expansion
- begin graph discovery only after setup is complete
- record screenshots only for valid in-context pages
- keep provenance metadata for scenario name and navigation type

### Each scenario should avoid
- direct visits to every known route
- out-of-context pages that only exist as technical endpoints
- utility/footer/header links dominating the graph
- admin/debug routes unless explicitly part of that scenario

### Important map boundary rule
Setup steps should not automatically become part of the final map.

The cleanest rule is:

- steps before `beginMap` are setup-only
- steps after `beginMap` belong to the mapped journey

This keeps the final graph focused on the experience, not on all setup mechanics.

---

## Phase 1 — Scenario-First Design and Scope ✓

### Goal
Define the scenario model and make it the center of the roadmap.

### Tasks
- [x] Define what a “scenario” is in this tool
- [x] Finalise YAML as the preferred scenario format
- [x] Decide where scenario definitions live: prototype-level `flow-map.config.yml`
- [x] Define minimum scenario structure: name, description, startUrl, steps, scope, limits
- [x] Output: per-scenario maps plus merged multi-scenario maps when running sets

### Acceptance criteria
- [x] Scenario structure is documented and stable
- [x] The roadmap clearly treats scenario mapping as the main mode
- [x] Broad crawl is explicitly demoted to debug/audit mode

---

## Phase 2 — Canonicalization and Noise Reduction ✓

### Goal
Reduce route noise so scenario maps remain readable.

### Tasks
- [x] Centralized canonicalization in `src/crawler.js` (`canonicalizePath`)
- [x] Canonicalize volatile routes: numeric IDs, UUIDs, dates, short alphanumeric IDs (6-12 chars), template expressions
- [x] Filter non-page targets: assets, CSS/JS/image/font paths, framework/admin paths
- [x] Classify links as `journey`, `global-nav`, `utility` — suppress global nav by default
- [x] Global nav edge upgrading: non-global-nav links upgrade existing global-nav duplicates
- [x] Visit-driven mode uses raw URLs as node IDs (preserves entity instances) with canonical mapping for edge resolution
- [x] Preserve raw and canonical forms via `canonicalToRaw` mapping

### Acceptance criteria
- [x] Asset/internal junk does not dominate the graph
- [x] Dynamic route families collapse into readable route patterns
- [x] Global layout links no longer overwhelm journey structure

---

## Phase 3 — Scenario Execution Engine ✓

### Goal
Crawl only from realistic user states, not from every known route.

### Tasks
- [x] Scenario runner (`src/scenario-runner.js`) with isolated browser/session context
- [x] All setup actions: goto, click, fill, select, check, submit, waitForUrl, waitForSelector, wait
- [x] Reusable `use` fragments with recursive resolution
- [x] `beginMap` / `endMap` boundaries separating setup from mapped journey
- [x] Visit-driven mode: `visit` steps specify exact pages; `snapshot` captures session-dependent pages
- [x] BFS crawl mode: automatic when no visit/snapshot steps present
- [x] Redirect resolution: probes unresolved link targets to discover redirects
- [x] Modal/overlay dismissal before screenshots
- [x] Dynamic screenshot heights based on actual page content
- [x] Desktop viewport support (`--desktop` flag, 1280x800)
- [x] Layout rank computation with tab sibling detection for layer-cake arrangement
- [x] Per-scenario provenance on edges/nodes

### Acceptance criteria
- [x] Screens discovered in a scenario are valid in-context pages
- [x] Black/empty screenshots are significantly reduced
- [x] The map reflects actual user-visible progression

---

## Phase 4 — Scenario Outputs and Viewer Experience ✓

### Goal
Make scenario maps easy to inspect and compare.

### Tasks
- [x] Output one graph per scenario with viewer, Mermaid sitemap, and metadata
- [x] Merged graph across selected scenarios (via `--scenario-set`)
- [x] Combined maps with shared nodes (e.g. `/dashboard`) and per-scenario layout
- [x] Per-scenario y-positioning in merged maps (tall pages in one scenario don't affect the other)
- [x] Layer-cake layout: tab siblings side-by-side, flow top to bottom
- [x] Forward edges routed through dagre; lateral and backward edges rendered as visual-only lines
- [x] Provenance filter in viewer (runtime/static/both)
- [x] Global nav toggle (hidden by default in scenario mode)

### Acceptance criteria
- [x] A user can inspect one scenario without unrelated flows cluttering the map
- [x] Merged views remain understandable
- [x] Viewer controls make provenance/noise visible but manageable

---

## Phase 5 — Broad Crawl as Debug Mode ✓

### Goal
Keep exhaustive crawl capability without letting it define the main product.

### Tasks
- [x] Broad crawl available as `audit` mode (`--mode audit`)
- [x] Static-only analysis available as `static` mode (default when no config)
- [x] Scenario mode is the primary mode for prototypes with config files
- [x] CLI documentation clearly distinguishes the three modes

### Acceptance criteria
- [x] Broad crawl remains useful for debugging
- [x] It is no longer confused with the main user-facing map mode

---

## Phase 6 — Validation with `manage-breast-screening-prototype` ✓

### Goal
Use the breast screening prototype as the proving ground for the new approach.

### Implemented scenarios

Six scenarios have been defined in the prototype’s `flow-map.config.yml`:

1. **`login-and-dashboard`** — Entry flow from start page through user selection to dashboard
2. **`clinic-workflow`** — Visit-driven: 20+ pages covering clinic tabs, appointment details, and clinic reports; uses click+snapshot for dynamic event pages
3. **`check-in-workflow`** — Full interactive workflow: identity confirmation → medical history (breast cancer form with checkboxes, radios, text input) → imaging → completion; uses sequential navigation edges through redirects
4. **`participant-management`** — BFS crawl of participant lookup, details, and medical history
5. **`reading-workflow`** — Interactive: uses `click` + `snapshot` for session-dependent batch pages (opinions, compare, technical recall, review), plus `visit` for static pages (priors, history, clinics tabs)
6. **`reporting`** — Reports and data exports

### Combined maps
- `clinic-and-reading` scenario set produces a merged side-by-side view with `/dashboard` as a shared node
- `clinic-full` set combines clinic-workflow + check-in-workflow
- `core-user-journeys` set runs all six scenarios

### Results
- clinic-workflow: 15 nodes, 46 edges (visit-driven + click/snapshot for dynamic events)
- check-in-workflow: 7 nodes, 17 edges (full interactive workflow through 7 screens)
- reading-workflow: 17 nodes, 57 edges
- Screenshots are valid, in-context, and dynamically sized
- Layer-cake layout with tab groups side-by-side
- Sequential navigation edges correctly link pages navigated via server-side redirects

### Acceptance criteria
- [x] Scenario maps look closer to real user experience than the broad crawl map
- [x] Black/empty screenshots are materially reduced
- [x] The resulting maps are useful to humans without deep prototype knowledge

---

## Product decision principles

### What to include
Include screens that:
- are reachable through realistic user interaction
- appear in valid seeded/stateful context
- materially help explain a journey

### What not to prioritize
Do not prioritize:
- every technically routable page
- routes only reachable by direct URL hacking
- repeated utility/header/footer links
- invalid context screens that users would never actually see

---

## Resolved design questions

- [x] Scenario maps are the primary CLI output when a config file exists
- [x] Merged maps are produced automatically when running scenario sets
- [x] Suppressed global-nav links are hidden by default in the viewer (toggle available)
- [x] Canonicalization collapses to `:id` (not semantic names) — simpler and sufficient
- [x] Screenshots from redirected/invalid pages are skipped automatically
- [x] Scenario setup lives in `flow-map.config.yml` (YAML config, not code)
- [x] Setup prefers UI-driven steps; `visit` and `snapshot` provide flexible alternatives

## Open design questions

- [ ] Should the tool auto-detect visit-driven vs BFS mode, or should it be explicit in config?
- [ ] Should merged maps support more than two scenarios side-by-side?
- [ ] Should there be a way to define shared "anchor" nodes across scenarios beyond automatic dedup?

---

## Success criteria

This strategy is successful if:

- [ ] maps look like real user journeys, not route dumps
- [ ] screenshots are mostly valid and meaningful
- [ ] seed-data-driven flows are visible without giant graph explosion
- [ ] repeated layout/global-nav links no longer dominate the graph
- [ ] scenario outputs are understandable by product/design/engineering stakeholders

---

## Immediate next steps

- [x] Update planning docs to make scenario-first mapping the primary recommendation
- [x] Stop treating broad runtime crawl as the default success metric
- [x] Finalise the YAML scenario definition format
- [x] Implement 5 real scenarios for `manage-breast-screening-prototype`
- [x] Validate that scenario maps are more representative than broad crawl output

### Future work
- [ ] Add tests for scenario runner and config validation
- [ ] Improve error recovery when interactive steps fail mid-scenario
- [ ] Consider a scenario recorder that watches user interaction and generates YAML
- [ ] Explore cross-prototype stitching (iOS native → web prototype handoff)