const fs = require("fs");
const path = require("path");

/**
 * Build a self-contained HTML viewer for the flow map.
 * Outputs a single index.html with embedded JS that renders
 * an interactive, zoomable, pannable flow diagram.
 */
async function buildViewer(graph, outputDir, hasScreenshots) {
  fs.mkdirSync(outputDir, { recursive: true });

  // Write graph data as JSON
  const dataPath = path.join(outputDir, "graph-data.json");
  fs.writeFileSync(dataPath, JSON.stringify(graph, null, 2));

  // Write the HTML viewer
  const htmlPath = path.join(outputDir, "index.html");
  fs.writeFileSync(htmlPath, generateViewerHtml(graph, hasScreenshots));

  // Write the CSS
  const cssPath = path.join(outputDir, "styles.css");
  fs.writeFileSync(cssPath, generateViewerCss());

  // Write the JS
  const jsPath = path.join(outputDir, "viewer.js");
  fs.writeFileSync(jsPath, generateViewerJs());
}

function generateViewerHtml(graph, hasScreenshots) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prototype Flow Map</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="toolbar">
    <h1>Prototype Flow Map</h1>
    <div class="toolbar-controls">
      <span id="node-count"></span>
      <button onclick="zoomIn()">Zoom +</button>
      <button onclick="zoomOut()">Zoom −</button>
      <button onclick="resetView()">Reset view</button>
      <button onclick="fitToScreen()">Fit to screen</button>
      <label><input type="checkbox" id="toggle-back-links" checked> Show back links</label>
      <label><input type="checkbox" id="toggle-labels" checked> Show labels</label>
      <select id="hub-filter">
        <option value="">All hubs</option>
      </select>
      <input type="text" id="search" placeholder="Search pages..." />
    </div>
  </div>
  <div id="canvas-container">
    <svg id="flow-svg"></svg>
  </div>
  <div id="detail-panel" class="hidden">
    <button id="close-panel" onclick="closePanel()">✕</button>
    <div id="panel-content"></div>
  </div>
  <script>
    window.__GRAPH_DATA__ = ${JSON.stringify(graph)};
    window.__HAS_SCREENSHOTS__ = ${hasScreenshots ? "true" : "false"};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></script>
  <script src="viewer.js"></script>
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
.node-group { cursor: pointer; }
.node-group:hover .node-rect { stroke: #53d8fb; stroke-width: 2; }

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
  stroke-width: 1.5;
}

