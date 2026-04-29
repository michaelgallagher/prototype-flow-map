const { assignSubgraphLayout } = require("./layout-ranks");

/**
 * Platform-agnostic fallback: infer virtual subgraph owners when no real
 * platform tab/nav structure was detected.
 *
 * Heuristic:
 *   1. Find the root — the unique node with isStartNode, or the unique
 *      zero-in-degree node (excluding back-edges).
 *   2. Take the root's direct outbound forward edges.
 *   3. If ≥2 of those targets each have ≥2 reachable descendants, treat
 *      each qualifying target as a virtual subgraph owner.
 *   4. Multi-source BFS from the virtual owners (via assignSubgraphLayout).
 *
 * Skips entirely if any node already has subgraphOwner (platform-specific
 * detection already ran, e.g. Android bottom-nav or iOS TabView).
 */
function inferVirtualSubgraphOwners(graph) {
  if (graph.nodes.some((n) => n.subgraphOwner !== undefined)) return;

  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  // Build forward adjacency excluding back-edges.
  const forwardAdj = buildForwardAdj(graph.nodes, graph.edges);

  // Find the root: prefer isStartNode, fall back to unique zero-in-degree node.
  const inDegree = new Map();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const [, children] of forwardAdj) {
    for (const child of children) {
      inDegree.set(child, (inDegree.get(child) || 0) + 1);
    }
  }

  // Count reachable descendants from each node (BFS, memoised).
  const descendantCount = memoDescendantCount(forwardAdj, nodeIds);

  // Find root candidates: prefer isStartNode, then any zero-in-degree node.
  // When multiple zero-in-degree nodes exist (e.g. orphan dead-code views),
  // try each one and pick the first that produces ≥2 qualifying children.
  const rootCandidates = graph.nodes.find((n) => n.isStartNode)
    ? [graph.nodes.find((n) => n.isStartNode).id]
    : [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);

  let root = null;
  let candidates = [];
  for (const id of rootCandidates) {
    const qualifying = (forwardAdj.get(id) || []).filter(
      (child) => descendantCount(child) >= 2
    );
    if (qualifying.length >= 2) {
      root = id;
      candidates = qualifying;
      break;
    }
  }
  if (!root) return; // no node qualifies as a hub root

  // The root itself anchors column 0 (its "leftover" children — leaves and
  // external links that don't qualify as virtual owners — will be claimed by
  // the root's BFS). Virtual owners get columns 1, 2, 3… and claim their own
  // subtrees. BFS FIFO ensures virtual owners' nodes aren't stolen by the root
  // even though the root is seeded first (virtual owners are seeded in the same
  // initial wave, so their descendants are claimed before the root can reach them).
  const primaryStarts = [
    { id: root, order: 0 },
    ...candidates.map((id, idx) => ({ id, order: idx + 1 })),
  ];

  assignSubgraphLayout({ nodes: graph.nodes, edges: graph.edges, primaryStarts, lateralEdgePairs: new Set() });
}

/**
 * Returns a memoised function that counts reachable descendants of any node.
 */
function memoDescendantCount(forwardAdj, nodeIds) {
  const cache = new Map();

  function count(id, visiting = new Set()) {
    if (cache.has(id)) return cache.get(id);
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let total = 0;
    for (const child of (forwardAdj.get(id) || [])) {
      total += 1 + count(child, visiting);
    }
    cache.set(id, total);
    return total;
  }

  return count;
}

/**
 * Build forward adjacency map, excluding back-edges detected via DFS.
 */
function buildForwardAdj(nodes, edges) {
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Detect back-edges via DFS coloring.
  const adj = new Map();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target) && e.type !== 'tab') {
      adj.get(e.source).push(e.target);
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of nodeIds) color.set(id, WHITE);
  const backEdgeKeys = new Set();

  function dfs(u) {
    color.set(u, GRAY);
    for (const v of (adj.get(u) || [])) {
      if (color.get(v) === GRAY) backEdgeKeys.add(`${u}|${v}`);
      else if (color.get(v) === WHITE) dfs(v);
    }
    color.set(u, BLACK);
  }
  for (const id of nodeIds) {
    if (color.get(id) === WHITE) dfs(id);
  }

  // Build clean forward adjacency without back-edges.
  const forwardAdj = new Map();
  for (const id of nodeIds) forwardAdj.set(id, []);
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    if (e.type === 'tab') continue; // lateral — not a forward edge
    if (backEdgeKeys.has(`${e.source}|${e.target}`)) continue;
    forwardAdj.get(e.source).push(e.target);
  }

  return forwardAdj;
}

module.exports = { inferVirtualSubgraphOwners };
