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
  const startDestinations = []; // canonical route strings from NavHost(startDestination = ...)
  // Seed-data lookup: class name → [id, id, ...] in source order, across all files.
  // Used to supply realistic defaults for parameterized routes that read from
  // a ViewModel collection (e.g. `getTrustedPerson("trusted-1")`).
  const seedIdsByClass = new Map();
  // Getter function name → return class (e.g. "getTrustedPerson" → "TrustedAccessPerson").
  const getterReturnType = new Map();

  // URL bindings harvested from WebFlowConfig-style constructors anywhere in
  // the project. Screens that refer to these bindings by name (e.g.
  // `activeWebFlow = PrescriptionWebFlow.RepeatPrescription`) then get the
  // underlying URL attributed as an external link.
  //
  // Keyed on both bare property name (`RepeatPrescription`) and
  // object-qualified name (`PrescriptionWebFlow.RepeatPrescription`).
  const urlBindings = new Map();

  for (const filePath of kotlinFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    const stripped = stripKotlinComments(content);

    extractRouteConstants(stripped, routeConstants);
    extractRouteHelpers(stripped, routeHelpers);
    extractBottomNavItems(stripped, bottomNavItems, routeConstants);
    extractInlineNavItems(stripped, bottomNavItems, routeConstants);
    extractSeedIds(stripped, seedIdsByClass);
    extractGetterReturnTypes(stripped, getterReturnType);
    extractUrlBindings(stripped, urlBindings);
  }

  // Pass 2: parse NavHost composable() registrations and screen navigate() calls
  const screensByRoute = new Map();

  for (const filePath of kotlinFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    const stripped = stripKotlinComments(content);
    const relativePath = path.relative(projectPath, filePath);

    // Extract NavHost composable() registrations + startDestination
    extractNavHostEntries(stripped, navHostEntries, routeConstants, filePath, startDestinations, seedIdsByClass, getterReturnType);

    // Extract navController.navigate() calls from screen files
    extractNavigations(stripped, filePath, relativePath, routeConstants, routeHelpers, screensByRoute);

    // Extract navController.navigate() calls from NavHost composable lambdas
    extractNavHostNavigations(stripped, filePath, relativePath, routeConstants, routeHelpers, navHostEntries, screensByRoute);

    // Extract openTab() calls
    extractExternalLinks(stripped, filePath, relativePath, screensByRoute, urlBindings);
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
      isStartDestination: false,
      navArgs: entry.navArgs || [],
    });
  }

  // Mark the NavHost startDestination (first one parsed wins if multiple)
  const canonicalStart = startDestinations.length > 0
    ? canonicalizeRoute(startDestinations[0])
    : null;
  if (canonicalStart) {
    const startScreen = results.find((r) => r.route === canonicalStart);
    if (startScreen) startScreen.isStartDestination = true;
  }

  // Attach bottom nav items to the startDestination screen (falls back to first result)
  // Dedupe by canonical route in case the same tab was picked up by multiple detectors.
  if (bottomNavItems.length > 0 && results.length > 0) {
    const hostScreen =
      (canonicalStart && results.find((r) => r.route === canonicalStart)) ||
      results[0];
    const seen = new Set();
    const deduped = [];
    for (const item of bottomNavItems) {
      const resolved = resolveRouteRef(item.routeRef, routeConstants) || item.route;
      const canon = canonicalizeRoute(resolved);
      if (seen.has(canon)) continue;
      seen.add(canon);
      deduped.push({ route: resolved, label: item.label });
    }
    hostScreen.bottomNavItems = deduped;
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
 * Extract bottom-nav entries from inline NavItem(...) list patterns, e.g.:
 *   listOf(
 *     NavItem("Home", "home", Icons.Default.Home, ...),
 *     NavItem("Messages", "messages", ...),
 *   )
 * Accepts both positional (label, route) and named (label = "...", route = "...") forms.
 * Silently ignores NavItem calls where label/route aren't string literals.
 */
function extractInlineNavItems(content, bottomNavItems, routeConstants) {
  // Capture only if preceded by `listOf(` or `,\s*` within a few hundred chars —
  // cheap guard against unrelated `NavItem` types that aren't bottom-nav lists.
  // In practice this prototype's shape is `listOf(NavItem(...), NavItem(...), ...)`.
  const navItemRe = /\bNavItem\s*\(/g;
  const seenRoutes = new Set(bottomNavItems.map((i) => i.route));
  let match;
  while ((match = navItemRe.exec(content)) !== null) {
    const closeParenIdx = findMatchingParen(content, match.index + match[0].length - 1);
    if (closeParenIdx === -1) continue;
    const args = content.slice(match.index + match[0].length, closeParenIdx);

    // Named args take precedence.
    const namedLabel = args.match(/\blabel\s*=\s*"([^"]+)"/);
    const namedRoute = args.match(/\broute\s*=\s*(Routes\.\w+|"([^"]+)")/);

    let label = namedLabel ? namedLabel[1] : null;
    let routeRaw = null;
    if (namedRoute) {
      routeRaw = namedRoute[1];
    } else {
      // Positional: first two string literals are label, route.
      const strings = [...args.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      if (strings.length >= 2) {
        label = label || strings[0];
        routeRaw = `"${strings[1]}"`;
      }
    }
    if (!routeRaw || !label) continue;

    const isRoutesRef = routeRaw.startsWith("Routes.");
    const resolvedRoute = isRoutesRef
      ? resolveRouteRef(routeRaw, routeConstants) || routeRaw.replace("Routes.", "")
      : routeRaw.replace(/^"|"$/g, "");

    if (seenRoutes.has(resolvedRoute)) continue;
    seenRoutes.add(resolvedRoute);

    bottomNavItems.push({
      route: resolvedRoute,
      label,
      routeRef: isRoutesRef ? routeRaw : null,
    });
  }
}

/**
 * Extract composable() route registrations from NavHost blocks.
 */
function extractNavHostEntries(content, navHostEntries, routeConstants, filePath, startDestinations, seedIdsByClass, getterReturnType) {
  // Find NavHost blocks
  const navHostRe = /\bNavHost\s*\(/g;
  let match;
  while ((match = navHostRe.exec(content)) !== null) {
    const closeParenIdx = findMatchingParen(content, match.index + match[0].length - 1);
    if (closeParenIdx === -1) continue;

    // Capture startDestination from NavHost args (positional or named).
    // Example shapes: NavHost(navController, startDestination = "home") { ... }
    //                 NavHost(startDestination = Routes.home, ...) { ... }
    if (startDestinations) {
      const navHostArgs = content.slice(match.index + match[0].length - 1, closeParenIdx + 1);
      const startDestMatch = navHostArgs.match(/\bstartDestination\s*=\s*(Routes\.\w+|"([^"]+)"|[A-Z][A-Za-z0-9]+)/);
      if (startDestMatch) {
        const raw = startDestMatch[1];
        let resolved = null;
        if (raw.startsWith('"')) resolved = raw.slice(1, -1);
        else if (raw.startsWith("Routes.")) resolved = resolveRouteRef(raw, routeConstants) || raw.replace("Routes.", "");
        else resolved = routeConstants.get(raw) || null;
        if (resolved) startDestinations.push(resolved);
      }
    }

    // Locate the NavHost body: either the trailing lambda after its closing `)`,
    // or (rare) a `builder = { ... }` inside the args. Prefer the trailing lambda.
    // Fall back to a generous range so we don't miss composables in long files.
    let bodyStart = match.index;
    let bodyEnd = content.length;
    const afterClose = content.slice(closeParenIdx + 1);
    const trailingBrace = afterClose.match(/^\s*\{/);
    if (trailingBrace) {
      const lambdaStart = closeParenIdx + 1 + trailingBrace.index;
      const lambda = findClosureAt(content, lambdaStart);
      if (lambda) {
        bodyStart = lambdaStart;
        bodyEnd = lambda.end + 1;
      }
    }
    const searchContent = content.slice(bodyStart, bodyEnd);

    // Find composable() registrations
    const composableRe = /\bcomposable\s*\(/g;
    let compMatch;
    while ((compMatch = composableRe.exec(searchContent)) !== null) {
      const compStart = bodyStart + compMatch.index;
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

      // Extract navArgument declarations from the composable() args.
      // Supports both builder form:
      //   navArgument("id") { type = NavType.StringType; defaultValue = "1" }
      // and call form:
      //   navArgument("id") { type = NavType.StringType }
      const navArgs = extractNavArguments(compArgs);

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
        // Try to infer a realistic sample value for each placeholder param by
        // looking at the lambda body for `viewModel.getXxx(paramName)` calls and
        // following the getter's return type to a seed-data list of that class.
        if (seedIdsByClass && getterReturnType) {
          resolveSampleValues(lambda.content, navArgs, seedIdsByClass, getterReturnType);
        }
        navHostEntries.push({ route, composableName, filePath, isModal, navArgs });
      }
    }

    break; // Only process the first NavHost per file
  }
}

/**
 * Scan constructor-style calls `ClassName( ... id = "..." ... )` and record
 * the first string id assigned inside each. Used later to supply a realistic
 * value for a `{personId}`-style placeholder when the Compose navArgument has
 * no declared default.
 *
 * Prioritizes ids that appear inside seed-state regions:
 *   MutableStateFlow( listOf(ClassName(id = "...")) )
 *   fun defaultXxx(): List<X> = listOf(ClassName(id = "..."))
 * so that preview/addable/test-only constructors don't mask the real seed.
 * Non-priority occurrences are still recorded as a fallback.
 *
 * Only captures ids at the top level of a constructor's args (depth 0), so
 * nested calls like `Color(...)` don't leak into the outer class's list.
 */
function extractSeedIds(content, seedIdsByClass) {
  const skipRe = /^(listOf|setOf|mapOf|arrayOf|List|Set|Map|Color|Modifier|MutableStateFlow|StateFlow|Pair|Triple|remember|mutableStateOf)$/;

  // First, find priority regions: MutableStateFlow(...) and `default\w+()` bodies.
  const priorityRanges = [];
  const msfRe = /\bMutableStateFlow\s*\(/g;
  let pm;
  while ((pm = msfRe.exec(content)) !== null) {
    const open = pm.index + pm[0].length - 1;
    const close = findMatchingParen(content, open);
    if (close !== -1) priorityRanges.push([open + 1, close]);
  }
  const defRe = /\bfun\s+default\w+\s*\(\s*\)\s*:[^=]*=\s*/g;
  let dm;
  while ((dm = defRe.exec(content)) !== null) {
    // Body is the expression after `=`. Take until the first matching `)` of a
    // `listOf(` immediately following, or the next top-level newline+close — for
    // robustness we allow a generous window up to the end of a matching listOf.
    const after = content.slice(dm.index + dm[0].length);
    const listOfMatch = after.match(/^listOf\s*\(/);
    if (!listOfMatch) continue;
    const open = dm.index + dm[0].length + listOfMatch[0].length - 1;
    const close = findMatchingParen(content, open);
    if (close !== -1) priorityRanges.push([open + 1, close]);
  }

  function inPriorityRange(idx) {
    for (const [s, e] of priorityRanges) if (idx >= s && idx <= e) return true;
    return false;
  }

  const ctorRe = /\b([A-Z]\w+)\s*\(/g;
  let match;
  while ((match = ctorRe.exec(content)) !== null) {
    const className = match[1];
    if (skipRe.test(className)) continue;
    const openParen = match.index + match[0].length - 1;
    const close = findMatchingParen(content, openParen);
    if (close === -1) continue;
    const body = content.slice(openParen + 1, close);
    const id = findTopLevelId(body);
    if (!id) continue;
    if (!seedIdsByClass.has(className)) seedIdsByClass.set(className, { primary: [], fallback: [] });
    const bucket = seedIdsByClass.get(className);
    const list = inPriorityRange(match.index) ? bucket.primary : bucket.fallback;
    if (!list.includes(id)) list.push(id);
  }
}

/**
 * Pick the best sample id for a given class from the bucketed seed map.
 * Primary (inside MutableStateFlow/default*()) beats fallback (previews, addable lists).
 */
function pickSampleId(bucket) {
  if (!bucket) return null;
  if (bucket.primary.length > 0) return bucket.primary[0];
  if (bucket.fallback.length > 0) return bucket.fallback[0];
  return null;
}

/**
 * Return the first `id = "..."` string assignment at paren-depth 0 of `body`.
 * Skips assignments inside nested `(...)` so we don't pick up e.g. a color arg.
 */
function findTopLevelId(body) {
  const re = /\bid\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") depth--;
    }
    if (depth === 0) return m[1];
  }
  return null;
}

/**
 * Scan for getter function declarations with explicit return types:
 *   fun getTrustedPerson(personId: String): TrustedAccessPerson? = ...
 *   fun getCaredForPerson(personId: String): CaredForPerson = ...
 *
 * Populates getterReturnType: getterName → className.
 */
function extractGetterReturnTypes(content, getterReturnType) {
  const re = /\bfun\s+(get\w+)\s*\([^)]*\)\s*:\s*([A-Z]\w+)\??/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    getterReturnType.set(m[1], m[2]);
  }
}

/**
 * For each navArg, search the composable's render lambda for a getter call
 * of the form `<receiver>.<getter>(<paramName>)`. If the getter's return type
 * maps to a known seed class, set sampleValue to that class's first seed id.
 *
 * Declared defaults and explicit overrides take precedence over sampleValue —
 * this only fills in the null/empty cases.
 */
function resolveSampleValues(lambdaBody, navArgs, seedIdsByClass, getterReturnType) {
  for (const arg of navArgs) {
    if (arg.defaultValue && arg.defaultValue !== "") continue; // declared default wins
    const callRe = new RegExp(`\\w+\\.(get\\w+)\\s*\\(\\s*${escapeRegex(arg.name)}\\b`);
    const m = lambdaBody.match(callRe);
    if (!m) continue;
    const className = getterReturnType.get(m[1]);
    if (!className) continue;
    const sampleId = pickSampleId(seedIdsByClass.get(className));
    if (!sampleId) continue;
    arg.sampleValue = sampleId;
  }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract navArgument("name") { type = NavType.X; defaultValue = Y } declarations
 * from the args of a composable() call. Returns array of { name, type, defaultValue }.
 *
 * `compArgs` is the substring inside composable(...) — typically contains an
 * `arguments = listOf(navArgument(...) { ... }, navArgument(...) { ... })` block.
 */
function extractNavArguments(compArgs) {
  const results = [];
  const navArgRe = /\bnavArgument\s*\(\s*"([^"]+)"\s*\)\s*\{/g;
  let match;
  while ((match = navArgRe.exec(compArgs)) !== null) {
    const name = match[1];
    const bodyStart = match.index + match[0].length - 1; // position of `{`
    const closure = findClosureAt(compArgs, bodyStart);
    if (!closure) continue;
    const body = closure.content;

    // type = NavType.StringType / BoolType / IntType / LongType / FloatType / ...
    const typeMatch = body.match(/\btype\s*=\s*NavType\.(\w+)/);
    const type = typeMatch ? typeMatch[1] : null;

    // defaultValue = "foo" | 123 | true | false | 1.5
    const defStrMatch = body.match(/\bdefaultValue\s*=\s*"([^"]*)"/);
    const defLitMatch = body.match(/\bdefaultValue\s*=\s*(true|false|-?\d+(?:\.\d+)?)/);
    let defaultValue = null;
    if (defStrMatch) defaultValue = defStrMatch[1];
    else if (defLitMatch) defaultValue = defLitMatch[1];

    results.push({ name, type, defaultValue });
  }
  return results;
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
 * Harvest WebFlowConfig-style URL bindings from a single file.
 *
 * Matches declarations of the form:
 *   val NAME = SomeCtor(
 *     url = "https://..."               — literal URL
 *     url = "$BASE_URL/path"            — string-interpolated URL using a
 *                                          file-local `const val BASE_URL = "..."`
 *     title = "Some label"              — optional display label
 *     ...                               — other args ignored
 *   )
 *
 * The constructor name is intentionally open — any call whose argument list
 * contains a literal `url = "..."` counts. That covers `WebFlowConfig(...)`,
 * `InAppBrowser(...)`, and any sibling patterns downstream prototypes might
 * invent without needing a hardcoded type name.
 *
 * Resolves Kotlin string interpolation against file-local `const val`
 * string constants so that `"$BASE_URL/foo"` gives back the full URL.
 *
 * Writes both the bare and object-qualified forms into `bindings`:
 *   "RepeatPrescription" → { url, label }
 *   "PrescriptionWebFlow.RepeatPrescription" → { url, label }
 * so downstream lookup handles both `.X` and qualified `.Obj.X` references.
 */
function extractUrlBindings(content, bindings) {
  // File-local string constants (supports `const val`, `private const val`,
  // etc.; optional `: String` type annotation).
  const stringConstants = new Map();
  const constRe =
    /\b(?:public\s+|private\s+|internal\s+|protected\s+)?(?:const\s+)?val\s+(\w+)\s*(?::\s*String)?\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let cmatch;
  while ((cmatch = constRe.exec(content)) !== null) {
    stringConstants.set(cmatch[1], cmatch[2]);
  }

  // Track `object Name { ... }` brace-spans so we can qualify bindings.
  const objectBlocks = [];
  const objRe = /\bobject\s+(\w+)\s*\{/g;
  let omatch;
  while ((omatch = objRe.exec(content)) !== null) {
    const openBrace = content.indexOf("{", omatch.index);
    if (openBrace === -1) continue;
    const closure = findClosureAt(content, openBrace);
    if (!closure) continue;
    objectBlocks.push({
      name: omatch[1],
      start: openBrace,
      end: closure.end,
    });
  }

  // Find `val Name = SomeCtor(` and capture the argument block.
  const valRe = /\bval\s+(\w+)\s*=\s*(\w+)\s*\(/g;
  let vmatch;
  while ((vmatch = valRe.exec(content)) !== null) {
    const name = vmatch[1];
    const openParen = content.indexOf("(", vmatch.index + vmatch[0].length - 1);
    const closeParen = findMatchingParen(content, openParen);
    if (closeParen === -1) continue;
    const argsBlock = content.slice(openParen + 1, closeParen);

    // Extract `url = "..."` — only the first occurrence.
    const urlMatch = /\burl\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(argsBlock);
    if (!urlMatch) continue;

    let url = urlMatch[1];
    // Resolve `$CONST` and `${CONST}` interpolations using file-local constants.
    url = url.replace(/\$\{(\w+)\}/g, (m, key) =>
      stringConstants.has(key) ? stringConstants.get(key) : m,
    );
    url = url.replace(/\$(\w+)/g, (m, key) =>
      stringConstants.has(key) ? stringConstants.get(key) : m,
    );

    if (!/^https?:\/\//i.test(url)) continue;

    // Optional label from a sibling `title = "..."` argument.
    const titleMatch = /\btitle\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(argsBlock);
    const label = titleMatch ? titleMatch[1] : null;

    const entry = { url, label };

    // Qualify via the nearest enclosing `object Name { ... }`, if any.
    const enclosing = objectBlocks.find(
      (b) => vmatch.index > b.start && vmatch.index < b.end,
    );
    if (enclosing) {
      bindings.set(`${enclosing.name}.${name}`, entry);
    }
    // Bare form — only set if not already claimed by a different qualified
    // owner, otherwise later files' bindings can stomp earlier ones. When
    // multiple objects define the same bare name, the qualified form is the
    // safe way to disambiguate in downstream lookups.
    if (!bindings.has(name)) {
      bindings.set(name, entry);
    }
  }
}

/**
 * Extract external / web-handoff URLs from screen files. Recognizes:
 *   openTab(context, "https://...")                     — Chrome Custom Tabs helper
 *   InAppBrowser(url = "https://...", ...)              — embedded WebView composable
 *   InAppBrowser("https://...", ...)                    — positional variant
 *   CustomTabsIntent.Builder()...launchUrl(ctx, Uri.parse("https://..."))
 *
 * Also resolves indirections through a cross-file URL-binding map:
 *   activeWebFlow = PrescriptionWebFlow.RepeatPrescription
 *   activeWebFlow = RepeatPrescription
 *   InAppBrowser(url = SomeConfig.url, ...)  (via the `X = Y` assignment if
 *                                              `Y` was previously declared
 *                                              as a WebFlowConfig-style binding)
 *
 * Pure runtime indirection that can't be name-matched (e.g. `url = param.url`
 * where `param` is a function argument) is still skipped.
 */
function extractExternalLinks(content, filePath, relativePath, screensByRoute, urlBindings) {
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
    const pushUnique = (link) => {
      if (!externalLinks.some((l) => l.url === link.url)) externalLinks.push(link);
    };

    // openTab(context, "https://...")
    const openTabRe = /openTab\s*\(\s*\w+\s*,\s*"(https?:\/\/[^"]+)"\s*\)/g;
    let otMatch;
    while ((otMatch = openTabRe.exec(body.content)) !== null) {
      pushUnique({ url: otMatch[1], label: null });
    }

    // InAppBrowser(url = "https://...", ...) and InAppBrowser("https://...", ...)
    const inAppRe = /\bInAppBrowser\s*\(\s*(?:url\s*=\s*)?"(https?:\/\/[^"]+)"/g;
    let iaMatch;
    while ((iaMatch = inAppRe.exec(body.content)) !== null) {
      pushUnique({ url: iaMatch[1], label: null });
    }

    // CustomTabsIntent.Builder()...launchUrl(ctx, Uri.parse("https://..."))
    // Only matches a literal URL inside Uri.parse(); dynamically-built URLs are
    // skipped. Allows an intervening chain of .setShowTitle(...), .build(), etc.
    const ctiRe =
      /CustomTabsIntent\.Builder\s*\(\s*\)[\s\S]{0,2000}?\.launchUrl\s*\(\s*\w+\s*,\s*Uri\.parse\s*\(\s*"(https?:\/\/[^"]+)"/g;
    let ctiMatch;
    while ((ctiMatch = ctiRe.exec(body.content)) !== null) {
      pushUnique({ url: ctiMatch[1], label: null });
    }

    // Resolve indirected assignments against the project-wide URL bindings
    // harvested in pass 1. Covers patterns like:
    //   activeWebFlow = PrescriptionWebFlow.RepeatPrescription
    //   activeCover   = .repeatPrescription      (iOS-ish; ignored here)
    // We look for any assignment of an identifier or dotted ref to a state
    // variable, then consult the bindings map. Try qualified first so the
    // object-qualified form wins when both exist.
    if (urlBindings && urlBindings.size > 0) {
      const assignRe =
        /\b(?:\w+)\s*=\s*((?:[A-Z]\w*\.)?[A-Za-z]\w*)\b/g;
      let amatch;
      const seenRefs = new Set();
      while ((amatch = assignRe.exec(body.content)) !== null) {
        const ref = amatch[1];
        if (seenRefs.has(ref)) continue;
        seenRefs.add(ref);
        const binding = urlBindings.get(ref);
        if (!binding) continue;
        pushUnique({ url: binding.url, label: binding.label });
      }
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
