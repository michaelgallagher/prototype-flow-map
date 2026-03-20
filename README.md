# Prototype flow map

Generate interactive flow maps from Express/Nunjucks prototype kit projects (NHS Prototype Kit, GOV.UK Prototype Kit, etc.). Also supports native iOS/SwiftUI prototypes.

The tool analyses your prototype's templates, routes, and runtime behaviour to produce a visual map of every screen and the connections between them, with screenshots.

![Example flowmap screenshot showing a graph of pages and connections, with a detail panel open for one page showing its screenshot and metadata](docs/assets/example-nhsapp-map.png)

## Features

- **Scenario-first mapping** — define realistic user journeys and map what users actually experience
- **Interactive workflow mapping** — walk through multi-step forms with clicks, fills, checkboxes, and snapshots
- **Combined scenario maps** — run multiple scenarios and produce a merged view with shared nodes
- **Screenshots** — captured with Playwright, dynamically sized to fit page content
- **Interactive viewer** — pan, zoom, search, drag nodes, filter by provenance
- **Static analysis** — auto-discovers pages from Nunjucks templates and Express route handlers
- **iOS/SwiftUI support** — parses SwiftUI navigation patterns and captures screenshots via XCUITest
- **PDF export** — optional full-canvas or fit-to-screen PDF output

## Quick start

```bash
npm install
npx playwright install chromium
```

### Static mode (default)

This is the basic mode. You give the tool a path to your prototype, and it analyses the Nunjucks templates and Express routes to find all pages and connections. This is a good way to get a quick overview of your prototype's structure, but it won't capture any dynamic behaviour or seed data. 

```bash
# Analyse templates and routes without scenarios
npx prototype-flow-map /path/to/prototype

# Scope to specific start points
npx prototype-flow-map /path/to/prototype --from "/pages/home,/pages/messages"
```

### Scenario mode

This mode uses a script to walk your prototype as a user would, capturing the actual pages visited and interactions performed. This is the recommended way to get a realistic map of your prototype if you rely on seed data (but not only – it would work for most prototypes).

```bash
# Run a single scenario
npx prototype-flow-map /path/to/prototype --scenario clinic-workflow

# Run a set of scenarios
npx prototype-flow-map /path/to/prototype --scenario-set core-user-journeys --desktop

# List available scenarios
npx prototype-flow-map /path/to/prototype --list-scenarios
```

Scenarios are defined as `.flow` files in a `scenarios/` directory in your prototype. See ["writing scenarios"](docs/scenarios.md) for the full format.

## Documentation

| Guide | Description |
|---|---|
| [CLI reference](docs/cli-reference.md) | All command-line options, mapping modes, output structure |
| [Using the viewer](docs/viewer.md) | Navigation, filters, repositioning nodes, hiding pages |
| [Writing scenarios](docs/scenarios.md) | `.flow` file format, fragments, scenario sets, visit-driven vs BFS modes |
| [iOS/SwiftUI support](docs/ios-support.md) | Setup, navigation patterns detected, config overrides |
| [How it works](docs/how-it-works.md) | Architecture overview for each mode (scenario, static, iOS) |
| [Editor support](editor/README.md) | Syntax highlighting for `.flow` files in VS Code, Zed, Sublime Text, and others |

## Planning and design

Design rationale, roadmaps, and option analyses are in [`docs/planning-materials/`](docs/planning-materials/).

## Prerequisites

- Node.js 20+
- The prototype must be installable and runnable via `node app.js`
- For iOS: Xcode with iOS Simulator
