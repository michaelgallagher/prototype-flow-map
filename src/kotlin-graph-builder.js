const { toLabel, canonicalizeRoute } = require("./kotlin-parser");

/**
 * Build a directed graph from parsed Kotlin/Compose navigation data.
 *
 * Nodes = Composable screens + external web destinations
 * Edges = navigation connections between them
 *
 * Edge types:
 *   "link"    — navController.navigate() push navigation
 *   "tab"     — bottom navigation bar tab
 *   "modal"   — slideIntoContainer(Up) modal-style transition
 *   "safari"  — external browser link (openTab)
 */
function buildKotlinGraph(parsedScreens) {
  const nodes = [];
  const edges = [];
  const nodeMap = new Map(); // route -> node

  // Index screens by route for lookup
  const screenByRoute = new Map();
  for (const screen of parsedScreens) {
    screenByRoute.set(screen.route, screen);
  }

  // --- Pass 1: create nodes for all registered screens ---
  for (const screen of parsedScreens) {
    if (nodeMap.has(screen.route)) continue;

    const node = {
      id: screen.route,
      label: toLabel(screen.composableName),
      urlPath: screen.route,
      rawRoute: screen.rawRoute || screen.route,
      hub: null,
      filePath: screen.relativePath || null,
      screenshot: null,
      type: "screen",
    };
    nodes.push(node);
    nodeMap.set(screen.route, node);
  }

  // --- Pass 2: create edges from navigate() calls ---
  for (const screen of parsedScreens) {
    for (const { targetRoute } of screen.navigations) {
      const canonTarget = canonicalizeRoute(targetRoute);

      // Create target node if it doesn't exist (navigate to unregistered route)
      if (!nodeMap.has(canonTarget)) {
        const targetScreen = screenByRoute.get(canonTarget);
        const node = {
          id: canonTarget,
          label: targetScreen ? toLabel(targetScreen.composableName) : routeToLabel(canonTarget),
          urlPath: canonTarget,
          hub: null,
          filePath: targetScreen?.relativePath || null,
          screenshot: null,
          type: "screen",
        };
        nodes.push(node);
        nodeMap.set(canonTarget, node);
      }

      // Check if target is a modal transition
      const targetScreen = screenByRoute.get(canonTarget);
      const edgeType = targetScreen?.isModal ? "modal" : "link";
      addEdge(edges, screen.route, canonTarget, { type: edgeType, label: "" });
    }

    // External links
    for (const { url, label } of screen.externalLinks) {
      if (!nodeMap.has(url)) {
        const webNode = {
          id: url,
          label: label || summariseUrl(url),
          urlPath: url,
          hub: null,
          filePath: null,
          screenshot: null,
          type: "external",
        };
        nodes.push(webNode);
        nodeMap.set(url, webNode);
      }
      addEdge(edges, screen.route, url, {
        type: "safari",
        label: label || summariseUrl(url),
      });
    }

    // Bottom nav items → tab edges
    for (const { route: tabRoute, label } of screen.bottomNavItems) {
      const canonTab = canonicalizeRoute(tabRoute);
      if (!nodeMap.has(canonTab)) continue; // skip if tab route not registered
      addEdge(edges, screen.route, canonTab, { type: "tab", label: label || "" });
    }
  }

  // --- Pass 3: add lateral edges between bottom nav siblings ---
  const tabScreens = parsedScreens.filter((s) => s.bottomNavItems.length > 0);
  for (const host of tabScreens) {
    const tabRoutes = host.bottomNavItems
      .map((item) => canonicalizeRoute(item.route))
      .filter((r) => nodeMap.has(r));

    if (tabRoutes.length < 2) continue;
    for (let i = 0; i < tabRoutes.length; i++) {
      for (let j = i + 1; j < tabRoutes.length; j++) {
        addEdge(edges, tabRoutes[i], tabRoutes[j], { type: "tab", label: "" });
        addEdge(edges, tabRoutes[j], tabRoutes[i], { type: "tab", label: "" });
      }
    }
  }

  // --- Pass 4: assign layout ranks ---
  const uniqueEdges = deduplicateEdges(edges);
  assignLayoutRanks(nodes, uniqueEdges, parsedScreens);

  return { nodes, edges: uniqueEdges };
}

/**
 * Shorten a URL to a readable label.
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

/**
 * Convert a route string to a human-readable label.
 * "bookAppointmentMenu" → "Book Appointment Menu"
 */
