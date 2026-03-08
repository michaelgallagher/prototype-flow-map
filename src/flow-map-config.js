const fs = require("fs");
const path = require("path");

const CONFIG_FILENAMES = [".flow-map.json", "flow-map.config.json"];

/**
 * Load a flow-map config file from the prototype root.
 * Looks for .flow-map.json or flow-map.config.json.
 * Returns a validated config object, or an empty default if no file found.
 *
 * Config shape:
 * {
 *   exclude: ["ViewNameA", "ViewNameB"],         // nodes to remove from the graph
 *   overrides: {
 *     "ViewName": {
 *       steps: [
 *         "tap:Label text",             // tap element with this label
 *         "tapTab:Label:index",         // tap a tab bar button
 *         "tapContaining:partial text", // tap button whose label CONTAINS text
 *         "tapCell:0",                  // tap cell at index
 *         "swipeLeft:firstCell",        // swipe-left on first cell
 *         "wait:2.0"                    // sleep for N seconds
 *       ]
 *     }
 *   }
 * }
 */
function loadConfig(prototypePath) {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = path.join(prototypePath, filename);
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);
        console.log(`   Config: ${filename}`);
        return validateConfig(config);
      } catch (err) {
        console.warn(`   ⚠️  Failed to parse ${filename}: ${err.message}`);
        return defaultConfig();
      }
    }
  }
  return defaultConfig();
}

function defaultConfig() {
  return { exclude: [], overrides: {} };
}

function validateConfig(raw) {
  const config = defaultConfig();

  if (Array.isArray(raw.exclude)) {
    config.exclude = raw.exclude.filter((e) => typeof e === "string");
  }

  if (raw.overrides && typeof raw.overrides === "object") {
    for (const [viewName, override] of Object.entries(raw.overrides)) {
      if (override && Array.isArray(override.steps)) {
        config.overrides[viewName] = {
          steps: override.steps.filter((s) => typeof s === "string"),
        };
      }
    }
  }

  return config;
}

/**
 * Remove excluded nodes from the graph.
 */
function applyExclusions(graph, exclude) {
  if (!exclude || exclude.length === 0) return graph;
  const excludeSet = new Set(exclude);
  return {
    nodes: graph.nodes.filter((n) => !excludeSet.has(n.id)),
    edges: graph.edges.filter(
      (e) => !excludeSet.has(e.source) && !excludeSet.has(e.target),
    ),
  };
}

module.exports = { loadConfig, applyExclusions };
