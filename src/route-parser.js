const fs = require("fs");
const path = require("path");

/**
 * Parse Express route files (routes.js, app.js) to find explicit
 * route handlers with redirects and renders.
 */
function parseRoutes(prototypePath) {
  const routes = [];

  // Parse app/routes.js
  const routesFile = path.join(prototypePath, "app", "routes.js");
  if (fs.existsSync(routesFile)) {
    routes.push(...parseRouteFile(routesFile));
  }

  // Parse app.js for inline route handlers
  const appFile = path.join(prototypePath, "app.js");
  if (fs.existsSync(appFile)) {
    routes.push(...parseRouteFile(appFile));
  }

  return routes;
}

/**
 * Parse a single JS file for Express route definitions
 */
function parseRouteFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const routes = [];

  // Match router.get/post/use and app.get/post/use patterns
  const routeRegex =
    /(?:router|app)\.(get|post|use)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:\(req,\s*res(?:,\s*next)?\)\s*=>|function\s*\(req,\s*res(?:,\s*next)?\))\s*\{([\s\S]*?)^\s*\}\s*\)/gm;

  let match;
  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = match[2];
    const body = match[3];

    const route = {
      method,
      path: routePath,
      redirects: [],
      renders: [],
    };

    // Find res.redirect() calls
    const redirectRegex = /res\.redirect\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let redirectMatch;
    while ((redirectMatch = redirectRegex.exec(body)) !== null) {
      route.redirects.push(redirectMatch[1]);
    }

    // Find res.render() calls
    const renderRegex = /res\.render\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let renderMatch;
    while ((renderMatch = renderRegex.exec(body)) !== null) {
      route.renders.push("/" + renderMatch[1]);
    }

    // Find dynamic redirects using urlFormat or template literals
    const dynamicRedirectRegex =
      /res\.redirect\s*\(\s*(?:urlFormat\s*\(\s*\{[\s\S]*?pathname:\s*[`'"]([^`'"]*)[`'"]/g;
    let dynMatch;
    while ((dynMatch = dynamicRedirectRegex.exec(body)) !== null) {
      if (dynMatch[1]) route.redirects.push(dynMatch[1]);
    }

    if (route.redirects.length > 0 || route.renders.length > 0) {
      routes.push(route);
    }
  }

  // Also look for the catch-all POST→GET redirect pattern
  const catchAllPost = content.match(
    /app\.post\s*\(\s*\/\^\\\/\(\[.*?\]\+\)\$\/.*?res\.redirect/s,
  );
  if (catchAllPost) {
    routes.push({
      method: "POST",
      path: "/*",
      isCatchAll: true,
      redirects: ["SAME_PATH_AS_GET"],
      renders: [],
    });
  }

  return routes;
}

module.exports = { parseRoutes };
