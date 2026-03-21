const fs = require("fs");
const path = require("path");

/**
 * Parse a .flow scenario file into the internal scenario object format.
 *
 * Format:
 *   # Description line(s) — leading comment block becomes the description
 *
 *   Start /clinics
 *   Scope /dashboard /clinics /events /reports
 *   Exclude /prototype-admin /api /assets
 *   Tags clinic appointment core
 *   Limit pages 120
 *   Limit depth 12
 *   Disabled
 *
 *   --- Setup ---
 *   Use setup.clinician
 *   Goto /choose-user
 *   Click "text=Receptionist"
 *   WaitForUrl /dashboard
 *
 *   --- Map ---
 *   Visit /dashboard
 *   Visit /clinics/today
 *   Click "a:has-text('View appointment')"
 *   Snapshot
 *   Wait 1000
 *   Fill "input[name='search']" "HITCHIN"
 *   Check "#cancerLocationRightBreast"
 *   Select "#dropdown" "Image obscured"
 *
 *   # Label-based (Capybara-style):
 *   FillIn "First name" with "Frankie"
 *   Select "Email" from "Contact preference"
 *   Check "Right breast"
 *   Choose "At an NHS hospital"
 */
function parseFlowFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const name = path.basename(filePath, ".flow");
  return parseFlowText(raw, name);
}

/**
 * Parse .flow text content into a scenario object.
 * Exported separately for testing.
 */
function parseFlowText(text, name) {
  const lines = text.split("\n");

  const scenario = {
    name,
    description: "",
    startUrl: "/",
    enabled: true,
    tags: [],
    steps: [],
    scope: {
      includePrefixes: [],
      excludePrefixes: [],
    },
    limits: {
      maxPages: 120,
      maxDepth: 12,
    },
  };

  // Phase 1: extract description from leading comment block
  let lineIndex = 0;
  const descriptionLines = [];

  // Skip leading blank lines
  while (lineIndex < lines.length && lines[lineIndex].trim() === "") {
    lineIndex++;
  }

  // Collect consecutive comment lines as description
  while (lineIndex < lines.length) {
    const trimmed = lines[lineIndex].trim();
    if (trimmed.startsWith("#")) {
      const commentText = trimmed.slice(1).trim();
      if (commentText) {
        descriptionLines.push(commentText);
      }
      lineIndex++;
    } else {
      break;
    }
  }

  scenario.description = descriptionLines.join(" ");

  // Phase 2: parse the rest — metadata directives and blocks
  let currentBlock = "header"; // "header" | "setup" | "map"

  while (lineIndex < lines.length) {
    const raw = lines[lineIndex];
    const trimmed = raw.trim();
    lineIndex++;

    // Skip blank lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Block markers: "--- Setup ---" or "Setup:"
    if (/^-{3,}\s*setup\s*-{3,}$/i.test(trimmed) || /^setup\s*:$/i.test(trimmed)) {
      currentBlock = "setup";
      continue;
    }
    if (/^-{3,}\s*map\s*-{3,}$/i.test(trimmed) || /^map\s*:$/i.test(trimmed)) {
      currentBlock = "map";
      scenario.steps.push({ type: "beginMap" });
      continue;
    }

    if (currentBlock === "header") {
      parseDirective(trimmed, scenario);
    } else {
      // Setup or Map block — parse as a step
      const step = parseStepLine(trimmed);
      if (step) {
        scenario.steps.push(step);
      } else {
        console.warn(`   ⚠️  Could not parse step: ${trimmed}`);
      }
    }
  }

  // If we had a Map: block, add endMap
  if (currentBlock === "map") {
    scenario.steps.push({ type: "endMap" });
  }

  return scenario;
}

/**
 * Parse a header directive line like "Start /clinics" or "Tags clinic core".
 */