.edge-path--link       { stroke: #4a6fa5; }
.edge-path--form       { stroke: #5aaf6a; }
.edge-path--conditional { stroke: #e8a838; stroke-dasharray: 6,3; }
.edge-path--redirect   { stroke: #aa55cc; stroke-dasharray: 3,3; }
.edge-path--back       { stroke: #555; stroke-dasharray: 4,4; }
.edge-path--render     { stroke: #aa55cc; }

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

.edge-arrowhead { fill: #4a6fa5; }
.edge-arrowhead--form { fill: #5aaf6a; }
.edge-arrowhead--conditional { fill: #e8a838; }
.edge-arrowhead--redirect { fill: #aa55cc; }
.edge-arrowhead--back { fill: #555; }

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
  let showBackLinks = true;
  let showLabels = true;
  let hubFilter = '';
  let searchTerm = '';

  // Layout the graph using dagre
  function layoutGraph() {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: 'TB',
      nodesep: 60,
      ranksep: 100,
      edgesep: 30,
      marginx: 40,
      marginy: 40,
    });
    g.setDefaultEdgeLabel(() => ({}));

    const NODE_WIDTH = 200;
    const NODE_HEIGHT = hasScreenshots ? 200 : 70;

    const filteredNodes = graph.nodes.filter(n => {
      if (hubFilter && n.hub !== hubFilter) return false;
      if (searchTerm && !n.label.toLowerCase().includes(searchTerm) && !n.urlPath.toLowerCase().includes(searchTerm)) return false;
      return true;
    });

    const filteredNodeIds = new Set(filteredNodes.map(n => n.id));

    filteredNodes.forEach(node => {
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT, ...node });
    });

    const filteredEdges = graph.edges.filter(e => {
      if (!filteredNodeIds.has(e.source) || !filteredNodeIds.has(e.target)) return false;
      if (!showBackLinks && e.type === 'back') return false;
      return true;
    });

    filteredEdges.forEach((edge, i) => {
      g.setEdge(edge.source, edge.target, { ...edge, id: 'edge-' + i });
    });

    dagre.layout(g);

    layoutNodes = {};
    g.nodes().forEach(id => {
      layoutNodes[id] = g.node(id);
    });

    layoutEdges = [];
    g.edges().forEach(e => {
      const edgeData = g.edge(e);
      layoutEdges.push({
        ...edgeData,
        source: e.v,
        target: e.w,
        points: edgeData.points,
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
    ['link', 'form', 'conditional', 'redirect', 'back'].forEach(type => {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrow-' + type);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '10');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '8');
      marker.setAttribute('markerHeight', '8');
      marker.setAttribute('orient', 'auto-start-reverse');
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

    // Render edges
    layoutEdges.forEach(edge => {
      const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');

      // Build path from points
      const points = edge.points;
      let d = 'M ' + points[0].x + ' ' + points[0].y;
      for (let i = 1; i < points.length; i++) {
        d += ' L ' + points[i].x + ' ' + points[i].y;
      }

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'edge-path edge-path--' + (edge.type || 'link'));
      path.setAttribute('marker-end', 'url(#arrow-' + (edge.type || 'link') + ')');
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
      group.addEventListener('click', () => showDetail(node));

      // Background rect
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', node.width);
      rect.setAttribute('height', node.height);
      rect.setAttribute('class', 'node-rect node-rect--' + (node.type || 'content'));
      rect.dataset.nodeId = node.id;
      group.appendChild(rect);

      // Screenshot thumbnail
      if (hasScreenshots && node.screenshot) {
        const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        img.setAttribute('href', node.screenshot);
        img.setAttribute('x', '4');
        img.setAttribute('y', '4');
        img.setAttribute('width', node.width - 8);
        img.setAttribute('height', node.height - 36);
        img.setAttribute('preserveAspectRatio', 'xMidYMin slice');
        img.setAttribute('class', 'node-screenshot');
        // Clip to rounded rect
        const clipId = 'clip-' + node.id.replace(/[^a-zA-Z0-9]/g, '-');
        const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
        clipPath.setAttribute('id', clipId);
        const clipRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        clipRect.setAttribute('x', '4');
        clipRect.setAttribute('y', '4');
        clipRect.setAttribute('width', node.width - 8);
        clipRect.setAttribute('height', node.height - 36);
        clipRect.setAttribute('rx', '4');
        clipPath.appendChild(clipRect);
        defs.appendChild(clipPath);
        img.setAttribute('clip-path', 'url(#' + clipId + ')');
        group.appendChild(img);
      }

      // Type badge
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      badge.setAttribute('x', node.width / 2);
      badge.setAttribute('y', hasScreenshots ? node.height - 20 : 16);
      badge.setAttribute('class', 'node-type-badge');
      badge.textContent = node.type || '';
      group.appendChild(badge);

      // Title label
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', node.width / 2);
      label.setAttribute('y', hasScreenshots ? node.height - 8 : 34);
      label.setAttribute('class', 'node-label');
      label.textContent = truncate(node.label, 28);
      group.appendChild(label);

      // URL path (small text)
      if (!hasScreenshots) {
        const pathLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        pathLabel.setAttribute('x', node.width / 2);
        pathLabel.setAttribute('y', 50);
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

    if (hasScreenshots && node.screenshot) {
      html += '<img class="panel-screenshot" src="' + node.screenshot + '" alt="Screenshot of ' + escapeHtml(node.label) + '" />';
    }

    html += '<dl class="panel-meta">';
    html += '<dt>URL</dt><dd>' + escapeHtml(node.urlPath) + '</dd>';
    html += '<dt>File</dt><dd>' + escapeHtml(node.filePath || '–') + '</dd>';
    html += '<dt>Type</dt><dd>' + escapeHtml(node.type || '–') + '</dd>';
    if (node.hub) html += '<dt>Hub</dt><dd>' + escapeHtml(node.hub) + '</dd>';
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

  window.resetView = function() {
    transform = { x: 0, y: 0, scale: 1 };
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
  document.getElementById('toggle-back-links').addEventListener('change', (e) => {
    showBackLinks = e.target.checked;
    render();
  });

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

  // Helpers
  function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max) + '…' : str;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Initial render
  render();
})();
`;
}

module.exports = { buildViewer };