function routeToLabel(route) {
  return route
    .replace(/[_-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
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
 * Use DFS to find back-edges in a directed graph (edges that form cycles).
 * Returns a Set of "source|target" keys for back-edges.
 */
function findBackEdges(edges, nodeIds) {
  const adj = new Map();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    adj.get(e.source).push(e.target);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of nodeIds) color.set(id, WHITE);
  const backEdges = new Set();

  function dfs(u) {
    color.set(u, GRAY);
    for (const v of (adj.get(u) || [])) {
      if (color.get(v) === GRAY) {
        backEdges.add(`${u}|${v}`);
      } else if (color.get(v) === WHITE) {
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const id of nodeIds) {
    if (color.get(id) === WHITE) dfs(id);
  }

  return backEdges;
}

/**
 * Assign layoutRank to each node via BFS from root nodes.
 * Tab siblings share the same rank.
 * Back-edges (navigation cycles back to earlier screens) are excluded
 * so cycle entry points are correctly identified as roots.
 */
function assignLayoutRanks(nodes, edges, parsedScreens) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Build tab sibling pairs to exclude from rank computation.
  // Only lateral sibling↔sibling pairs are excluded, NOT host→sibling edges.
  // This ensures the host screen's direct navigate() calls to tabs still
  // contribute to rank (e.g. home → messages should make messages rank 1).
  const tabSiblingPairs = new Set();
  for (const screen of parsedScreens) {
    if (screen.bottomNavItems.length < 2) continue;
    const host = screen.route;
    const tabRoutes = screen.bottomNavItems
      .map((item) => canonicalizeRoute(item.route))
      .filter((r) => nodeIds.has(r) && r !== host); // exclude the host itself
    for (let i = 0; i < tabRoutes.length; i++) {
      for (let j = i + 1; j < tabRoutes.length; j++) {
        tabSiblingPairs.add(`${tabRoutes[i]}|${tabRoutes[j]}`);
        tabSiblingPairs.add(`${tabRoutes[j]}|${tabRoutes[i]}`);
      }
    }
  }

  // Rank edges = non-tab-sibling edges between known nodes
  const rankEdges = edges.filter(
    (e) =>
      nodeIds.has(e.source) &&
      nodeIds.has(e.target) &&
      !tabSiblingPairs.has(`${e.source}|${e.target}`)
  );

  // Detect back-edges so cycles don't inflate in-degrees of entry nodes
  const backEdges = findBackEdges(rankEdges, nodeIds);

  const children = new Map();
  const inDegree = new Map();
  for (const id of nodeIds) {
    children.set(id, []);
    inDegree.set(id, 0);
  }

  for (const e of rankEdges) {
    if (backEdges.has(`${e.source}|${e.target}`)) continue;
    children.get(e.source).push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
  }

  // Find roots (nodes with no incoming non-back, non-tab-sibling edges)
  const roots = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) roots.push(id);
  }

  // BFS — track visited edges to prevent re-processing in remaining cycles
  const rankOf = new Map();
  const queue = [];
  const visitedEdges = new Set();

  for (const r of roots) {
    rankOf.set(r, 0);
    queue.push(r);
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentRank = rankOf.get(current);
    for (const child of children.get(current) || []) {
      const edgeKey = `${current}|${child}`;
      if (visitedEdges.has(edgeKey)) continue;
      visitedEdges.add(edgeKey);

      const existingRank = rankOf.get(child);
      const newRank = currentRank + 1;
      if (existingRank === undefined || newRank > existingRank) {
        rankOf.set(child, newRank);
        queue.push(child);
      }
    }
  }

  // Force tab siblings (non-host) to share the same rank
  for (const screen of parsedScreens) {
    if (screen.bottomNavItems.length < 2) continue;
    const host = screen.route;
    const tabRoutes = screen.bottomNavItems
      .map((item) => canonicalizeRoute(item.route))
      .filter((r) => rankOf.has(r) && r !== host);
    if (tabRoutes.length === 0) continue;
    const sharedRank = Math.min(...tabRoutes.map((r) => rankOf.get(r)));
    for (const r of tabRoutes) {
      rankOf.set(r, sharedRank);
    }
  }

  // Apply ranks
  for (const [id, rank] of rankOf) {
    const node = nodeById.get(id);
    if (node) node.layoutRank = rank;
  }
}

module.exports = { buildKotlinGraph };
