const { normalizeUrlPath, isProbablyAppRoute } = require("./graph-builder");
const { canonicalizePath } = require("./crawler");

/**
 * Enrich a runtime scenario graph with metadata from static analysis.
 *
 * Static analysis provides:
 * - pageTitle (from {% set pageHeading %} or <title>)
 * - filePath (which template serves this route)
 * - node type (form, hub, page, start)
 * - conditional branch labels
 * - static-only edges (links/forms found in templates but not in runtime DOM)
 *
 * The runtime graph is the primary source of truth — static data only supplements.
 */
function enrichScenarioGraph(graph, templateData, explicitRoutes) {
  // Build lookup from normalized URL path → template data
  const templateLookup = buildTemplateLookup(templateData);
  const routeLookup = buildRouteLookup(explicitRoutes);

  // Enrich nodes
  for (const node of graph.nodes) {
    const tpl = findTemplate(node.urlPath, templateLookup);
    if (!tpl) continue;

    // Use static pageTitle if the runtime title is generic or missing
    if (tpl.pageTitle && isGenericTitle(node.label, node.actualTitle)) {
      node.label = tpl.pageTitle;
    }

    // Add file path from static analysis
    if (!node.filePath && tpl.relativePath) {
      node.filePath = tpl.relativePath;
    }

    // Upgrade node type from static categorisation if more specific
    if (node.type === "page") {
      const staticType = categoriseFromTemplate(tpl);
      if (staticType !== "page") {
        node.type = staticType;
      }
    }

    // Add hub metadata
    if (tpl.hub && !node.hub) {
      node.hub = tpl.hub;
    }

    // Mark provenance
    node.staticEnriched = true;
  }

  // Build set of existing edge keys for dedup
  const existingEdgeKeys = new Set(
    graph.edges.map((e) => edgeKey(e.source, e.target, e.type)),
  );

  // Add static-only edges that connect existing runtime nodes
  const runtimeNodeIds = new Set(graph.nodes.map((n) => n.id));
  const staticEdges = extractStaticEdges(templateData, explicitRoutes);

  let staticEdgesAdded = 0;
  for (const edge of staticEdges) {
    // Only add if both endpoints exist in the runtime graph
    if (!runtimeNodeIds.has(edge.source) || !runtimeNodeIds.has(edge.target)) {
      continue;
    }

    const key = edgeKey(edge.source, edge.target, edge.type);
    if (existingEdgeKeys.has(key)) {
      // Edge already exists from runtime — enrich it with static metadata
      const existing = graph.edges.find(
        (e) =>
          e.source === edge.source &&
          e.target === edge.target &&
          e.type === edge.type,
      );
      if (existing) {
        if (!existing.label && edge.label) {
          existing.label = edge.label;
        }
        if (edge.condition && !existing.condition) {
          existing.condition = edge.condition;
        }
        existing.provenance = "both";
      }
      continue;
    }

    // Add the static-only edge
    existingEdgeKeys.add(key);
    graph.edges.push({
      ...edge,
      provenance: "static",
    });
    staticEdgesAdded++;
  }

  return {
    graph,
    enrichmentStats: {
      nodesEnriched: graph.nodes.filter((n) => n.staticEnriched).length,
      staticEdgesAdded,
      templatesCovered: templateLookup.size,
    },
  };
}

/**
 * Build a map from normalized URL path → template data.
 * Includes both exact and canonical forms for flexible matching.
 */
function buildTemplateLookup(templateData) {
  const lookup = new Map();

  for (const tpl of templateData) {
    if (!isProbablyAppRoute(tpl.urlPath)) continue;

    const normalized = normalizeUrlPath(tpl.urlPath);
    if (!lookup.has(normalized)) {
      lookup.set(normalized, tpl);
    }

    // Also index by canonical path (with ID collapsing)
    const canonical = canonicalizePath(tpl.urlPath);
    if (canonical && canonical !== normalized && !lookup.has(canonical)) {
      lookup.set(canonical, tpl);
    }
  }

  return lookup;
}

/**
 * Build a map from route path → route handler data.
 */
function buildRouteLookup(explicitRoutes) {
  const lookup = new Map();
  for (const route of explicitRoutes) {
    const normalized = normalizeUrlPath(route.path);
    if (!lookup.has(normalized)) {
      lookup.set(normalized, route);
    }
  }
  return lookup;
}

/**
 * Find the template that best matches a runtime URL path.
 * Tries exact match first, then canonical form, then path-pattern matching.
 */
