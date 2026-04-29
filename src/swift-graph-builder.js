const { toLabel } = require("./swift-parser");
const path = require("path");
const { assignSubgraphLayout } = require("./layout-ranks");

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

  // --- Pass 4: add lateral edges between tab siblings ---
  // In iOS, users can tap any tab from any other tab, so tab siblings
  // should have bidirectional edges showing top-level navigation paths.
  for (const view of parsedViews) {
    if (view.tabChildren.length < 2) continue;
    const tabTargets = view.tabChildren.map((t) => t.target);
    for (let i = 0; i < tabTargets.length; i++) {
      for (let j = i + 1; j < tabTargets.length; j++) {
        addEdge(edges, tabTargets[i], tabTargets[j], { type: "tab", label: "" });
        addEdge(edges, tabTargets[j], tabTargets[i], { type: "tab", label: "" });
      }
    }
  }

  // --- Pass 5: assign layout ranks and subgraph ownership ---
  const uniqueEdges = deduplicateEdges(edges);
  const tabHosts = findTabHosts(parsedViews, nodeMap);

  if (tabHosts.length > 0) {
    // Has explicit TabView structure → each tab target becomes a column start.
    // The TabView host itself is structural (no UI of its own) — remove it and
    // its edges from the graph so the tab targets become natural roots.
    if (tabHosts.length > 1) {
      console.warn(`[flow-map] Multiple TabView hosts detected; using first (${tabHosts[0].viewName})`);
    }
    const host = tabHosts[0];

    const primaryStarts = host.tabChildren
      .map(({ target }, idx) => ({ id: target, order: idx }))
      .filter((s) => nodeMap.has(s.id));

    const lateralEdgePairs = buildTabSiblingPairs(parsedViews);

    const structuralHostIds = new Set(tabHosts.map((h) => h.viewName));
    const finalNodes = nodes.filter((n) => !structuralHostIds.has(n.id));
    const finalEdges = uniqueEdges.filter(
      (e) => !structuralHostIds.has(e.source) && !structuralHostIds.has(e.target)
    );

    assignSubgraphLayout({ nodes: finalNodes, edges: finalEdges, primaryStarts, lateralEdgePairs });
    return { nodes: finalNodes, edges: finalEdges };
  }

  // No TabView detected → assign layoutRank only via simple BFS.
  // subgraphOwner is intentionally left unset so the virtual-inference pass
  // (step 3) can run on the resulting graph.
  assignLayoutRanksOnly(nodes, uniqueEdges, parsedViews);
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

/**
 * Returns views that own a TabView (i.e. have 2+ tab children that exist as nodes).
 */
function findTabHosts(parsedViews, nodeMap) {
  return parsedViews.filter(
    (v) => v.tabChildren.length >= 2 && v.tabChildren.some((t) => nodeMap.has(t.target))
  );
}

/**
 * Builds the set of lateral edge pairs (bidirectional tab-sibling relationships)
 * so the BFS excludes them from rank assignment.
 */
function buildTabSiblingPairs(parsedViews) {
  const pairs = new Set();
  for (const view of parsedViews) {
    if (view.tabChildren.length < 2) continue;
    const targets = view.tabChildren.map((t) => t.target);
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        pairs.add(`${targets[i]}|${targets[j]}`);
        pairs.add(`${targets[j]}|${targets[i]}`);
      }
    }
  }
  return pairs;
}

/**
 * Assigns layoutRank only (no subgraphOwner) via BFS from zero-in-degree roots.
 * Used when no TabView host is detected; subgraphOwner is left unset so the
 * virtual-inference pass can run later.
 */
function assignLayoutRanksOnly(nodes, edges, parsedViews) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const lateralEdgePairs = buildTabSiblingPairs(parsedViews);

  const children = new Map();
  const inDegree = new Map();
  for (const id of nodeIds) {
    children.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    if (lateralEdgePairs.has(`${e.source}|${e.target}`)) continue;
    children.get(e.source).push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
  }

  const rankOf = new Map();
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) { rankOf.set(id, 0); queue.push(id); }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentRank = rankOf.get(current);
    for (const child of children.get(current) || []) {
      const newRank = currentRank + 1;
      if (!rankOf.has(child) || newRank > rankOf.get(child)) {
        rankOf.set(child, newRank);
        queue.push(child);
      }
    }
  }

  for (const [id, rank] of rankOf) {
    const node = nodeById.get(id);
    if (node) node.layoutRank = rank;
  }
}

module.exports = { buildSwiftGraph };
