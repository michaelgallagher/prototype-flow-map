const fs = require("fs");
const path = require("path");

/**
 * Build a self-contained HTML viewer for the flow map.
 * Outputs a single index.html with embedded JS that renders
 * an interactive, zoomable, pannable flow diagram.
 */
async function buildViewer(
  graph,
  outputDir,
  hasScreenshots,
  viewport,
  options = {},
) {
  const { name, rootOutputDir } = options;
  fs.mkdirSync(outputDir, { recursive: true });

  // CSS and JS live in the root output dir (shared across all maps).
  // When running in named-map mode the map's index.html is two levels deep
  // (maps/<name>/index.html), so we need to adjust the relative paths.
  const sharedAssetsDir = rootOutputDir || outputDir;
  const assetPrefix = rootOutputDir ? "../../" : "";

  // Write graph data as JSON
  const dataPath = path.join(outputDir, "graph-data.json");
  fs.writeFileSync(dataPath, JSON.stringify(graph, null, 2));

  // Write the HTML viewer
  const htmlPath = path.join(outputDir, "index.html");
  fs.writeFileSync(
    htmlPath,
    generateViewerHtml(graph, hasScreenshots, viewport, name, assetPrefix),
  );

  // Write the CSS and JS only to the shared root directory
  fs.mkdirSync(sharedAssetsDir, { recursive: true });
  const cssPath = path.join(sharedAssetsDir, "styles.css");
  fs.writeFileSync(cssPath, generateViewerCss());

  const jsPath = path.join(sharedAssetsDir, "viewer.js");
  fs.writeFileSync(jsPath, generateViewerJs());

  // Remove any stale per-map copies left over from older builds
  if (rootOutputDir) {
    for (const stale of ["viewer.js", "styles.css"]) {
      const stalePath = path.join(outputDir, stale);
      if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
    }
  }
}

