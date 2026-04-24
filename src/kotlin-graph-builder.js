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
      navArgs: screen.navArgs || [],
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
 * Assign layoutRank + subgraph ownership via per-owner multi-source BFS.
 *
 * Model: each "top-row" node (startDestination + its tab siblings) is a start
 * node and the root of its own subgraph. Every other node is claimed by the
 * nearest start (FIFO ties → lower startOrder wins), and its layoutRank is the
 * distance from its owner. Orphan roots (nodes with no incoming edges that
 * aren't reachable from any tab) each become their own start — they render as
 * additional columns to the right of the main tab columns.
 *
 * Tab-sibling edges (lateral) and back-edges (navigation cycles) are excluded
 * from the BFS so entry points aren't demoted and siblings stay co-ranked.
 *
 * Outputs on each node:
 *   - layoutRank:     distance from owner (0 for starts)
 *   - subgraphOwner:  id of the owning start
 *   - isStartNode:    true iff the node is a start
 *   - startOrder:     position in the left-to-right column ordering
 */
function assignLayoutRanks(nodes, edges, parsedScreens) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Identify the start destination + its tab siblings. These become columns.
  const startScreen = parsedScreens.find((s) => s.isStartDestination);
  const startRoute = startScreen ? startScreen.route : null;
  const primaryStarts = []; // [{ id, order }]
  if (startRoute && nodeIds.has(startRoute)) {
    const tabItems = startScreen.bottomNavItems || [];
    if (tabItems.length > 0) {
      // Use tab order from the nav bar.
      tabItems.forEach((item, idx) => {
        const r = canonicalizeRoute(item.route);
        if (nodeIds.has(r) && !primaryStarts.find((s) => s.id === r)) {
          primaryStarts.push({ id: r, order: idx });
        }
      });
      // Ensure startDestination is included even if not in its own nav bar
      if (!primaryStarts.find((s) => s.id === startRoute)) {
        primaryStarts.unshift({ id: startRoute, order: -1 });
        primaryStarts.forEach((s, i) => (s.order = i));
      }
    } else {
      primaryStarts.push({ id: startRoute, order: 0 });
    }
  }

  // Tab-sibling pairs (all pairs within the same bottomNavItems list).
  const tabSiblingPairs = new Set();
  for (const screen of parsedScreens) {
    if (screen.bottomNavItems.length < 2) continue;
    const tabRoutes = screen.bottomNavItems
      .map((item) => canonicalizeRoute(item.route))
      .filter((r) => nodeIds.has(r));
    for (let i = 0; i < tabRoutes.length; i++) {
      for (let j = i + 1; j < tabRoutes.length; j++) {
        tabSiblingPairs.add(`${tabRoutes[i]}|${tabRoutes[j]}`);
        tabSiblingPairs.add(`${tabRoutes[j]}|${tabRoutes[i]}`);
      }
    }
  }

  const rankEdges = edges.filter(
    (e) =>
      nodeIds.has(e.source) &&
      nodeIds.has(e.target) &&
      !tabSiblingPairs.has(`${e.source}|${e.target}`)
  );
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

  const rankOf = new Map();
  const ownerOf = new Map();
  const startList = []; // [{ id, order, isOrphan }]
  const queue = [];
  let head = 0;

  function seedStart(id, order, isOrphan = false) {
    rankOf.set(id, 0);
    ownerOf.set(id, id);
    startList.push({ id, order, isOrphan });
    queue.push(id);
  }

  function runBfs() {
    while (head < queue.length) {
      const current = queue[head++];
      const currentRank = rankOf.get(current);
      const currentOwner = ownerOf.get(current);
      for (const child of children.get(current) || []) {
        if (rankOf.has(child)) continue; // FIFO: first claimant (shortest, earliest start) wins
        rankOf.set(child, currentRank + 1);
        ownerOf.set(child, currentOwner);
        queue.push(child);
      }
    }
  }

  // Seed primary starts in order so ties go to earlier tab.
  if (primaryStarts.length > 0) {
    primaryStarts
      .slice()
      .sort((a, b) => a.order - b.order)
      .forEach((s) => seedStart(s.id, s.order, false));
    runBfs();
  } else {
    // No startDestination parsed — fall back to all zero-in-degree nodes.
    let order = 0;
    for (const [id, deg] of inDegree) {
      if (deg === 0) seedStart(id, order++, false);
    }
    runBfs();
  }

  // Orphan pass: each unreached zero-in-degree node becomes its own start,
  // getting its own column to the right of the tabs.
  let nextOrder = startList.length;
  for (const [id, deg] of inDegree) {
    if (rankOf.has(id)) continue;
    if (deg !== 0) continue;
    seedStart(id, nextOrder++, true);
  }
  runBfs();

  // Cycle stragglers (inside disconnected strongly-connected components with
  // no zero-in-degree node) — each becomes its own orphan start.
  for (const id of nodeIds) {
    if (rankOf.has(id)) continue;
    seedStart(id, nextOrder++, true);
  }
  runBfs();

  // Apply outputs.
  for (const [id, rank] of rankOf) {
    const node = nodeById.get(id);
    if (!node) continue;
    node.layoutRank = rank;
    node.subgraphOwner = ownerOf.get(id);
  }
  for (const s of startList) {
    const node = nodeById.get(s.id);
    if (!node) continue;
    node.isStartNode = true;
    node.startOrder = s.order;
    if (s.isOrphan) node.isOrphanRoot = true;
  }
}

module.exports = { buildKotlinGraph };
