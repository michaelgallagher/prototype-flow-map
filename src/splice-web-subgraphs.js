const { canonicalizeAbsolute } = require("./web-jumpoff-crawler");

/**
 * Collect seed URLs to crawl from a native graph's external nodes.
 *
 * Looks for nodes whose `type` is "external" or "web-view" (the types emitted
 * by swift-graph-builder and kotlin-graph-builder for links to hosted web
 * prototypes). Filters by origin against the webJumpoffs.allowlist so we
 * never reach out to third-party hosts the user hasn't explicitly allowed.
 *
 * Returns an array of absolute URL strings in canonical form. Duplicate URLs
 * collapse (an origin reached from multiple native screens only needs crawling
 * once per run).
 */
function collectSeedUrls(graph, allowlist) {
  const allowed = new Set(Array.isArray(allowlist) ? allowlist : []);
  const seeds = new Set();

  for (const node of graph.nodes || []) {
    if (node.type !== "external" && node.type !== "web-view") continue;
    const raw = node.id || node.urlPath;
    if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) continue;
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch {
      continue;
    }
    if (allowed.size > 0 && !allowed.has(origin)) continue;
    const canonical = canonicalizeAbsolute(raw);
    if (canonical) seeds.add(canonical);
  }

  return Array.from(seeds);
}

/**
 * Splice a crawled web subgraph into a native graph.
 *
 * Both the iOS and Android graph-builders key external-URL nodes on the full
 * URL (same as the crawler's canonical form). That means every seed URL from
 * the crawl collides with an existing "external" or "web-view" node in the
 * native graph — they represent the exact same screen, just viewed from two
 * angles (static reference vs. runtime fetch).
 *
 * So the splice takes the form of an **upgrade** rather than an addition:
 *   - Existing external / web-view node whose id matches a crawled subgraph
 *     root gets its label, screenshot, and metadata replaced with the richer
 *     crawl data, and its type flipped to "web-page". The original type is
 *     preserved on `nativeHandoffType` so the viewer can still hint at how the
 *     user reached the web flow (safari vs embedded WKWebView).
 *   - Non-seed web-page nodes (internal pages discovered during BFS) are
 *     added fresh — they weren't in the native graph to begin with.
 *   - Internal same-origin link edges are merged in (dedup'd by source/target/
 *     type key).
 *
 * No separate "web-enter" edge is needed: the existing native→external edge
 * (already typed `safari` or `web-view`) now lands on the upgraded web-page
 * node and still conveys "this is where the user leaves the native shell."
 *
 * Idempotent: running twice doesn't duplicate nodes or edges.
 *
 * Returns { nodesAdded, nodesUpgraded, edgesAdded } counts for logging.
 */