function generateViewerHtml(
  graph,
  hasScreenshots,
  viewport,
  name,
  assetPrefix = "",
) {
  const vpWidth = (viewport && viewport.width) || 375;
  const vpHeight = (viewport && viewport.height) || 812;
  const backLink = name
    ? '<a href="../../index.html" class="back-to-index">&larr; All maps</a>'
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prototype Flow Map</title>
  <link rel="stylesheet" href="${assetPrefix}styles.css">
</head>
<body>
  <div id="toolbar">
    ${backLink}
    <h1>Prototype Flow Map</h1>
    <div class="toolbar-controls">
      <span id="node-count"></span>
      <button onclick="zoomIn()">Zoom +</button>
      <button onclick="zoomOut()">Zoom −</button>
      <button onclick="fitToScreen()">Fit to screen</button>
      <button id="toggle-thumbnail" onclick="toggleThumbnail()" style="display:none">Show thumbnails</button>
      <button id="toggle-screenshots" onclick="toggleScreenshots()" style="display:none">Hide screenshots</button>
      <label><input type="checkbox" id="toggle-labels" checked> Show labels</label>
      <select id="hub-filter">
        <option value="">All hubs</option>
      </select>
      <input type="text" id="search" placeholder="Search pages..." />
      <button id="show-all-btn" onclick="showAllNodes()" style="display:none">Show hidden (0)</button>
      <button id="reset-positions-btn" onclick="resetPositions()">Reset positions</button>
    </div>
  </div>
  <div id="canvas-container">
    <svg id="flow-svg"></svg>
  </div>
  <div id="legend">
    <h3>Edge types</h3>
    <div class="legend-item"><span class="legend-swatch" style="background:#5aaf6a;height:2px"></span> Form submission</div>
    <div class="legend-item"><span class="legend-swatch" style="background:#6b9fd4;height:1.5px"></span> Link / push nav</div>
    <div class="legend-item"><span class="legend-swatch" style="height:1px;border-top:1px dashed #e8a838;background:none"></span> Conditional</div>
    <div class="legend-item"><span class="legend-swatch" style="height:1px;border-top:1px dashed #53d8fb;background:none"></span> Tab / global nav</div>
    <div class="legend-item"><span class="legend-swatch" style="height:1.5px;border-top:1.5px dashed #c47ab0;background:none"></span> Sheet (modal)</div>
    <div class="legend-item"><span class="legend-swatch" style="background:#d47a6b;height:2px"></span> Full-screen cover</div>
    <div class="legend-item"><span class="legend-swatch" style="height:1.5px;border-top:1.5px dashed #5aaf6a;background:none"></span> Web view</div>
    <div class="legend-item"><span class="legend-swatch" style="height:1px;border-top:1px dashed #8f8f40;background:none"></span> Safari / external</div>
  </div>
  <div id="detail-panel" class="hidden">
    <button id="close-panel" onclick="closePanel()">✕</button>
    <div id="panel-content"></div>
  </div>
  <script>
    window.__GRAPH_DATA__ = ${JSON.stringify(graph)};
    window.__HAS_SCREENSHOTS__ = ${hasScreenshots ? "true" : "false"};
    window.__VIEWPORT_WIDTH__ = ${vpWidth};
    window.__VIEWPORT_HEIGHT__ = ${vpHeight};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></script>
  <script src="${assetPrefix}viewer.js"></script>
</body>
</html>`;
}

function generateViewerCss() {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #1a1a2e;
  color: #e0e0e0;
  overflow: hidden;
  height: 100vh;
}

#toolbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: #16213e;
  border-bottom: 1px solid #0f3460;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

#toolbar h1 {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
}

.back-to-index {
  color: #53d8fb;
  text-decoration: none;
  font-size: 13px;
  padding: 4px 10px;
  border: 1px solid #0f3460;
  border-radius: 4px;
  white-space: nowrap;
}
.back-to-index:hover {
  background: #0f3460;
}

.toolbar-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.toolbar-controls button {
  background: #0f3460;
  color: #e0e0e0;
  border: 1px solid #1a4a8a;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.toolbar-controls button:hover { background: #1a4a8a; }

.toolbar-controls label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
}

.toolbar-controls select,
.toolbar-controls input[type="text"] {
  background: #0f3460;
  color: #e0e0e0;
  border: 1px solid #1a4a8a;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.toolbar-controls input[type="text"] { width: 160px; }

#node-count {
  font-size: 12px;
  color: #888;
}

#canvas-container {
  position: fixed;
  top: 50px;
  left: 0;
  right: 0;
  bottom: 0;
}

#flow-svg {
  width: 100%;
  height: 100%;
  cursor: grab;
}

#flow-svg:active { cursor: grabbing; }

/* Node styles */
.node-group { cursor: grab; transition: opacity 0.15s; }
.node-group:active { cursor: grabbing; }
.node-group:hover .node-rect { stroke: #53d8fb; stroke-width: 2; }
.hide-node-btn:hover { background: #5f2e2e !important; }

.node-rect {
  rx: 6;
  ry: 6;
  stroke-width: 1;
}

.node-rect--content   { fill: #1e3a5f; stroke: #2a5a8f; }
.node-rect--question  { fill: #1e3f5f; stroke: #2a8f5a; }
.node-rect--check-answers { fill: #3f3a1e; stroke: #8f7a2a; }
.node-rect--confirmation { fill: #1e3f2f; stroke: #2a8f4a; }
.node-rect--error     { fill: #3f1e1e; stroke: #8f2a2a; }
.node-rect--splash    { fill: #2e1e4f; stroke: #5a2a8f; }
.node-rect--index     { fill: #0f3460; stroke: #53d8fb; }
.node-rect--highlight { stroke: #ffcc00 !important; stroke-width: 3 !important; }
/* iOS / native platform node types */
.node-rect--screen    { fill: #1a3545; stroke: #2a7a9f; }
.node-rect--web-view  { fill: #1a3f22; stroke: #2a8f40; }
.node-rect--external  { fill: #3a3520; stroke: #8f7a30; }

.node-label {
  fill: #ffffff;
  font-size: 11px;
  font-weight: 500;
  text-anchor: middle;
  pointer-events: none;
}

.node-path-label {
  fill: #8899aa;
  font-size: 9px;
  text-anchor: middle;
  pointer-events: none;
}

.node-type-badge {
  fill: #8899aa;
  font-size: 8px;
  text-anchor: middle;
  pointer-events: none;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.node-screenshot {
  pointer-events: none;
  opacity: 0.9;
}

/* Edge styles */
.edge-path {
  fill: none;
  transition: opacity 0.15s;
}

.edge-path--form        { stroke: #5aaf6a; stroke-width: 2; opacity: 0.85; }
.edge-path--link        { stroke: #6b9fd4; stroke-width: 1.2; opacity: 0.75; }
.edge-path--conditional { stroke: #e8a838; stroke-width: 1; stroke-dasharray: 6,3; opacity: 0.7; }
.edge-path--redirect    { stroke: #aa55cc; stroke-width: 1; stroke-dasharray: 3,3; opacity: 0.6; }
.edge-path--render      { stroke: #aa55cc; stroke-width: 1; opacity: 0.5; }
.edge-path--nav         { stroke: #53d8fb; stroke-width: 1; stroke-dasharray: 8,4; opacity: 0.5; }
/* iOS / native platform edge types */
.edge-path--sheet       { stroke: #c47ab0; stroke-width: 1.5; stroke-dasharray: 5,3; opacity: 0.8; }
.edge-path--full-screen { stroke: #d47a6b; stroke-width: 2; opacity: 0.85; }
.edge-path--tab         { stroke: #53d8fb; stroke-width: 1.5; opacity: 0.65; }
.edge-path--web-view    { stroke: #5aaf6a; stroke-width: 1.5; stroke-dasharray: 4,3; opacity: 0.75; }
.edge-path--safari      { stroke: #8f8f40; stroke-width: 1; stroke-dasharray: 3,3; opacity: 0.6; }

.edge-label {
  font-size: 9px;
  fill: #aabbcc;
  pointer-events: none;
}

.edge-condition-label {
  font-size: 8px;
  fill: #e8a838;
  pointer-events: none;
  font-style: italic;
}

.edge-arrowhead { fill: #6b9fd4; }
.edge-arrowhead--form { fill: #5aaf6a; }
.edge-arrowhead--conditional { fill: #e8a838; }
.edge-arrowhead--redirect { fill: #aa55cc; }
.edge-arrowhead--render { fill: #aa55cc; }
.edge-arrowhead--nav { fill: #53d8fb; }
/* iOS / native platform arrowheads */
.edge-arrowhead--sheet       { fill: #c47ab0; }
.edge-arrowhead--full-screen { fill: #d47a6b; }
.edge-arrowhead--tab         { fill: #53d8fb; }
.edge-arrowhead--web-view    { fill: #5aaf6a; }
.edge-arrowhead--safari      { fill: #8f8f40; }

.node-rect--start-node { stroke: #53d8fb !important; stroke-width: 2.5 !important; filter: drop-shadow(0 0 4px rgba(83, 216, 251, 0.4)); }

.start-node-badge {
  font-size: 9px;
  font-weight: 600;
  fill: #53d8fb;
  letter-spacing: 1.5px;
}

/* Detail panel */
#detail-panel {
  position: fixed;
  top: 50px;
  right: 0;
  bottom: 0;
  width: 380px;
  background: #16213e;
  border-left: 1px solid #0f3460;
  padding: 16px;
  overflow-y: auto;
  z-index: 50;
  transition: transform 0.2s ease;
}

#detail-panel.hidden {
  transform: translateX(100%);
}

#close-panel {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  color: #888;
  font-size: 18px;
  cursor: pointer;
}

#panel-content h2 {
  font-size: 16px;
  margin-bottom: 8px;
  color: #fff;
}

#panel-content .panel-screenshot {
  width: 100%;
  border-radius: 6px;
  border: 1px solid #0f3460;
  margin-bottom: 12px;
}

#panel-content .panel-meta {
  font-size: 12px;
  color: #8899aa;
  margin-bottom: 12px;
}

#panel-content .panel-meta dt {
  font-weight: 600;
  color: #aabbcc;
  margin-top: 8px;
}

#panel-content .panel-meta dd {
  margin-left: 0;
  margin-top: 2px;
}

#panel-content .panel-links {
  list-style: none;
  padding: 0;
}

#panel-content .panel-links li {
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px solid #0f3460;
}

#panel-content .panel-links .link-target {
  color: #53d8fb;
}

#panel-content .panel-links .link-condition {
  color: #e8a838;
  font-style: italic;
  font-size: 11px;
}

/* Legend */
#legend {
  position: fixed;
  bottom: 16px;
  left: 16px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  padding: 12px;
  font-size: 11px;
  z-index: 50;
}

#legend h3 {
  font-size: 12px;
  margin-bottom: 6px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}

.legend-swatch {
  width: 20px;
  height: 3px;
  border-radius: 1px;
}
`;
}