function findTemplate(urlPath, templateLookup) {
  // Exact match
  if (templateLookup.has(urlPath)) {
    return templateLookup.get(urlPath);
  }

  // Canonical match (e.g. runtime /clinics/abc123 → template /clinics/:id)
  const canonical = canonicalizePath(urlPath);
  if (canonical && templateLookup.has(canonical)) {
    return templateLookup.get(canonical);
  }

  // Pattern match: replace concrete segments with Express-style params
  // e.g. /participants/abc123/details → try /participants/:participantId/details
  const segments = urlPath.split("/");
  for (const [tplPath, tpl] of templateLookup) {
    const tplSegments = tplPath.split("/");
    if (tplSegments.length !== segments.length) continue;

    const matches = tplSegments.every((tplSeg, i) => {
      if (tplSeg === segments[i]) return true;
      // Template uses :param style
      if (tplSeg.startsWith(":")) return true;
      // Template uses {{expression}} style
      if (tplSeg.includes("{{")) return true;
      return false;
    });

    if (matches) return tpl;
  }

  return null;
}

/**
 * Check if a title is generic (e.g. just the service name repeated on every page).
 */
function isGenericTitle(label, actualTitle) {
  if (!label) return true;
  if (!actualTitle) return false;

  // Common generic patterns in GOV.UK/NHS prototypes
  const genericPatterns = [
    /^GOV\.UK/i,
    /^NHS/i,
    /– NHS$/i,
    /– GOV\.UK$/i,
    /prototype/i,
  ];

  // If the label is just the page title (which is often the service name), it's generic
  return genericPatterns.some((p) => p.test(label));
}

/**
 * Categorise a node from its template data.
 */
function categoriseFromTemplate(tpl) {
  const routePath = tpl.urlPath || "";
  if (routePath === "/" || routePath === "/index") return "start";
  if (tpl.hub) return "hub";
  if (tpl.formActions && tpl.formActions.length > 0) return "form";
  if (tpl.links && tpl.links.length > 3) return "hub";
  return "page";
}

/**
 * Extract edges from static analysis (templates + routes).
 */
function extractStaticEdges(templateData, explicitRoutes) {
  const edges = [];
  const explicitPostHandlers = new Map();

  for (const route of explicitRoutes) {
    if (route.method === "POST" && !route.isCatchAll) {
      explicitPostHandlers.set(normalizeUrlPath(route.path), route);
    }
  }

  const hasCatchAllPost = explicitRoutes.some((r) => r.isCatchAll);

  for (const tpl of templateData) {
    if (!isProbablyAppRoute(tpl.urlPath)) continue;
    const source = normalizeUrlPath(tpl.urlPath);

    // Links
    for (const link of tpl.links || []) {
      const target = normalizeUrlPath(link.target);
      if (!isProbablyAppRoute(target)) continue;
      edges.push({
        source,
        target,
        type: "link",
        label: link.label || "",
      });
    }

    // Form actions
    for (const form of tpl.formActions || []) {
      const rawTarget = normalizeUrlPath(form.target);
      if (!isProbablyAppRoute(rawTarget)) continue;

      const target = resolveFormTarget(
        rawTarget,
        form.method,
        explicitPostHandlers,
        hasCatchAllPost,
      );
      if (!isProbablyAppRoute(target)) continue;

      edges.push({
        source,
        target,
        type: "form",
        label: form.label || "Submit",
        method: form.method,
      });
    }

    // Conditional links
    for (const cond of tpl.conditionalLinks || []) {
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

      edges.push({
        source,
        target: rawTarget,
        type: "conditional",
        label: cond.label || "",
        condition: cond.condition || "",
      });
    }

    // JS redirects
    for (const redirect of tpl.jsRedirects || []) {
      const target = normalizeUrlPath(redirect.target);
      if (!isProbablyAppRoute(target)) continue;
      edges.push({
        source,
        target,
        type: "redirect",
        label: redirect.label || "",
      });
    }
  }

  // Explicit route redirects and renders
  for (const route of explicitRoutes) {
    if (!isProbablyAppRoute(route.path)) continue;
    const source = normalizeUrlPath(route.path);

    if (route.redirectTo) {
      const target = normalizeUrlPath(route.redirectTo);
      if (isProbablyAppRoute(target)) {
        edges.push({
          source,
          target,
          type: "redirect",
          label: "",
        });
      }
    }

    if (route.rendersTemplate) {
      const target = normalizeUrlPath(route.rendersTemplate);
      if (isProbablyAppRoute(target)) {
        edges.push({
          source,
          target,
          type: "render",
          label: "",
        });
      }
    }
  }

  return edges;
}

/**
 * Resolve a form's POST target to its actual destination.
 */
function resolveFormTarget(
  target,
  method,
  explicitPostHandlers,
  hasCatchAllPost,
) {
  if (!method || method.toUpperCase() !== "POST") return target;

  const handler = explicitPostHandlers.get(target);
  if (handler) {
    return normalizeUrlPath(handler.redirectTo || handler.rendersTemplate || target);
  }

  // If there's a catch-all POST handler (prototype kit auto-store-data),
  // the form POSTs to the same URL which then redirects to the same page via GET
  if (hasCatchAllPost) {
    return target;
  }

  return target;
}

function edgeKey(source, target, type) {
  return `${source}|${target}|${type}`;
}

module.exports = { enrichScenarioGraph };
