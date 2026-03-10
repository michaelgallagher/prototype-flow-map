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

const DEFAULT_IGNORED_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "_",
  "cacheBust",
  "timestamp",
  "ts",
]);

const ASSET_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".json",
  ".xml",
  ".txt",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".zip",
]);

const INTERNAL_PATH_PREFIXES = [
  "/assets/",
  "/public/",
  "/dist/",
  "/build/",
  "/scripts/",
  "/styles/",
  "/images/",
  "/fonts/",
  "/favicon",
  "/api/",
  "/prototype-admin/",
  "/_includes/",
  "/_templates/",
];

const DEFAULT_CANONICALIZATION_OPTIONS = {
  collapseNumericSegments: true,
  collapseUuidSegments: true,
  collapseDateSegments: true,
  collapseTemplateExpressions: true,
  sortQueryParams: true,
  dropIgnoredQueryParams: true,
};

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
 * Decide whether a path is a likely application route we should include in the graph.
 * This is intentionally conservative: it blocks obvious assets/framework internals but
 * allows normal-looking app paths through for later canonicalization.
 */
function isProbablyAppRoute(urlPath) {
  if (!urlPath) return false;
  if (typeof urlPath !== "string") return false;

  const trimmed = urlPath.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return false;
  if (/^(javascript:|mailto:|tel:|data:)/i.test(trimmed)) return false;

  const normalized = normalizeUrlPath(trimmed, {
    collapseNumericSegments: false,
    collapseUuidSegments: false,
    collapseDateSegments: false,
    collapseTemplateExpressions: false,
    sortQueryParams: false,
    dropIgnoredQueryParams: false,
  });

  if (!normalized.startsWith("/")) return false;

  if (INTERNAL_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }

  const pathname = normalized.split("?")[0];

  if (pathname === "/") return true;

  const lowerPath = pathname.toLowerCase();
  for (const ext of ASSET_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) return false;
  }

  return true;
}

/**
 * Phase 2 canonicalization:
 * - strips fragments
 * - collapses duplicate slashes
 * - normalizes trailing slash (except root)
 * - sorts query params
 * - drops common ignored query params
 * - canonicalizes template expressions, numeric IDs, UUIDs, and date-like segments
 */
function normalizeUrlPath(urlPath, options = DEFAULT_CANONICALIZATION_OPTIONS) {
  if (!urlPath) return "/";

  const opts = {
    ...DEFAULT_CANONICALIZATION_OPTIONS,
    ...options,
  };

  let normalized = String(urlPath).trim();

  try {
    if (/^https?:\/\//i.test(normalized)) {
      const absolute = new URL(normalized);
      normalized = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    }
  } catch {
    // Keep original string if absolute URL parsing fails.
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

  const rawSegments = pathname.split("/");
  const canonicalSegments = rawSegments.map((segment, index) => {
    if (index === 0 || !segment) return segment;
    return canonicalizePathSegment(segment, opts);
  });

  pathname = canonicalSegments.join("/") || "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.replace(/\/+$/, "");
  }

  let params = Array.from(parsed.searchParams.entries());

  if (opts.dropIgnoredQueryParams) {
    params = params.filter(
      ([key]) => !DEFAULT_IGNORED_QUERY_PARAMS.has(String(key).trim()),
    );
  }

  if (opts.sortQueryParams) {
    params.sort(([a], [b]) => a.localeCompare(b));
  }

  const canonicalParams = params.map(([key, value]) => [
    key,
    canonicalizeQueryValue(value, opts),
  ]);

  const sortedSearch = new URLSearchParams(canonicalParams).toString();

  return `${pathname}${sortedSearch ? `?${sortedSearch}` : ""}`;
}

function canonicalizePathSegment(segment, options) {
  const decoded = safeDecodeURIComponent(segment).trim();
  if (!decoded) return segment;

  if (
    options.collapseTemplateExpressions &&
    containsTemplateExpression(decoded)
  ) {
    return canonicalTemplateSegment(decoded);
  }

  if (options.collapseUuidSegments && isUuidLike(decoded)) {
    return ":uuid";
  }

  if (options.collapseDateSegments && isDateLike(decoded)) {
    return ":date";
  }

  if (options.collapseNumericSegments && isNumericId(decoded)) {
    return ":id";
  }

  return decoded;
}

function canonicalizeQueryValue(value, options) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return trimmed;

  if (
    options.collapseTemplateExpressions &&
    containsTemplateExpression(trimmed)
  ) {
    return ":param";
  }

  if (options.collapseUuidSegments && isUuidLike(trimmed)) {
    return ":uuid";
  }

  if (options.collapseDateSegments && isDateLike(trimmed)) {
    return ":date";
  }

  if (options.collapseNumericSegments && isNumericId(trimmed)) {
    return ":id";
  }

  return trimmed;
}

