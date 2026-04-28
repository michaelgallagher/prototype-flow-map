/**
 * Idempotently injects prototype-flow-map launch-args route-handler code into
 * a SwiftUI prototype for the simctl-based screenshot pipeline.
 *
 * Requires the prototype to use iOS 16+ NavigationStack(path:) with a typed
 * navigationDestination(for:) modifier. Call detectNavigationStackPattern()
 * first to gate — if it returns false, fall back to the XCUITest path.
 *
 * Inject targets:
 *  1. App entry point (@main struct) — skip splash/loading animation
 *  2. NavigationHost (owns NavigationStack(path:)) — .task dispatcher,
 *     .navigationDestination(for: String.self), flowMapSubDestination() helper
 *  3. Parent views with sheet/fullScreenCover children — .task to open modals
 *
 * All injections are idempotent (guarded by a sentinel comment) and are
 * reverted by calling the cleanup function returned by injectFlowMapRouteHandler.
 */

const fs = require("fs");
const path = require("path");
const { globSync } = require("glob");

const SENTINEL = "// [flow-map-injected]";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether the prototype uses the iOS 16+ NavigationStack(path:) pattern
 * that the launch-args injector supports. Call before injecting.
 *
 * @param {string} prototypePath
 * @returns {boolean}
 */