function parseDirective(line, scenario) {
  const lower = line.toLowerCase();

  if (lower.startsWith("start ")) {
    scenario.startUrl = line.slice(6).trim();
  } else if (lower.startsWith("scope ")) {
    scenario.scope.includePrefixes = splitTokens(line.slice(6));
  } else if (lower.startsWith("exclude ")) {
    scenario.scope.excludePrefixes = splitTokens(line.slice(8));
  } else if (lower.startsWith("tags ")) {
    scenario.tags = splitTokens(line.slice(5));
  } else if (lower.startsWith("limit ")) {
    const rest = line.slice(6).trim();
    const match = rest.match(/^(\w+)\s+(\d+)$/i);
    if (match) {
      const key = match[1].toLowerCase();
      const val = parseInt(match[2], 10);
      if (key === "pages") scenario.limits.maxPages = val;
      if (key === "depth") scenario.limits.maxDepth = val;
    }
  } else if (lower === "disabled") {
    scenario.enabled = false;
  }
}

/**
 * Parse a step line like:
 *   Visit /dashboard
 *   Click "a:has-text('View appointment')"
 *   Fill "input[name='search']" "HITCHIN"
 *   Wait 1000
 *   Snapshot
 *   Use setup.clinician
 */
/**
 * Heuristic: does a string look like a CSS selector?
 * Returns true if it starts with #, ., [ or contains selector combinator chars.
 */
function looksLikeSelector(str) {
  if (/^[#.\[]/.test(str)) return true;
  if (/[:>~+]/.test(str)) return true;
  return false;
}

function parseStepLine(line) {
  const args = tokenize(line);
  if (args.length === 0) return null;

  const action = args[0].toLowerCase();

  switch (action) {
    case "goto":
      return args[1] ? { type: "goto", url: args[1] } : null;

    case "click":
      return args[1] ? { type: "click", selector: args[1] } : null;

    case "clicklink":
      return args[1] ? { type: "clickLink", text: args[1] } : null;

    case "clickbutton":
      return args[1] ? { type: "clickButton", text: args[1] } : null;

    case "fill":
      return args[1] && args[2]
        ? { type: "fill", selector: args[1], value: args[2] }
        : null;

    case "fillin":
      // FillIn "First name" with "Frankie"
      if (args[1] && args[2]?.toLowerCase() === "with" && args[3]) {
        return { type: "fillIn", label: args[1], value: args[3] };
      }
      return null;

    case "select":
      // Select "Email" from "Contact preference" → label-based selectFrom
      // Select "#dropdown" "value" → CSS-selector select
      if (args[1] && args[2]?.toLowerCase() === "from" && args[3]) {
        return { type: "selectFrom", label: args[3], value: args[1] };
      }
      return args[1] && args[2]
        ? { type: "select", selector: args[1], value: args[2] }
        : null;

    case "check":
      // Check "#selector" → CSS-selector check
      // Check "Right breast" → label-based checkByLabel
      if (args[1] && looksLikeSelector(args[1])) {
        return { type: "check", selector: args[1] };
      }
      return args[1] ? { type: "checkByLabel", label: args[1] } : null;

    case "choose":
      return args[1] ? { type: "choose", label: args[1] } : null;

    case "submit":
      return args[1] ? { type: "submit", selector: args[1] } : null;

    case "waitforurl":
      return args[1] ? { type: "waitForUrl", url: args[1] } : null;

    case "waitforselector":
      return args[1] ? { type: "waitForSelector", selector: args[1] } : null;

    case "wait":
      return args[1] ? { type: "wait", ms: parseInt(args[1], 10) } : null;

    case "visit":
      return args[1] ? { type: "visit", url: args[1] } : null;

    case "snapshot":
      return { type: "snapshot" };

    case "use":
      return args[1] ? { type: "use", fragment: args[1] } : null;

    default:
      return null;
  }
}

/**
 * Tokenize a line into arguments, respecting quoted strings.
 *
 *   Visit /dashboard           → ["Visit", "/dashboard"]
 *   Click "text=Receptionist"  → ["Click", "text=Receptionist"]
 *   Fill "#input" "value"      → ["Fill", "#input", "value"]
 *   Wait 1000                  → ["Wait", "1000"]
 */
function tokenize(line) {
  const tokens = [];
  let i = 0;
  const len = line.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= len) break;

    if (line[i] === '"') {
      // Quoted string — find closing quote
      i++; // skip opening quote
      let token = "";
      while (i < len && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < len) {
          token += line[i + 1];
          i += 2;
        } else {
          token += line[i];
          i++;
        }
      }
      if (i < len) i++; // skip closing quote
      tokens.push(token);
    } else {
      // Unquoted token — read until whitespace
      let token = "";
      while (i < len && line[i] !== " " && line[i] !== "\t") {
        token += line[i];
        i++;
      }
      tokens.push(token);
    }
  }

  return tokens;
}

