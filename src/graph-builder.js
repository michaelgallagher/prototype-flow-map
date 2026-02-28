const { minimatch } = require("minimatch");

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
    if (
      !matchesBasePaths(tpl.urlPath, basePath) ||
      matchesExclude(tpl.urlPath, exclude)
    ) {
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
    if (
      !matchesBasePaths(tpl.urlPath, basePath) ||
      matchesExclude(tpl.urlPath, exclude)
    ) {
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

    // Back link (dashed edge)
    if (tpl.backLink) {
      addEdge(edges, tpl.urlPath, tpl.backLink, {
        type: "back",
        label: "Back",
      });
    }
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

  // Identify the main user flows (form chains leading to confirmation/check-answers)
  computeMainFlow(nodes, uniqueEdges);

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
 * Identify "main flow" chains — sequences of form submissions
 * that progress from questions through to confirmation/check-answers pages.
 * Tags matching nodes and edges with isMainFlow: true.
 */
function computeMainFlow(nodes, edges) {
  const nodeMap = {};
  nodes.forEach((n) => {
    nodeMap[n.id] = n;
  });

  // Build adjacency list of forward-progression edges (form + redirect)
  const forwardAdj = {};
  edges.forEach((e) => {
    if (e.type === "form" || e.type === "redirect") {
      if (!forwardAdj[e.source]) forwardAdj[e.source] = [];
      forwardAdj[e.source].push(e);
    }
  });

  const terminalTypes = new Set(["confirmation", "check-answers"]);

  // DFS to find the longest chain from a start node to a terminal node
  function findChain(startId, visited) {
    if (visited.has(startId)) return [];
    visited.add(startId);
    const outEdges = forwardAdj[startId] || [];
    let bestChain = [];
    for (const edge of outEdges) {
      const targetNode = nodeMap[edge.target];
      if (!targetNode) continue;
      if (terminalTypes.has(targetNode.type)) {
        return [edge]; // reached a terminal
      }
      const sub = findChain(edge.target, new Set(visited));
      if (sub.length > 0 && sub.length + 1 > bestChain.length) {
        bestChain = [edge, ...sub];
      }
    }
    return bestChain;
  }

  // Find chains starting from question nodes that have outgoing form edges
  const mainFlowEdgeKeys = new Set();
  const mainFlowNodeIds = new Set();

  const starters = nodes.filter(
    (n) => n.type === "question" && (forwardAdj[n.id] || []).length > 0,
  );

  starters.forEach((starter) => {
    const chain = findChain(starter.id, new Set());
    if (chain.length >= 2) {
      // At least 2 form steps = a meaningful user flow
      mainFlowNodeIds.add(starter.id);
      chain.forEach((e) => {
        mainFlowEdgeKeys.add(`${e.source}|${e.target}|${e.type}`);
        mainFlowNodeIds.add(e.source);
        mainFlowNodeIds.add(e.target);
      });
    }
  });

  // Tag nodes and edges
  nodes.forEach((n) => {
    n.isMainFlow = mainFlowNodeIds.has(n.id);
  });
  edges.forEach((e) => {
    e.isMainFlow = mainFlowEdgeKeys.has(`${e.source}|${e.target}|${e.type}`);
  });
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
 * Filter a graph to only nodes reachable from a given starting page,
 * following forward navigation edges (not back-links).
 * This lets you scope a flow that doesn't share a URL prefix.
 */
function filterByReachability(graph, fromPage) {
  if (!fromPage) return graph;

  const startNode = graph.nodes.find(
    (n) => n.id === fromPage || n.urlPath === fromPage,
  );

  if (!startNode) {
    console.warn(
      `⚠️  Warning: --from page "${fromPage}" not found in graph — showing full graph`,
    );
    return graph;
  }

  // Build adjacency list following forward edges only (not back-links)
  const forwardEdgeTypes = new Set(["form", "link", "redirect", "conditional", "render"]);
  const adj = {};
  graph.edges.forEach((e) => {
    if (!forwardEdgeTypes.has(e.type)) return;
    if (!adj[e.source]) adj[e.source] = [];
    adj[e.source].push(e.target);
  });

  // BFS from start node
  const reachable = new Set();
  const queue = [fromPage];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    (adj[current] || []).forEach((target) => {
      if (!reachable.has(target)) queue.push(target);
    });
  }

  return {
    nodes: graph.nodes.filter((n) => reachable.has(n.id)),
    edges: graph.edges.filter(
      (e) => reachable.has(e.source) && reachable.has(e.target),
    ),
  };
}

module.exports = { buildGraph, filterByReachability };
