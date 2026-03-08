/**
 * Generates a Swift XCUITest file that navigates to every screen in the
 * parsed graph and writes a PNG screenshot directly to a temp directory.
 *
 * Strategy:
 *  - BFS from the root node(s) using only "link" and "tab" edges.
 *  - For each reachable screen, produce a test method that launches the app
 *    fresh, taps through the path, then writes a screenshot to disk.
 *  - Tab taps use XCUIApplication.tabBars; all other taps use a helper
 *    that tries both the edge label and the destination node's display label,
 *    since HubRowLink accessibility labels come from hubType.title which may
 *    differ from the enum case name stored on the edge.
 */

const NAVIGABLE_EDGE_TYPES = new Set(["link", "tab"]);
const MODAL_EDGE_TYPES = new Set(["sheet", "full-screen"]);

/**
 * Sanitize a node ID for use as a filesystem filename / Swift identifier.
 * Replaces all non-alphanumeric characters with `_` and truncates to 200 chars.
 */
function sanitizeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, "_").slice(0, 200);
}

/**
 * Generate the full Swift test file content.
 *
 * @param {object} graph - { nodes, edges }
 * @param {string} screenshotsDir - absolute path on the Mac host where PNGs are written
 * @returns {string} Swift source code
 */
function generateXCUITest(graph, screenshotsDir) {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // Find root nodes: screen nodes with no incoming link/tab edges
  const hasIncoming = new Set(
    graph.edges
      .filter((e) => NAVIGABLE_EDGE_TYPES.has(e.type))
      .map((e) => e.target),
  );
  const rootIds = graph.nodes
    .filter((n) => n.type === "screen" && !hasIncoming.has(n.id))
    .map((n) => n.id);

  if (rootIds.length === 0) return null;

  // The default tab target is the first tab child of the root (usually "Home").
  // When the app launches it starts on this view, so we can skip tapping it.
  let defaultTabTarget = null;
  for (const e of graph.edges) {
    if (rootIds.includes(e.source) && e.type === "tab") {
      defaultTabTarget = e.target;
      break;
    }
  }

  // BFS to compute edge-paths from roots to every reachable node
  const edgePaths = bfsEdgePaths(graph, rootIds);

  // Generate one test method per reachable screen node
  const methods = [];
  for (const [nodeId, edgePath] of edgePaths) {
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== "screen") continue;

    const taps = buildTaps(edgePath, nodeMap, defaultTabTarget);
    methods.push(generateMethod(nodeId, taps, screenshotsDir));
  }

  // Generate modal test methods for sheet/fullScreenCover/web-view screens
  const modalScreens = collectModalScreens(graph, edgePaths);
  for (const [nodeId, { parentEdgePath, triggerEdge }] of modalScreens) {
    const parentTaps = buildTaps(parentEdgePath, nodeMap, defaultTabTarget);
    methods.push(generateModalMethod(nodeId, parentTaps, triggerEdge, screenshotsDir));
  }

  if (methods.length === 0) return null;

  return generateTestFile(methods, screenshotsDir);
}

// ---------------------------------------------------------------------------
// Modal screen collection
// ---------------------------------------------------------------------------

/**
 * Collect screens reachable only via modal edges (sheet, full-screen, web-view).
 * Returns Map<nodeId, { parentEdgePath, triggerEdge }> where parentEdgePath is
 * the BFS path to the source screen and triggerEdge is the modal-opening edge.
 * Skips safari edges and nodes already reachable via regular BFS.
 */
function collectModalScreens(graph, edgePaths) {
  const modalScreens = new Map();

  for (const edge of graph.edges) {
    if (!MODAL_EDGE_TYPES.has(edge.type)) continue;
    if (!edgePaths.has(edge.source)) continue; // source not reachable via BFS
    if (edgePaths.has(edge.target)) continue;  // already covered by regular BFS
    if (modalScreens.has(edge.target)) continue; // already captured via another path

    modalScreens.set(edge.target, {
      parentEdgePath: edgePaths.get(edge.source),
      triggerEdge: edge,
    });
  }

  return modalScreens;
}

