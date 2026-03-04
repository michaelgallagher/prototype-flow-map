const { minimatch } = require("minimatch");

/**
 * The set of edge types that represent meaningful forward navigation.
 * Used consistently by both filterByReachability and filterByExclusion.
 */
const FORWARD_EDGE_TYPES = new Set([
  "form",
  "link",
  "redirect",
  "conditional",
  "render",
]);

/**
 * Check if a URL path matches any of the comma-separated base path patterns.
 * Supports prefixes and glob patterns (e.g. "/pages/gp,/pages/booking" or "/pages/gp-*").
 */
function matchesBasePaths(urlPath, basePath) {
  if (!basePath) return true;

  const patterns = basePath
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  return patterns.some((pattern) => {
    if (/[*?[\{]/.test(pattern)) {
      return minimatch(urlPath, pattern);
    }
    return urlPath.startsWith(pattern);
  });
}

/**
 * Check if a URL path matches any of the comma-separated exclude patterns.
 * For non-glob patterns, uses exact match or prefix+/ match
 * (so --exclude /pages/test excludes /pages/test/step-1 but not /pages/testing).
 */
function matchesExclude(urlPath, exclude) {
  if (!exclude) return false;

  const patterns = exclude
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  return patterns.some((pattern) => {
    if (/[*?[\{]/.test(pattern)) {
      return minimatch(urlPath, pattern);
    }
    return urlPath === pattern || urlPath.startsWith(pattern + "/");
  });
}

/**
 * Build a directed graph from parsed template data and route handlers.
 *
 * Nodes = pages (screens)
 * Edges = navigation links between pages
 */
function buildGraph(templateData, explicitRoutes, basePath, exclude) {
  // We intentionally do NOT filter nodes by `exclude` at build time any more.
  // The graph is built in full so that filterByExclusion can later perform a
  // proper subtree-aware prune (removing excluded roots AND any nodes that are
  // only reachable through them). matchesExclude is still used below to skip
  // creating nodes/edges for paths that match file-path prefixes, but the
  // semantic "exclude this page and its children" logic lives in
  // filterByExclusion, which is called in index.js after the graph is built.
  const nodes = [];
  const edges = [];
  const nodeMap = new Map(); // urlPath -> node

  // Track which POST routes have explicit handlers
  const explicitPostHandlers = new Map();
  for (const route of explicitRoutes) {
    if (route.method === "POST" && !route.isCatchAll) {
      explicitPostHandlers.set(route.path, route);
    }
  }

  // Check if the catch-all POST→GET redirect exists
  const hasCatchAllPost = explicitRoutes.some((r) => r.isCatchAll);

  // Step 1: Create nodes for each template
  for (const tpl of templateData) {
    if (!matchesBasePaths(tpl.urlPath, basePath)) {
      continue;
    }

    const node = {
      id: tpl.urlPath,
      label: tpl.pageTitle || tpl.urlPath.split("/").pop() || "Home",
      urlPath: tpl.urlPath,
      hub: tpl.hub || null,
      filePath: tpl.relativePath,
      screenshot: null,
      type: categoriseNode(tpl),
    };

    nodes.push(node);
    nodeMap.set(tpl.urlPath, node);
  }

  // Step 2: Create edges from links, forms, conditionals, and JS redirects
  for (const tpl of templateData) {
    if (!matchesBasePaths(tpl.urlPath, basePath)) {
      continue;
    }

    // Regular links
    for (const link of tpl.links) {
      addEdge(edges, tpl.urlPath, link.target, {
        type: "link",
        label: link.label || "",
      });
    }

    // Form actions
    for (const form of tpl.formActions) {
      const target = resolveFormTarget(
        form.target,
        form.method,
        explicitPostHandlers,
        hasCatchAllPost,
      );
      addEdge(edges, tpl.urlPath, target, {
        type: "form",
        label: form.label || "Submit",
        method: form.method,
      });
    }

    // Conditional links and forms
    for (const cond of tpl.conditionalLinks) {
      const target =
        cond.type === "form"
          ? resolveFormTarget(
              cond.target,
              cond.method || "POST",
              explicitPostHandlers,
              hasCatchAllPost,
            )
          : cond.target;

      addEdge(edges, tpl.urlPath, target, {
        type: "conditional",
        label: cond.label || "",
        condition: cond.condition,
        method: cond.method,
      });
    }

    // JS redirects
    for (const redirect of tpl.jsRedirects) {
      addEdge(edges, tpl.urlPath, redirect.target, {
        type: "redirect",
        label: redirect.label || "Redirect",
      });
    }

    // Back links are intentionally omitted — the forward edge to a page
    // already implies the user can navigate back.
  }

  // Step 3: Add edges from explicit route handlers
  for (const route of explicitRoutes) {
    if (route.isCatchAll) continue;
    for (const redirect of route.redirects) {
      addEdge(edges, route.path, redirect, {
        type: "redirect",
        label: `${route.method} handler → redirect`,
        method: route.method,
      });
    }
    for (const render of route.renders) {
      addEdge(edges, route.path, render, {
        type: "render",
        label: `${route.method} handler → render`,
        method: route.method,
      });
    }
  }

  // Deduplicate edges
  const uniqueEdges = deduplicateEdges(edges);

  return { nodes, edges: uniqueEdges };
}

/**
 * Resolve where a form POST actually goes.
 * In the NHS prototype kit, POSTs without explicit handlers
 * get redirected to a GET at the same path (auto-store-data pattern).
 */
function resolveFormTarget(
  actionPath,
  method,
  explicitPostHandlers,
  hasCatchAllPost,
) {
  if (method === "POST" && explicitPostHandlers.has(actionPath)) {
    // There's an explicit handler — it may redirect somewhere else
    // but we'll handle that via the explicit routes edges
    return actionPath;
  }

  // With catch-all POST→GET, form POSTs redirect to the same path as a GET
  // which means the page at that path is rendered
  if (method === "POST" && hasCatchAllPost) {
    return actionPath;
  }

  return actionPath;
}

function addEdge(edges, source, target, metadata) {
  // Don't add self-loops unless they're meaningful
  if (source === target && metadata.type !== "conditional") return;

  edges.push({
    source,
    target,
    ...metadata,
  });
}

function deduplicateEdges(edges) {
  const seen = new Set();
  return edges.filter((edge) => {
    const key = `${edge.source}|${edge.target}|${edge.type}|${edge.condition || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build a forward-edge adjacency list from a graph.
 */
function buildAdjacency(graph) {
  const adj = {};
  graph.edges.forEach((e) => {
    if (!FORWARD_EDGE_TYPES.has(e.type)) return;
    if (!adj[e.source]) adj[e.source] = [];
    adj[e.source].push(e.target);
  });
  return adj;
}

/**
 * Collect all node IDs reachable from `startIds` via forward edges (BFS).
 */
function collectReachable(startIds, adj) {
  const reachable = new Set();
  const queue = [...startIds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    (adj[current] || []).forEach((target) => {
      if (!reachable.has(target)) queue.push(target);
    });
  }
  return reachable;
}

/**
 * Remove excluded pages and any descendants that have no other route into them.
 *
 * Algorithm:
 *  1. Find all "exclude root" nodes whose urlPath matches the --exclude patterns.
 *  2. BFS forward from those roots to collect the full candidate subtree.
 *  3. For each node in the subtree, check whether it has any incoming forward
 *     edge from a node that is NOT itself in the subtree. If it does, the node
 *     is reachable via another path and is kept. If every incoming edge comes
 *     from inside the subtree (or from an excluded root), it is removed.
 *  4. Edges whose source or target has been removed are also dropped.
 *
 * This means that a shared page (e.g. a common confirmation screen) that is
 * also linked from outside the excluded subtree will be preserved.
 */
function filterByExclusion(graph, exclude) {
  if (!exclude) return graph;

  const patterns = exclude
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (patterns.length === 0) return graph;

  // Step 1: find all nodes that are exclude roots
  const excludeRootIds = new Set(
    graph.nodes
      .filter((n) => matchesExclude(n.urlPath, exclude))
      .map((n) => n.id),
  );

  if (excludeRootIds.size === 0) {
    patterns.forEach((p) =>
      console.warn(`⚠️  Warning: --exclude pattern "${p}" matched no pages`),
    );
    return graph;
  }

  // Step 2: BFS forward from exclude roots to find the full candidate subtree
  const adj = buildAdjacency(graph);
  const subtree = collectReachable([...excludeRootIds], adj);

  // Step 3: build a reverse adjacency so we can check incoming edges
  const reverseAdj = {};
  graph.edges.forEach((e) => {
    if (!FORWARD_EDGE_TYPES.has(e.type)) return;
    if (!reverseAdj[e.target]) reverseAdj[e.target] = [];
    reverseAdj[e.target].push(e.source);
  });

  // A node in the subtree is removable only if ALL of its incoming forward
  // edges originate from within the subtree itself (i.e. no outside entry point).
  // Exclude roots are always removed regardless of incoming edges.
  const toRemove = new Set();

  for (const nodeId of subtree) {
    if (excludeRootIds.has(nodeId)) {
      toRemove.add(nodeId);
      continue;
    }
    const incomers = reverseAdj[nodeId] || [];
    const hasOutsideIncomer = incomers.some((src) => !subtree.has(src));
    if (!hasOutsideIncomer) {
      toRemove.add(nodeId);
    }
  }

  const keptNodes = graph.nodes.filter((n) => !toRemove.has(n.id));
  const keptEdges = graph.edges.filter(
    (e) => !toRemove.has(e.source) && !toRemove.has(e.target),
  );

  const removedCount = toRemove.size;
  const rootList = [...excludeRootIds].join(", ");
  console.log(`   Excluded ${removedCount} node(s) rooted at: ${rootList}`);

  return { nodes: keptNodes, edges: keptEdges };
}

function categoriseNode(tpl) {
  if (tpl.urlPath === "/" || tpl.urlPath.endsWith("/index")) return "index";
  if (tpl.extendsLayout === "layout-app-splash-screen.html") return "splash";
  if (tpl.pageTitle && /confirm/i.test(tpl.pageTitle)) return "confirmation";
  if (tpl.pageTitle && /error/i.test(tpl.pageTitle)) return "error";
  if (tpl.pageTitle && /check/i.test(tpl.pageTitle)) return "check-answers";

  // Has forms = question page
  if (
    tpl.formActions.length > 0 ||
    tpl.conditionalLinks.some((l) => l.type === "form")
  ) {
    return "question";
  }

  return "content";
}

/**
 * Filter a graph to only nodes reachable from one or more starting pages,
 * following forward navigation edges (not back-links).
 * Accepts a comma-separated string of start pages.
 * When multiple start pages are given, synthetic "nav" edges connect them
 * so they appear related in the viewer.
 */
function filterByReachability(graph, fromPages) {
  if (!fromPages) return graph;

  const startPageIds = [
    ...new Set(
      fromPages
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];

  if (startPageIds.length === 0) return graph;

  // Resolve each start page to a graph node
  const validStartNodes = [];
  for (const pageId of startPageIds) {
    const node = graph.nodes.find(
      (n) => n.id === pageId || n.urlPath === pageId,
    );
    if (!node) {
      console.warn(
        `⚠️  Warning: --from page "${pageId}" not found in graph — skipping`,
      );
    } else {
      validStartNodes.push(node);
    }
  }

  if (validStartNodes.length === 0) {
    console.warn(
      `⚠️  Warning: none of the --from pages were found in graph — showing full graph`,
    );
    return graph;
  }

  // Build adjacency list and BFS from all valid start nodes
  const adj = buildAdjacency(graph);
  const reachable = collectReachable(
    validStartNodes.map((n) => n.id),
    adj,
  );

  // Filter nodes and edges to reachable set
  const filteredNodes = graph.nodes.filter((n) => reachable.has(n.id));
  const filteredEdges = graph.edges.filter(
    (e) => reachable.has(e.source) && reachable.has(e.target),
  );

  // Mark start nodes and preserve --from order for the viewer
  const startNodeOrder = new Map(validStartNodes.map((n, i) => [n.id, i]));
  filteredNodes.forEach((n) => {
    if (startNodeOrder.has(n.id)) {
      n.isStartNode = true;
      n.startOrder = startNodeOrder.get(n.id);
    }
  });

  // Add synthetic "nav" edges between start pages (all-to-all, bidirectional)
  if (validStartNodes.length > 1) {
    for (let i = 0; i < validStartNodes.length; i++) {
      for (let j = i + 1; j < validStartNodes.length; j++) {
        const a = validStartNodes[i].id;
        const b = validStartNodes[j].id;
        filteredEdges.push({
          source: a,
          target: b,
          type: "nav",
          label: "Global nav",
        });
        filteredEdges.push({
          source: b,
          target: a,
          type: "nav",
          label: "Global nav",
        });
      }
    }
  }

  return { nodes: filteredNodes, edges: filteredEdges };
}

module.exports = { buildGraph, filterByExclusion, filterByReachability };
