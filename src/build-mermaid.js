const fs = require("fs");
const path = require("path");

/**
 * Generate a Mermaid flowchart definition from the graph and write it
 * to sitemap.mmd in the output directory.
 */
function buildMermaid(graph, outputDir) {
  const lines = ["flowchart TD"];

  // Build a set of node IDs that actually appear in edges, so we
  // don't emit orphan nodes that clutter the diagram
  const connectedIds = new Set();
  graph.edges.forEach((e) => {
    if (e.type === "nav") return;
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  });

  // Node definitions
  const nodeMap = {};
  graph.nodes.forEach((n) => {
    nodeMap[n.id] = n;
  });

  // Emit connected nodes with labels
  graph.nodes.forEach((n) => {
    if (!connectedIds.has(n.id)) return;
    const mid = mermaidId(n.id);
    const label = escapeLabel(n.label || n.urlPath);
    lines.push(`  ${mid}["${label}"]`);
  });

  lines.push("");

  // Edges
  graph.edges.forEach((e) => {
    // Skip nav edges (synthetic) and self-references
    if (e.type === "nav") return;
    if (e.source === e.target) return;
    // Skip edges to nodes not in our graph
    if (!nodeMap[e.source] || !nodeMap[e.target]) return;

    const src = mermaidId(e.source);
    const tgt = mermaidId(e.target);

    if (e.type === "conditional") {
      const condLabel = escapeLabel(e.label || "conditional");
      lines.push(`  ${src} -. "${condLabel}" .-> ${tgt}`);
    } else {
      lines.push(`  ${src} --> ${tgt}`);
    }
  });

  lines.push("");

  // Class definitions for node types
  lines.push("  classDef start fill:#53d8fb,stroke:#0f3460,color:#000");
  lines.push(
    "  classDef question fill:#e94560,stroke:#0f3460,color:#fff",
  );
  lines.push(
    "  classDef confirmation fill:#4ecca3,stroke:#0f3460,color:#000",
  );
  lines.push("  classDef error fill:#ff6b6b,stroke:#0f3460,color:#fff");

  // Apply classes to nodes
  const classAssignments = { start: [], question: [], confirmation: [], error: [] };
  graph.nodes.forEach((n) => {
    if (!connectedIds.has(n.id)) return;
    const mid = mermaidId(n.id);
    if (n.isStartNode) {
      classAssignments.start.push(mid);
    } else if (n.type === "question") {
      classAssignments.question.push(mid);
    } else if (n.type === "confirmation" || n.type === "check-answers") {
      classAssignments.confirmation.push(mid);
    } else if (n.type === "error") {
      classAssignments.error.push(mid);
    }
  });

  Object.entries(classAssignments).forEach(([cls, ids]) => {
    if (ids.length > 0) {
      lines.push(`  class ${ids.join(",")} ${cls}`);
    }
  });

  const mmd = lines.join("\n") + "\n";
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "sitemap.mmd"), mmd);
}

/**
 * Convert a URL path to a valid Mermaid node ID.
 * Mermaid IDs cannot contain slashes, hyphens at start, or special chars.
 */
function mermaidId(urlPath) {
  return urlPath
    .replace(/^\//, "")
    .replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Escape a label for use inside Mermaid quoted strings.
 */
function escapeLabel(str) {
  return str.replace(/"/g, "'").replace(/\n/g, " ");
}

module.exports = { buildMermaid };
