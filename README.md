# Prototype Flow Map

Generate interactive flow maps from Express/Nunjucks prototype kit projects (NHS Prototype Kit, GOV.UK Prototype Kit, etc.).

Analyses your prototype's templates, routes, and conditional logic to produce a visual map of every screen and the connections between them — with screenshots.

![Example flowmap screenshot showing a graph of pages and connections, with a detail panel open for one page showing its screenshot and metadata](docs/assets/example-nhsapp-map.png)

## Features

- **Auto-discovers all pages** from Nunjucks templates (mirrors the prototype kit's auto-routing)
- **Extracts navigation** from `href` links, `<form action>` attributes, and JS redirects
- **Detects conditional branches** (`{% if data['...'] %}` blocks wrapping different links)
- **Parses Express route handlers** for explicit redirects and renders
- **Screenshots every page** using Playwright (headless Chromium)
- **Interactive web viewer** — pan, zoom, click nodes for detail, filter by hub, search
- **Shareable output** — a static HTML site you can open locally or deploy anywhere

## Prerequisites

- Node.js 20+ 
- The prototype you want to map must be installable and runnable via `node app.js`

## Install

```bash
cd prototype-flow-map
npm install
npx playwright install chromium
```

## Usage

```bash
# Point it at any prototype project
npx prototype-flow-map /path/to/your/prototype

# With options
npx prototype-flow-map /path/to/your/prototype \
  --output ./my-flow-map \
  --port 4321 \
  --width 375 \
  --height 812 \
  --base-path /pages
  --from /pages/xxxxx (determines the start point, can have mulitple – separate with commas)
  --no-screenshots (don't add screenshots to the output)
  --no-open (don't automatically open the viewer)

# Skip screenshots (faster, static analysis only)
npx prototype-flow-map /path/to/your/prototype --no-screenshots
```

## Options

| Option | Default | Description |
|---|---|---|
| `--output, -o` | `./flow-map-output` | Output directory for the generated flow map |
| `--port, -p` | `4321` | Port to start the prototype server on |
| `--width` | `375` | Screenshot viewport width (pixels) |
| `--height` | `812` | Screenshot viewport height (pixels) |
| `--no-screenshots` | `false` | Skip screenshotting (much faster) |
| `--base-path` | `""` | Only include pages under this path (e.g. `/pages`) |
| `--start-url` | `/` | URL to begin crawling from |
| `--from` | `""` | Sets the start point for the graph; allows for multiple inputs, which will be merged into a single map |
| `--no-open` | `false` | Don't automatically open the viewer in a browser

## Output

The tool generates a folder (default `./flow-map-output/`) containing a subfolder for each map:

```
flow-map-output/maps/{your-map-here}
  index.html           # Interactive viewer — open this
  styles.css           # Viewer styles
  viewer.js            # Viewer logic
  graph-data.json      # Raw graph data (nodes + edges)
  sitemap.mmd          # Mermaid text-based graph definition
  meta.json            # Graph metadata (number of nodes, name, etc.)
  screenshots/         # PNG screenshot of every page
```

Open `index.html` in a browser to explore the flow map. You can deploy the entire folder to GitHub Pages, Netlify, or any static host to share with your team.

## How it works

1. **Scans** `app/views/` for all `.html` template files
2. **Parses** each template for `href=`, `action=`, `location.href`, `{% set backLinkURL %}`, and `{% if %}` conditional blocks
3. **Parses** `routes.js` and `app.js` for explicit `res.redirect()` and `res.render()` calls
4. **Builds a directed graph** of pages (nodes) and navigation paths (edges)
5. **Starts the prototype**, crawls every page with Playwright, and takes screenshots
6. **Generates a static HTML viewer** with the graph and screenshots embedded

## Viewer controls

- **Pan**: Click and drag the background
- **Zoom**: Scroll wheel, or use the + / − buttons
- **Click a node**: Opens a detail panel with screenshot, metadata, and all incoming/outgoing links
- **Filter by hub**: Use the dropdown to show only pages in a specific section
- **Search**: Type to filter pages by name or URL path
- **Toggle back links**: Show/hide the dashed "Back" link edges
- **Toggle labels**: Show/hide edge labels and conditions
`
## To do

- Add an interface for exluding areas or pages
- Make it possible to add your own images into the flow?
- Make the command line prompt easier to use (multiple steps)
  - The sequence:
    - Path to the prototype
    - Name
    - Title
    - Start points
    - Screenshots option
  - At each step, if you just press enter, it will use the default value
- Make it an npm package and something that be installed into a prototype so it auto-runs on build?
- Add a text-based visualisation of the site
