const { toLabel } = require("./swift-parser");
const path = require("path");

/**
 * Build a directed graph from parsed Swift view data.
 *
 * Nodes = SwiftUI screens + external web destinations
 * Edges = navigation connections between them
 *
 * Edge types:
 *   "link"        — push navigation (RowLink, NavigationLink)
 *   "sheet"       — .sheet() modal
 *   "full-screen" — .fullScreenCover()
 *   "tab"         — TabView tab
 *   "web-view"    — embedded web view (WKWebView)
 *   "safari"      — SFSafariViewController / external browser
 */
function buildSwiftGraph(parsedViews) {
  const nodes = [];
  const edges = [];
  const nodeMap = new Map(); // id -> node

  // --- Pass 1: collect all referenced view names ---
  const referencedViews = new Set();
  // Also track which views ARE sources (have navigation)
  const sourceViews = new Set();

  for (const view of parsedViews) {
    for (const { target } of view.pushLinks) referencedViews.add(target);
    for (const { target } of view.sheets) referencedViews.add(target);
    for (const { target } of view.fullScreenCovers) referencedViews.add(target);
    for (const { target } of view.tabChildren) referencedViews.add(target);
    for (const { target } of view.navigationDestinations) referencedViews.add(target);
    if (
      view.pushLinks.length > 0 ||
      view.sheets.length > 0 ||
      view.fullScreenCovers.length > 0 ||
      view.webLinks.length > 0 ||
      view.tabChildren.length > 0 ||
      view.navigationDestinations.length > 0
    ) {
      sourceViews.add(view.viewName);
    }
  }

  // --- Pass 2: create nodes for views that appear in the graph ---
  const viewByName = new Map(parsedViews.map((v) => [v.viewName, v]));

  const allViewNames = new Set([...sourceViews, ...referencedViews]);

  for (const viewName of allViewNames) {
    const parsed = viewByName.get(viewName);
    const label = parsed?.navigationTitle || toLabel(viewName);
    const node = {
      id: viewName,
      label,
      urlPath: viewName, // used by viewer for display
      hub: null,
      filePath: parsed?.relativePath || null,
      screenshot: null,
      type: "screen",
    };
    nodes.push(node);
    nodeMap.set(viewName, node);
  }

  // --- Pass 3: create edges ---
  for (const view of parsedViews) {
    const source = view.viewName;

    // Push navigation
    for (const { target, label } of view.pushLinks) {
      addEdge(edges, source, target, { type: "link", label: label || "" });
    }

    // Sheets
    for (const { target, triggerLabel } of view.sheets) {
      addEdge(edges, source, target, { type: "sheet", label: triggerLabel || toLabel(target) });
    }

    // Full-screen covers
    for (const { target, triggerLabel } of view.fullScreenCovers) {
      addEdge(edges, source, target, {
        type: "full-screen",
        label: triggerLabel || toLabel(target),
      });
    }

    // Tab children
    for (const { target, label } of view.tabChildren) {
      addEdge(edges, source, target, { type: "tab", label: label || "" });
    }

    // Programmatic navigation destinations
    for (const { target, label } of view.navigationDestinations) {
      addEdge(edges, source, target, {
        type: "link",
        label: label || "",
      });
    }

    // Web links
    for (const { url, label, mode } of view.webLinks) {
      const webNodeId = url;

      // Create the external node if it doesn't exist
      if (!nodeMap.has(webNodeId)) {
        const webNode = {
          id: webNodeId,
          label: label || summariseUrl(url),
          urlPath: url,
          hub: null,
          filePath: null,
          screenshot: null,
          type: mode === "safari" ? "external" : "web-view",
        };
        nodes.push(webNode);
        nodeMap.set(webNodeId, webNode);
      }

      const edgeType = mode === "safari" ? "safari" : "web-view";
      addEdge(edges, source, webNodeId, {
        type: edgeType,
        label: label || summariseUrl(url),
      });
    }
  }

  const uniqueEdges = deduplicateEdges(edges);
  return { nodes, edges: uniqueEdges };
}

/**
 * Shorten a URL to a readable label, e.g.:
 * "https://www.nhs.uk/nhs-app/help/" → "nhs.uk › nhs-app/help"
 */
function summariseUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const pathname = u.pathname.replace(/\/$/, "") || "";
    return pathname ? `${host} › ${pathname.replace(/^\//, "")}` : host;
  } catch {
    return url;
  }
}

function addEdge(edges, source, target, metadata) {
  if (source === target) return;
  edges.push({ source, target, ...metadata });
}

function deduplicateEdges(edges) {
  const seen = new Set();
  return edges.filter((e) => {
    const key = `${e.source}|${e.target}|${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { buildSwiftGraph };