/**
 * Split a line into space-separated tokens (no quoting needed for simple values).
 */
function splitTokens(str) {
  return str
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

/**
 * Scan a directory for .flow files and parse them all.
 * Returns an array of scenario objects.
 */
function loadFlowScenarios(prototypePath) {
  const scenariosDir = path.join(prototypePath, "scenarios");
  if (!fs.existsSync(scenariosDir)) return [];

  const files = fs
    .readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".flow"))
    .sort();

  const scenarios = [];
  for (const file of files) {
    try {
      const scenario = parseFlowFile(path.join(scenariosDir, file));
      scenarios.push(scenario);
    } catch (err) {
      console.warn(`   ⚠️  Failed to parse ${file}: ${err.message}`);
    }
  }

  return scenarios;
}

/**
 * Scan scenarios/fragments/ for .flow files and parse them as step sequences.
 * Each file becomes a named fragment — filename (minus .flow) is the name.
 * e.g. fragments/setup.clinician.flow → fragment "setup.clinician"
 *
 * Returns an object: { "setup.clinician": [step, step, ...], ... }
 */
function loadFlowFragments(prototypePath) {
  const fragmentsDir = path.join(prototypePath, "scenarios", "fragments");
  if (!fs.existsSync(fragmentsDir)) return {};

  const files = fs
    .readdirSync(fragmentsDir)
    .filter((f) => f.endsWith(".flow"))
    .sort();

  const fragments = {};
  for (const file of files) {
    try {
      const filePath = path.join(fragmentsDir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const name = path.basename(file, ".flow");
      const steps = parseFragmentText(raw);
      if (steps.length > 0) {
        fragments[name] = steps;
      }
    } catch (err) {
      console.warn(`   ⚠️  Failed to parse fragment ${file}: ${err.message}`);
    }
  }

  return fragments;
}

/**
 * Parse a fragment .flow file into an array of steps.
 * Fragments are simpler than scenarios — just step lines and comments.
 * No header directives, no Setup:/Map: blocks needed.
 */
function parseFragmentText(text) {
  const lines = text.split("\n");
  const steps = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // Skip block markers if someone includes them
    if (/^-{3,}\s*\w+\s*-{3,}$/i.test(trimmed)) continue;
    if (/^\w+\s*:$/i.test(trimmed)) continue;

    const step = parseStepLine(trimmed);
    if (step) {
      steps.push(step);
    }
  }

  return steps;
}

/**
 * Scan scenarios/ for .set files and parse them as scenario set definitions.
 * Each file is a list of scenario names, one per line. Comments with #.
 * Filename (minus .set) becomes the set name.
 * e.g. core-user-journeys.set → set "core-user-journeys"
 *
 * Returns an object: { "core-user-journeys": ["clinic-workflow", ...], ... }
 */
function loadFlowScenarioSets(prototypePath) {
  const scenariosDir = path.join(prototypePath, "scenarios");
  if (!fs.existsSync(scenariosDir)) return {};

  const files = fs
    .readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".set"))
    .sort();

  const sets = {};
  for (const file of files) {
    try {
      const filePath = path.join(scenariosDir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const name = path.basename(file, ".set");
      const names = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      if (names.length > 0) {
        sets[name] = names;
      }
    } catch (err) {
      console.warn(`   ⚠️  Failed to parse set ${file}: ${err.message}`);
    }
  }

  return sets;
}

module.exports = {
  parseFlowFile,
  parseFlowText,
  loadFlowScenarios,
  loadFlowFragments,
  loadFlowScenarioSets,
  tokenize,
};
