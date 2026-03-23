const fs = require("fs");
const path = require("path");

/**
 * Parse all Kotlin files in a project and extract Compose navigation information.
 *
 * Returns an array of parsed composable screens, each with:
 * {
 *   route,            // canonical route string (e.g. "prescriptions2")
 *   composableName,   // the @Composable function name (e.g. "Prescriptions")
 *   filePath,         // absolute path
 *   relativePath,     // relative to project root
 *   navigations:      [{ targetRoute, label }]       — navController.navigate() calls
 *   externalLinks:    [{ url, label }]                — openTab() calls
 *   bottomNavItems:   [{ route, label }]              — BottomNavItem entries
 * }
 */
function parseKotlinProject(kotlinFiles, projectPath) {
  // Pass 1: build route registry from Routes objects and BottomNavItem definitions
  const routeConstants = new Map(); // "Routes.prescriptions2" → "prescriptions2"
  const bottomNavItems = []; // [{ route, label, routeRef }]
  const navHostEntries = []; // [{ route, composableName, filePath, isModal }]

  for (const filePath of kotlinFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    const stripped = stripKotlinComments(content);

    extractRouteConstants(stripped, routeConstants);
    extractBottomNavItems(stripped, bottomNavItems, routeConstants);
  }

  // Pass 2: parse NavHost composable() registrations and screen navigate() calls
  const screensByRoute = new Map();

  for (const filePath of kotlinFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    const stripped = stripKotlinComments(content);
    const relativePath = path.relative(projectPath, filePath);

    // Extract NavHost composable() registrations
    extractNavHostEntries(stripped, navHostEntries, routeConstants, filePath);

    // Extract navController.navigate() calls from screen files
    extractNavigations(stripped, filePath, relativePath, routeConstants, screensByRoute);

    // Extract openTab() calls
    extractExternalLinks(stripped, filePath, relativePath, screensByRoute);
  }

  // Pass 3: merge NavHost entries with screen data
  const results = [];
  const processedRoutes = new Set();

  for (const entry of navHostEntries) {
    const canonicalRoute = canonicalizeRoute(entry.route);
    if (processedRoutes.has(canonicalRoute)) continue;
    processedRoutes.add(canonicalRoute);

    const screen = screensByRoute.get(entry.composableName) || {};

    results.push({
      route: canonicalRoute,
      composableName: entry.composableName,
      filePath: screen.filePath || entry.filePath,
      relativePath: screen.relativePath || path.relative(projectPath, entry.filePath),
      navigations: screen.navigations || [],
      externalLinks: screen.externalLinks || [],
      bottomNavItems: [],
      isModal: entry.isModal || false,
    });
  }

  // Attach bottom nav items to the screen that hosts the NavHost (or first result)
  if (bottomNavItems.length > 0 && results.length > 0) {
    // Find the NavHost host screen or use the start destination
    const startRoute = navHostEntries.length > 0 ? canonicalizeRoute(navHostEntries[0].route) : null;
    const hostScreen = results.find((r) => r.route === startRoute) || results[0];
    hostScreen.bottomNavItems = bottomNavItems.map((item) => ({
      route: resolveRouteRef(item.routeRef, routeConstants) || item.route,
      label: item.label,
    }));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

function stripKotlinComments(src) {
  let out = "";
  let i = 0;
  const len = src.length;

  while (i < len) {
    // String literal
    if (src[i] === '"') {
      // Triple-quoted string
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        out += src[i++];
        out += src[i++];
        out += src[i++];
        while (i < len) {
          if (src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
            out += src[i++];
            out += src[i++];
            out += src[i++];
            break;
          }
          out += src[i++];
        }
        continue;
      }
      out += src[i++];
      while (i < len) {
        if (src[i] === "\\") { out += src[i++]; if (i < len) out += src[i++]; continue; }
        if (src[i] === '"') { out += src[i++]; break; }
        out += src[i++];
      }
      continue;
    }
    // Line comment
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < len && src[i] !== "\n") i++;
      continue;
    }
    // Block comment (Kotlin allows nesting)
    if (src[i] === "/" && src[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; }
        else if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    out += src[i++];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Closure/brace helpers
// ---------------------------------------------------------------------------

function findClosureAt(source, pos) {
  let depth = 0;
  for (let i = pos; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return { content: source.slice(pos + 1, i), end: i };
    }
  }
  return null;
}

function findMatchingParen(source, pos) {
  let depth = 0;
  for (let i = pos; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

/**
 * Canonicalize a route string by stripping parameter placeholders and values.
 * "prescriptionPharmacyDetail/{pharmacyId}?editMode={editMode}" → "prescriptionPharmacyDetail"
 * "message_detail/{messageId}" → "message_detail"
 * "prescriptionPharmacyDetail/1" → "prescriptionPharmacyDetail" (hardcoded param value)
 */
function canonicalizeRoute(route) {
  if (!route) return route;
  // Strip {placeholder} segments, query strings, and trailing slash
  let canonical = route.replace(/\/?\{[^}]+\}/g, "").replace(/\?.*$/, "").replace(/\/+$/, "");
  // Also strip trailing path segments that look like parameter values
  // e.g. "prescriptionPharmacyDetail/1" → "prescriptionPharmacyDetail"
  // e.g. "prescriptionConfirmationRepeat/Boots/123 High St/Paracetamol/"
  // Only strip segments after the first path component
  if (canonical.includes("/")) {
    canonical = canonical.split("/")[0];
  }
  return canonical || route;
}

/**
 * Resolve a route reference like "Routes.prescriptions2" to its string value.
 */
function resolveRouteRef(ref, routeConstants) {
  if (!ref) return null;
  return routeConstants.get(ref) || null;
}

/**
 * Resolve a navigate() argument to a canonical route string.
 * Handles: "home", Routes.prescriptions2, "message_detail/${message.id}"
 */
function resolveNavigateArg(arg, routeConstants) {
  if (!arg) return null;

  // Routes.xxx reference
  const routeRefMatch = arg.match(/^Routes\.(\w+)$/);
  if (routeRefMatch) {
    const resolved = routeConstants.get(`Routes.${routeRefMatch[1]}`);
    return resolved ? canonicalizeRoute(resolved) : routeRefMatch[1];
  }

  // BottomNavItem.xxx.route reference
  const bottomNavMatch = arg.match(/^BottomNavItem\.(\w+)\.route$/);
  if (bottomNavMatch) {
    const resolved = routeConstants.get(`BottomNavItem.${bottomNavMatch[1]}.route`);
    return resolved ? canonicalizeRoute(resolved) : bottomNavMatch[1].toLowerCase();
  }

  // String literal (possibly with interpolation)
  const strMatch = arg.match(/^"([^"]*)"$/);
  if (strMatch) {
    let route = strMatch[1];
    // Replace Kotlin string interpolation: ${...} → placeholder, then canonicalize
    route = route.replace(/\$\{[^}]+\}/g, "{param}").replace(/\$\w+/g, "{param}");
    return canonicalizeRoute(route);
  }

  // Plain identifier — might be a local variable; treat as route
  return canonicalizeRoute(arg);
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Extract route string constants from `object Routes { ... }` blocks.
 */
function extractRouteConstants(content, routeConstants) {
  // Match: object Routes { ... }
  const objectRe = /\bobject\s+Routes\s*\{/g;
  let match;
  while ((match = objectRe.exec(content)) !== null) {
    const closure = findClosureAt(content, match.index + match[0].length - 1);
    if (!closure) continue;

    // Match: var/val/const val name = "value"
    const propRe = /(?:const\s+val|var|val)\s+(\w+)\s*=\s*"([^"]+)"/g;
    let propMatch;
    while ((propMatch = propRe.exec(closure.content)) !== null) {
      routeConstants.set(`Routes.${propMatch[1]}`, propMatch[2]);
    }
  }
}

