const fs = require("fs");
const path = require("path");

const CONFIG_FILENAMES = [".flow-map.json", "flow-map.config.json"];

/**
 * Load a flow-map config file from the prototype root.
 * Looks for .flow-map.json or flow-map.config.json.
 * Returns a validated config object, or an empty default if no file found.
 *
 * Web config shape:
 * {
 *   runtimeCrawl: true,
 *   runtimeCrawlOptions: {
 *     enabled: true
 *   }
 * }
 *
 * iOS config shape:
 * {
 *   exclude: ["ViewNameA", "ViewNameB"],
 *   overrides: {
 *     "ViewName": {
 *       steps: [
 *         "tap:Label text",
 *         "tapTab:Label:index",
 *         "tapContaining:partial text",
 *         "tapCell:0",
 *         "swipeLeft:firstCell",
 *         "wait:2.0"
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
  return {
    exclude: [],
    overrides: {},
    runtimeCrawl: false,
    runtimeCrawlOptions: {
      enabled: false,
    },
  };
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

  if (typeof raw.runtimeCrawl === "boolean") {
    config.runtimeCrawl = raw.runtimeCrawl;
    config.runtimeCrawlOptions.enabled = raw.runtimeCrawl;
  }

  if (
    raw.runtimeCrawlOptions &&
    typeof raw.runtimeCrawlOptions === "object" &&
    !Array.isArray(raw.runtimeCrawlOptions)
  ) {
    if (typeof raw.runtimeCrawlOptions.enabled === "boolean") {
      config.runtimeCrawlOptions.enabled = raw.runtimeCrawlOptions.enabled;
      config.runtimeCrawl = raw.runtimeCrawlOptions.enabled;
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
