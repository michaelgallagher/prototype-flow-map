# Using the viewer

The tool generates an interactive HTML viewer for each map. Open `index.html` in a browser to explore.

## Navigation

- **Pan**: Click and drag the background
- **Zoom**: Scroll wheel, or use the + / - buttons
- **Fit to screen**: Reset the view to fit all nodes

## Inspecting pages

- **Click a node** to open the detail panel showing:
  - Full screenshot
  - Page metadata (URL path, file path, node type, hub)
  - Incoming and outgoing edges with labels
  - Provenance badges (runtime vs static)
- **Search** to filter pages by name or URL path

## Filters and toggles

- **Filter by hub**: Show only pages in a specific section
- **Toggle labels**: Show/hide edge labels and conditions
- **Toggle global nav**: Show/hide global navigation edges (hidden by default in scenario mode)
- **Provenance filter**: Filter edges by source — runtime only, static only, or both
- **Show/hide screenshots**: Toggle between screenshot view and compact node view
- **Thumbnail mode**: Switch between full-page and compact thumbnail screenshots

## Repositioning nodes

- **Drag nodes**: Click and drag any node to reposition it. Positions are saved in your browser's localStorage and persist across reloads.
- **Reset positions**: Clear all manual positions and return to the computed layout.

## Hiding nodes

- Click a node, then use the **"Hide this page"** button to remove it from view
- Use **"Show hidden"** to restore all hidden nodes

## Layout

In scenario mode, the layout is computed as a grid:

- Nodes are arranged in horizontal rows by rank (visit order)
- Tab siblings (pages with mutual cross-links) are grouped on the same row
- The flow progresses top to bottom
- Each row is centred on a common axis

In static mode, dagre handles the layout automatically based on the graph structure.