function containsTemplateExpression(value) {
  return /\{\{.*?\}\}|\{%.*?%\}/.test(value);
}

function canonicalTemplateSegment(value) {
  const trimmed = value.trim();

  const tokens = Array.from(trimmed.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)).map(
    (match) => match[1].trim(),
  );

  if (tokens.length === 1) {
    return `:${templateTokenToParamName(tokens[0])}`;
  }

  if (tokens.length > 1) {
    return tokens
      .map((token) => `:${templateTokenToParamName(token)}`)
      .join("-");
  }

  return ":param";
}

function templateTokenToParamName(token) {
  const cleaned = String(token || "")
    .replace(/\bor\b.*$/i, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();

  const parts = cleaned.split(/[.\s|/-]+/).filter(Boolean);
  const last = parts[parts.length - 1] || "param";
  const safe = last.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();

  if (!safe) return "param";
  if (safe === "id") return "id";
  return safe;
}

function isNumericId(value) {
  return /^\d+$/.test(value);
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isDateLike(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) ||
    /^\d{2}-\d{2}-\d{4}$/.test(value) ||
    /^\d{4}\/\d{2}\/\d{2}$/.test(value)
  );
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  const nodes = [];
  const edges = [];
  const nodeMap = new Map();

  const explicitPostHandlers = new Map();
  for (const route of explicitRoutes) {
    if (route.method === "POST" && !route.isCatchAll) {
      explicitPostHandlers.set(normalizeUrlPath(route.path), route);
    }
  }

  const hasCatchAllPost = explicitRoutes.some((r) => r.isCatchAll);

  for (const tpl of templateData) {
    if (!isProbablyAppRoute(tpl.urlPath)) continue;
    if (!matchesBasePaths(tpl.urlPath, basePath)) continue;

    const normalizedUrlPath = normalizeUrlPath(tpl.urlPath);
    if (!isProbablyAppRoute(normalizedUrlPath)) continue;

    const node = {
      id: normalizedUrlPath,
      label: tpl.pageTitle || normalizedUrlPath.split("/").pop() || "Home",
      urlPath: normalizedUrlPath,
      hub: tpl.hub || null,
      filePath: tpl.relativePath,
      screenshot: null,
      type: categoriseNode(tpl),
      rawUrlPath: tpl.urlPath,
      canonicalUrlPath: normalizedUrlPath,
    };

    if (!nodeMap.has(normalizedUrlPath)) {
      nodes.push(node);
      nodeMap.set(normalizedUrlPath, node);
    }
  }

  for (const tpl of templateData) {
    if (!isProbablyAppRoute(tpl.urlPath)) continue;
    if (!matchesBasePaths(tpl.urlPath, basePath)) continue;

    const source = normalizeUrlPath(tpl.urlPath);
    if (!isProbablyAppRoute(source)) continue;

    for (const link of tpl.links) {
      const target = normalizeUrlPath(link.target);
      if (!isProbablyAppRoute(target)) continue;

      addEdge(edges, source, target, {
        type: "link",
        label: link.label || "",
        provenance: "static",
      });
    }

    for (const form of tpl.formActions) {
      const canonicalTarget = normalizeUrlPath(form.target);
      if (!isProbablyAppRoute(canonicalTarget)) continue;

      const target = resolveFormTarget(
        canonicalTarget,
        form.method,
        explicitPostHandlers,
        hasCatchAllPost,
      );

      if (!isProbablyAppRoute(target)) continue;

      addEdge(edges, source, target, {
        type: "form",
        label: form.label || "Submit",
        method: form.method,
        provenance: "static",
      });
    }

    for (const cond of tpl.conditionalLinks) {
      const rawTarget =
        cond.type === "form"
          ? resolveFormTarget(
              normalizeUrlPath(cond.target),
              cond.method || "POST",
              explicitPostHandlers,
              hasCatchAllPost,
            )
          : normalizeUrlPath(cond.target);

      if (!isProbablyAppRoute(rawTarget)) continue;

      addEdge(edges, source, rawTarget, {
        type: "conditional",
        label: cond.label || "",
        condition: cond.condition,
        method: cond.method,
        provenance: "static",
      });
    }

    for (const redirect of tpl.jsRedirects) {
      const target = normalizeUrlPath(redirect.target);
      if (!isProbablyAppRoute(target)) continue;

      addEdge(edges, source, target, {
        type: "redirect",
        label: redirect.label || "Redirect",
        provenance: "static",
      });
    }
  }

  for (const route of explicitRoutes) {
    if (route.isCatchAll) continue;
    if (!isProbablyAppRoute(route.path)) continue;

    const source = normalizeUrlPath(route.path);
    if (!isProbablyAppRoute(source)) continue;

    for (const redirect of route.redirects) {
      const target = normalizeUrlPath(redirect);
      if (!isProbablyAppRoute(target)) continue;

      addEdge(edges, source, target, {
        type: "redirect",
        label: `${route.method} handler → redirect`,
        method: route.method,
        provenance: "static",
      });
    }

    for (const render of route.renders) {
      const target = normalizeUrlPath(render);
      if (!isProbablyAppRoute(target)) continue;

      addEdge(edges, source, target, {
        type: "render",
        label: `${route.method} handler → render`,
        method: route.method,
        provenance: "static",
      });
    }
  }

  for (const runtimeEdge of runtimeEdges) {
    if (!runtimeEdge || !runtimeEdge.from || !runtimeEdge.to) continue;
    if (!isProbablyAppRoute(runtimeEdge.from)) continue;
    if (!isProbablyAppRoute(runtimeEdge.to)) continue;

    const source = normalizeUrlPath(runtimeEdge.from);
    const target = normalizeUrlPath(runtimeEdge.to);

    if (!isProbablyAppRoute(source) || !isProbablyAppRoute(target)) continue;

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
      navigationCategory:
        runtimeEdge.navigationCategory ||
        classifyRuntimeNavigation(runtimeEdge.label, source, target),
      rawSource: runtimeEdge.from,
      rawTarget: runtimeEdge.to,
    });
  }

  for (const edge of edges) {
    ensureNode(nodeMap, nodes, edge.source);
    ensureNode(nodeMap, nodes, edge.target);
  }

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
  const normalizedActionPath = normalizeUrlPath(actionPath);

  if (
    String(method || "").toUpperCase() === "POST" &&
    explicitPostHandlers.has(normalizedActionPath)
  ) {
    return normalizedActionPath;
  }

  if (String(method || "").toUpperCase() === "POST" && hasCatchAllPost) {
    return normalizedActionPath;
  }

  return normalizedActionPath;
}

