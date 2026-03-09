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
 * Minimal Phase 1 URL normalization for runtime/static edge keying.
 * Conservative by design:
 * - strips fragments
 * - collapses duplicate slashes
 * - normalizes trailing slash (except root)
 * - sorts query params if present
 *
 * This intentionally does NOT canonicalize IDs or drop query params yet.
 */
function normalizeUrlPath(urlPath) {
  if (!urlPath) return "/";

  let normalized = String(urlPath).trim();

  // If an absolute URL slips through, normalize to pathname/search/hash first
  try {
    if (/^https?:\/\//i.test(normalized)) {
      const absolute = new URL(normalized);
      normalized = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    }
  } catch {
    // keep original string if URL parsing fails
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  let parsed;
  try {
    parsed = new URL(normalized, "http://runtime-local");
  } catch {
    return normalized;
  }

  let pathname = parsed.pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.replace(/\/+$/, "");
  }
  if (!pathname) pathname = "/";

  const params = Array.from(parsed.searchParams.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const sortedSearch = new URLSearchParams(params).toString();

  return `${pathname}${sortedSearch ? `?${sortedSearch}` : ""}`;
}

/**
 * Build a directed graph from parsed template data and route handlers.
 *
 * Nodes = pages (screens)
 * Edges = navigation links between pages
 */
function buildGraph(
  templateData,
  explicitRoutes,
  basePath,
  exclude,
  runtimeEdges = [],
) {
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

    const normalizedUrlPath = normalizeUrlPath(tpl.urlPath);
    const node = {
      id: normalizedUrlPath,
      label: tpl.pageTitle || normalizedUrlPath.split("/").pop() || "Home",
      urlPath: normalizedUrlPath,
      hub: tpl.hub || null,
      filePath: tpl.relativePath,
      screenshot: null,
      type: categoriseNode(tpl),
    };

    nodes.push(node);
    nodeMap.set(normalizedUrlPath, node);
  }

  // Step 2: Create edges from links, forms, conditionals, and JS redirects
  for (const tpl of templateData) {
    if (!matchesBasePaths(tpl.urlPath, basePath)) {
      continue;
    }

    const source = normalizeUrlPath(tpl.urlPath);

    // Regular links
    for (const link of tpl.links) {
      addEdge(edges, source, normalizeUrlPath(link.target), {
        type: "link",
        label: link.label || "",
        provenance: "static",
      });
    }

    // Form actions
    for (const form of tpl.formActions) {
      const target = resolveFormTarget(
        normalizeUrlPath(form.target),
        form.method,
        explicitPostHandlers,
        hasCatchAllPost,
      );
      addEdge(edges, source, target, {
        type: "form",
        label: form.label || "Submit",
        method: form.method,
        provenance: "static",
      });
    }

    // Conditional links and forms
    for (const cond of tpl.conditionalLinks) {
      const target =
        cond.type === "form"
          ? resolveFormTarget(
              normalizeUrlPath(cond.target),
              cond.method || "POST",
              explicitPostHandlers,
              hasCatchAllPost,
            )
          : normalizeUrlPath(cond.target);

      addEdge(edges, source, target, {
        type: "conditional",
        label: cond.label || "",
        condition: cond.condition,
        method: cond.method,
        provenance: "static",
      });
    }

    // JS redirects
    for (const redirect of tpl.jsRedirects) {
      addEdge(edges, source, normalizeUrlPath(redirect.target), {
        type: "redirect",
        label: redirect.label || "Redirect",
        provenance: "static",
      });
    }

    // Back links are intentionally omitted — the forward edge to a page
    // already implies the user can navigate back.
  }

  // Step 3: Add edges from explicit route handlers
  for (const route of explicitRoutes) {
    if (route.isCatchAll) continue;
    const source = normalizeUrlPath(route.path);

    for (const redirect of route.redirects) {
      addEdge(edges, source, normalizeUrlPath(redirect), {
        type: "redirect",
        label: `${route.method} handler → redirect`,
        method: route.method,
        provenance: "static",
      });
    }
    for (const render of route.renders) {
      addEdge(edges, source, normalizeUrlPath(render), {
        type: "render",
        label: `${route.method} handler → render`,
        method: route.method,
        provenance: "static",
      });
    }
  }

  // Step 4: Merge runtime-discovered edges
  for (const runtimeEdge of runtimeEdges) {
    if (!runtimeEdge || !runtimeEdge.from || !runtimeEdge.to) continue;

    const source = normalizeUrlPath(runtimeEdge.from);
    const target = normalizeUrlPath(runtimeEdge.to);

    if (
      !matchesBasePaths(source, basePath) ||
      !matchesBasePaths(target, basePath)
    ) {
      continue;
    }

    addEdge(edges, source, target, {
      type: runtimeEdge.kind === "form" ? "form" : "link",
      label: runtimeEdge.label || "",
      method: runtimeEdge.method,
      provenance: "runtime",
      sourceKind: runtimeEdge.kind || "anchor",
    });
  }

  // Ensure runtime-only nodes are represented
  for (const edge of edges) {
    ensureNode(nodeMap, nodes, edge.source);
    ensureNode(nodeMap, nodes, edge.target);
  }

  // Deduplicate edges with provenance-aware merge
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
  source = normalizeUrlPath(source);
  target = normalizeUrlPath(target);

  // Don't add self-loops unless they're meaningful
  if (source === target && metadata.type !== "conditional") return;

  edges.push({
    source,
    target,
    ...metadata,
  });
}

