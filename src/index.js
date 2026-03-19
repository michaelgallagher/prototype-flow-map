const fs = require("fs");
const path = require("path");
const { scanTemplates } = require("./scanner");
const { parseTemplate } = require("./template-parser");
const { parseRoutes } = require("./route-parser");
const { crawlAndScreenshot } = require("./crawler");
const {
  buildGraph,
  filterByExclusion,
  filterByReachability,
  normalizeUrlPath,
} = require("./graph-builder");
const { buildViewer } = require("./build-viewer");
const { buildMermaid } = require("./build-mermaid");
const { exportPdf } = require("./export-pdf");
const { buildIndex } = require("./build-index");
const { scanSwiftFiles } = require("./swift-scanner");
const { parseSwiftFile } = require("./swift-parser");
const { buildSwiftGraph } = require("./swift-graph-builder");
const { crawlAndScreenshotIos } = require("./swift-crawler");
const {
  loadConfig,
  applyExclusions,
  getScenarios,
  resolveSteps,
} = require("./flow-map-config");
const { runScenarios } = require("./scenario-runner");
const { enrichScenarioGraph } = require("./static-enrichment");

async function generate(options) {
  const {
    prototypePath,
    outputDir,
    port,
    viewport,
    screenshots,
    runtimeCrawl = false,
    basePath,
    exclude,
    from,
    startUrl,
    name,
    title,
    exportPdf: shouldExportPdf,
    pdfMode,
    mode = "static",
    config,
    scenario: scenarioName,
    scenarioSet,
  } = options;

  // Scenario mode: delegate to scenario pipeline
  if (mode === "scenario") {
    return generateScenario(options);
  }

  // Audit mode: force runtime crawl on
  if (mode === "audit") {
    options.runtimeCrawl = true;
  }

  // When --name is provided, output goes to maps/<name>/ within the output dir
  const mapOutputDir = name ? path.join(outputDir, "maps", name) : outputDir;

  // Step 1: Scan for all template files
  console.log("1️⃣  Scanning templates...");
  const templateFiles = scanTemplates(prototypePath);
  console.log(`   Found ${templateFiles.length} templates`);

  // Step 2: Parse each template for links, forms, conditionals
  console.log("2️⃣  Parsing templates for routes and conditions...");
  const templateData = [];
  for (const file of templateFiles) {
    const parsed = parseTemplate(file, prototypePath);
    if (parsed) templateData.push(parsed);
  }
  console.log(`   Parsed ${templateData.length} page templates`);

  // Step 3: Parse explicit route handlers
  console.log("3️⃣  Parsing Express route handlers...");
  const explicitRoutes = parseRoutes(prototypePath);
  console.log(`   Found ${explicitRoutes.length} explicit route handlers`);

  // Step 4: Build the graph from static analysis
  console.log("4️⃣  Building flow graph...");
  let graph = buildGraph(templateData, explicitRoutes, basePath, exclude, []);
  if (exclude) {
    graph = filterByExclusion(graph, exclude);
  }
  if (from) {
    graph = filterByReachability(graph, from);
    const fromPages = from
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    // Mark start nodes and their order for layout positioning
    const startSet = new Set(fromPages.map(normalizeUrlPath));
    graph.nodes.forEach((node) => {
      if (startSet.has(node.urlPath) || startSet.has(node.id)) {
        node.isStartNode = true;
        node.startOrder = fromPages.findIndex(
          (p) => normalizeUrlPath(p) === node.urlPath || normalizeUrlPath(p) === node.id,
        );
      }
    });

    const label =
      fromPages.length === 1 ? fromPages[0] : `${fromPages.length} start pages`;
    console.log(`   Filtered to pages reachable from ${label}`);
  }
  console.log(
    `   Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
  );

  // Step 5: Crawl and screenshot (if enabled)
  if (screenshots) {
    console.log("5️⃣  Crawling prototype and capturing screenshots...");
    graph = await crawlAndScreenshot(graph, {
      prototypePath,
      port,
      viewport,
      outputDir: mapOutputDir,
      startUrl,
      runtimeCrawl,
    });

    if (
      runtimeCrawl &&
      Array.isArray(graph.runtimeEdges) &&
      graph.runtimeEdges.length > 0
    ) {
      const runtimeEdges = graph.runtimeEdges;
      const crawlStats = graph.crawlStats;
      const nodeMetadata = new Map(
        graph.nodes.map((node) => [
          node.urlPath,
          {
            screenshot: node.screenshot,
            actualTitle: node.actualTitle,
            isStartNode: node.isStartNode,
            startOrder: node.startOrder,
          },
        ]),
      );

      graph = buildGraph(
        templateData,
        explicitRoutes,
        basePath,
        exclude,
        runtimeEdges,
      );

      graph.runtimeEdges = runtimeEdges;
      graph.crawlStats = crawlStats;

      graph.nodes.forEach((node) => {
        const existing = nodeMetadata.get(node.urlPath);
        if (!existing) return;
        if (existing.screenshot) node.screenshot = existing.screenshot;
        if (existing.actualTitle) node.actualTitle = existing.actualTitle;
        if (existing.isStartNode) node.isStartNode = existing.isStartNode;
        if (existing.startOrder !== undefined) {
          node.startOrder = existing.startOrder;
        }
      });

      if (exclude) {
        graph = filterByExclusion(graph, exclude);
      }
      if (from) {
        graph = filterByReachability(graph, from);
      }

      if (graph.crawlStats) {
        graph.crawlStats.runtimeEdgesMerged = graph.runtimeEdges.length;
      }
    }

    console.log(
      `   Captured ${graph.nodes.filter((n) => n.screenshot).length} screenshots`,
    );

    if (runtimeCrawl && graph.crawlStats) {
      console.log(
        `   Runtime crawl: ${graph.crawlStats.pagesVisited || 0} pages visited, ` +
          `${graph.crawlStats.runtimeLinksExtracted || 0} links extracted, ` +
          `${graph.crawlStats.runtimeEdgesDiscovered || 0} runtime edges discovered`,
      );
      console.log(
        `   Updated graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
      );
    }
  } else {
    console.log("5️⃣  Skipping screenshots (--no-screenshots)");
  }

  // Step 6: Build the viewer
  console.log("6️⃣  Building interactive viewer...");
  await buildViewer(graph, mapOutputDir, screenshots, viewport, {
    name,
    rootOutputDir: name ? outputDir : null,
  });
  console.log("   Viewer built");

  if (shouldExportPdf) {
    const resolvedPdfMode = pdfMode || "canvas";
    console.log(`   Generating PDF export (${resolvedPdfMode})...`);
    await exportPdf({
      viewerHtmlPath: path.join(mapOutputDir, "index.html"),
      outputDir: mapOutputDir,
      mode: resolvedPdfMode,
    });
    console.log("   PDF written (map.pdf)");
  }

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
      runtimeCrawl,
    };
    fs.mkdirSync(mapOutputDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapOutputDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );

    console.log("7️⃣  Building collection index...");
    buildIndex(outputDir);
    console.log("   Collection index built");
  }
}

