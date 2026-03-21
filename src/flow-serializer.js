/**
 * Serialize recorded steps into .flow file text.
 * Inverse of flow-parser.js.
 */

/**
 * Escape a string for use in a .flow file quoted argument.
 * Backslash-escapes any embedded double quotes.
 */
function escapeQuoted(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Quote a value for .flow syntax. Only quotes if the value contains spaces
 * or special characters, or is always-quoted by convention.
 */
function q(str) {
  return `"${escapeQuoted(str)}"`;
}

/**
 * Serialize a single step to its .flow line representation.
 */
function serializeStep(step) {
  switch (step.type) {
    case "goto":
      return `Goto ${step.url}`;
    case "clickLink":
      return `ClickLink ${q(step.text)}`;
    case "clickButton":
      return `ClickButton ${q(step.text)}`;
    case "click":
      return `Click ${q(step.selector)}`;
    case "fillIn":
      return `FillIn ${q(step.label)} with ${q(step.value)}`;
    case "fill":
      return `Fill ${q(step.selector)} ${q(step.value)}`;
    case "selectFrom":
      return `Select ${q(step.value)} from ${q(step.label)}`;
    case "select":
      return `Select ${q(step.selector)} ${q(step.value)}`;
    case "checkByLabel":
      return `Check ${q(step.label)}`;
    case "check":
      return `Check ${q(step.selector)}`;
    case "choose":
      return `Choose ${q(step.label)}`;
    case "visit":
      return `Visit ${step.url}`;
    case "snapshot":
      return "Snapshot";
    default:
      return `# Unknown step type: ${step.type}`;
  }
}

/**
 * Auto-derive Scope prefixes from visited URLs.
 * Extracts the first path segment from each URL and deduplicates.
 */
function deriveScope(steps) {
  const prefixes = new Set();
  for (const step of steps) {
    const url = step.url || "";
    if (!url.startsWith("/")) continue;
    const segments = url.split("/").filter(Boolean);
    if (segments.length > 0) {
      prefixes.add(`/${segments[0]}`);
    }
  }
  return Array.from(prefixes).sort();
}

/**
 * Serialize a full recorded scenario to .flow file text.
 *
 * @param {Object} opts
 * @param {string} opts.startUrl - The initial URL (for the Start directive)
 * @param {Array} opts.setupSteps - Steps recorded during Setup phase
 * @param {Array} opts.mapSteps - Steps recorded during Map phase
 * @returns {string} .flow file content
 */
function serializeFlow({ startUrl, setupSteps, mapSteps }) {
  const lines = [];

  // Header
  lines.push(`Start ${startUrl || "/"}`);

  // Derive scope from map steps that have URLs
  const allMapSteps = mapSteps || [];
  const scope = deriveScope(allMapSteps);
  if (scope.length > 0) {
    lines.push(`Scope ${scope.join(" ")}`);
  }

  lines.push("");

  // Setup block
  if (setupSteps && setupSteps.length > 0) {
    lines.push("--- Setup ---");
    for (const step of setupSteps) {
      lines.push(serializeStep(step));
    }
    lines.push("");
  }

  // Map block
  lines.push("--- Map ---");
  for (const step of allMapSteps) {
    lines.push(serializeStep(step));
  }

  lines.push("");
  return lines.join("\n");
}

module.exports = { serializeFlow, serializeStep, deriveScope };
