# CLI reference

## Usage

```bash
npx prototype-flow-map /path/to/prototype [options]
```

## Common commands

```bash
# Record a flow map interactively (opens a browser)
npx prototype-flow-map --record /path/to/prototype

# Record with a custom script filename and desktop viewport
npx prototype-flow-map --record my-journey --desktop /path/to/prototype

# Static analysis (no scenario config needed)
npx prototype-flow-map /path/to/prototype

# Static analysis, with scoping refinements
npx prototype-flow-map /path/to/prototype --from "/pages/home,/pages/messages" --exclude "/pages/messages/*"

# Run a single scenario
npx prototype-flow-map /path/to/prototype --scenario clinic-workflow

# Run a set of scenarios
npx prototype-flow-map /path/to/prototype --scenario-set core-user-journeys

# List available scenarios
npx prototype-flow-map /path/to/prototype --list-scenarios

# Desktop screenshots
npx prototype-flow-map /path/to/prototype --scenario clinic-workflow --desktop

# Named map with title
npx prototype-flow-map /path/to/prototype --name screening-case-management --title "Screening app" --scenario-set clinic-full
```

## Options

| Option | Default | Description |
|---|---|---|
| `--record [filename]` | — | Record a scenario interactively (opens a browser). Optional filename, default: `recorded.flow` |
| `-o, --output` | `./flow-map-output` | Output directory |
| `-p, --port` | `4321` | Port to start the prototype server on |
| `--width` | `375` | Screenshot viewport width (pixels) |
| `--height` | `812` | Screenshot viewport height (pixels) |
| `--desktop` | — | Use desktop viewport (1280x800) instead of mobile |
| `--no-screenshots` | — | Skip screenshotting (much faster) |
| `--mode` | `static` | Mapping mode: `static`, `scenario`, or `audit` |
| `--scenario` | — | Run a single named scenario (implies `--mode scenario`) |
| `--scenario-set` | — | Run a named set of scenarios (implies `--mode scenario`) |
| `--list-scenarios` | — | List available scenarios and exit |
| `--from` | — | Only show pages reachable from these paths (comma-separated) |
| `--base-path` | — | Only include pages under this path prefix |
| `--exclude` | — | Exclude pages matching these paths (comma-separated, supports globs) |
| `--start-url` | `/` | URL to begin crawling from (static/audit modes) |
| `--runtime-crawl` | `false` | Add runtime DOM link extraction to static mode |
| `--name` | prototype folder slug | Map folder slug (lowercase alphanumeric + hyphens) |
| `--title` | prototype folder name | Human-readable map title shown in index |
| `--export-pdf` | `false` | Generate a PDF of the flow map (`map.pdf`) |
| `--pdf-mode` | `canvas` | PDF mode: `canvas` (full-canvas) or `snapshot` (A3 fit-to-screen) |
| `--platform` | auto-detected | Project platform: `web`, `ios`, or `android`. Android uses `ANDROID_SERIAL` env var to pick a device when multiple are attached |
| `--web-jumpoffs` | — | iOS/Android only — crawl hosted web prototypes that the native flow links out to and splice them into the map (overrides `webJumpoffs.enabled` in config). See [Web jump-offs](web-jumpoffs.md) |
| `--no-web-jumpoffs` | — | Force-disable web jump-off crawling for this run |
| `--no-web-cache` | — | Skip the per-page web-jumpoff cache for this run (forces a fresh crawl). Cache on disk is preserved |
| `--clear-web-cache` | — | Wipe the web-jumpoff cache directory before crawling, then continue |
| `--no-open` | — | Don't automatically open the viewer in a browser |

`--record` cannot be combined with `--mode`, `--scenario`, or `--scenario-set`.

## Mapping modes

| Mode | Purpose | Best for |
|---|---|---|
| `record` | Interactive recording -- click through your prototype in a browser | Quick maps, exploration, non-technical users |
| `static` | Broad static analysis of all templates and routes (this is the default mode) | Simple prototypes without seed data |
| `scenario` | Map realistic user journeys with setup steps and scoped crawling | Prototypes with seed data, stateful flows, or complex routing |
| `audit` | Static analysis plus runtime crawl of every discoverable page | Debugging and coverage checks |

## Output

The tool generates a folder (default `./flow-map-output/`) containing:

```
index.html           # Collection index (lists all maps)
styles.css           # Shared styles
viewer.js            # Shared viewer JavaScript
maps/
  <map-name>/
    index.html       # Interactive viewer (open this)
    graph-data.json  # Raw graph data (nodes + edges)
    sitemap.mmd      # Mermaid graph definition
    meta.json        # Map metadata
    map.pdf          # PDF export (if --export-pdf)
    screenshots/     # PNG screenshots
```
