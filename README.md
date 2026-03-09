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

If you want to save your map, you might also want to give it a name. This has two optional parts: `--name` and `--title`. The name flag determines what the folder is called (inside `flow-map-output/maps/`) and the title flag sets the visible name in the site index. If you don't provide either of these flags, the default behaviour is to use the prototype folder name. (*Given that this is all very manual right now, if you give your map a name or title, you should probably keep using the same one, otherwise it will create an entirely new folder instead of writing over the current one.)

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
| `--exclude` | "" | Removes pages and their children |
| `--name` | prototype folder slug | Map folder slug (must be lowercase alphanumeric + hyphens) |
| `--title` | prototype folder name | Human-readable map title shown in index |
| `--export-pdf` | `false` | Generate a PDF of the flow map (`map.pdf`) |
| `--pdf-mode` | `canvas` | PDF mode: `canvas` (full-canvas default) or `snapshot` (A3 fit-to-screen) |
| `--platform` | auto-detected | Project platform: `web` or `ios` |
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

## iOS / SwiftUI projects

The tool also supports native iOS prototypes built with SwiftUI. It auto-detects iOS projects (by looking for `.xcodeproj` / `.xcworkspace` files) or you can force it with `--platform ios`.

```bash
npx prototype-flow-map /path/to/your/ios-prototype --platform ios
```

It parses your Swift source files for navigation patterns (`NavigationLink`, `NavigationStack`, `TabView`, `.sheet()`, `.fullScreenCover()`, custom `RowLink` / `HubRowLink` components) and builds a graph of all screens. Screenshots are captured by generating a temporary XCUITest that launches the app in the simulator, navigates to each screen, and takes a screenshot.

### Requirements for iOS

- Xcode installed (with iOS Simulator)
- The project must have a UI Testing Bundle target (e.g. `MyAppUITests`)
- At least one `.swift` file in the UITest target (the tool temporarily replaces it)

### Config file (`.flow-map.json`)

For screens the auto-detection can't handle — data-dependent UI, custom button components, item-based sheets — you can place a `.flow-map.json` file in the prototype root. The tool picks it up automatically.

```json
{
  "exclude": [
    "SomeEmbeddedComponent",
    "AnotherNonScreen"
  ],
  "overrides": {
    "AppointmentDetailView": {
      "steps": [
        "tap:Appointments",
        "tap:Manage GP appointments",
        "tapContaining:Appointment on"
      ]
    },
    "RemovedMessagesView": {
      "steps": [
        "tapTab:Messages:1",
        "swipeLeft:firstCell",
        "tap:Remove",
        "wait:1.0",
        "tap:Removed messages"
      ]
    }
  }
}
```

#### `exclude`

An array of view names to remove from the graph entirely. Use this for embedded components that the parser picks up as screens but aren't actually navigable destinations (e.g. section views, helper components).

#### `overrides`

A map of view name to custom test steps. When a screen has an override, the tool skips auto-detection for that screen and generates a test using your steps instead. Each step is a string in the format `command:arguments`.

| Step | Example | Description |
|---|---|---|
| `tap:Label` | `tap:Appointments` | Tap a button, cell, or element matching this label |
| `tapTab:Label:index` | `tapTab:Messages:1` | Tap a tab bar button by label and index (index is zero-based) |
| `tapContaining:text` | `tapContaining:Appointment on` | Tap the first button whose accessibility label contains this text |
| `tapCell:index` | `tapCell:0` | Tap a list cell by index (zero-based) |
| `tapSwitch:index` | `tapSwitch:0` | Tap a toggle/switch by index (zero-based) — useful for checkboxes and selection toggles |
| `swipeLeft:firstCell` | `swipeLeft:firstCell` | Swipe left on the first cell (to reveal swipe actions) |
| `swipeLeft:index` | `swipeLeft:2` | Swipe left on a cell at a specific index |
| `wait:seconds` | `wait:1.5` | Wait for a number of seconds |

Steps run in order after the app launches. If any `tap` or `tapTab` step fails to find its target, the test aborts and no screenshot is taken (preventing wrong screenshots).

#### When to use overrides

- **Item-based sheets** — where the trigger is a dynamic element (e.g. tapping an appointment card). Use `tapContaining` with a keyword from the element's accessibility label.
- **Data-dependent screens** — where a button only appears after some user action (e.g. swipe-deleting a message to reveal "Removed messages"). Script the prerequisite actions as steps.
- **Custom button components** — where the parser can't extract the trigger label. Provide the button text directly in a `tap` step.

#### When to use excludes

- **Embedded sub-views** — components like `UrgentMedicalHelpSection` that conform to `View` but are never navigation destinations.
- **Unreachable screens** — views whose navigation link is commented out or removed but the view file still exists.

The config file name can be either `.flow-map.json` or `flow-map.config.json`.

## How it works

### Web prototypes

1. **Scans** `app/views/` for all `.html` template files
2. **Parses** each template for `href=`, `action=`, `location.href`, `{% set backLinkURL %}`, and `{% if %}` conditional blocks
3. **Parses** `routes.js` and `app.js` for explicit `res.redirect()` and `res.render()` calls
4. **Builds a directed graph** of pages (nodes) and navigation paths (edges)
5. **Starts the prototype**, crawls every page with Playwright, and takes screenshots
6. **Generates a static HTML viewer** with the graph and screenshots embedded

### iOS prototypes

1. **Scans** for all `.swift` files in the project
2. **Parses** each file for SwiftUI navigation patterns (`NavigationLink`, `TabView`, `.sheet()`, `.fullScreenCover()`, `RowLink`, `HubRowLink`)
3. **Builds a directed graph** of screens and navigation edges
4. **Applies config** — removes excluded nodes, prepares override test steps
5. **Generates a temporary XCUITest** that navigates to each screen and takes a screenshot
6. **Runs `xcodebuild test`** in the iOS Simulator, collects the PNG files
7. **Generates a static HTML viewer** with the graph and screenshots embedded

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

- Make the iOS screenshot capture faster (each test relaunches the app; scroll-retry is aggressive)
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
