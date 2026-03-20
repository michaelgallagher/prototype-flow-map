const { globSync } = require("glob");
const path = require("path");
const fs = require("fs");

/**
 * Scan a prototype project for all Nunjucks/HTML template files
 * in the views directory. Excludes layouts, includes, and components
 * that aren't standalone pages.
 */
function scanTemplates(prototypePath) {
  const viewsDir = path.join(prototypePath, "app", "views");

  if (!fs.existsSync(viewsDir)) {
    throw new Error(`Views directory not found: ${viewsDir}`);
  }

  // Find all .html files in the views directory
  const allFiles = globSync("**/*.html", {
    cwd: viewsDir,
    absolute: true,
  });

  // Skip templates where the filename starts with an underscore,
  // as by convention these are included in other pages rather than
  // being standalone pages themselves.
  const filteredFiles = allFiles.filter((filePath) => {
    const fileName = path.basename(filePath);
    return !fileName.startsWith("_");
  });

  return filteredFiles;
}

/**
 * Convert a template file path to its URL path
 * (mirrors the auto-routing middleware behaviour)
 */
function fileToUrlPath(filePath, prototypePath) {
  const viewsDir = path.join(prototypePath, "app", "views");
  let relative = path.relative(viewsDir, filePath);

  // Remove .html extension
  relative = relative.replace(/\.html$/, "");

  // Remove trailing /index
  relative = relative.replace(/\/index$/, "");

  // If it's just 'index', it maps to '/'
  if (relative === "index") return "/";

  return "/" + relative;
}

module.exports = { scanTemplates, fileToUrlPath };