/**
 * Extract bottom navigation items from sealed class BottomNavItem definitions.
 */
function extractBottomNavItems(content, bottomNavItems, routeConstants) {
  // Pattern: data object Home : BottomNavItem(Routes.home, "Home", ...)
  const itemRe = /data\s+object\s+(\w+)\s*:\s*BottomNavItem\s*\(/g;
  let match;
  while ((match = itemRe.exec(content)) !== null) {
    const objectName = match[1];
    const closeParenIdx = findMatchingParen(content, match.index + match[0].length - 1);
    if (closeParenIdx === -1) continue;

    const args = content.slice(match.index + match[0].length, closeParenIdx);

    // First arg is route, second is label
    // Route can be: Routes.home, "home", etc.
    // Label is the second string argument
    const routeMatch = args.match(/^\s*(Routes\.\w+|"[^"]+")/);
    const labelMatch = args.match(/,\s*"([^"]+)"/);

    if (routeMatch && labelMatch) {
      const routeRef = routeMatch[1].replace(/"/g, "");
      const label = labelMatch[1];
      const isRoutesRef = routeMatch[1].startsWith("Routes.");

      // Also register as BottomNavItem.xxx.route for NavHost resolution
      const resolvedRoute = isRoutesRef
        ? resolveRouteRef(routeRef, routeConstants) || routeRef.replace("Routes.", "")
        : routeRef;
      routeConstants.set(`BottomNavItem.${objectName}.route`, resolvedRoute);

      bottomNavItems.push({
        route: resolvedRoute,
        label,
        routeRef: isRoutesRef ? routeRef : null,
      });
    }
  }
}

/**
 * Extract composable() route registrations from NavHost blocks.
 */
function extractNavHostEntries(content, navHostEntries, routeConstants, filePath) {
  // Find NavHost blocks
  const navHostRe = /\bNavHost\s*\(/g;
  let match;
  while ((match = navHostRe.exec(content)) !== null) {
    const closeParenIdx = findMatchingParen(content, match.index + match[0].length - 1);
    if (closeParenIdx === -1) continue;

    // The NavHost body might be inside the paren args (builder = { }) or after
    // Look for composable() calls in a reasonable range after the NavHost
    const searchEnd = Math.min(content.length, match.index + 20000);
    const searchContent = content.slice(match.index, searchEnd);

    // Find composable() registrations
    const composableRe = /\bcomposable\s*\(/g;
    let compMatch;
    while ((compMatch = composableRe.exec(searchContent)) !== null) {
      const compStart = match.index + compMatch.index;
      const compParenClose = findMatchingParen(content, compStart + compMatch[0].length - 1);
      if (compParenClose === -1) continue;

      const compArgs = content.slice(compStart + compMatch[0].length, compParenClose);

      // Extract route = "..." or route = Routes.xxx or BottomNavItem.xxx.route
      let route = null;
      const routeNamedMatch = compArgs.match(/\broute\s*=\s*(Routes\.\w+|BottomNavItem\.\w+\.route|"[^"]+")/);
      if (routeNamedMatch) {
        const routeArg = routeNamedMatch[1];
        if (routeArg.startsWith('"')) {
          route = routeArg.slice(1, -1);
        } else if (routeArg.startsWith("Routes.")) {
          route = resolveRouteRef(routeArg, routeConstants) || routeArg.replace("Routes.", "");
        } else if (routeArg.startsWith("BottomNavItem.")) {
          route = resolveRouteRef(routeArg, routeConstants) || routeArg;
        }
      }
      if (!route) continue;

      // Detect modal transition (slideIntoContainer towards Up)
      const isModal = /SlideDirection\.Up/.test(compArgs);

      // Find the composable function name in the trailing lambda
      const afterParen = content.slice(compParenClose + 1);
      const trailingBrace = afterParen.match(/^\s*\{/);
      if (!trailingBrace) {
        // Might be inline: composable(...) { ScreenName(...) }
        // Look right after the closing paren for a lambda
        continue;
      }

      const lambdaStart = compParenClose + 1 + trailingBrace.index;
      const lambda = findClosureAt(content, lambdaStart);
      if (!lambda) continue;

      // Extract the composable function call — first PascalCase identifier followed by (
      const fnCallRe = /\b([A-Z][A-Za-z0-9]+)\s*\(/g;
      let fnMatch;
      let composableName = null;
      while ((fnMatch = fnCallRe.exec(lambda.content)) !== null) {
        const name = fnMatch[1];
        // Skip known non-screen types
        if (/^(Modifier|URL|URLDecoder|NavType|AnimatedContentTransitionScope|Spring)$/.test(name)) continue;
        composableName = name;
        break;
      }

      if (composableName) {
        navHostEntries.push({ route, composableName, filePath, isModal });
      }
    }

    break; // Only process the first NavHost per file
  }
}

/**
 * Extract navController.navigate() calls from screen composable files.
 */
function extractNavigations(content, filePath, relativePath, routeConstants, screensByRoute) {
  // Find @Composable fun declarations to associate navigations with screens
  const funRe = /\bfun\s+([A-Z][A-Za-z0-9]+)\s*\(/g;
  let funMatch;
  while ((funMatch = funRe.exec(content)) !== null) {
    const fnName = funMatch[1];

    // Check if this function takes navController parameter
    const paramCloseIdx = findMatchingParen(content, funMatch.index + funMatch[0].length - 1);
    if (paramCloseIdx === -1) continue;
    const params = content.slice(funMatch.index + funMatch[0].length, paramCloseIdx);
    if (!/navController/i.test(params)) continue;

    // Find the function body
    const afterParams = content.slice(paramCloseIdx + 1);
    const bodyBrace = afterParams.match(/^\s*[:{]?\s*\{/);
    if (!bodyBrace) continue;

    // Handle `: SomeType {` or just `{`
    const braceIdx = paramCloseIdx + 1 + afterParams.indexOf("{", bodyBrace.index);
    const body = findClosureAt(content, braceIdx);
    if (!body) continue;

    const navigations = [];

    // navController.navigate("route") or navController.navigate(Routes.xxx)
    const navRe = /navController\.navigate\s*\(\s*("(?:[^"\\]|\\.)*"|Routes\.\w+|BottomNavItem\.\w+\.route|[a-zA-Z_]\w*)/g;
    let navMatch;
    while ((navMatch = navRe.exec(body.content)) !== null) {
      const rawArg = navMatch[1];
      const targetRoute = resolveNavigateArg(rawArg, routeConstants);
      if (targetRoute) {
        navigations.push({ targetRoute, label: null });
      }
    }

    if (!screensByRoute.has(fnName)) {
      screensByRoute.set(fnName, {
        filePath,
        relativePath,
        navigations: [],
        externalLinks: [],
      });
    }
    const screen = screensByRoute.get(fnName);
    screen.navigations.push(...navigations);
  }
}

/**
 * Extract openTab(context, "url") calls from screen files.
 */
function extractExternalLinks(content, filePath, relativePath, screensByRoute) {
  const funRe = /\bfun\s+([A-Z][A-Za-z0-9]+)\s*\(/g;
  let funMatch;
  while ((funMatch = funRe.exec(content)) !== null) {
    const fnName = funMatch[1];

    const paramCloseIdx = findMatchingParen(content, funMatch.index + funMatch[0].length - 1);
    if (paramCloseIdx === -1) continue;

    const bodyStart = content.indexOf("{", paramCloseIdx + 1);
    if (bodyStart === -1) continue;
    const body = findClosureAt(content, bodyStart);
    if (!body) continue;

    const externalLinks = [];

    // openTab(context, "https://...")
    const openTabRe = /openTab\s*\(\s*\w+\s*,\s*"(https?:\/\/[^"]+)"\s*\)/g;
    let otMatch;
    while ((otMatch = openTabRe.exec(body.content)) !== null) {
      externalLinks.push({ url: otMatch[1], label: null });
    }

    if (externalLinks.length > 0) {
      if (!screensByRoute.has(fnName)) {
        screensByRoute.set(fnName, {
          filePath,
          relativePath,
          navigations: [],
          externalLinks: [],
        });
      }
      screensByRoute.get(fnName).externalLinks.push(...externalLinks);
    }
  }
}

/**
 * Convert a PascalCase composable name to a human-readable label.
 * "BookAppointmentMenu" → "Book Appointment Menu"
 * "PrescriptionDetail" → "Prescription Detail"
 */
function toLabel(composableName) {
  return composableName
    .replace(/([A-Z])/g, " $1")
    .trim();
}

module.exports = { parseKotlinProject, canonicalizeRoute, toLabel };