async function generateNative(options) {
  const { prototypePath, outputDir, name, title, screenshots } = options;

  const mapOutputDir = name ? path.join(outputDir, "maps", name) : outputDir;

  // Step 1: Scan for Swift source files
  console.log("1️⃣  Scanning Swift files...");
  const swiftFiles = scanSwiftFiles(prototypePath);
  console.log(`   Found ${swiftFiles.length} Swift files`);

  // Step 2: Parse each file for navigation patterns
  console.log("2️⃣  Parsing views for navigation...");
  const parsedViews = [];
  for (const file of swiftFiles) {
    const parsed = parseSwiftFile(file, prototypePath);
    if (parsed) parsedViews.push(parsed);
  }
  console.log(`   Parsed ${parsedViews.length} SwiftUI views`);

  // Step 3: Build the graph
  console.log("3️⃣  Building flow graph...");
  const config = loadConfig(prototypePath);
  let graph = buildSwiftGraph(parsedViews);
  graph = applyExclusions(graph, config.exclude);
  console.log(
    `   Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
  );
  if (config.exclude.length > 0) {
    console.log(`   Excluded: ${config.exclude.join(", ")}`);
  }

  // Step 4: Capture screenshots via XCUITest (if enabled)
  if (screenshots) {
    console.log("4️⃣  Capturing screenshots via XCUITest...");
    graph = await crawlAndScreenshotIos(graph, {
      prototypePath,
      outputDir: mapOutputDir,
      overrides: config.overrides,
    });
    console.log(
      `   Captured ${graph.nodes.filter((n) => n.screenshot).length} screenshots`,
    );
  } else {
    console.log("4️⃣  Skipping screenshots (--no-screenshots)");
  }

  // Step 5: Build the viewer
  console.log("5️⃣  Building interactive viewer...");
  await buildViewer(graph, mapOutputDir, screenshots, null, {
    name,
    rootOutputDir: name ? outputDir : null,
  });
  console.log("   Viewer built");

  // Step 6: Generate Mermaid sitemap
  buildMermaid(graph, mapOutputDir);
  console.log("   Mermaid sitemap written");

  // Step 7: Write map metadata and rebuild collection index (multi-map mode)
  if (name) {
    const meta = {
      name,
      title: title || path.basename(prototypePath),
      updatedAt: new Date().toISOString(),
      platform: "ios",
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      hasScreenshots: Boolean(screenshots),
    };
    fs.mkdirSync(mapOutputDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapOutputDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );

    console.log("7️⃣  Building collection index...");
    buildIndex(outputDir);
    console.log("   Collection index built");
  }
}

async function generateScenario(options) {
  const {
    prototypePath,
    outputDir,
    port,
    viewport,
    name,
    title,
    exportPdf: shouldExportPdf,
    pdfMode,
    config,
    scenario: scenarioName,
    scenarioSet,
  } = options;

  // Resolve which scenarios to run
  const scenarios = getScenarios(config, {
    scenario: scenarioName,
    scenarioSet,
  });
  console.log(
    `   Running ${scenarios.length} scenario(s): ${scenarios.map((s) => s.name).join(", ")}`,
  );

  // Pre-resolve steps for all scenarios
  const resolvedStepsMap = new Map();
  for (const scenario of scenarios) {
    const resolved = resolveSteps(scenario.steps, config.fragments || {});
    resolvedStepsMap.set(scenario.name, resolved);
  }

  // Log scenario plans
  for (const scenario of scenarios) {
    const resolved = resolvedStepsMap.get(scenario.name);
    console.log(`\n── Scenario: ${scenario.name} ──`);
    if (scenario.description) {
      console.log(`   ${scenario.description}`);
    }
    console.log(`   Start URL: ${scenario.startUrl}`);
    console.log(
      `   Steps: ${resolved.length} (${scenario.steps.length} before fragment expansion)`,
    );
    console.log(
      `   Scope: include ${scenario.scope.includePrefixes.length} prefixes, exclude ${scenario.scope.excludePrefixes.length} prefixes`,
    );
    console.log(
      `   Limits: max ${scenario.limits.maxPages} pages, depth ${scenario.limits.maxDepth}`,
    );
  }

  // Run static analysis for enrichment
  console.log(`\n1️⃣  Running static analysis for enrichment...`);
  const templateFiles = scanTemplates(prototypePath);
  const templateData = [];
  for (const file of templateFiles) {
    const parsed = parseTemplate(file, prototypePath);
    if (parsed) templateData.push(parsed);
  }
  const explicitRoutes = parseRoutes(prototypePath);
  console.log(
    `   Parsed ${templateData.length} templates, ${explicitRoutes.length} route handlers`,
  );

  // Pre-compute map output directories for each scenario
  const mapOutputDirs = new Map();
  const scenarioMapNames = new Map();
  for (const scenario of scenarios) {
    const scenarioMapName =
      scenarios.length > 1
        ? `${name || "scenario"}-${scenario.name}`
        : name || scenario.name;
    scenarioMapNames.set(scenario.name, scenarioMapName);
    mapOutputDirs.set(
      scenario.name,
      path.join(outputDir, "maps", scenarioMapName),
    );
  }

  // Run all scenarios
  console.log(`\n   Starting prototype server and browser...`);
  const results = await runScenarios(scenarios, {
    prototypePath,
    port,
    viewport,
    mapOutputDirs,
    config,
    resolvedStepsMap,
  });

  // Build output for each scenario
  for (const result of results) {
    const scenarioMapName = scenarioMapNames.get(result.name);
    const mapOutputDir = mapOutputDirs.get(result.name);

    console.log(`\n── Output: ${result.name} ──`);
    console.log(
      `   Runtime: ${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges`,
    );
    console.log(
      `   Crawl: ${result.crawlStats.pagesVisited} pages visited, ${result.crawlStats.runtimeLinksExtracted} links extracted`,
    );

    // Enrich with static analysis
    const { enrichmentStats } = enrichScenarioGraph(
      result.graph,
      templateData,
      explicitRoutes,
    );
    console.log(
      `   Enriched: ${enrichmentStats.nodesEnriched} nodes enriched, ${enrichmentStats.staticEdgesAdded} static edges added`,
    );
    console.log(
      `   Final: ${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges`,
    );

    // Build viewer for each scenario
    console.log(`   Building viewer...`);
    await buildViewer(result.graph, mapOutputDir, true, viewport, {
      name: scenarioMapName,
      rootOutputDir: outputDir,
    });
    console.log(`   Viewer built`);

    // Build Mermaid sitemap
    buildMermaid(result.graph, mapOutputDir);
    console.log(`   Mermaid sitemap written`);

    // Export PDF if requested
    if (shouldExportPdf) {
      const resolvedPdfMode = pdfMode || "canvas";
      console.log(`   Generating PDF export (${resolvedPdfMode})...`);
      await exportPdf({
        viewerHtmlPath: path.join(mapOutputDir, "index.html"),
        outputDir: mapOutputDir,
        mode: resolvedPdfMode,
      });
      console.log(`   PDF written (map.pdf)`);
    }

    // Always write metadata and graph data (used by combined map builder)
    const scenarioTitle = results.length > 1
      ? `${title || name || "Scenario"}: ${result.name}`
      : title || result.name;
    const meta = {
      name: scenarioMapName,
      title: scenarioTitle,
      updatedAt: new Date().toISOString(),
      mode: "scenario",
      scenario: result.name,
      nodeCount: result.graph.nodes.length,
      edgeCount: result.graph.edges.length,
      hasScreenshots: true,
      crawlStats: result.crawlStats,
    };
    fs.mkdirSync(mapOutputDir, { recursive: true });
    fs.writeFileSync(
      path.join(mapOutputDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );

    // Write graph data
    fs.writeFileSync(
      path.join(mapOutputDir, "graph-data.json"),
      JSON.stringify(result.graph, null, 2),
    );
  }

  // When multiple scenarios are run, also build a combined map
  if (results.length > 1) {
    console.log(`\n── Combined map ──`);
    const combinedGraph = mergeScenarioGraphs(results, mapOutputDirs, scenarioMapNames);
    console.log(
      `   Merged: ${combinedGraph.nodes.length} nodes, ${combinedGraph.edges.length} edges`,
    );

    const combinedMapName = name || "combined";
    const combinedOutputDir = path.join(outputDir, "maps", combinedMapName);
    fs.mkdirSync(combinedOutputDir, { recursive: true });

    // Copy screenshots from each scenario into the combined output
    const combinedScreenshotsDir = path.join(combinedOutputDir, "screenshots");
    fs.mkdirSync(combinedScreenshotsDir, { recursive: true });
    for (const result of results) {
      const srcDir = path.join(mapOutputDirs.get(result.name), "screenshots");
      if (fs.existsSync(srcDir)) {
        for (const file of fs.readdirSync(srcDir)) {
          const src = path.join(srcDir, file);
          const dest = path.join(combinedScreenshotsDir, file);
          if (!fs.existsSync(dest)) {
            fs.copyFileSync(src, dest);
          }
        }
      }
    }

    await buildViewer(combinedGraph, combinedOutputDir, true, viewport, {
      name: combinedMapName,
      rootOutputDir: outputDir,
    });
    console.log(`   Combined viewer built`);

    buildMermaid(combinedGraph, combinedOutputDir);

    const combinedMeta = {
      name: combinedMapName,
      title: title || "Combined scenarios",
      updatedAt: new Date().toISOString(),
      mode: "scenario",
      scenario: results.map((r) => r.name).join(" + "),
      nodeCount: combinedGraph.nodes.length,
      edgeCount: combinedGraph.edges.length,
      hasScreenshots: true,
    };
    fs.writeFileSync(
      path.join(combinedOutputDir, "meta.json"),
      JSON.stringify(combinedMeta, null, 2),
    );
    fs.writeFileSync(
      path.join(combinedOutputDir, "graph-data.json"),
      JSON.stringify(combinedGraph, null, 2),
    );
  }

  // Rebuild collection index
  if (name || results.length > 1) {
    console.log(`\n   Building collection index...`);
    buildIndex(outputDir);
    console.log(`   Collection index built`);
  }
}

/**
 * Merge multiple scenario graphs into a single combined graph.
 * Shared nodes (e.g. /dashboard) are merged; edges are deduplicated.
 * Layout ranks are recomputed so shared nodes sit at the top and
 * each scenario's flow extends below.
 */
function mergeScenarioGraphs(results, mapOutputDirs, scenarioMapNames) {
  const nodeMap = new Map();
  const edgeKeys = new Set();
  const edges = [];

  for (const result of results) {
    const scenarioScreenshotPrefix = scenarioMapNames.get(result.name);
    const scenarioOutputDir = mapOutputDirs.get(result.name);

    for (const node of result.graph.nodes) {
      if (!nodeMap.has(node.id)) {
        nodeMap.set(node.id, {
          ...node,
          scenarios: [result.name],
        });
      } else {
        // Node already exists from another scenario — mark as shared
        const existing = nodeMap.get(node.id);
        if (!existing.scenarios.includes(result.name)) {
          existing.scenarios.push(result.name);
        }
      }
    }

    for (const edge of result.graph.edges) {
      const key = `${edge.source}|${edge.target}|${edge.type}|${edge.method || "GET"}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({ ...edge, scenario: result.name });
      }
    }
  }

  // Recompute layout ranks for the combined graph.
  // Strategy: shared nodes get rank 0. Each scenario's non-shared nodes
  // keep their relative rank ordering, offset so scenarios don't collide.
  // Each scenario gets its own rank range so their flows remain separate.
  const nodes = Array.from(nodeMap.values());
  const sharedNodes = nodes.filter((n) => n.scenarios && n.scenarios.length > 1);
  const sharedIds = new Set(sharedNodes.map((n) => n.id));

  // Give shared nodes rank 0
  sharedNodes.forEach((n) => { n.layoutRank = 0; });

  // Assign each scenario its own rank range so flows don't interleave.
  let nextRank = 1;
  for (const result of results) {
    const scenarioNodes = result.graph.nodes
      .filter((n) => !sharedIds.has(n.id) && n.layoutRank !== undefined)
      .sort((a, b) => a.layoutRank - b.layoutRank);

    if (scenarioNodes.length === 0) continue;

    // Get the distinct ranks used by this scenario's non-shared nodes
    const origRanks = [...new Set(scenarioNodes.map((n) => n.layoutRank))].sort((a, b) => a - b);
    // Map each original rank to a combined rank, starting after the previous scenario
    const rankMapping = new Map();
    origRanks.forEach((origRank, idx) => {
      rankMapping.set(origRank, nextRank + idx);
    });

    for (const n of scenarioNodes) {
      const merged = nodeMap.get(n.id);
      if (merged) merged.layoutRank = rankMapping.get(n.layoutRank);
    }

    nextRank += origRanks.length;
  }

  return { nodes, edges };
}

module.exports = { generate, generateNative };
