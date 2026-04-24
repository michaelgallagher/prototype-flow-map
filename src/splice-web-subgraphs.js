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

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
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

  return { nodesAdded, nodesUpgraded, edgesAdded };
}

function edgeKey(source, target, type) {
  return `${source}|${target}|${type || ""}`;
}

module.exports = { collectSeedUrls, spliceWebSubgraphs };
