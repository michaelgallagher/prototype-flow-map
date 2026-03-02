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
- **PDF export** — optional `map.pdf`, with full-canvas layout as default

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

The most basic way to use the tool is like so:

```bash
# Point it at any prototype project
npx prototype-flow-map /path/to/your/prototype
```

That will get you a map of *everything* in your prototype. Depending on how things are set up, that may or may not be a good idea. 

There are lots of options you can use to tune the output, the most useful of which is `--from`, which lets you scope the output to a specific start point. The tool will crawl from that point onward (i.e. down the tree). You can give this flag multiple values if you want, which is useful because the default behaviour won't capture sideways links from `{% include %}` partials right now (it makes it very hard to limit the scope of the crawler). If you give the tool multiple `--from` points, it will look for ways that they connect them via the `{% include %} partials. This is something of a workaround right now. 

An example of how this would work with the NHS App prototype would be to use a prompt like: 

```bash
# Point it at any prototype project
npx prototype-flow-map /path/to/your/prototype --from "/pages/home-p9,/pages/messages-p9,/pages/profile-p9"
```

That will get you a map of the three main tabs. Please note that the tool will arrange them in the order you list them, running from left to right on the output map. 

If you want to save your map, you probably also want to give it a name. This has two parts: `--name` and `--title`. The name flag determines what the folder is called (inside `flow-map-output/maps/`) and the title flag sets the visible name in the site index. You don't need to provide both. If you don't provide these flags, defaults are generated from the prototype folder name, and output still goes into `maps/<derived-name>/`. Given that this is all very manual right now, if you give your map a name or title, you should keep using the same one, otherwise it will create a new folder instead of writing over the current one. 

The order of the flags doesn't matter. 

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
| `--name` | prototype folder slug | Map folder slug (must be lowercase alphanumeric + hyphens) |
| `--title` | prototype folder name | Human-readable map title shown in index |
| `--export-pdf` | `false` | Generate a PDF of the flow map (`map.pdf`) |
| `--pdf-mode` | `canvas` | PDF mode: `canvas` (full-canvas default) or `snapshot` (A3 fit-to-screen) |
| `--no-open` | `false` | Don't automatically open the viewer in a browser

## Output

The tool generates a folder (default `./flow-map-output/`) containing the index: 

```
  index.html           # The table of contents (open this)
  style.css            # Styles for the viewer and maps
  viewer.js            # JavaScript for the interactive viewer
  maps/                # Subfolders for each generated map
```

Each time you run the tool it will also produce a subfolder for the specific map you are generating, which will contain:

```
  index.html           # Interactive viewer (open this)
  map.pdf              # Optional PDF export (full-canvas by default)
  graph-data.json      # Raw graph data (nodes + edges)
  sitemap.mmd          # Mermaid text-based graph definition
  meta.json            # Graph metadata (number of nodes, name, etc.)
  map.pdf              # A PDF of the map, if you've chosen to generate one
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
- Can this output a file for Mural?
- Can the changes the user makes to the map positions be saved?