function addEdge(edges, source, target, metadata) {
  source = normalizeUrlPath(source);
  target = normalizeUrlPath(target);

  if (!isProbablyAppRoute(source) || !isProbablyAppRoute(target)) return;

  if (source === target && metadata.type !== "conditional") return;

  edges.push({
    source,
    target,
    navigationCategory:
      metadata.navigationCategory ||
      classifyRuntimeNavigation(metadata.label, source, target),
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

    if (!existing.navigationCategory && edge.navigationCategory) {
      existing.navigationCategory = edge.navigationCategory;
    }

    if (!existing.rawSource && edge.rawSource) {
      existing.rawSource = edge.rawSource;
    }

    if (!existing.rawTarget && edge.rawTarget) {
      existing.rawTarget = edge.rawTarget;
    }

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
  if (!isProbablyAppRoute(normalized)) return;
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
    rawUrlPath: urlPath,
    canonicalUrlPath: normalized,
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
 */
function filterByExclusion(graph, exclude) {
  if (!exclude) return graph;

  const patterns = exclude
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (patterns.length === 0) return graph;

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

  const adj = buildAdjacency(graph);
  const subtree = collectReachable([...excludeRootIds], adj);

  const reverseAdj = {};
  graph.edges.forEach((e) => {
    if (!FORWARD_EDGE_TYPES.has(e.type)) return;
    if (!reverseAdj[e.target]) reverseAdj[e.target] = [];
    reverseAdj[e.target].push(e.source);
  });

  const removable = new Set();
  let changed = true;

  while (changed) {
    changed = false;

    for (const nodeId of subtree) {
      if (removable.has(nodeId)) continue;

      const incoming = reverseAdj[nodeId] || [];

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
  const routePath = tpl.urlPath || "";

  if (routePath === "/" || routePath === "/index") return "start";
  if (tpl.hub) return "hub";
  if (tpl.formActions && tpl.formActions.length > 0) return "form";
  if (tpl.links && tpl.links.length > 3) return "hub";
  return "page";
}

function classifyRuntimeNavigation(label, source, target) {
  const text = String(label || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!text) return "journey";

  if (
    text.includes("accessibility") ||
    text.includes("terms and conditions") ||
    text.includes("contact us") ||
    text === "log out"
  ) {
    return "utility";
  }

  if (
    text === "home" ||
    text === "settings" ||
    text === "reports" ||
    text === "screening" ||
    text === "image reading"
  ) {
    return "global-nav";
  }

  if (source === "/" && target === "/start") {
    return "entry";
  }

  return "journey";
}

module.exports = {
  buildGraph,
  filterByExclusion,
  filterByReachability,
  normalizeUrlPath,
  isProbablyAppRoute,
};