function deduplicateEdges(edges) {
  const merged = new Map();

  for (const edge of edges) {
    const key = edgeKey(edge);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...edge });
      continue;
    }

    existing.provenance = mergeProvenance(existing.provenance, edge.provenance);

    if (!existing.label && edge.label) {
      existing.label = edge.label;
    }

    if (!existing.method && edge.method) {
      existing.method = edge.method;
    }

    if (!existing.condition && edge.condition) {
      existing.condition = edge.condition;
    }

    if (!existing.sourceKind && edge.sourceKind) {
      existing.sourceKind = edge.sourceKind;
    }

    // Preserve explicit signal for older viewer/debugging compatibility
    existing.discoveredByCrawler =
      Boolean(existing.discoveredByCrawler) || edge.provenance === "runtime";
  }

  return Array.from(merged.values());
}

function edgeKey(edge) {
  return [
    normalizeUrlPath(edge.source),
    normalizeUrlPath(edge.target),
    edge.type || "",
    edge.method || "",
    edge.condition || "",
  ].join("|");
}

function mergeProvenance(a = "static", b = "static") {
  if (a === b) return a;
  if (a === "both" || b === "both") return "both";
  return "both";
}

function ensureNode(nodeMap, nodes, urlPath) {
  const normalized = normalizeUrlPath(urlPath);
  if (nodeMap.has(normalized)) return;

  const label =
    normalized === "/"
      ? "Home"
      : normalized.split("/").filter(Boolean).pop() || "Home";

  const node = {
    id: normalized,
    label,
    urlPath: normalized,
    hub: null,
    filePath: null,
    screenshot: null,
    type: "page",
  };

  nodeMap.set(normalized, node);
  nodes.push(node);
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
  const removable = new Set();

  let changed = true;
  while (changed) {
    changed = false;

    for (const nodeId of subtree) {
      if (removable.has(nodeId)) continue;

      const incoming = reverseAdj[nodeId] || [];

      // Exclude roots are always removable by definition
      if (excludeRootIds.has(nodeId)) {
        removable.add(nodeId);
        changed = true;
        continue;
      }

      const hasOutsideIncoming = incoming.some(
        (src) => !subtree.has(src) || !removable.has(src),
      );

      if (!hasOutsideIncoming) {
        removable.add(nodeId);
        changed = true;
      }
    }
  }

  const filteredNodes = graph.nodes.filter((n) => !removable.has(n.id));
  const keptNodeIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = graph.edges.filter(
    (e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target),
  );

  return { nodes: filteredNodes, edges: filteredEdges };
}

/**
 * Keep only nodes reachable from the given comma-separated starting pages.
 */
function filterByReachability(graph, from) {
  if (!from) return graph;

  const startIds = from
    .split(",")
    .map((p) => normalizeUrlPath(p.trim()))
    .filter(Boolean);

  if (startIds.length === 0) return graph;

  const adj = buildAdjacency(graph);
  const reachable = collectReachable(startIds, adj);

  const filteredNodes = graph.nodes.filter((n) => reachable.has(n.id));
  const keptNodeIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = graph.edges.filter(
    (e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target),
  );

  return { nodes: filteredNodes, edges: filteredEdges };
}

function categoriseNode(tpl) {
  const path = tpl.urlPath || "";

  if (path === "/" || path === "/index") return "start";
  if (tpl.hub) return "hub";
  if (tpl.formActions && tpl.formActions.length > 0) return "form";
  if (tpl.links && tpl.links.length > 3) return "hub";
  return "page";
}

module.exports = {
  buildGraph,
  filterByExclusion,
  filterByReachability,
  normalizeUrlPath,
};
