/**
 * Build a directed graph from parsed template data and route handlers.
 *
 * Nodes = pages (screens)
 * Edges = navigation links between pages
 */
function buildGraph(templateData, explicitRoutes, basePath) {
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
    if (basePath && !tpl.urlPath.startsWith(basePath) && tpl.urlPath !== "/") {
      continue;
    }

    const node = {
      id: tpl.urlPath,
      label: tpl.pageTitle || tpl.urlPath.split("/").pop() || "Home",
      urlPath: tpl.urlPath,
      hub: tpl.hub || null,
      filePath: tpl.relativePath,
      screenshot: null,
      type: categoriseNode(tpl),
    };

    nodes.push(node);
    nodeMap.set(tpl.urlPath, node);
  }

  // Step 2: Create edges from links, forms, conditionals, and JS redirects
  for (const tpl of templateData) {
    if (basePath && !tpl.urlPath.startsWith(basePath) && tpl.urlPath !== "/") {
      continue;
    }

    // Regular links
    for (const link of tpl.links) {
      addEdge(edges, tpl.urlPath, link.target, {
        type: "link",
        label: link.label || "",
      });
    }

    // Form actions
    for (const form of tpl.formActions) {
      const target = resolveFormTarget(
        form.target,
        form.method,
        explicitPostHandlers,
        hasCatchAllPost,
      );
      addEdge(edges, tpl.urlPath, target, {
        type: "form",
        label: form.label || "Submit",
        method: form.method,
      });
    }

    // Conditional links and forms
    for (const cond of tpl.conditionalLinks) {
      const target =
        cond.type === "form"
          ? resolveFormTarget(
              cond.target,
              cond.method || "POST",
              explicitPostHandlers,
              hasCatchAllPost,
            )
          : cond.target;

      addEdge(edges, tpl.urlPath, target, {
        type: "conditional",
        label: cond.label || "",
        condition: cond.condition,
        method: cond.method,
      });
    }

    // JS redirects
    for (const redirect of tpl.jsRedirects) {
      addEdge(edges, tpl.urlPath, redirect.target, {
        type: "redirect",
        label: redirect.label || "Redirect",
      });
    }

    // Back link (dashed edge)
    if (tpl.backLink) {
      addEdge(edges, tpl.urlPath, tpl.backLink, {
        type: "back",
        label: "Back",
      });
    }
  }

  // Step 3: Add edges from explicit route handlers
  for (const route of explicitRoutes) {
    if (route.isCatchAll) continue;
    for (const redirect of route.redirects) {
      addEdge(edges, route.path, redirect, {
        type: "redirect",
        label: `${route.method} handler → redirect`,
        method: route.method,
      });
    }
    for (const render of route.renders) {
      addEdge(edges, route.path, render, {
        type: "render",
        label: `${route.method} handler → render`,
        method: route.method,
      });
    }
  }

  // Deduplicate edges
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
  // Don't add self-loops unless they're meaningful
  if (source === target && metadata.type !== "conditional") return;

  edges.push({
    source,
    target,
    ...metadata,
  });
}

function deduplicateEdges(edges) {
  const seen = new Set();
  return edges.filter((edge) => {
    const key = `${edge.source}|${edge.target}|${edge.type}|${edge.condition || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function categoriseNode(tpl) {
  if (tpl.urlPath === "/" || tpl.urlPath.endsWith("/index")) return "index";
  if (tpl.extendsLayout === "layout-app-splash-screen.html") return "splash";
  if (tpl.pageTitle && /confirm/i.test(tpl.pageTitle)) return "confirmation";
  if (tpl.pageTitle && /error/i.test(tpl.pageTitle)) return "error";
  if (tpl.pageTitle && /check/i.test(tpl.pageTitle)) return "check-answers";

  // Has forms = question page
  if (
    tpl.formActions.length > 0 ||
    tpl.conditionalLinks.some((l) => l.type === "form")
  ) {
    return "question";
  }

  return "content";
}

module.exports = { buildGraph };