// ---------------------------------------------------------------------------
// BFS
// ---------------------------------------------------------------------------

function bfsEdgePaths(graph, startIds) {
  // Returns Map<nodeId, Array<edge>>
  // where edge-array is the sequence of edges from a root to that node.
  const visited = new Map();
  const queue = [];

  for (const id of startIds) {
    visited.set(id, []);
    queue.push(id);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const currentPath = visited.get(current);

    for (const edge of graph.edges) {
      if (edge.source !== current) continue;
      if (!NAVIGABLE_EDGE_TYPES.has(edge.type)) continue;
      if (visited.has(edge.target)) continue;

      const newPath = [...currentPath, edge];
      visited.set(edge.target, newPath);
      queue.push(edge.target);
    }
  }

  return visited;
}

// ---------------------------------------------------------------------------
// Tap building
// ---------------------------------------------------------------------------

/**
 * Convert a sequence of graph edges to an array of tap descriptors.
 * Each tap has { kind: "tab"|"element", candidates: [string] }
 * where candidates are tried in order until one is found in the UI.
 */
function buildTaps(edgePath, nodeMap, defaultTabTarget) {
  const taps = [];

  for (const edge of edgePath) {
    if (edge.type === "tab") {
      // Skip tapping the default tab — the app already starts there.
      if (edge.target === defaultTabTarget) continue;
      taps.push({ kind: "tab", candidates: [edge.label].filter(Boolean) });
    } else if (edge.type === "link") {
      // Candidate labels to try in the UI, in preference order:
      //  1. The destination node's display label (from navigationTitle) — matches
      //     HubRowLink buttons whose text comes from hubType.title.
      //  2. The edge label (RowLink title) — the actual button text for RowLinks.
      // Deduplication removes redundant candidates.
      const destNode = nodeMap.get(edge.target);
      const destLabel = destNode?.label ?? null;
      const edgeLabel = edge.label || null;

      const candidates = [...new Set([destLabel, edgeLabel].filter(Boolean))];
      if (candidates.length === 0) continue;
      taps.push({ kind: "element", candidates });
    }
  }

  return taps;
}

// ---------------------------------------------------------------------------
// Swift code generation
// ---------------------------------------------------------------------------

function generateMethod(nodeId, taps, screenshotsDir) {
  const safeName = sanitizeFilename(nodeId);
  const escapedDir = swiftEscape(screenshotsDir);
  const escapedName = swiftEscape(safeName);

  const tapLines = taps.map((tap) => {
    if (tap.kind === "tab") {
      const label = swiftEscape(tap.candidates[0]);
      return `        tapTab("${label}", in: app)`;
    }
    // Build a Swift array literal of candidate strings
    const candidatesLiteral = tap.candidates
      .map((c) => `"${swiftEscape(c)}"`)
      .join(", ");
    return `        tapElement(matching: [${candidatesLiteral}], in: app)`;
  });

  return `
    func testCapture_${safeName}() {
        let app = XCUIApplication()
        app.launch()
${tapLines.join("\n")}
        Thread.sleep(forTimeInterval: 2.0)
        writeScreenshot(name: "${escapedName}", to: "${escapedDir}")
    }`;
}

/**
 * Generate a test method that navigates to a parent screen, taps the modal
 * trigger, waits for the animation, then captures the modal screen.
 */
