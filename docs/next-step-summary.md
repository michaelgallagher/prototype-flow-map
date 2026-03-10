Summary for next chat

We pivoted the project from **broad runtime crawl** to **scenario-first runtime mapping**.

### Strategic decision
Keep **three modes**:

- **`static`**
  - preserve existing static-analysis-first approach
  - useful for simple prototypes, quick maps, fallback mode

- **`scenario`**
  - new primary mode for realistic/stateful/seed-heavy prototypes
  - uses runtime execution guided by explicit scenarios
  - intended to produce maps that reflect actual user experience

- **`audit`**
  - broad discovery / exhaustive engineering mode
  - static + broad runtime crawl
  - explicitly non-representative, for debugging/coverage only

---

## Key conclusions reached

### Why the old broad runtime crawl was not enough
Testing on `manage-breast-screening-prototype` showed:
- too many technically reachable screens
- invalid/out-of-context pages
- black/empty screenshots
- lots of layout/global-nav noise
- output looked like a **route inventory**, not a **user journey map**

### New recommendation
Use **scenario-first runtime mapping** as the primary approach:
- start from realistic entry points
- establish real state/seed/user context
- crawl only from valid in-scenario navigation
- build **one map per scenario**
- optionally merge scenarios later

Static parsing remains useful for:
- route awareness
- conditional labels
- enrichment
- simpler prototypes

---

## Docs updated

### `docs/plans.md`
Now reflects:
- scenario-first runtime mapping as the main recommendation
- broad crawl demoted to debug/audit mode
- YAML chosen as the preferred scenario format
- static mode retained as valuable
- high-level scenario config proposal added

### `docs/scenario-first-runtime-mapping-roadmap.md`
Now contains:
- implementation roadmap
- YAML-first scenario design
- step model
- reusable fragments
- candidate initial scenarios for `manage-breast-screening-prototype`

---

## YAML decision

We decided **not** to use JSON for scenarios.

### Preferred format
- **YAML**

### Preferred file
- **`flow-map.config.yml`**

### Why
- more human-readable
- better for ordered steps
- easier to review/edit
- better for reusable fragments
- closer to a future lightweight scripting model

JSON may still be supported for legacy/basic config if needed, but scenario authoring should be **YAML-first**.

---

## Proposed scenario model

### Top-level config ideas
- `mode: static | scenario | audit`
- `staticAnalysis`
- `runtimeMapping`
- `scenarioSets`
- `fragments`
- `scenarios`

### Scenario shape
Each scenario should support:
- `name`
- `description`
- `startUrl`
- `tags`
- `steps`
- `crawl`

### Step model
Initial step types proposed:
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

### Important rule
- steps **before** `beginMap` = setup only
- steps **after** `beginMap` = contribute to final mapped journey

This was inspired partly by VHS’s hidden setup vs visible output model.

### Reusable fragments
Support YAML fragments such as:
- `setup.receptionist`
- `setup.reading-user`

Then scenarios can use:
- `use: setup.receptionist`

---

## Proposed initial scenarios for `manage-breast-screening-prototype`

1. **`login-and-dashboard`**
   - establish entry path and valid runtime context

2. **`clinic-workflow`**
   - clinic / appointment / event flow

3. **`participant-management`**
   - participant detail/edit/questionnaire flow

4. **`reading-workflow`**
   - image reading / batch / opinion / review flow

5. **`reporting`**
   - reporting flow kept separate from operational maps

6. **optional** `admin-or-prototype-tools`
   - settings / seed profiles / prototype-only utilities

---

## Code changes already made before the pivot

There were earlier runtime crawl changes implemented, including:
- runtime edge extraction
- URL canonicalization
- asset/internal-route filtering
- some global-nav suppression
- provenance tagging
- graph merge changes

But these were still in support of the older broad crawl path.

They are **not the final product direction now**.
Some of that work may be reused inside scenario mode, but the next step should not be “keep refining broad crawl.”
It should be implementing the **scenario system**.

---

## Recommended next implementation steps

### Phase A — YAML config loading
Start here.

Files to change:
- `src/flow-map-config.js`

Tasks:
- support `flow-map.config.yml`
- parse YAML
- validate:
  - `mode`
  - `scenarioSets`
  - `fragments`
  - `scenarios`
  - step shapes

Need likely dependency:
- a YAML parser package, e.g. `yaml`

### Phase B — CLI support
Files:
- `bin/cli.js`
- `src/index.js`

Add flags:
- `--mode <static|scenario|audit>`
- `--scenario <name>`
- `--scenario-set <name>`
- `--list-scenarios`
- `--debug-broad-crawl`

Recommended default behavior:
- no scenario flags -> current **static** mode
- `--scenario` / `--scenario-set` -> **scenario** mode
- `--debug-broad-crawl` -> **audit** mode

### Phase C — scenario runner
Likely new file:
- `src/scenario-runner.js`

Responsibilities:
- fresh Playwright context per scenario
- execute ordered YAML `steps`
- begin collecting pages/edges/screenshots only after `beginMap`
- enforce per-scenario crawl limits
- return graph + screenshots + provenance

### Phase D — first real scenario only
Implement just one scenario first:
- **`login-and-dashboard`**

Why:
- simplest
- validates config loading
- validates step execution
- validates `beginMap`
- validates per-scenario output path

### Phase E — integrate static enrichment
In scenario mode:
- runtime graph is primary
- static parser enriches labels / route hints / conditions

In static mode:
- preserve current behavior

In audit mode:
- keep broad crawl / exhaustive behavior

---

## Suggested opening prompt for next chat

You can paste something like this:

> We’ve decided to pivot the prototype-flow-map tool to a scenario-first runtime mapping approach while preserving static mode and audit mode.  
>  
> Current desired modes:
> - static = existing static-analysis-first behavior
> - scenario = primary mode for realistic user-journey maps
> - audit = broad discovery/debug mode  
>  
> Scenario configs should use YAML, with `flow-map.config.yml` as the preferred file.  
>  
> Please start by implementing Phase A:
> 1. extend `src/flow-map-config.js` to load and validate YAML config
> 2. support `mode`, `scenarioSets`, `fragments`, and `scenarios`
> 3. keep backward compatibility with existing static/basic config where possible  
>  
> Then outline what will be needed for CLI scenario selection.