function detectNavigationStackPattern(prototypePath) {
  const swiftFiles = globSync("**/*.swift", {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/*Tests*/**", "**/Pods/**"],
  });

  for (const f of swiftFiles) {
    const content = fs.readFileSync(f, "utf-8");
    if (
      content.includes("NavigationStack(path:") ||
      content.includes("NavigationStack(path :")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Inject the flow-map route-handler code into the prototype.
 *
 * @param {object} graph - { nodes, edges } from swift-graph-builder
 * @param {string} prototypePath
 * @param {object[]} parsedViews - array of parsed view objects from swift-parser
 * @returns {{ cleanup: function, routePlan: object }} cleanup restores files;
 *   routePlan is the set of routes the runner should loop over.
 */
function injectFlowMapRouteHandler(graph, prototypePath, parsedViews) {
  const backups = []; // { filePath, original }

  function backup(filePath, content) {
    backups.push({ filePath, original: content });
  }

  // Build a map of viewName → parsed view data for fast lookup
  const viewMap = new Map(parsedViews.map((v) => [v.name, v]));

  // 1. Find the NavigationHost file
  const hostInfo = findNavigationHost(prototypePath);
  if (!hostInfo) {
    throw new Error(
      "Could not find a NavigationStack(path:) host view. " +
        "Ensure the prototype uses iOS 16+ path-based navigation.",
    );
  }
  const { filePath: hostFile, enumType } = hostInfo;
  const hostContent = fs.readFileSync(hostFile, "utf-8");

  // 2. Parse enum-case → view-name mapping from the existing navigationDestination switch
  const caseMap = parseCaseMap(hostContent, enumType, prototypePath);

  // 3. Build the full route plan from the graph
  const routePlan = buildRoutePlan(graph, caseMap);

  // 4. Inject NavigationHost
  if (!hostContent.includes(SENTINEL)) {
    const injected = injectIntoNavigationHost(hostContent, routePlan, enumType);
    backup(hostFile, hostContent);
    fs.writeFileSync(hostFile, injected, "utf-8");
  }

  // 5. Inject App.swift splash-skip
  const appInfo = injectAppSplashSkip(prototypePath, backup);
  void appInfo; // may be null if no splash pattern found

  // 6. Inject parent-view sheet/cover triggers
  injectSheetTriggers(graph, viewMap, prototypePath, routePlan, backup);

  function cleanup() {
    for (const { filePath, original } of backups) {
      try {
        fs.writeFileSync(filePath, original, "utf-8");
      } catch (err) {
        console.warn(`   ⚠️  Could not restore ${filePath}: ${err.message}`);
      }
    }
  }

  return { cleanup, routePlan };
}

// ---------------------------------------------------------------------------
// Route plan
// ---------------------------------------------------------------------------

/**
 * Build the set of routes we'll capture, derived from the graph.
 *
 * Returns an object:
 *   routePlan.level1Routes  — [{ routeKey, viewName, caseExpr }]
 *     routeKey:  the string used in the route arg (e.g. "messages")
 *     viewName:  SwiftUI view name (e.g. "MessagesView")
 *     caseExpr:  enum expression (e.g. ".messages" or "NavigationDestination.messages")
 *
 *   routePlan.pushRoutes    — [{ routeKey, viewName }]
 *     routeKey:  the String value pushed to navigationPath (= viewName)
 *     viewName:  SwiftUI view name
 *
 *   routePlan.allRoutes     — [{ route, nodeId }]
 *     route:  full "/" delimited route string
 *     nodeId: graph node id
 *
 *   routePlan.sheetRoutes   — [{ route, parentViewName, stateVar, nodeId }]
 *     parentViewName: the view that owns the sheet @State var
 *     stateVar:       the @State var to set true (if known)
 *
 *   routePlan.pushableViews — Set<string> of viewName that can be pushed as Strings
 */
function buildRoutePlan(graph, caseMap) {
  // Build adjacency: source → [{ target, edgeType }]
  const adj = new Map();
  for (const edge of graph.edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source).push({ target: edge.target, type: edge.type });
  }

  const level1Routes = [];
  const pushRoutes = [];
  const allRoutes = [];
  const sheetRoutes = [];

  // Collect all nodes reachable via link edges from level-1 nodes (the enum cases)
  const level1ViewNames = new Set(caseMap.values());

  // BFS: for each level-1 node, collect its push-reachable descendants
  for (const [routeKey, viewName] of caseMap) {
    const l1Node = graph.nodes.find((n) => n.id === viewName || n.label === viewName);
    if (!l1Node) continue;

    const caseExpr = `.${routeKey}`;
    level1Routes.push({ routeKey, viewName, caseExpr });
    allRoutes.push({ route: routeKey, nodeId: l1Node.id });

    // BFS from level-1 node for push-navigation descendants
    const visited = new Set([l1Node.id]);
    const queue = [{ nodeId: l1Node.id, prefix: routeKey }];

    while (queue.length > 0) {
      const { nodeId, prefix } = queue.shift();
      for (const { target, type } of adj.get(nodeId) || []) {
        if (visited.has(target)) continue;
        visited.add(target);

        const targetNode = graph.nodes.find((n) => n.id === target);
        if (!targetNode) continue;

        if (type === "link") {
          // Push navigation — can address via String path
          const routeKey2 = targetNode.id; // viewName as the route key
          const fullRoute = `${prefix}/${routeKey2}`;
          pushRoutes.push({ routeKey: routeKey2, viewName: targetNode.id });
          allRoutes.push({ route: fullRoute, nodeId: targetNode.id });
          queue.push({ nodeId: target, prefix: fullRoute });
        } else if (type === "sheet" || type === "full-screen") {
          // Sheet/cover — triggered by parent view's .task, not path push
          const parentViewName = graph.nodes.find((n) => n.id === nodeId)?.id || nodeId;
          const fullRoute = `${prefix}/${targetNode.id}`;
          sheetRoutes.push({
            route: fullRoute,
            parentViewName,
            stateVar: null, // resolved later by injectSheetTriggers
            nodeId: targetNode.id,
          });
          allRoutes.push({ route: fullRoute, nodeId: targetNode.id });
          // Don't BFS deeper through sheets — they're modal roots
        }
      }
    }
  }

  // Deduplicate pushRoutes by viewName
  const seenPush = new Set();
  const dedupedPushRoutes = pushRoutes.filter(({ viewName }) => {
    if (seenPush.has(viewName)) return false;
    seenPush.add(viewName);
    return true;
  });

  const pushableViews = new Set(dedupedPushRoutes.map((r) => r.viewName));

  return { level1Routes, pushRoutes: dedupedPushRoutes, allRoutes, sheetRoutes, pushableViews };
}

// ---------------------------------------------------------------------------
// NavigationHost injection
// ---------------------------------------------------------------------------

/**
 * Find the Swift file that contains NavigationStack(path: $...) — the NavigationHost.
 * Returns { filePath, enumType } or null.
 */
function findNavigationHost(prototypePath) {
  const swiftFiles = globSync("**/*.swift", {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/*Tests*/**", "**/Pods/**"],
  });

  for (const filePath of swiftFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes("NavigationStack(path:") && !content.includes("NavigationStack(path :")) {
      continue;
    }
    // Extract the enum type from: navigationDestination(for: <Type>.self)
    const enumMatch = content.match(/\.navigationDestination\(for:\s*([A-Z][A-Za-z0-9_]+)\.self/);
    if (!enumMatch) continue;
    return { filePath, enumType: enumMatch[1] };
  }
  return null;
}

/**
 * Parse the existing navigationDestination switch in the NavigationHost to build
 * a Map of routeKey → viewName.
 *
 * Looks for patterns like:
 *   case .messages: MessagesView()
 *   case .profile: ProfileView()
 */
function parseCaseMap(hostContent, enumType, prototypePath) {
  const caseMap = new Map();

  // Find the switch block inside navigationDestination(for: EnumType.self)
  const ndPattern = new RegExp(
    `\\.navigationDestination\\(for:\\s*${enumType}\\.self[^{]*\\{[^{]*switch[^{]*\\{([\\s\\S]*?)\\}\\s*\\}\\s*\\}`,
    "m",
  );
  const ndMatch = hostContent.match(ndPattern);
  if (!ndMatch) return caseMap;

  const switchBody = ndMatch[1];

  // Match: case .<caseName>: <ViewName>(...)  or  case .<caseName>:\n  <ViewName>(...)
  const casePattern = /case\s+\.([a-z][A-Za-z0-9_]*):\s*\n?\s*([A-Z][A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = casePattern.exec(switchBody)) !== null) {
    caseMap.set(m[1], m[2]); // routeKey → viewName
  }

  return caseMap;
}

/**
 * Inject the flow-map code into the NavigationHost file content.
 *
 * Three insertions:
 *  A. Inside the NavigationStack content (after existing navigationDestination(for: EnumType.self)):
 *     .navigationDestination(for: String.self) { ... }
 *
 *  B. Outside the NavigationStack (as a .task on the List/root, or after closing brace):
 *     .task { ... route dispatcher ... }
 *
 *  C. Bottom of struct: flowMapSubDestination() @ViewBuilder helper
 */
function injectIntoNavigationHost(content, routePlan, enumType) {
  const { level1Routes, pushRoutes, pushableViews } = routePlan;

  // -- A: .navigationDestination(for: String.self) --
  // Insert it after the existing .navigationDestination(for: EnumType.self) { ... } block
  const ndEnumPattern = new RegExp(
    `(\\.navigationDestination\\(for:\\s*${enumType}\\.self[^{]*\\{[\\s\\S]*?^\\s*\\})`,
    "m",
  );
  // The block ends at the closing } of the closure — we need to find it with brace-counting
  const ndStringHandler = `\n            .navigationDestination(for: String.self) { viewName in\n                ${SENTINEL}\n                flowMapSubDestination(viewName)\n            }`;

  let result = content;

  // Find the navigationDestination(for: EnumType.self) block and insert after it
  const insertAfterEnum = insertAfterNavigationDestination(content, enumType, ndStringHandler);
  if (insertAfterEnum) {
    result = insertAfterEnum;
  }

  // -- B: .task dispatcher --
  // Insert as a modifier on the NavigationStack (after its closing brace + .id() if present)
  const taskCode = generateTaskCode(level1Routes, pushableViews, enumType);
  result = insertTaskAfterNavigationStack(result, taskCode);

  // -- C: flowMapSubDestination helper --
  const helperCode = generateHelperFunction(pushRoutes);
  result = insertHelperAtStructBottom(result, helperCode);

  return result;
}

function insertAfterNavigationDestination(content, enumType, insertion) {
  // Find the start of .navigationDestination(for: EnumType.self)
  const startPattern = new RegExp(
    `\\.navigationDestination\\(for:\\s*${enumType}\\.self`,
  );
  const startMatch = startPattern.exec(content);
  if (!startMatch) return null;

  // Count braces from the opening { of the trailing closure
  let pos = startMatch.index + startMatch[0].length;
  // Skip to the first {
  while (pos < content.length && content[pos] !== "{") pos++;
  if (pos >= content.length) return null;

  // Count balanced braces to find the closing } of the closure
  let depth = 0;
  let end = pos;
  while (end < content.length) {
    if (content[end] === "{") depth++;
    else if (content[end] === "}") {
      depth--;
      if (depth === 0) { end++; break; }
    }
    end++;
  }

  // Check if String handler already injected
  if (content.slice(startMatch.index, end + 200).includes("for: String.self")) return null;

  return content.slice(0, end) + insertion + content.slice(end);
}

function insertTaskAfterNavigationStack(content, taskCode) {
  // Don't re-inject if already present
  if (content.includes(SENTINEL)) return content;

  // Find the NavigationStack's closing brace by brace-counting from "NavigationStack(path:"
  const nsStart = content.search(/NavigationStack\(path:/);
  if (nsStart === -1) return content;

  // Find the opening { of the NavigationStack content
  let pos = nsStart + "NavigationStack(path:".length;
  while (pos < content.length && content[pos] !== "{") pos++;
  if (pos >= content.length) return content;

  // Count braces to find closing }
  let depth = 0;
  let end = pos;
  while (end < content.length) {
    if (content[end] === "{") depth++;
    else if (content[end] === "}") {
      depth--;
      if (depth === 0) { end++; break; }
    }
    end++;
  }

  // Skip past .id(...) if present
  const afterNs = content.slice(end);
  const idMatch = afterNs.match(/^(\s*\.id\([^)]+\))/);
  if (idMatch) end += idMatch[1].length;

  return content.slice(0, end) + "\n" + taskCode + content.slice(end);
}

function insertHelperAtStructBottom(content, helperCode) {
  // Insert before the last closing brace of the struct (before the #Preview blocks)
  const previewIdx = content.search(/\n#Preview/);
  if (previewIdx !== -1) {
    return content.slice(0, previewIdx) + "\n" + helperCode + "\n" + content.slice(previewIdx);
  }
  // Fallback: before the final closing brace
  const lastBrace = content.lastIndexOf("\n}");
  if (lastBrace !== -1) {
    return content.slice(0, lastBrace) + "\n" + helperCode + "\n" + content.slice(lastBrace);
  }
  return content + "\n" + helperCode;
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

function generateTaskCode(level1Routes, pushableViews, enumType) {
  const cases = level1Routes
    .map(
      ({ routeKey, caseExpr }) =>
        `        case "${routeKey}": level1 = ${caseExpr}`,
    )
    .join("\n");

  const pushableArray = [...pushableViews]
    .map((v) => `            "${v}"`)
    .join(",\n");

  return `        .task {
            ${SENTINEL}
            // prototype-flow-map: read -flowMapRoute launch arg and dispatch navigation.
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-flowMapRoute"), i + 1 < args.count else { return }
            let segments = args[i + 1].split(separator: "/").map(String.init)
            guard let first = segments.first else { return }
            let level1: ${enumType}?
            switch first {
${cases}
            default: level1 = nil
            }
            guard let level1 else { return }
            let pushableViews: Set<String> = [
${pushableArray}
            ]
            navigationPath = NavigationPath()
            navigationPath.append(level1)
            for segment in segments.dropFirst() {
                guard pushableViews.contains(segment) else { break }
                navigationPath.append(segment)
            }
        }`;
}

function generateHelperFunction(pushRoutes) {
  const cases = pushRoutes
    .map(({ viewName }) => `        case "${viewName}": ${viewName}()`)
    .join("\n");

  return `    // prototype-flow-map: resolve String navigation path segments to views.
    ${SENTINEL}
    @ViewBuilder
    private func flowMapSubDestination(_ viewName: String) -> some View {
        switch viewName {
${cases}
        default: EmptyView()
        }
    }`;
}

// ---------------------------------------------------------------------------
// App.swift splash-skip injection
// ---------------------------------------------------------------------------

/**
 * Find the @main App struct and inject a splash-skip when -flowMapRoute is present.
 * Targets the common pattern of an @State showSplash / isLoading bool.
 *
 * Returns true if injected, false if no matching pattern found (non-fatal).
 */
function injectAppSplashSkip(prototypePath, backup) {
  const swiftFiles = globSync("**/*.swift", {
    cwd: prototypePath,
    absolute: true,
    ignore: ["**/*Tests*/**", "**/Pods/**"],
  });

  for (const filePath of swiftFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes("@main")) continue;
    if (content.includes(SENTINEL)) continue; // already injected

    // Look for a common splash State pattern:
    // @State private var showSplash: Bool = true  or  = State(initialValue: true)
    const splashVarMatch = content.match(
      /@State\s+(?:private\s+)?var\s+(show(?:Splash|Loading|Launch)|isLoading|isSplashVisible)\s*:\s*Bool/,
    );
    if (!splashVarMatch) continue;

    const varName = splashVarMatch[1];

    // Inject an init() that sets the var to false when -flowMapRoute is present.
    // Strategy: find the struct declaration line and insert init() after the
    // State property declarations block.
    const initInjection = `
    ${SENTINEL}
    init() {
        // prototype-flow-map: skip splash/animation when launched with -flowMapRoute.
        if ProcessInfo.processInfo.arguments.contains("-flowMapRoute") {
            self._${varName} = State(initialValue: false)
        }
    }
`;

    // Insert after the last @State property declaration block, before `var body`
    const bodyIdx = content.search(/\n\s{4}var body\s*:/);
    if (bodyIdx === -1) continue;

    const injected = content.slice(0, bodyIdx) + "\n" + initInjection + content.slice(bodyIdx);
    backup(filePath, content);
    fs.writeFileSync(filePath, injected, "utf-8");
    return { filePath, varName };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sheet/cover trigger injection
// ---------------------------------------------------------------------------

/**
 * For each sheet/fullScreenCover route in the plan, find the parent view file
 * and inject a .task that reads the launch arg and sets the controlling @State var.
 */
function injectSheetTriggers(graph, viewMap, prototypePath, routePlan, backup) {
  // Group sheet routes by parentViewName
  const byParent = new Map();
  for (const sr of routePlan.sheetRoutes) {
    if (!byParent.has(sr.parentViewName)) byParent.set(sr.parentViewName, []);
    byParent.get(sr.parentViewName).push(sr);
  }

  for (const [parentViewName, sheetRoutes] of byParent) {
    const parsedView = viewMap.get(parentViewName);
    if (!parsedView || !parsedView.filePath) continue;

    const filePath = path.resolve(prototypePath, parsedView.filePath);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf-8");
    if (content.includes(SENTINEL)) continue;

    // For each sheet route, find the @State var that controls it
    const triggers = resolveSheetStateVars(content, sheetRoutes, routePlan);
    if (triggers.length === 0) continue;

    const taskCode = generateSheetTriggerTask(parentViewName, triggers);

    // Insert before the first .alert( or .sheet( or end-of-body
    const injected = insertSheetTriggerTask(content, taskCode);
    backup(filePath, content);
    fs.writeFileSync(filePath, injected, "utf-8");
  }
}

/**
 * For each sheet route, find the @State var name that controls it.
 * Looks for .sheet(isPresented: $<var>) / .fullScreenCover(isPresented: $<var>)
 * followed by a block containing the target view name.
 */
function resolveSheetStateVars(content, sheetRoutes, routePlan) {
  const triggers = [];

  // Match: .sheet(isPresented: $<var>) { ... <ViewName>() ... }
  // or:    .fullScreenCover(isPresented: $<var>) { ... <ViewName>() ... }
  const modalPattern =
    /\.(sheet|fullScreenCover)\(isPresented:\s*\$([A-Za-z_][A-Za-z0-9_]*)[^{]*\{([\s\S]*?)\n\s{8}\}/gm;

  let m;
  while ((m = modalPattern.exec(content)) !== null) {
    const stateVar = m[2];
    const closureBody = m[3];

    // Find which sheet route targets a view present in this closure
    for (const sr of sheetRoutes) {
      if (closureBody.includes(sr.nodeId + "()") || closureBody.includes(sr.nodeId + " ")) {
        // Build a route segment hint from the full route string
        const segments = sr.route.split("/");
        const leafSegment = segments[segments.length - 1];
        triggers.push({
          stateVar,
          routeSegment: leafSegment,
          routeFull: sr.route,
          parentViewName: sr.parentViewName,
        });
      }
    }
  }

  return triggers;
}

function generateSheetTriggerTask(parentViewName, triggers) {
  const parentSegment = triggers[0]?.routeFull.split("/")[0] ?? "";
  const parentSegmentGuess = parentViewName; // e.g. "ProfileView"

  // Group switches by route prefix (the parent view's route key)
  const cases = triggers
    .map(({ stateVar, routeSegment }) => `            case "${routeSegment}": ${stateVar} = true`)
    .join("\n");

  // The guard checks that segments[0] matches the level-1 key, segments[-2] matches
  // the parent view name (for level-2+ parents), and segments.last is the leaf.
  return `        .task {
            ${SENTINEL}
            // prototype-flow-map: open sheet/cover when route targets a modal child.
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-flowMapRoute"), i + 1 < args.count else { return }
            let segments = args[i + 1].split(separator: "/").map(String.init)
            guard segments.count > 1 else { return }
            guard segments.contains("${parentSegmentGuess}") || segments.first == "${parentSegment}" else { return }
            let leaf = segments.last ?? ""
            switch leaf {
${cases}
            default: break
            }
        }`;
}

function insertSheetTriggerTask(content, taskCode) {
  // Insert before the first .alert( modifier, or before .sheet(isPresented:,
  // or as the last modifier before the closing brace of body.
  const alertIdx = content.search(/\n\s+\.alert\(/);
  if (alertIdx !== -1) {
    return content.slice(0, alertIdx) + "\n" + taskCode + content.slice(alertIdx);
  }
  // Fallback: insert before the first .sheet(
  const sheetIdx = content.search(/\n\s+\.sheet\(/);
  if (sheetIdx !== -1) {
    return content.slice(0, sheetIdx) + "\n" + taskCode + content.slice(sheetIdx);
  }
  // Last resort: before final closing brace
  const lastBrace = content.lastIndexOf("\n    }");
  if (lastBrace !== -1) {
    return content.slice(0, lastBrace) + "\n" + taskCode + content.slice(lastBrace);
  }
  return content + "\n" + taskCode;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  detectNavigationStackPattern,
  injectFlowMapRouteHandler,
  buildRoutePlan, // exported for testing
  parseCaseMap,   // exported for testing
};
