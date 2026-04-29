/**
 * Shared subgraph layout assignment.
 *
 * Assigns layoutRank, subgraphOwner, isStartNode, startOrder, and isOrphanRoot
 * to each node via per-owner multi-source BFS.
 *
 * Model: each primary start node is the root of its own column. Every other
 * node is claimed by the nearest start (FIFO ties → lower startOrder wins).
 * layoutRank is the BFS distance from the owning start (0 for starts).
 * Orphan roots (zero-in-degree nodes unreachable from any primary start)
 * each get their own column to the right of the primary columns.
 *
 * @param {object} opts
 * @param {Array}  opts.nodes          - graph node objects (mutated in place)
 * @param {Array}  opts.edges          - graph edge objects { source, target, type }
 * @param {Array}  opts.primaryStarts  - [{ id, order }] — the intended start nodes in column order
 * @param {Set}    opts.lateralEdgePairs - Set of "a|b" strings for edges to exclude from BFS
 *                                        (tab-sibling pairs, etc.)
 */
function assignSubgraphLayout({ nodes, edges, primaryStarts, lateralEdgePairs }) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Build forward adjacency, excluding lateral pairs and back-edges.
  const rankEdges = edges.filter(
    (e) =>
      nodeIds.has(e.source) &&
      nodeIds.has(e.target) &&
      !lateralEdgePairs.has(`${e.source}|${e.target}`)
  );
  const backEdgeKeys = findBackEdges(rankEdges, nodeIds);

  const children = new Map();
  const inDegree = new Map();
  for (const id of nodeIds) {
    children.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of rankEdges) {
    if (backEdgeKeys.has(`${e.source}|${e.target}`)) continue;
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

  // Seed primary starts in order so ties go to the earlier start.
  if (primaryStarts.length > 0) {
    primaryStarts
      .slice()
      .sort((a, b) => a.order - b.order)
      .forEach((s) => seedStart(s.id, s.order, false));
    runBfs();
  } else {
    // No primary starts provided — fall back to all zero-in-degree nodes.
    let order = 0;
    for (const [id, deg] of inDegree) {
      if (deg === 0) seedStart(id, order++, false);
    }
    runBfs();
  }

  // Orphan pass: each unreached zero-in-degree node becomes its own column.
  let nextOrder = startList.length;
  for (const [id, deg] of inDegree) {
    if (rankOf.has(id)) continue;
    if (deg !== 0) continue;
    seedStart(id, nextOrder++, true);
  }
  runBfs();

  // Cycle stragglers (inside disconnected SCCs with no zero-in-degree node).
  for (const id of nodeIds) {
    if (rankOf.has(id)) continue;
    seedStart(id, nextOrder++, true);
  }
  runBfs();

  // Apply outputs to nodes.
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

/**
 * Use DFS to find back-edges in a directed graph (edges that form cycles).
 * Returns a Set of "source|target" keys for back-edges.
 */
function findBackEdges(edges, nodeIds) {
  const adj = new Map();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (adj.has(e.source)) adj.get(e.source).push(e.target);
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

module.exports = { assignSubgraphLayout };
