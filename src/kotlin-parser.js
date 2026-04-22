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
  // Pass 1: build route registry from Routes objects, BottomNavItem definitions, and helper fns
  const routeConstants = new Map(); // "Routes.prescriptions2" → "prescriptions2"
  const routeHelpers = new Map();  // "familyCarerCaredForDetailRoute" → "familyCarer/caredFor/{param}"
  const bottomNavItems = []; // [{ route, label, routeRef }]
  const navHostEntries = []; // [{ route, composableName, filePath, isModal }]

  for (const filePath of kotlinFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    const stripped = stripKotlinComments(content);

    extractRouteConstants(stripped, routeConstants);
    extractRouteHelpers(stripped, routeHelpers);
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
    extractNavigations(stripped, filePath, relativePath, routeConstants, routeHelpers, screensByRoute);

    // Extract navController.navigate() calls from NavHost composable lambdas
    extractNavHostNavigations(stripped, filePath, relativePath, routeConstants, routeHelpers, navHostEntries, screensByRoute);

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
      rawRoute: entry.route,
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
 * Canonicalize a route string by stripping parameter placeholders and hardcoded values.
 * "prescriptionPharmacyDetail/{pharmacyId}?editMode={editMode}" → "prescriptionPharmacyDetail"
 * "message_detail/{messageId}" → "message_detail"
 * "familyCarer/caredFor/{personId}" → "familyCarer/caredFor"
 * "prescriptionPharmacyDetail/1" → "prescriptionPharmacyDetail" (hardcoded param value)
 */
function canonicalizeRoute(route) {
  if (!route) return route;
  // Strip query strings first
  let canonical = route.replace(/\?.*$/, "");
  // Strip trailing slash
  canonical = canonical.replace(/\/+$/, "");
  // Split into path segments and drop any that are {placeholder} or look like runtime values
  // (all-digits, or contain $ interpolation markers from earlier processing)
  const segments = canonical.split("/").filter((seg) => {
    if (!seg) return false;
    if (/^\{[^}]+\}$/.test(seg)) return false; // {placeholder}
    if (/^\d+$/.test(seg)) return false;        // hardcoded numeric param
    if (seg.includes("{param}")) return false;  // interpolated string placeholder
    return true;
  });
  return segments.join("/") || route;
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
 * Handles: "home", Routes.prescriptions2, "message_detail/${message.id}",
 *          com.x.y.Routes.biometricLogin (fully-qualified), xyzRoute(id) (helper call)
 */
function resolveNavigateArg(arg, routeConstants, routeHelpers) {
  if (!arg) return null;

  // Fully-qualified Routes reference: com.x.y.Routes.xxx or any.pkg.Routes.xxx
  const fqRouteMatch = arg.match(/(?:\w+\.)+Routes\.(\w+)$/);
  if (fqRouteMatch) {
    const resolved = routeConstants.get(`Routes.${fqRouteMatch[1]}`);
    return resolved ? canonicalizeRoute(resolved) : fqRouteMatch[1];
  }

  // Routes.xxx reference
  const routeRefMatch = arg.match(/^Routes\.(\w+)$/);
  if (routeRefMatch) {
    const resolved = routeConstants.get(`Routes.${routeRefMatch[1]}`);
    return resolved ? canonicalizeRoute(resolved) : routeRefMatch[1];
  }

  // Routes.xxxRoute(args) — helper call via Routes object
  const routesHelperMatch = arg.match(/^Routes\.(\w+)\s*\(/);
  if (routesHelperMatch) {
    const helper = routeHelpers && routeHelpers.get(`Routes.${routesHelperMatch[1]}`);
    return helper ? canonicalizeRoute(helper) : null;
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
    // Replace Kotlin string interpolation: ${...} → drop segment, then canonicalize
    route = route.replace(/\$\{[^}]+\}/g, "{param}").replace(/\$\w+/g, "{param}");
    return canonicalizeRoute(route);
  }

  // Route helper function call: xyzRoute(args) or xyzRoute(id)
  const helperCallMatch = arg.match(/^([a-zA-Z_]\w*)\s*\(/);
  if (helperCallMatch && routeHelpers) {
    const helper = routeHelpers.get(helperCallMatch[1]);
    return helper ? canonicalizeRoute(helper) : null;
  }

  // Plain single-word identifier — check if it's a known file-level route constant
  if (/^[a-zA-Z_]\w*$/.test(arg)) {
    const fromConst = routeConstants.get(arg);
    if (fromConst) return canonicalizeRoute(fromConst);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Extract route helper functions: private fun xyzRoute(id: String) = "path/segment/$id"
 * Populates routeHelpers: Map of fnName → route template (with {param} substitution)
 * Also handles Routes object helper functions: fun xyzRoute(id: String) = "path/$id"
 */
function extractRouteHelpers(content, routeHelpers) {
  // Match: [private] fun xyzRoute(params) = "some/path/$id"
  // or: fun xyzRoute(params) = "some/path/${id}"
  const helperRe = /\bfun\s+([a-z]\w*Route)\s*\([^)]*\)\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = helperRe.exec(content)) !== null) {
    const fnName = match[1];
    let template = match[2];
    // Replace interpolations with {param}
    template = template.replace(/\$\{[^}]+\}/g, "{param}").replace(/\$\w+/g, "{param}");
    routeHelpers.set(fnName, template);
  }

  // Also capture helpers inside `object Routes { fun xyzRoute(...) = "..." }`
  const objectRe = /\bobject\s+Routes\s*\{/g;
  let objMatch;
  while ((objMatch = objectRe.exec(content)) !== null) {
    const closure = findClosureAt(content, objMatch.index + objMatch[0].length - 1);
    if (!closure) continue;

    const innerRe = /\bfun\s+([a-z]\w*Route)\s*\([^)]*\)\s*=\s*"([^"]+)"/g;
    let innerMatch;
    while ((innerMatch = innerRe.exec(closure.content)) !== null) {
      const fnName = innerMatch[1];
      let template = innerMatch[2];
      template = template.replace(/\$\{[^}]+\}/g, "{param}").replace(/\$\w+/g, "{param}");
      routeHelpers.set(fnName, template);
      routeHelpers.set(`Routes.${fnName}`, template);
    }
  }
}

