const fs = require("fs");
const path = require("path");

function exportMural(graph, outputDir) {
  const muralDir = path.join(outputDir, "mural");
  fs.mkdirSync(muralDir, { recursive: true });

  const nodeLayout = computeLayout(graph);

  const nodesCsv = buildNodesCsv(graph);
  fs.writeFileSync(path.join(muralDir, "nodes.csv"), nodesCsv);

  const edgesCsv = buildEdgesCsv(graph);
  fs.writeFileSync(path.join(muralDir, "edges.csv"), edgesCsv);

  const svg = buildSvg(graph, nodeLayout);
  fs.writeFileSync(path.join(muralDir, "map.svg"), svg);

  const readme = buildReadme();
  fs.writeFileSync(path.join(muralDir, "README.txt"), readme);
}

function buildNodesCsv(graph) {
  const header = [
    "id",
    "title",
    "urlPath",
    "type",
    "hub",
    "isMainFlow",
    "screenshot",
  ];
  const rows = graph.nodes.map((node) => [
    node.id,
    node.label || "",
    node.urlPath || "",
    node.type || "",
    node.hub || "",
    node.isMainFlow ? "true" : "false",
    node.screenshot || "",
  ]);

  return [header, ...rows].map(toCsvLine).join("\n") + "\n";
}

function buildEdgesCsv(graph) {
  const header = [
    "source",
    "target",
    "type",
    "label",
    "condition",
    "isMainFlow",
  ];
  const rows = graph.edges.map((edge) => [
    edge.source,
    edge.target,
    edge.type || "",
    edge.label || "",
    edge.condition || "",
    edge.isMainFlow ? "true" : "false",
  ]);

  return [header, ...rows].map(toCsvLine).join("\n") + "\n";
}

