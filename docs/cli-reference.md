# CLI reference

## Usage

```bash
# Generate a flow map
npx prototype-flow-map /path/to/prototype [options]

# Serve a previously-generated output directory
npx prototype-flow-map serve [output-dir] [--port 3000]
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

# Serve an output directory locally with shared layout-position persistence
npx prototype-flow-map serve ./flow-map-output --port 3000

# Generate and serve in one go (server starts after generation completes)
npx prototype-flow-map /path/to/prototype --scenario clinic-workflow --serve --port 3000
```

## Options

| Option | Default | Description |
|---|---|---|
| `--record [filename]` | — | Record a scenario interactively (opens a browser). Optional filename, default: `recorded.flow` |
| `-o, --output` | `./flow-map-output` | Output directory |
| `-p, --prototype-port` | `4321` | Port to start the prototype kit server on (web prototypes only) |
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
| `--serve` | — | After generation, start the local server (positions + hidden state persistence) and keep it running. Opens the served URL unless `--no-open` is set. Press Ctrl-C to stop |
| `--port` | `3000` (or `$PORT`) | Port for the local server when `--serve` is set. No effect otherwise — for the prototype kit's own port use `-p` / `--prototype-port` |

`--record` cannot be combined with `--mode`, `--scenario`, or `--scenario-set`.

## Mapping modes

| Mode | Purpose | Best for |
|---|---|---|
| `record` | Interactive recording -- click through your prototype in a browser | Quick maps, exploration, non-technical users |
| `static` | Broad static analysis of all templates and routes (this is the default mode) | Simple prototypes without seed data |
| `scenario` | Map realistic user journeys with setup steps and scoped crawling | Prototypes with seed data, stateful flows, or complex routing |
| `audit` | Static analysis plus runtime crawl of every discoverable page | Debugging and coverage checks |

## `serve` subcommand

Run a local web server over an output directory. Adds REST endpoints for collaborative features. Equivalent to `--serve` on the main generate command but works against an already-generated output dir without regenerating.

```bash
npx prototype-flow-map serve [output-dir] [--port <number>]
```

| Argument / Option | Default | Description |
|---|---|---|
| `output-dir` | `./flow-map-output` | The output directory to serve |
| `--port` | `3000` (or `$PORT`) | Port to listen on |

Endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check; viewer uses this to detect serve mode |
| `GET` | `/api/maps/:name/positions` | Read saved positions for a map |
| `PUT` | `/api/maps/:name/positions` | Write positions for a map |
| `GET` | `/api/maps/:name/hidden` | Read saved hidden-node set for a map |
| `PUT` | `/api/maps/:name/hidden` | Write hidden-node set for a map |
| Static | `/maps/:name/` | Static file serving for the map's viewer assets |

Persisted to disk per map as `<output>/maps/<name>/positions.json` and `<output>/maps/<name>/hidden.json`. On regeneration the tool reads these files and carries forward entries whose node IDs still exist in the new graph (stale entries are silently dropped).

The viewer detects serve mode automatically and behaves differently in two ways:

- **Positions** — drag-to-reposition stages changes in `localStorage`; click "Save layout" to commit to the server. The button shows a dirty/saved indicator.
- **Hidden nodes** — every hide / restore action saves to the server immediately (no Save button, fire-and-forget).

When the server isn't reachable (file:// load, server stopped, network error), the viewer falls back to `localStorage`. Health-check timeout is 1.5s, so file:// loads detect "no server" almost instantly.

See [`viewer.md`](viewer.md#repositioning-nodes) for the full position-loading priority chain.

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
    positions.json   # Saved manual node positions (created by serve mode)
```