function generateModalMethod(nodeId, parentTaps, triggerEdge, screenshotsDir) {
  const safeName = sanitizeFilename(nodeId);
  const escapedDir = swiftEscape(screenshotsDir);
  const escapedName = swiftEscape(safeName);
  const waitTime = triggerEdge.type === "web-view" ? "4.0" : "2.0";

  const lines = parentTaps.map((tap) => {
    if (tap.kind === "tab") {
      return `        tapTab("${swiftEscape(tap.candidates[0])}", in: app)`;
    }
    const lit = tap.candidates.map((c) => `"${swiftEscape(c)}"`).join(", ");
    return `        tapElement(matching: [${lit}], in: app)`;
  });

  if (triggerEdge.label) {
    lines.push(`        tapElement(matching: ["${swiftEscape(triggerEdge.label)}"], in: app)`);
  }

  return `
    func testCapture_modal_${safeName}() {
        let app = XCUIApplication()
        app.launch()
${lines.join("\n")}
        Thread.sleep(forTimeInterval: ${waitTime})
        writeScreenshot(name: "${escapedName}", to: "${escapedDir}")
    }`;
}

function generateTestFile(methods, screenshotsDir) {
  const escapedDir = swiftEscape(screenshotsDir);
  return `import XCTest

// Auto-generated by prototype-flow-map.
// This file is temporary — it is restored after screenshot capture.

final class FlowMapCapture: XCTestCase {

    override func setUpWithError() throws {
        // Continue on failure so all screens get a capture attempt.
        continueAfterFailure = true
    }

    // MARK: - Helpers

    /// Tap a tab bar button by label.
    func tapTab(_ label: String, in app: XCUIApplication) {
        // Exact match
        let exact = app.tabBars.buttons[label]
        if exact.waitForExistence(timeout: 3) {
            exact.tap()
            Thread.sleep(forTimeInterval: 1.0)
            return
        }
        // Contains fallback (handles icon+text accessibility labels)
        let pred = NSPredicate(format: "label CONTAINS[c] %@", label)
        let fuzzy = app.tabBars.buttons.matching(pred).firstMatch
        if fuzzy.waitForExistence(timeout: 1) {
            fuzzy.tap()
            Thread.sleep(forTimeInterval: 1.0)
        }
    }

    /// Find any tappable element matching one of the candidate labels and tap it.
    /// Prioritises interactive elements (buttons, cells) over static text to avoid
    /// accidentally tapping section headers or navigation titles.
    @discardableResult
    func tapElement(matching candidates: [String], in app: XCUIApplication) -> Bool {
        for candidate in candidates {
            // 1. Button — most common for navigation links
            let btn = app.buttons[candidate]
            if btn.waitForExistence(timeout: 3) {
                btn.tap()
                Thread.sleep(forTimeInterval: 1.0)
                return true
            }
            // 2. List / table cell
            let cell = app.cells[candidate]
            if cell.waitForExistence(timeout: 1) {
                cell.tap()
                Thread.sleep(forTimeInterval: 1.0)
                return true
            }
            // 3. Accessibility identifier
            let identPred = NSPredicate(format: "identifier ==[c] %@", candidate)
            let identEl = app.descendants(matching: .any).matching(identPred).firstMatch
            if identEl.waitForExistence(timeout: 1) {
                identEl.tap()
                Thread.sleep(forTimeInterval: 1.0)
                return true
            }
            // 4. Scroll and retry buttons/cells (up to 5 swipes, then restore)
            var swiped = 0
            for _ in 0..<5 {
                app.swipeUp()
                swiped += 1
                if btn.waitForExistence(timeout: 1) {
                    btn.tap()
                    Thread.sleep(forTimeInterval: 1.0)
                    return true
                }
                if cell.waitForExistence(timeout: 1) {
                    cell.tap()
                    Thread.sleep(forTimeInterval: 1.0)
                    return true
                }
            }
            // Restore scroll position so subsequent taps/screenshots aren't affected
            for _ in 0..<swiped { app.swipeDown() }
        }
        // No candidate found — leave the screen as-is and continue.
        return false
    }

    /// Write the current screen as a PNG to the given directory.
    func writeScreenshot(name: String, to dir: String) {
        let dirURL = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
        let fileURL = dirURL.appendingPathComponent("\\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: fileURL)
    }

    // MARK: - Screen captures
${methods.join("\n")}
}
`;
}

function swiftEscape(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

module.exports = { generateXCUITest, sanitizeFilename };
