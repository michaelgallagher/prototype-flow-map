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

### Supported initial actions
- `goto`
- `click`
- `fill`
- `select`
- `check`
- `submit`
- `waitForUrl`
- `waitForSelector`
- `wait`
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

## Phase 1 — Scenario-First Design and Scope

### Goal
Define the scenario model and make it the center of the roadmap.

### Tasks
- [ ] Define what a “scenario” is in this tool
- [ ] Finalise YAML as the preferred scenario format
- [ ] Decide where scenario definitions live:
  - [ ] prototype-level config file
  - [ ] separate scenario files
  - [ ] shared library plus per-prototype overrides
- [ ] Define minimum scenario structure:
  - [ ] `name`
  - [ ] `description`
  - [ ] `startUrl`
  - [ ] setup steps
  - [ ] crawl scope rules
- [ ] Decide whether output should default to:
  - [ ] one scenario map at a time
  - [ ] all scenarios separately
  - [ ] merged multi-scenario map plus per-scenario maps

### Acceptance criteria
- [ ] Scenario structure is documented and stable
- [ ] The roadmap clearly treats scenario mapping as the main mode
- [ ] Broad crawl is explicitly demoted to debug/audit mode

---

## Phase 2 — Canonicalization and Noise Reduction

### Goal
Reduce route noise so scenario maps remain readable.

### Tasks
- [ ] Keep centralized canonicalization in one place
- [ ] Canonicalize volatile routes:
  - [ ] numeric IDs -> `:id`
  - [ ] UUIDs -> `:uuid`
  - [ ] date-like segments -> `:date`
  - [ ] template expressions -> semantic placeholder when possible
- [ ] Filter obvious non-page targets:
  - [ ] assets
  - [ ] CSS/JS/image/font paths
  - [ ] internal framework/admin paths where appropriate
- [ ] Reduce layout/global-nav noise:
  - [ ] classify links as `journey`, `global-nav`, `utility`, `entry`
  - [ ] suppress or separately tag low-value repeated links
- [ ] Preserve raw and canonical forms for debugging

### Acceptance criteria
- [ ] Asset/internal junk does not dominate the graph
- [ ] Dynamic route families collapse into readable route patterns
- [ ] Global layout links no longer overwhelm journey structure

---

## Phase 3 — Scenario Execution Engine

### Goal
Crawl only from realistic user states, not from every known route.

### Tasks
- [ ] Add scenario runner with isolated browser/session context
- [ ] Support scenario setup actions:
  - [ ] navigate
  - [ ] click
  - [ ] fill
  - [ ] submit
  - [ ] wait for URL
  - [ ] wait for selector
  - [ ] reusable `use` fragments
- [ ] Support per-scenario seed/user setup
- [ ] Start crawl expansion only after scenario setup is complete
- [ ] Restrict discovered edges to scenario-valid state
- [ ] Store scenario provenance on edges/nodes/screenshots

### Acceptance criteria
- [ ] Screens discovered in a scenario are valid in-context pages
- [ ] Black/empty screenshots are significantly reduced
- [ ] The map reflects actual user-visible progression

---

## Phase 4 — Scenario Outputs and Viewer Experience

### Goal
Make scenario maps easy to inspect and compare.

### Tasks
- [ ] Output one graph per scenario
- [ ] Optionally output merged graph across selected scenarios
- [ ] Add metadata:
  - [ ] `scenario`
  - [ ] `provenance`
  - [ ] `navigationCategory`
- [ ] Add viewer controls for:
  - [ ] scenario filter
  - [ ] provenance filter
  - [ ] navigation-category filter
- [ ] Consider hiding suppressed nav by default while allowing reveal in debug mode

### Acceptance criteria
- [ ] A user can inspect one scenario without unrelated flows cluttering the map
- [ ] Merged views remain understandable
- [ ] Viewer controls make provenance/noise visible but manageable

---

## Phase 5 — Broad Crawl as Debug Mode

### Goal
Keep exhaustive crawl capability without letting it define the main product.

### Tasks
- [ ] Rename/document broad crawl as debug or audit mode
- [ ] Ensure broad crawl output is clearly labeled non-representative
- [ ] Add diagnostics/reporting for:
  - [ ] invalid pages
  - [ ] redirects
  - [ ] suppressed layout links
  - [ ] collapsed canonical routes
- [ ] Keep this mode available for engineering validation only

### Acceptance criteria
- [ ] Broad crawl remains useful for debugging
- [ ] It is no longer confused with the main user-facing map mode

---

## Phase 6 — Validation with `manage-breast-screening-prototype`

### Goal
Use the breast screening prototype as the proving ground for the new approach.

### Initial target scenarios