/**
 * Extract route string constants from `object Routes { ... }` blocks
 * and from file-level private const val declarations.
 */
function extractRouteConstants(content, routeConstants) {
  // Routes object properties
  const objectRe = /\bobject\s+Routes\s*\{/g;
  let match;
  while ((match = objectRe.exec(content)) !== null) {
    const closure = findClosureAt(content, match.index + match[0].length - 1);
    if (!closure) continue;

    const propRe = /(?:const\s+val|var|val)\s+(\w+)\s*=\s*"([^"]+)"/g;
    let propMatch;
    while ((propMatch = propRe.exec(closure.content)) !== null) {
      routeConstants.set(`Routes.${propMatch[1]}`, propMatch[2]);
    }
  }

  // File-level private/internal const val declarations (e.g. in AppNavigation.kt)
  // private const val FamilyCarerAddCaredForRoute = "familyCarer/addCaredFor"
  const fileConstRe = /(?:private\s+|internal\s+)?const\s+val\s+([A-Z][A-Za-z0-9]+(?:Route|Pattern|Path))\s*=\s*"([^"]+)"/g;
  let constMatch;
  while ((constMatch = fileConstRe.exec(content)) !== null) {
    // Only store if not already registered (Routes object takes precedence)
    if (!routeConstants.has(constMatch[1])) {
      routeConstants.set(constMatch[1], constMatch[2]);
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
      const routeNamedMatch = compArgs.match(/\broute\s*=\s*(Routes\.\w+|BottomNavItem\.\w+\.route|"[^"]+"|[A-Z][A-Za-z0-9]+)/);
      if (routeNamedMatch) {
        const routeArg = routeNamedMatch[1];
        if (routeArg.startsWith('"')) {
          route = routeArg.slice(1, -1);
        } else if (routeArg.startsWith("Routes.")) {
          route = resolveRouteRef(routeArg, routeConstants) || routeArg.replace("Routes.", "");
        } else if (routeArg.startsWith("BottomNavItem.")) {
          route = resolveRouteRef(routeArg, routeConstants) || routeArg;
        } else {
          // File-level constant (e.g. FamilyCarerAddCaredForRoute)
          route = routeConstants.get(routeArg) || null;
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
        // Skip known non-screen composables and Compose/Kotlin built-ins
        if (/^(Modifier|URL|URLDecoder|NavType|AnimatedContentTransitionScope|Spring|LaunchedEffect|DisposableEffect|SideEffect|remember|Box|Column|Row|Text|Icon|Surface|Scaffold|HorizontalDivider|VerticalDivider|Spacer|Card|Button|IconButton|AlertDialog|ModalBottomSheet|BackHandler|NavHost|CompositionLocalProvider|ProvideTextStyle|ExitTransition|EnterTransition|AnimatedVisibility|CrossfadeScope)$/.test(name)) continue;
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
function extractNavigations(content, filePath, relativePath, routeConstants, routeHelpers, screensByRoute) {
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

    const navigations = extractNavigationsFromBlock(body.content, routeConstants, routeHelpers);

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
 * Extract navigate() calls from inside AppNavigation.kt composable() lambdas.
 * These are navigate calls that don't live inside a named @Composable function
 * (they're inside inline lambdas passed to composable(route = "x") { ... }).
 * We attribute them to the parent route's screen.
 */
function extractNavHostNavigations(content, filePath, relativePath, routeConstants, routeHelpers, navHostEntries, screensByRoute) {
  // Only process files that contain a NavHost
  if (!content.includes("NavHost")) return;

  // For each registered NavHost entry, find its composable() block and scan for navigate() calls
  const composableRe = /\bcomposable\s*\(/g;
  let match;
  while ((match = composableRe.exec(content)) !== null) {
    const compStart = match.index;
    const compParenClose = findMatchingParen(content, compStart + match[0].length - 1);
    if (compParenClose === -1) continue;

    const compArgs = content.slice(compStart + match[0].length, compParenClose);

    // Extract route (mirrors extractNavHostEntries logic)
    let route = null;
    const routeNamedMatch = compArgs.match(/\broute\s*=\s*(Routes\.\w+|BottomNavItem\.\w+\.route|"[^"]+"|[A-Z][A-Za-z0-9]+)/);
    if (routeNamedMatch) {
      const routeArg = routeNamedMatch[1];
      if (routeArg.startsWith('"')) {
        route = canonicalizeRoute(routeArg.slice(1, -1));
      } else if (routeArg.startsWith("Routes.")) {
        const resolved = routeConstants.get(routeArg);
        route = resolved ? canonicalizeRoute(resolved) : routeArg.replace("Routes.", "");
      } else if (routeArg.startsWith("BottomNavItem.")) {
        const resolved = routeConstants.get(routeArg);
        route = resolved ? canonicalizeRoute(resolved) : null;
      } else {
        const resolved = routeConstants.get(routeArg);
        route = resolved ? canonicalizeRoute(resolved) : null;
      }
    }
    if (!route) continue;

    // Find the trailing lambda
    const afterParen = content.slice(compParenClose + 1);
    const braceOffset = afterParen.indexOf("{");
    if (braceOffset === -1) continue;
    const lambdaStart = compParenClose + 1 + braceOffset;
    const lambda = findClosureAt(content, lambdaStart);
    if (!lambda) continue;

    const navigations = extractNavigationsFromBlock(lambda.content, routeConstants, routeHelpers);
    if (navigations.length === 0) continue;

    // Find the composable function name to look up screen
    // Find composable screen name — skip built-ins that appear before the actual screen call
    const nonScreenRe = /^(Modifier|URL|URLDecoder|NavType|AnimatedContentTransitionScope|Spring|LaunchedEffect|DisposableEffect|SideEffect|remember|Box|Column|Row|Text|Icon|Surface|Scaffold|HorizontalDivider|VerticalDivider|Spacer|Card|Button|IconButton|AlertDialog|ModalBottomSheet|BackHandler|NavHost|CompositionLocalProvider|ExitTransition|EnterTransition|AnimatedVisibility)$/;
    const fnCallRe = /\b([A-Z][A-Za-z0-9]+)\s*\(/g;
    let fnMatch;
    let composableName = null;
    while ((fnMatch = fnCallRe.exec(lambda.content)) !== null) {
      if (!nonScreenRe.test(fnMatch[1])) { composableName = fnMatch[1]; break; }
    }

    // Attribute navigations to the composable name (or directly to route)
    const key = composableName || route;
    if (!screensByRoute.has(key)) {
      screensByRoute.set(key, {
        filePath,
        relativePath,
        navigations: [],
        externalLinks: [],
      });
    }
    const screen = screensByRoute.get(key);
    // Deduplicate against already-extracted navigations from screen files
    for (const nav of navigations) {
      if (!screen.navigations.some((n) => n.targetRoute === nav.targetRoute)) {
        screen.navigations.push(nav);
      }
    }
  }
}

/**
 * Extract navController.navigate() calls from an arbitrary code block.
 * Uses paren-matching rather than regex to correctly handle nested call expressions.
 */
function extractNavigationsFromBlock(blockContent, routeConstants, routeHelpers) {
  const navigations = [];
  const navRe = /navController\.navigate\s*\(/g;
  let navMatch;
  while ((navMatch = navRe.exec(blockContent)) !== null) {
    // The opening paren is the last char of the match
    const openParen = navMatch.index + navMatch[0].length - 1;
    const closeParen = findMatchingParen(blockContent, openParen);
    if (closeParen === -1) continue;

    const argStr = blockContent.slice(openParen + 1, closeParen).trim();
    const rawArg = extractFirstArg(argStr);
    if (!rawArg) continue;

    const targetRoute = resolveNavigateArg(rawArg, routeConstants, routeHelpers);
    if (targetRoute) {
      navigations.push({ targetRoute, label: null });
    }
  }
  return navigations;
}

/**
 * Extract the first argument token from a navigate() argument string.
 * Handles: "route", Routes.xxx, fqRoute, helperFn(id), com.x.Routes.xxx
 */
function extractFirstArg(raw) {
  if (!raw) return null;
  raw = raw.trim();

  // String literal
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    return end !== -1 ? raw.slice(0, end + 1) : null;
  }

  // Identifier (possibly qualified with dots or a function call)
  // Match: word(.word)* optionally followed by ( for function calls
  const identMatch = raw.match(/^((?:\w+\.)*\w+)\s*(\()?/);
  if (identMatch) {
    return identMatch[2] ? `${identMatch[1]}(` : identMatch[1];
  }

  return null;
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