function toCsvLine(values) {
  return values
    .map((value) => {
      const str = String(value == null ? "" : value);
      const escaped = str.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}

function computeLayout(graph) {
  const nodeMap = new Map();
  graph.nodes.forEach((node) => {
    nodeMap.set(node.id, node);
  });

  const adjacency = new Map();
  const incoming = new Map();

  graph.nodes.forEach((node) => {
    adjacency.set(node.id, []);
    incoming.set(node.id, 0);
  });

  graph.edges.forEach((edge) => {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) return;
    if (edge.source === edge.target) return;
    adjacency.get(edge.source).push(edge.target);
    incoming.set(edge.target, incoming.get(edge.target) + 1);
  });

  const queue = [];
  incoming.forEach((count, nodeId) => {
    if (count === 0) queue.push(nodeId);
  });
  queue.sort();

  const topoOrder = [];
  const inCopy = new Map(incoming);
  while (queue.length > 0) {
    const nodeId = queue.shift();
    topoOrder.push(nodeId);

    const next = adjacency.get(nodeId) || [];
    next.forEach((targetId) => {
      const nextIn = inCopy.get(targetId) - 1;
      inCopy.set(targetId, nextIn);
      if (nextIn === 0) {
        queue.push(targetId);
        queue.sort();
      }
    });
  }

  graph.nodes.forEach((node) => {
    if (!topoOrder.includes(node.id)) topoOrder.push(node.id);
  });

  const layerById = new Map();
  topoOrder.forEach((nodeId) => {
    const currentLayer = layerById.get(nodeId) || 0;
    const next = adjacency.get(nodeId) || [];
    next.forEach((targetId) => {
      const existing = layerById.get(targetId) || 0;
      if (existing < currentLayer + 1) {
        layerById.set(targetId, currentLayer + 1);
      }
    });
  });

  const nodesByLayer = new Map();
  graph.nodes.forEach((node) => {
    const layer = layerById.get(node.id) || 0;
    if (!nodesByLayer.has(layer)) nodesByLayer.set(layer, []);
    nodesByLayer.get(layer).push(node);
  });

  nodesByLayer.forEach((list) => {
    list.sort((a, b) => {
      const byMainFlow = Number(Boolean(b.isMainFlow)) - Number(Boolean(a.isMainFlow));
      if (byMainFlow !== 0) return byMainFlow;
      return (a.label || a.id).localeCompare(b.label || b.id);
    });
  });

  const nodeWidth = 260;
  const nodeHeight = 110;
  const xGap = 140;
  const yGap = 40;
  const leftPad = 60;
  const topPad = 60;

  const positioned = new Map();
  [...nodesByLayer.keys()]
    .sort((a, b) => a - b)
    .forEach((layer) => {
      const nodes = nodesByLayer.get(layer);
      nodes.forEach((node, index) => {
        const x = leftPad + layer * (nodeWidth + xGap);
        const y = topPad + index * (nodeHeight + yGap);
        positioned.set(node.id, {
          x,
          y,
          width: nodeWidth,
          height: nodeHeight,
        });
      });
    });

  return positioned;
}

function buildSvg(graph, nodeLayout) {
  const positions = [];
  nodeLayout.forEach((pos) => positions.push(pos));

  const maxX = positions.reduce((max, pos) => Math.max(max, pos.x + pos.width), 1200);
  const maxY = positions.reduce((max, pos) => Math.max(max, pos.y + pos.height), 800);

  const width = maxX + 80;
  const height = maxY + 80;

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  lines.push("<defs>");
  lines.push(
    '<marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L10,4 L0,8 z" fill="#6b7a90"/></marker>',
  );
  lines.push("</defs>");
  lines.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);

  graph.edges.forEach((edge) => {
    const source = nodeLayout.get(edge.source);
    const target = nodeLayout.get(edge.target);
    if (!source || !target) return;

    const x1 = source.x + source.width;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y + target.height / 2;

    const c1x = x1 + 40;
    const c1y = y1;
    const c2x = x2 - 40;
    const c2y = y2;

    const stroke = edge.isMainFlow ? "#37b24d" : "#6b7a90";
    const dash = edge.type === "conditional" ? ' stroke-dasharray="6 4"' : "";
    const widthPx = edge.isMainFlow ? 2.5 : 1.5;

    lines.push(
      `<path d="M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="${widthPx}" marker-end="url(#arrow)"${dash} />`,
    );
  });

  graph.nodes.forEach((node) => {
    const pos = nodeLayout.get(node.id);
    if (!pos) return;

    const fill = fillForNodeType(node.type);
    const stroke = node.isMainFlow ? "#2f9e44" : "#9aa5b1";
    const title = escapeXml(node.label || node.id);
    const pathText = escapeXml(node.urlPath || node.id);
    const typeText = escapeXml(node.type || "content");

    lines.push(
      `<rect x="${pos.x}" y="${pos.y}" width="${pos.width}" height="${pos.height}" rx="8" ry="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5" />`,
    );
    lines.push(
      `<text x="${pos.x + 12}" y="${pos.y + 28}" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#1f2933">${trimText(title, 34)}</text>`,
    );
    lines.push(
      `<text x="${pos.x + 12}" y="${pos.y + 50}" font-family="Arial, sans-serif" font-size="11" fill="#334e68">${trimText(pathText, 38)}</text>`,
    );
    lines.push(
      `<text x="${pos.x + 12}" y="${pos.y + 70}" font-family="Arial, sans-serif" font-size="10" fill="#627d98">${typeText}</text>`,
    );
  });

  lines.push("</svg>");
  return lines.join("\n") + "\n";
}

function fillForNodeType(type) {
  switch (type) {
    case "question":
      return "#e6f4ea";
    case "confirmation":
    case "check-answers":
      return "#eaf4ff";
    case "error":
      return "#fdecea";
    case "index":
      return "#f0f4f8";
    default:
      return "#f8fafc";
  }
}

function trimText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildReadme() {
  return [
    "Mural MVP export",
    "",
    "Files:",
    "- nodes.csv: node metadata from graph-data.json",
    "- edges.csv: edge metadata from graph-data.json",
    "- map.svg: ready-to-import visual map",
    "",
    "Suggested usage in Mural:",
    "1) Upload map.svg to quickly place the whole flow on a board.",
    "2) Optionally import nodes.csv as cards/stickies for editable objects.",
    "3) Use edges.csv as reference for connectors or relationship checks.",
    "",
    "This is an MVP export and does not create native Mural connectors automatically.",
    "",
  ].join("\n");
}

module.exports = { exportMural };