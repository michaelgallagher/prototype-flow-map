const { globSync } = require("glob");

/**
 * Detect whether a directory looks like an Android/Kotlin project.
 */
function isAndroidProject(projectPath) {
  const ktFiles = globSync("**/*.kt", {
    cwd: projectPath,
    ignore: ["**/node_modules/**", "**/build/**", "**/.gradle/**"],
    absolute: false,
  });
  return ktFiles.length > 0;
}

/**
 * Scan an Android/Kotlin project for all Kotlin source files,
 * excluding test targets and build artefacts.
 */
function scanKotlinFiles(projectPath) {
  return globSync("**/*.kt", {
    cwd: projectPath,
    absolute: true,
    ignore: [
      "**/*Test/**",
      "**/*Tests/**",
      "**/test/**",
      "**/androidTest/**",
      "**/build/**",
      "**/.gradle/**",
    ],
  });
}

module.exports = { isAndroidProject, scanKotlinFiles };
