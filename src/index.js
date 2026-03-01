const fs = require("fs");
const path = require("path");
const { scanTemplates } = require("./scanner");
const { parseTemplate } = require("./template-parser");
const { parseRoutes } = require("./route-parser");
const { crawlAndScreenshot } = require("./crawler");
const { buildGraph, filterByReachability } = require("./graph-builder");
const { buildViewer } = require("./build-viewer");
const { buildMermaid } = require("./build-mermaid");
const { buildIndex } = require("./build-index");

async function generate(options) {
  const {
    prototypePath,
    outputDir,
    port,
    viewport,
    screenshots,
    basePath,
    exclude,
    from,
    startUrl,
    name,
    title,
  } = options;

  // When --name is provided, output goes to maps/<name>/ within the output dir
  const mapOutputDir = name ? path.join(outputDir, "maps", name) : outputDir;

  // Step 1: Scan for all template files
  console.log("1\uFE0F\u20E3  Scanning templates...");
  const templateFiles = scanTemplates(prototypePath);
  console.log(`   Found ${templateFiles.length} templates`);

  // Step 2: Parse each template for links, forms, conditionals
  console.log("2\uFE0F\u20E3  Parsing templates for routes and conditions...");
  const templateData = [];
  for (const file of templateFiles) {
    const parsed = parseTemplate(file, prototypePath);
    if (parsed) templateData.push(parsed);
  }
  console.log(`   Parsed ${templateData.length} page templates`);

  // Step 3: Parse explicit route handlers
  console.log("3\uFE0F\u20E3  Parsing Express route handlers...");
  const explicitRoutes = parseRoutes(prototypePath);
  console.log(`   Found ${explicitRoutes.length} explicit route handlers`);

  // Step 4: Build the graph from static analysis
  console.log("4\uFE0F\u20E3  Building flow graph...");
  let graph = buildGraph(templateData, explicitRoutes, basePath, exclude);
  if (from) {
    graph = filterByReachability(graph, from);
    const fromPages = from
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const label =
      fromPages.length === 1
        ? fromPages[0]
        : `${fromPages.length} start pages`;
    console.log(`   Filtered to pages reachable from ${label}`);
  }
  console.log(
    `   Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
  );

  // Step 5: Crawl and screenshot (if enabled)
  if (screenshots) {
    console.log("5\uFE0F\u20E3  Crawling prototype and capturing screenshots...");
    graph = await crawlAndScreenshot(graph, {
      prototypePath,
      port,
      viewport,
      outputDir: mapOutputDir,
      startUrl,
    });
    console.log(
      `   Captured ${graph.nodes.filter((n) => n.screenshot).length} screenshots`,
    );
  } else {
    console.log("5\uFE0F\u20E3  Skipping screenshots (--no-screenshots)");
  }

  // Step 6: Build the viewer
  console.log("6\uFE0F\u20E3  Building interactive viewer...");
  await buildViewer(graph, mapOutputDir, screenshots, viewport, { name });
  console.log("   Viewer built");

  // Step 6b: Generate Mermaid sitemap
  buildMermaid(graph, mapOutputDir);
  console.log("   Mermaid sitemap written");

  // Step 7: Write map metadata and rebuild collection index (multi-map mode)
  if (name) {
    const meta = {
      name,
      title: title || path.basename(prototypePath),
      updatedAt: new Date().toISOString(),
      from: from || null,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      hasScreenshots: screenshots,
    };
    fs.mkdirSync(mapOutputDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapOutputDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );

    console.log("7\uFE0F\u20E3  Building collection index...");
    buildIndex(outputDir);
    console.log("   Collection index built");
  }
}

module.exports = { generate };