#### 1. `login-and-dashboard`
**Purpose:** establish the prototype’s top-level entry and user selection flow.

**Likely scope:**
- `/`
- `/start`
- `/choose-user`
- `/cis2`
- `/dashboard`

**Why it matters:**
- this is the common entry path into the rest of the prototype
- it provides the initial valid runtime context for other scenarios

**Candidate setup:**
- start at `/`
- move through `/start`
- choose a user role
- confirm arrival at `/dashboard`

---

#### 2. `clinic-workflow`
**Purpose:** map reception/clinic operational flow around appointments and event handling.

**Likely scope:**
- `/dashboard`
- `/clinics`
- `/events`
- selected `/participants` screens that are genuinely reached from clinic flow

**Why it matters:**
- this appears to be one of the highest-value operational journeys
- many black/invalid screens seem related to clinic/event context, so this scenario will prove whether scenario-first crawling improves validity

**Candidate setup:**
- choose receptionist/clinic user
- navigate to clinic list or current clinic day
- open an event/appointment from valid context
- begin crawl from the first stable appointment-management page

---

#### 3. `participant-management`
**Purpose:** map participant lookup, details, edits, and questionnaire-related flows.

**Likely scope:**
- `/participants`
- `/participants/:id`
- questionnaire and personal-details flows that are actually reachable in context

**Why it matters:**
- participant-specific screens are heavily dynamic and are a common source of noisy route expansion
- this scenario will test canonicalization and context-aware screenshots

**Candidate setup:**
- choose an operational user
- navigate from dashboard to participant search/list
- open one participant from the seeded list
- crawl from the participant summary/details page

---

#### 4. `reading-workflow`
**Purpose:** map the image reading journey and associated review/opinion flows.

**Likely scope:**
- `/reading`
- `/reading/batch/...`
- `/reading/workflow/...`
- `/reading/history/...`
- related priors and review pages when valid in context

**Why it matters:**
- reading appears to be a substantial, internally connected journey
- this is likely one of the most important end-to-end scenario maps in the prototype

**Candidate setup:**
- choose a reading-capable user
- navigate into reading from dashboard
- open a valid batch/event from list context
- crawl from the first real reading workflow screen

---

#### 5. `reporting`
**Purpose:** map high-level reporting/navigation without polluting other operational maps.

**Likely scope:**
- `/reports`
- `/reports/screening`
- any valid report detail routes reached from the report UI

**Why it matters:**
- reporting is useful but structurally different from task workflows
- keeping it as a separate scenario may make the output much clearer

**Candidate setup:**
- choose a role with reporting access
- navigate from dashboard to reports
- start crawl from reports landing page

---

#### 6. `admin-or-prototype-tools` (optional, debug-oriented)
**Purpose:** isolate prototype-only tools/settings from product journeys.

**Likely scope:**
- `/settings`
- seed profile screens
- prototype/admin/reset utilities

**Why it matters:**
- these screens may be useful, but should not clutter user journey maps
- keeping them separate allows explicit inclusion without contaminating primary outputs

### Tasks
- [ ] Identify a small set of realistic scenario families, for example:
  - [ ] login / choose-user
  - [ ] clinic workflow
  - [ ] participant management
  - [ ] image reading
  - [ ] reporting
- [ ] Create initial scenario definitions for those flows
- [ ] Run scenario maps and compare against current broad crawl output
- [ ] Evaluate:
  - [ ] representativeness
  - [ ] screenshot validity
  - [ ] graph readability
  - [ ] missing journey-critical screens
- [ ] Record which scenario maps are worth keeping separate vs merged

### Acceptance criteria
- [ ] Scenario maps look closer to real user experience than the broad crawl map
- [ ] Black/empty screens are materially reduced
- [ ] The resulting maps are useful to humans without deep prototype knowledge

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

## Open design questions

- [ ] Should scenario maps be the default CLI output?
- [ ] Should merged maps be opt-in instead of default?
- [ ] Should suppressed global-nav links remain hidden by default in the viewer?
- [ ] How much semantic param naming is worth preserving (`:participantId`) vs collapsing to `:id`?
- [ ] Should black/empty screenshots be excluded automatically or flagged for review?
- [ ] Should scenario setup live in config or code fixtures?
- [ ] Should scenario setup prefer UI-driven steps exclusively, or allow direct state injection where prototypes are otherwise impractical to drive?

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

- [ ] Update planning docs to make scenario-first mapping the primary recommendation
- [ ] Stop treating broad runtime crawl as the default success metric
- [ ] Finalise the YAML scenario definition format
- [ ] Implement the first 3-5 real scenarios for `manage-breast-screening-prototype`
- [ ] Validate that those scenario maps are more representative than the current broad crawl output