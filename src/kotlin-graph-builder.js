const { toLabel, canonicalizeRoute } = require("./kotlin-parser");
const { assignSubgraphLayout } = require("./layout-ranks");

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
 * Compute the primary starts and lateral edge pairs for Android/Kotlin graphs,
 * then delegate to the shared assignSubgraphLayout helper.
 */
function assignLayoutRanks(nodes, edges, parsedScreens) {
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Identify the start destination + its tab siblings. These become columns.
  const startScreen = parsedScreens.find((s) => s.isStartDestination);
  const startRoute = startScreen ? startScreen.route : null;
  const primaryStarts = []; // [{ id, order }]
  if (startRoute && nodeIds.has(startRoute)) {
    const tabItems = startScreen.bottomNavItems || [];
    if (tabItems.length > 0) {
      tabItems.forEach((item, idx) => {
        const r = canonicalizeRoute(item.route);
        if (nodeIds.has(r) && !primaryStarts.find((s) => s.id === r)) {
          primaryStarts.push({ id: r, order: idx });
        }
      });
      // Ensure startDestination is included even if not in its own nav bar.
      if (!primaryStarts.find((s) => s.id === startRoute)) {
        primaryStarts.unshift({ id: startRoute, order: -1 });
        primaryStarts.forEach((s, i) => (s.order = i));
      }
    } else {
      primaryStarts.push({ id: startRoute, order: 0 });
    }
  }

  // Tab-sibling pairs (all pairs within the same bottomNavItems list).
  const lateralEdgePairs = new Set();
  for (const screen of parsedScreens) {
    if (screen.bottomNavItems.length < 2) continue;
    const tabRoutes = screen.bottomNavItems
      .map((item) => canonicalizeRoute(item.route))
      .filter((r) => nodeIds.has(r));
    for (let i = 0; i < tabRoutes.length; i++) {
      for (let j = i + 1; j < tabRoutes.length; j++) {
        lateralEdgePairs.add(`${tabRoutes[i]}|${tabRoutes[j]}`);
        lateralEdgePairs.add(`${tabRoutes[j]}|${tabRoutes[i]}`);
      }
    }
  }

  assignSubgraphLayout({ nodes, edges, primaryStarts, lateralEdgePairs });
}

module.exports = { buildKotlinGraph };