function generateViewerJs() {
  return `
(function() {
  const graph = window.__GRAPH_DATA__;
  const hasScreenshots = window.__HAS_SCREENSHOTS__;
  const svg = document.getElementById('flow-svg');
  const container = document.getElementById('canvas-container');

  // State
  let transform = { x: 0, y: 0, scale: 1 };
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let layoutNodes = {};
  let layoutEdges = [];
  let showLabels = true;
  let thumbnailMode = false; // false = full page, true = compact thumbnail
  let hideScreenshots = false;
  let hubFilter = '';
  let searchTerm = '';

  // Persist view mode preference
  const viewModeKey = 'flowmap-viewmode-' + location.pathname;
  try { thumbnailMode = localStorage.getItem(viewModeKey) === 'thumbnail'; } catch(e) {}

  // Hidden nodes (viewer-time exclusion, persisted in localStorage)
  let hiddenNodes = new Set();
  const hiddenStorageKey = 'flowmap-hidden-' + location.pathname;
  try {
    const savedHidden = localStorage.getItem(hiddenStorageKey);
    if (savedHidden) hiddenNodes = new Set(JSON.parse(savedHidden));
  } catch(e) {}

  function saveHiddenNodes() {
    try { localStorage.setItem(hiddenStorageKey, JSON.stringify([...hiddenNodes])); } catch(e) {}
  }

  // Manual node positions (drag-to-reposition, persisted in localStorage)
  let manualPositions = {};
  let isDragging = false;
  let dragTarget = null;
  const posStorageKey = 'flowmap-positions-' + location.pathname;
  try {
    const savedPos = localStorage.getItem(posStorageKey);
    if (savedPos) manualPositions = JSON.parse(savedPos);
  } catch(e) {}

  function savePositions() {
    try { localStorage.setItem(posStorageKey, JSON.stringify(manualPositions)); } catch(e) {}
  }

  // Screenshot viewport ratio (default 375x812 mobile)
  const VIEWPORT_WIDTH = window.__VIEWPORT_WIDTH__ || 375;
  const VIEWPORT_HEIGHT = window.__VIEWPORT_HEIGHT__ || 812;

  // Node sizing constants
  const NODE_WIDTH = 140;
  const LABEL_AREA = 32;
  const IMG_PAD = 3;

  // Returns { w, h } for a node, varying by thumbnailMode
  function getNodeDims() {
    const w = NODE_WIDTH;
    if (!hasScreenshots || hideScreenshots) {
      return { w, h: 56 };
    }
    // Full-page mode: height matches the screenshot's true aspect ratio
    // Thumbnail mode: fixed 90px crop
    const imgW = w - IMG_PAD * 2;
    const imgH = thumbnailMode
      ? Math.round(90)
      : Math.round(imgW * VIEWPORT_HEIGHT / VIEWPORT_WIDTH);
    return { w, h: imgH + LABEL_AREA + IMG_PAD };
  }

  // Layout the graph using dagre
  function layoutGraph() {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: 'TB',
      nodesep: 15,
      ranksep: 50,
      edgesep: 8,
      marginx: 30,
      marginy: 30,
    });
    g.setDefaultEdgeLabel(() => ({}));

    const filteredNodes = graph.nodes.filter(n => {
      if (hiddenNodes.has(n.id)) return false;
      if (hubFilter && n.hub !== hubFilter) return false;
      if (searchTerm && !n.label.toLowerCase().includes(searchTerm) && !n.urlPath.toLowerCase().includes(searchTerm)) return false;
      return true;
    });

    const filteredNodeIds = new Set(filteredNodes.map(n => n.id));

    filteredNodes.forEach(node => {
      const { w, h } = getNodeDims();
      g.setNode(node.id, { width: w, height: h, ...node });
    });

    // Identify start nodes and collect their IDs for layout pinning
    const startNodes = filteredNodes.filter(n => n.isStartNode);
    const startNodeIds = new Set(startNodes.map(n => n.id));

    // Separate nav edges and incoming-to-start edges from dagre-layoutable edges
    const navEdges = [];
    const incomingToStartEdges = [];
    const filteredEdges = graph.edges.filter(e => {
      if (!filteredNodeIds.has(e.source) || !filteredNodeIds.has(e.target)) return false;
      if (e.type === 'nav') { navEdges.push(e); return false; }
      // Exclude incoming edges to start nodes from dagre so they stay at top rank.
      // Applies for any number of start nodes — even a single --from page can be
      // pulled down the rank if something in the graph links back to it.
      if (startNodeIds.size >= 1 && startNodeIds.has(e.target) && !startNodeIds.has(e.source)) {
        incomingToStartEdges.push(e);
        return false;
      }
      return true;
    });

    filteredEdges.forEach((edge, i) => {
      g.setEdge(edge.source, edge.target, { ...edge, id: 'edge-' + i });
    });

    // Add virtual root to pin start nodes to the top rank.
    // Used for any number of start nodes — a single --from page also needs this
    // anchor so dagre doesn't assign it a lower rank due to back-edges or cycles.
    const virtualRootId = '__virtual_root__';
    if (startNodes.length >= 1) {
      g.setNode(virtualRootId, { width: 0, height: 0 });
      startNodes.forEach(n => {
        g.setEdge(virtualRootId, n.id, { weight: 2, minlen: 1 });
      });
    }

    dagre.layout(g);

    layoutNodes = {};
    g.nodes().forEach(id => {
      if (id === virtualRootId) return;
      layoutNodes[id] = g.node(id);
    });

    // Assign each node to its nearest start node's subgraph (multi-source BFS)
    const subgraphOf = {};
    if (startNodes.length > 1) {
      // Build adjacency from ALL graph edges (not just dagre-filtered ones)
      // so that crawler-discovered edges don't change subgraph assignment
      const forwardAdj = {};
      graph.edges.forEach(e => {
        if (e.type === 'nav') return;
        if (!filteredNodeIds.has(e.source) || !filteredNodeIds.has(e.target)) return;
        if (!forwardAdj[e.source]) forwardAdj[e.source] = [];
        forwardAdj[e.source].push(e.target);
      });

      // Multi-source BFS: all start nodes enqueued at distance 0.
      // Processes level-by-level so each node is claimed by its nearest start node.
      const queue = [];
      [...startNodes]
        .sort((a, b) => (a.startOrder || 0) - (b.startOrder || 0))
        .forEach(n => {
          subgraphOf[n.id] = n.id;
          queue.push(n.id);
        });

      let head = 0;
      while (head < queue.length) {
        const current = queue[head++];
        const owner = subgraphOf[current];
        (forwardAdj[current] || []).forEach(t => {
          if (subgraphOf[t] === undefined) {
            subgraphOf[t] = owner;
            queue.push(t);
          }
        });
      }
    }

    // Force start nodes to top rank and correct left-to-right order,
    // shifting their entire subgraphs with them
    if (startNodes.length > 1) {
      const sorted = startNodes
        .map(n => layoutNodes[n.id])
        .filter(Boolean)
        .sort((a, b) => (a.startOrder || 0) - (b.startOrder || 0));
      if (sorted.length > 1) {
        const minY = Math.min(...sorted.map(n => n.y));
        const xs = sorted.map(n => n.x).sort((a, b) => a - b);

        // Compute X delta for each start node
        const deltas = {};
        sorted.forEach((n, i) => {
          deltas[n.id] = xs[i] - n.x;
          n.y = minY;
          n.x = xs[i];
        });

        // Shift all child nodes by their parent start node's delta
        Object.keys(layoutNodes).forEach(nodeId => {
          if (startNodeIds.has(nodeId)) return;
          const parentStartId = subgraphOf[nodeId];
          if (parentStartId && deltas[parentStartId]) {
            layoutNodes[nodeId].x += deltas[parentStartId];
          }
        });
      }
    }

    // Resolve horizontal overlap between subgraphs after shifting
    if (startNodes.length > 1) {
      const gap = 40;
      // Compute bounding boxes per subgraph
      const bounds = {};
      Object.keys(layoutNodes).forEach(nodeId => {
        const n = layoutNodes[nodeId];
        const owner = startNodeIds.has(nodeId) ? nodeId : subgraphOf[nodeId];
        if (!owner) return;
        const left = n.x - n.width / 2;
        const right = n.x + n.width / 2;
        if (!bounds[owner]) bounds[owner] = { minX: left, maxX: right };
        else {
          bounds[owner].minX = Math.min(bounds[owner].minX, left);
          bounds[owner].maxX = Math.max(bounds[owner].maxX, right);
        }
      });

      // Sort subgraphs left-to-right by current start node X
      const orderedStarts = startNodes
        .map(n => layoutNodes[n.id])
        .filter(Boolean)
        .sort((a, b) => a.x - b.x);

      // Walk left to right, push apart if overlapping
      for (let i = 1; i < orderedStarts.length; i++) {
        const prevId = orderedStarts[i - 1].id;
        const currId = orderedStarts[i].id;
        if (!bounds[prevId] || !bounds[currId]) continue;
        const overlap = (bounds[prevId].maxX + gap) - bounds[currId].minX;
        if (overlap > 0) {
          // Push current subgraph and all subsequent subgraphs right
          for (let j = i; j < orderedStarts.length; j++) {
            const shiftId = orderedStarts[j].id;
            Object.keys(layoutNodes).forEach(nodeId => {
              const owner = startNodeIds.has(nodeId) ? nodeId : subgraphOf[nodeId];
              if (owner === shiftId) {
                layoutNodes[nodeId].x += overlap;
              }
            });
            if (bounds[shiftId]) {
              bounds[shiftId].minX += overlap;
              bounds[shiftId].maxX += overlap;
            }
          }
        }
      }
    }

    // Apply any manual position overrides
    Object.keys(manualPositions).forEach(nodeId => {
      if (layoutNodes[nodeId]) {
        layoutNodes[nodeId].x = manualPositions[nodeId].x;
        layoutNodes[nodeId].y = manualPositions[nodeId].y;
      }
    });

    layoutEdges = [];
    g.edges().forEach(e => {
      if (e.v === virtualRootId || e.w === virtualRootId) return;
      const edgeData = g.edge(e);
      layoutEdges.push({
        ...edgeData,
        source: e.v,
        target: e.w,
        points: edgeData.points,
      });
    });

    // Use straight border-to-border lines for all edges.
    layoutEdges = layoutEdges.map(edge => {
      return { ...edge, points: computeStraightEdge(edge.source, edge.target) };
    });

    // Add nav edges and incoming-to-start edges as straight lines.
    [...navEdges, ...incomingToStartEdges].forEach(edge => {
      layoutEdges.push({
        ...edge,
        points: computeStraightEdge(edge.source, edge.target),
      });
    });

    return g;
  }

  // Render the graph to SVG
  function render() {
    const g = layoutGraph();
    const graphInfo = g.graph();

    // Clear SVG
    svg.innerHTML = '';

    // Add defs for arrowheads
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    ['link', 'form', 'conditional', 'redirect', 'render', 'nav'].forEach(type => {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrow-' + type);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '10');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '8');
      marker.setAttribute('markerHeight', '8');
      marker.setAttribute('orient', 'auto');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      path.setAttribute('class', 'edge-arrowhead edge-arrowhead--' + type);
      marker.appendChild(path);
      defs.appendChild(marker);
    });
    svg.appendChild(defs);

    // Create main group for pan/zoom
    const mainGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    mainGroup.setAttribute('id', 'main-group');
    svg.appendChild(mainGroup);

    const edgePriority = { nav: -1, link: 1, render: 2, conditional: 3, redirect: 4, form: 5 };
    const sortedEdges = [...layoutEdges].sort((a, b) => {
      const pa = edgePriority[a.type] || 1;
      const pb = edgePriority[b.type] || 1;
      return pa - pb;
    });

    // Render edges
    sortedEdges.forEach(edge => {
      const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      edgeGroup.setAttribute('class', 'edge-group');
      edgeGroup.dataset.source = edge.source;
      edgeGroup.dataset.target = edge.target;

      // Build orthogonal path with rounded corners from points
      const points = edge.points;
      const d = buildOrthogonalPath(points);

      const edgeType = edge.type || 'link';
      const cssClass = 'edge-path edge-path--' + edgeType;
      const arrowType = edgeType;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cssClass);
      path.setAttribute('marker-end', 'url(#arrow-' + arrowType + ')');
      edgeGroup.appendChild(path);

      // Edge label
      if (showLabels && edge.label && edge.type !== 'back') {
        const midPoint = points[Math.floor(points.length / 2)];
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', midPoint.x);
        text.setAttribute('y', midPoint.y - 6);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'edge-label');
        text.textContent = truncate(edge.label, 30);
        edgeGroup.appendChild(text);
      }

      // Condition label
      if (showLabels && edge.condition) {
        const midPoint = points[Math.floor(points.length / 2)];
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', midPoint.x);
        text.setAttribute('y', midPoint.y + 10);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'edge-condition-label');
        text.textContent = truncate(edge.condition, 40);
        edgeGroup.appendChild(text);
      }

      mainGroup.appendChild(edgeGroup);
    });

    // Render nodes
    Object.values(layoutNodes).forEach(node => {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'node-group');
      group.setAttribute('transform', 'translate(' + (node.x - node.width/2) + ',' + (node.y - node.height/2) + ')');
      group.addEventListener('click', (e) => { e.stopPropagation(); if (!isDragging) showDetail(node); });
      group.addEventListener('mouseenter', () => { if (!dragTarget) highlightConnections(node.id); });
      group.addEventListener('mouseleave', () => { if (!dragTarget) clearHighlight(); });
      group.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const svgRect = svg.getBoundingClientRect();
        const mouseX = (e.clientX - svgRect.left - transform.x) / transform.scale;
        const mouseY = (e.clientY - svgRect.top - transform.y) / transform.scale;
        dragTarget = {
          nodeId: node.id,
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          offsetX: mouseX - node.x,
          offsetY: mouseY - node.y,
          hasMoved: false,
          group: group,
          node: node,
        };
      });

      // Background rect
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', node.width);
      rect.setAttribute('height', node.height);
      let rectClass = 'node-rect node-rect--' + (node.type || 'content');
      if (node.isStartNode) rectClass += ' node-rect--start-node';
      rect.setAttribute('class', rectClass);
      rect.dataset.nodeId = node.id;
      group.appendChild(rect);

      // Hub color strip on left edge
      if (node.hub) {
        const hubStrip = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        hubStrip.setAttribute('x', 0);
        hubStrip.setAttribute('y', 0);
        hubStrip.setAttribute('width', 3);
        hubStrip.setAttribute('height', node.height);
        hubStrip.setAttribute('fill', hubColor(node.hub));
        hubStrip.setAttribute('rx', '1');
        group.appendChild(hubStrip);
      }

      // Screenshot — full page by default, cropped thumbnail when thumbnailMode is on
      if (hasScreenshots && !hideScreenshots && node.screenshot) {
        const imgWidth = node.width - IMG_PAD * 2;
        const imgHeight = node.height - LABEL_AREA - IMG_PAD;
        const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        img.setAttribute('href', node.screenshot);
        img.setAttribute('x', IMG_PAD);
        img.setAttribute('y', IMG_PAD);
        img.setAttribute('width', imgWidth);
        img.setAttribute('height', imgHeight);
        // Full-page: fit entire screenshot without cropping
        // Thumbnail: crop to top portion only
        img.setAttribute('preserveAspectRatio', thumbnailMode ? 'xMidYMin slice' : 'xMidYMid meet');
        img.setAttribute('class', 'node-screenshot');
        // Clip to rounded rect
        const clipId = 'clip-' + node.id.replace(/[^a-zA-Z0-9]/g, '-');
        const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
        clipPath.setAttribute('id', clipId);
        const clipRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        clipRect.setAttribute('x', IMG_PAD);
        clipRect.setAttribute('y', IMG_PAD);
        clipRect.setAttribute('width', imgWidth);
        clipRect.setAttribute('height', imgHeight);
        clipRect.setAttribute('rx', '3');
        clipPath.appendChild(clipRect);
        defs.appendChild(clipPath);
        img.setAttribute('clip-path', 'url(#' + clipId + ')');
        group.appendChild(img);
      }

      // Title label
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', node.width / 2);
      label.setAttribute('y', (hasScreenshots && !hideScreenshots) ? node.height - 14 : 28);
      label.setAttribute('class', 'node-label');
      label.textContent = truncate(node.actualTitle || node.label, 20);
      group.appendChild(label);

      // Start node badge
      if (node.isStartNode) {
        const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        badge.setAttribute('x', node.width / 2);
        badge.setAttribute('y', -6);
        badge.setAttribute('text-anchor', 'middle');
        badge.setAttribute('class', 'start-node-badge');
        badge.textContent = 'START';
        group.appendChild(badge);
      }

      // Type badge (always visible)
      const typeBadge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      typeBadge.setAttribute('x', node.width / 2);
      typeBadge.setAttribute('y', (hasScreenshots && !hideScreenshots) ? node.height - 3 : 42);
      typeBadge.setAttribute('class', 'node-type-badge');
      typeBadge.textContent = (node.type || 'content').toUpperCase();
      group.appendChild(typeBadge);

      // URL path (small text) — only when screenshots are hidden or absent
      if (!hasScreenshots || hideScreenshots) {
        const pathLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        pathLabel.setAttribute('x', node.width / 2);
        pathLabel.setAttribute('y', 54);
        pathLabel.setAttribute('class', 'node-path-label');
        pathLabel.textContent = truncate(node.urlPath, 30);
        group.appendChild(pathLabel);
      }

      mainGroup.appendChild(group);
    });

    // Update node count
    document.getElementById('node-count').textContent =
      Object.keys(layoutNodes).length + ' pages, ' + layoutEdges.length + ' connections';

    // Populate hub filter
    const hubs = [...new Set(graph.nodes.map(n => n.hub).filter(Boolean))];
    const hubSelect = document.getElementById('hub-filter');
    if (hubSelect.options.length <= 1) {
      hubs.forEach(hub => {
        const opt = document.createElement('option');
        opt.value = hub;
        opt.textContent = hub;
        hubSelect.appendChild(opt);
      });
    }

    // Toggle toolbar buttons
    const showAllBtn = document.getElementById('show-all-btn');
    if (hiddenNodes.size > 0) {
      showAllBtn.style.display = '';
      showAllBtn.textContent = 'Show hidden (' + hiddenNodes.size + ')';
    } else {
      showAllBtn.style.display = 'none';
    }
    document.getElementById('toggle-screenshots').style.display = hasScreenshots ? '' : 'none';

    // Apply transform
    applyTransform();

    // Fit to screen on first render
    if (transform.x === 0 && transform.y === 0 && transform.scale === 1) {
      fitToScreen();
    }
  }

  // Show detail panel for a node
  function showDetail(node) {
    const panel = document.getElementById('detail-panel');
    const content = document.getElementById('panel-content');

    let html = '<h2>' + escapeHtml(node.label) + '</h2>';

    if (hasScreenshots && !hideScreenshots && node.screenshot) {
      html += '<img class="panel-screenshot" src="' + node.screenshot + '" alt="Screenshot of ' + escapeHtml(node.label) + '" />';
    }

    html += '<dl class="panel-meta">';
    html += '<dt>URL</dt><dd>' + escapeHtml(node.urlPath) + '</dd>';
    html += '<dt>File</dt><dd>' + escapeHtml(node.filePath || '–') + '</dd>';
    html += '<dt>Type</dt><dd>' + escapeHtml(node.type || '–') + '</dd>';
    if (node.hub) html += '<dt>Hub</dt><dd>' + escapeHtml(node.hub) + '</dd>';
    if (node.isStartNode) html += '<dt>Role</dt><dd>Start page (--from)</dd>';
    html += '</dl>';

    // Outgoing edges
    const outgoing = graph.edges.filter(e => e.source === node.id);
    if (outgoing.length > 0) {
      html += '<h3 style="margin-top:12px;font-size:13px;">Navigates to (' + outgoing.length + ')</h3>';
      html += '<ul class="panel-links">';
      outgoing.forEach(e => {
        html += '<li>';
        html += '<span class="link-target">' + escapeHtml(e.target) + '</span>';
        html += ' <span style="color:#666">(' + e.type + ')</span>';
        if (e.label) html += ' — ' + escapeHtml(e.label);
        if (e.condition) html += '<br><span class="link-condition">if ' + escapeHtml(e.condition) + '</span>';
        html += '</li>';
      });
      html += '</ul>';
    }

    // Incoming edges
    const incoming = graph.edges.filter(e => e.target === node.id);
    if (incoming.length > 0) {
      html += '<h3 style="margin-top:12px;font-size:13px;">Reached from (' + incoming.length + ')</h3>';
      html += '<ul class="panel-links">';
      incoming.forEach(e => {
        html += '<li>';
        html += '<span class="link-target">' + escapeHtml(e.source) + '</span>';
        html += ' <span style="color:#666">(' + e.type + ')</span>';
        if (e.condition) html += '<br><span class="link-condition">if ' + escapeHtml(e.condition) + '</span>';
        html += '</li>';
      });
      html += '</ul>';
    }

    html += '<button class="hide-node-btn" data-node-id="' + escapeHtml(node.id) + '" style="margin-top:12px;background:#3f1e1e;color:#ef4444;border:1px solid #8f2a2a;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;width:100%">Hide this page</button>';

    content.innerHTML = html;
    panel.classList.remove('hidden');

    // Highlight the node
    document.querySelectorAll('.node-rect--highlight').forEach(el => el.classList.remove('node-rect--highlight'));
    const nodeRect = document.querySelector('[data-node-id="' + CSS.escape(node.id) + '"]');
    if (nodeRect) nodeRect.classList.add('node-rect--highlight');
  }

  window.closePanel = function() {
    document.getElementById('detail-panel').classList.add('hidden');
    document.querySelectorAll('.node-rect--highlight').forEach(el => el.classList.remove('node-rect--highlight'));
  };

  // Pan and zoom
  function applyTransform() {
    const mainGroup = document.getElementById('main-group');
    if (mainGroup) {
      mainGroup.setAttribute('transform',
        'translate(' + transform.x + ',' + transform.y + ') scale(' + transform.scale + ')'
      );
    }
  }

  svg.addEventListener('mousedown', (e) => {
    if (e.target.closest('.node-group')) return;
    isPanning = true;
    panStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    transform.x = e.clientX - panStart.x;
    transform.y = e.clientY - panStart.y;
    applyTransform();
  });

  window.addEventListener('mouseup', () => { isPanning = false; });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = svg.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const newScale = Math.min(Math.max(transform.scale * delta, 0.05), 3);
    const scaleChange = newScale / transform.scale;

    transform.x = mouseX - scaleChange * (mouseX - transform.x);
    transform.y = mouseY - scaleChange * (mouseY - transform.y);
    transform.scale = newScale;

    applyTransform();
  }, { passive: false });

  window.zoomIn = function() {
    transform.scale = Math.min(transform.scale * 1.2, 3);
    applyTransform();
  };

  window.zoomOut = function() {
    transform.scale = Math.max(transform.scale * 0.8, 0.05);
    applyTransform();
  };

  window.fitToScreen = function() {
    const mainGroup = document.getElementById('main-group');
    if (!mainGroup) return;

    // Temporarily reset transform to get true bounding box
    mainGroup.setAttribute('transform', 'translate(0,0) scale(1)');
    const bbox = mainGroup.getBBox();
    mainGroup.setAttribute('transform',
      'translate(' + transform.x + ',' + transform.y + ') scale(' + transform.scale + ')'
    );

    if (bbox.width === 0 || bbox.height === 0) return;

    const containerRect = container.getBoundingClientRect();
    const padding = 60;
    const scaleX = (containerRect.width - padding * 2) / bbox.width;
    const scaleY = (containerRect.height - padding * 2) / bbox.height;
    const newScale = Math.min(scaleX, scaleY, 1.5);

    transform.scale = newScale;
    transform.x = (containerRect.width / 2) - (bbox.x + bbox.width / 2) * newScale;
    transform.y = (containerRect.height / 2) - (bbox.y + bbox.height / 2) * newScale;

    applyTransform();
  };

  // Controls
  document.getElementById('toggle-labels').addEventListener('change', (e) => {
    showLabels = e.target.checked;
    render();
  });

  document.getElementById('hub-filter').addEventListener('change', (e) => {
    hubFilter = e.target.value;
    render();
  });

  let searchTimeout;
  document.getElementById('search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchTerm = e.target.value.toLowerCase();
      render();
    }, 250);
  });

  // Hover highlighting
  function highlightConnections(nodeId) {
    const connectedNodes = new Set([nodeId]);
    document.querySelectorAll('.edge-group').forEach(eg => {
      if (eg.dataset.source === nodeId || eg.dataset.target === nodeId) {
        eg.style.opacity = '1';
        connectedNodes.add(eg.dataset.source);
        connectedNodes.add(eg.dataset.target);
      } else {
        eg.style.opacity = '0.08';
      }
    });
    document.querySelectorAll('.node-group').forEach(ng => {
      const nId = ng.querySelector('.node-rect') && ng.querySelector('.node-rect').dataset.nodeId;
      ng.style.opacity = connectedNodes.has(nId) ? '1' : '0.2';
    });
  }

  function clearHighlight() {
    document.querySelectorAll('.edge-group').forEach(eg => { eg.style.opacity = ''; });
    document.querySelectorAll('.node-group').forEach(ng => { ng.style.opacity = ''; });
  }

  // Thumbnail / full-page toggle
  window.toggleThumbnail = function() {
    thumbnailMode = !thumbnailMode;
    try { localStorage.setItem(viewModeKey, thumbnailMode ? 'thumbnail' : 'full'); } catch(e) {}
    document.getElementById('toggle-thumbnail').textContent = thumbnailMode ? 'Show full pages' : 'Show thumbnails';
    render();
  };

  // Hide/show nodes
  window.hideNode = function(nodeId) {
    hiddenNodes.add(nodeId);
    saveHiddenNodes();
    closePanel();
    render();
  };

  window.showAllNodes = function() {
    hiddenNodes.clear();
    saveHiddenNodes();
    render();
  };

  // Toggle screenshot visibility
  window.toggleScreenshots = function() {
    hideScreenshots = !hideScreenshots;
    document.getElementById('toggle-screenshots').textContent =
      hideScreenshots ? 'Show screenshots' : 'Hide screenshots';
    render();
  };

  // Reset manual positions
  window.resetPositions = function() {
    manualPositions = {};
    savePositions();
    render();
  };

  // Edge geometry helpers

  // Build a straight SVG path string from two points.
  function buildOrthogonalPath(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) return 'M ' + points[0].x + ' ' + points[0].y;
    const p0 = points[0], p1 = points[points.length - 1];
    return 'M ' + p0.x + ' ' + p0.y + ' L ' + p1.x + ' ' + p1.y;
  }


  // Returns the point on the border of a rectangle (cx, cy, w, h) that lies
  // on the straight line towards (targetX, targetY).
  function getEdgePoint(cx, cy, w, h, targetX, targetY) {
    const dx = targetX - cx;
    const dy = targetY - cy;
    const hw = w / 2;
    const hh = h / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (absDx * hh > absDy * hw) {
      const sign = dx > 0 ? 1 : -1;
      return { x: cx + sign * hw, y: cy + (dy * hw) / absDx };
    } else {
      const sign = dy > 0 ? 1 : -1;
      return { x: cx + (dx * hh) / absDy, y: cy + sign * hh };
    }
  }

  // Straight border-to-border line (used for manually repositioned nodes).
  function computeStraightEdge(sourceId, targetId) {
    const s = layoutNodes[sourceId];
    const t = layoutNodes[targetId];
    if (!s || !t) return [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    return [
      getEdgePoint(s.x, s.y, s.width, s.height, t.x, t.y),
      getEdgePoint(t.x, t.y, t.width, t.height, s.x, s.y),
    ];
  }



  function updateConnectedEdges(nodeId) {
    document.querySelectorAll('.edge-group').forEach(eg => {
      if (eg.dataset.source !== nodeId && eg.dataset.target !== nodeId) return;
      const pts = computeStraightEdge(eg.dataset.source, eg.dataset.target);
      const d = 'M ' + pts[0].x + ' ' + pts[0].y + ' L ' + pts[1].x + ' ' + pts[1].y;
      const path = eg.querySelector('.edge-path');
      if (path) path.setAttribute('d', d);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const lbl = eg.querySelector('.edge-label');
      if (lbl) { lbl.setAttribute('x', midX); lbl.setAttribute('y', midY - 6); }
      const cLbl = eg.querySelector('.edge-condition-label');
      if (cLbl) { cLbl.setAttribute('x', midX); cLbl.setAttribute('y', midY + 10); }
    });
  }

  // Drag-to-reposition: global mouse handlers
  window.addEventListener('mousemove', (e) => {
    if (!dragTarget) return;
    const dx = e.clientX - dragTarget.startMouseX;
    const dy = e.clientY - dragTarget.startMouseY;
    if (!dragTarget.hasMoved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    dragTarget.hasMoved = true;
    isDragging = true;

    const svgRect = svg.getBoundingClientRect();
    const mouseX = (e.clientX - svgRect.left - transform.x) / transform.scale;
    const mouseY = (e.clientY - svgRect.top - transform.y) / transform.scale;
    const newX = mouseX - dragTarget.offsetX;
    const newY = mouseY - dragTarget.offsetY;

    dragTarget.node.x = newX;
    dragTarget.node.y = newY;
    dragTarget.group.setAttribute('transform',
      'translate(' + (newX - dragTarget.node.width/2) + ',' + (newY - dragTarget.node.height/2) + ')'
    );
    updateConnectedEdges(dragTarget.nodeId);
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragTarget) return;
    if (dragTarget.hasMoved) {
      manualPositions[dragTarget.nodeId] = { x: dragTarget.node.x, y: dragTarget.node.y };
      savePositions();
      setTimeout(() => { isDragging = false; }, 0);
    }
    dragTarget = null;
  });

  // Delegated click handler for hide button in detail panel
  document.addEventListener('click', function(e) {
    if (e.target.classList.contains('hide-node-btn')) {
      hideNode(e.target.dataset.nodeId);
    }
  });

  // Helpers
  function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max) + '…' : str;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hubColor(hub) {
    const colors = ['#53d8fb', '#f97316', '#a855f7', '#ec4899', '#14b8a6', '#eab308', '#6366f1', '#ef4444', '#22c55e'];
    let hash = 0;
    for (let i = 0; i < hub.length; i++) hash = hub.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  // Show screenshot-related toggles only when screenshots are present
  if (hasScreenshots) {
    const btn = document.getElementById('toggle-thumbnail');
    btn.style.display = '';
    btn.textContent = thumbnailMode ? 'Show full pages' : 'Show thumbnails';
    document.getElementById('toggle-screenshots').style.display = '';
  }

  // Initial render
  render();
})();
`;
}

module.exports = { buildViewer };
