const { globSync } = require("glob");
const path = require("path");
const fs = require("fs");

/**
 * Detect whether a directory looks like an iOS/Swift project.
 */
function isIosProject(projectPath) {
  const swiftFiles = globSync("**/*.swift", {
    cwd: projectPath,
    ignore: ["**/node_modules/**", "**/.build/**"],
    absolute: false,
  });
  return swiftFiles.length > 0;
}

/**
 * Scan an iOS/Swift project for all Swift source files,
 * excluding test targets and build artefacts.
 */
function scanSwiftFiles(projectPath) {
  return globSync("**/*.swift", {
    cwd: projectPath,
    absolute: true,
    ignore: [
      "**/*Tests/**",
      "**/*UITests/**",
      "**/Pods/**",
      "**/.build/**",
      "**/DerivedData/**",
    ],
  });
}

module.exports = { isIosProject, scanSwiftFiles };