function spliceWebSubgraphs(graph, webResult) {
  if (!webResult || !Array.isArray(webResult.nodes)) {
    return { nodesAdded: 0, nodesUpgraded: 0, edgesAdded: 0 };
  }

  graph.nodes = graph.nodes || [];
  graph.edges = graph.edges || [];

  // Lookup map for splicing. The native parsers keep URLs verbatim (often
  // including a trailing slash like `/help/`) while the crawler stores every
  // node under its canonical form (`/help`). To make the splice match across
  // that difference, index external / web-view nodes under both their raw id
  // and their canonicalised form. Without this, a crawled web-page node
  // whose id is the canonical URL fails to find the native external node and
  // gets added as a duplicate disconnected node — leaving the user-facing
  // external chip flat with no screenshot and no children.
  const nodeById = new Map();
  for (const n of graph.nodes) {
    nodeById.set(n.id, n);
    if (n.type === "external" || n.type === "web-view") {
      const canonical = canonicalizeAbsolute(n.id);
      if (canonical && canonical !== n.id && !nodeById.has(canonical)) {
        nodeById.set(canonical, n);
      }
    }
  }
  const existingEdgeKeys = new Set(
    graph.edges.map((e) => edgeKey(e.source, e.target, e.type)),
  );

  let nodesAdded = 0;
  let nodesUpgraded = 0;

  for (const webNode of webResult.nodes) {
    const existing = nodeById.get(webNode.id);
    if (!existing) {
      graph.nodes.push(webNode);
      nodeById.set(webNode.id, webNode);
      nodesAdded += 1;
      continue;
    }

    // Upgrade an existing native external / web-view node to a web-page
    // node with the richer crawl metadata. Preserve the native handoff type
    // on `nativeHandoffType` so the viewer can still distinguish "opened in
    // Safari" from "embedded WKWebView" handoffs when styling the node.
    if (existing.type === "external" || existing.type === "web-view") {
      existing.nativeHandoffType = existing.type;
      existing.type = "web-page";
      if (webNode.label) existing.label = webNode.label;
      if (webNode.urlPath) existing.urlPath = webNode.urlPath;
      if (webNode.origin) existing.origin = webNode.origin;
      if (webNode.screenshot) existing.screenshot = webNode.screenshot;
      if (webNode.screenshotError) {
        existing.screenshotError = webNode.screenshotError;
      }
      if (webNode.error) existing.error = webNode.error;
      if (webNode.subgraphRoot) existing.subgraphRoot = true;

      // Normalise the upgraded node's id to canonical form so incoming
      // crawler edges (which use canonical ids) land on it. Rewrite any
      // pre-existing graph edges that referenced the old raw id so the
      // native handoff edge (safari / web-view) still points at this node.
      if (existing.id !== webNode.id) {
        const oldId = existing.id;
        existing.id = webNode.id;
        for (const e of graph.edges) {
          if (e.source === oldId) e.source = webNode.id;
          if (e.target === oldId) e.target = webNode.id;
        }
        // Rebuild edge-key set since source/target just changed.
        existingEdgeKeys.clear();
        for (const e of graph.edges) {
          existingEdgeKeys.add(edgeKey(e.source, e.target, e.type));
        }
        nodeById.set(webNode.id, existing);
        // Leave the stale oldId entry in nodeById too — harmless, and keeps
        // any later webNode lookups via the raw form pointing at the same
        // upgraded node.
      }
      nodesUpgraded += 1;
    }
    // If the existing node was already a web-page (re-running splice), the
    // crawler result is authoritative for label/screenshot — refresh them.
    else if (existing.type === "web-page") {
      if (webNode.label) existing.label = webNode.label;
      if (webNode.screenshot) existing.screenshot = webNode.screenshot;
      if (webNode.subgraphRoot) existing.subgraphRoot = true;
    }
    // Any other collision (e.g. a native screen sharing an URL-shaped id —
    // shouldn't happen in practice) we leave alone; the native node wins.
  }

  // Merge internal same-origin link edges from the crawl.
  let edgesAdded = 0;
  for (const edge of webResult.edges || []) {
    const key = edgeKey(edge.source, edge.target, edge.type);
    if (existingEdgeKeys.has(key)) continue;
    graph.edges.push(edge);
    existingEdgeKeys.add(key);
    edgesAdded += 1;
  }

  // Propagate layout metadata (subgraphOwner + layoutRank) from each upgraded
  // root to its BFS descendants in the web subgraph.
  //
  // Why this is necessary:
  // The native-mobile column-packing layout in build-viewer.js skips any
  // filtered node whose layoutRank is undefined — it never receives an X
  // coordinate, so it collapses behind other columns or off-canvas. The
  // upgraded roots already carry layoutRank + subgraphOwner (inherited from
  // the native graph build), but crawler-discovered children are added fresh
  // with neither field set. Without this pass, only the root of each web
  // journey is visible to the user.
  //
  // Algorithm: starting from every node that has subgraphRoot === true AND a
  // layoutRank, BFS outward following `link` edges and assign each child
  // `parent.layoutRank + 1` and `parent.subgraphOwner`. Diamond-safe via a
  // min-rank check.
  propagateLayoutToWebSubgraphs(graph);

  return { nodesAdded, nodesUpgraded, edgesAdded };
}

function propagateLayoutToWebSubgraphs(graph) {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // Build adjacency from link edges only (those are the crawler's BFS edges).
  const childrenBySource = new Map();
  for (const edge of graph.edges) {
    if (edge.type !== "link") continue;
    if (!childrenBySource.has(edge.source)) {
      childrenBySource.set(edge.source, []);
    }
    childrenBySource.get(edge.source).push(edge.target);
  }

  // Seed the BFS with every upgraded root that has usable layout metadata.
  const queue = [];
  for (const node of graph.nodes) {
    if (node.type !== "web-page") continue;
    if (!node.subgraphRoot) continue;
    if (node.layoutRank === undefined || node.subgraphOwner === undefined) {
      continue;
    }
    queue.push(node.id);
  }

  while (queue.length > 0) {
    const parentId = queue.shift();
    const parent = nodeMap.get(parentId);
    if (!parent) continue;
    const nextRank = parent.layoutRank + 1;
    const owner = parent.subgraphOwner;

    const children = childrenBySource.get(parentId) || [];
    for (const childId of children) {
      const child = nodeMap.get(childId);
      if (!child) continue;
      if (child.type !== "web-page") continue;
      // Don't overwrite a root's own metadata — roots are already placed.
      if (child.subgraphRoot) continue;

      let changed = false;
      if (child.subgraphOwner === undefined) {
        child.subgraphOwner = owner;
        changed = true;
      }
      if (child.layoutRank === undefined || child.layoutRank > nextRank) {
        child.layoutRank = nextRank;
        changed = true;
      }
      if (changed) queue.push(childId);
    }
  }
}

function edgeKey(source, target, type) {
  return `${source}|${target}|${type || ""}`;
}

module.exports = { collectSeedUrls, spliceWebSubgraphs };
