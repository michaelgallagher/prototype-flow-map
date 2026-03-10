const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const {
  startServer,
  stopServer,
  extractRuntimeLinks,
  canonicalizePath,
  urlToFilename,
} = require("./crawler");

/**
 * Run one or more scenarios against a prototype server.
 * Starts the server once, runs each scenario in an isolated browser context,
 * then stops the server.
 *
 * @param {Array} scenarios - Validated scenario objects
 * @param {Object} options
 * @param {string} options.prototypePath - Path to prototype project
 * @param {number} options.port - Server port
 * @param {Object} options.viewport - { width, height }
 * @param {Map} options.mapOutputDirs - Map of scenario.name → output directory
 * @param {Object} options.config - Full config object
 * @param {Map} options.resolvedStepsMap - Map of scenario.name → resolved steps
 *
 * Returns an array of scenario results, each with { name, graph, crawlStats }.
 */
async function runScenarios(scenarios, options) {
  const {
    prototypePath,
    port,
    viewport,
    mapOutputDirs,
    config,
    resolvedStepsMap,
  } = options;

  const server = await startServer(prototypePath, port);
  const baseUrl = `http://localhost:${port}`;
  let browser;

  try {
    browser = await chromium.launch();
    const results = [];

    for (const scenario of scenarios) {
      const resolvedSteps = resolvedStepsMap.get(scenario.name);
      const mapOutputDir = mapOutputDirs.get(scenario.name);
      const result = await runSingleScenario(scenario, {
        browser,
        baseUrl,
        viewport,
        mapOutputDir,
        resolvedSteps,
        config,
      });
      results.push(result);
    }

    return results;
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }
}

/**
 * Run a single scenario in its own browser context.
 * Executes setup steps, then BFS-crawls from startUrl.
 */
async function runSingleScenario(scenario, options) {
  const { browser, baseUrl, viewport, mapOutputDir, resolvedSteps, config } = options;

  const scenarioScreenshotsDir = path.join(mapOutputDir, "screenshots");
  fs.mkdirSync(scenarioScreenshotsDir, { recursive: true });

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
  });

  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const crawlStats = {
    pagesVisited: 0,
    runtimeLinksExtracted: 0,
    runtimeEdgesDiscovered: 0,
    setupStepsExecuted: 0,
  };

  try {
    const page = await context.newPage();

    // Split steps at beginMap
    const { setupSteps, mapSteps } = splitAtBeginMap(resolvedSteps);

    // Execute setup steps
    for (const step of setupSteps) {
      try {
        await executeStep(page, step, baseUrl);
        crawlStats.setupStepsExecuted++;
      } catch (err) {
        console.warn(
          `   Setup step failed, continuing with remaining steps...`,
        );
      }
    }

    // After setup, navigate to startUrl if we haven't already landed there
    const currentPath = canonicalizePath(new URL(page.url()).pathname);
    if (currentPath !== canonicalizePath(scenario.startUrl)) {
      await page.goto(`${baseUrl}${scenario.startUrl}`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await Promise.race([
        page.waitForLoadState("networkidle"),
        page.waitForTimeout(3000),
      ]);
    }

    // Execute any post-beginMap steps before crawling
    for (const step of mapSteps) {
      if (step.type === "endMap") break;
      await executeStep(page, step, baseUrl);
    }

    // BFS crawl from the current page
    await bfsCrawl({
      page,
      context,
      baseUrl,
      scenario,
      nodes,
      edges,
      edgeKeys,
      crawlStats,
      screenshotsDir: scenarioScreenshotsDir,
      config,
    });

    await page.close();
  } finally {
    await context.close();
  }

  return {
    name: scenario.name,
    graph: {
      nodes: Array.from(nodes.values()),
      edges,
    },
    crawlStats,
  };
}

/**
 * Split resolved steps into setup (before beginMap) and map (after beginMap).
 */
function splitAtBeginMap(steps) {
  const beginIdx = steps.findIndex((s) => s.type === "beginMap");
  if (beginIdx === -1) {
    // No beginMap — all steps are setup, crawl starts after
    return { setupSteps: steps, mapSteps: [] };
  }
  return {
    setupSteps: steps.slice(0, beginIdx),
    mapSteps: steps.slice(beginIdx + 1),
  };
}

/**
 * Execute a single scenario step against a Playwright page.
 */
async function executeStep(page, step, baseUrl) {
  const stepDesc = describeStep(step);
  try {
    switch (step.type) {
      case "goto":
        await page.goto(`${baseUrl}${step.url}`, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await Promise.race([
          page.waitForLoadState("networkidle"),
          page.waitForTimeout(3000),
        ]);
        break;

      case "click":
        await page.click(step.selector, { timeout: 5000 });
        await Promise.race([
          page.waitForLoadState("networkidle"),
          page.waitForTimeout(3000),
        ]);
        break;

      case "fill":
        await page.fill(step.selector, step.value, { timeout: 5000 });
        break;

      case "select":
        await page.selectOption(step.selector, step.value, { timeout: 5000 });
        break;

      case "check":
        await page.check(step.selector, { timeout: 5000 });
        break;

      case "submit": {
        const form = await page.waitForSelector(step.selector, {
          timeout: 5000,
        });
        await form.evaluate((el) => el.submit());
        await Promise.race([
          page.waitForLoadState("networkidle"),
          page.waitForTimeout(3000),
        ]);
        break;
      }

      case "waitForUrl":
        // Support prefix matching: /dashboard matches /dashboard?query=...
        await page.waitForURL(
          (url) => url.pathname.startsWith(step.url) || url.pathname === step.url,
          { timeout: 10000 },
        );
        break;

      case "waitForSelector":
        await page.waitForSelector(step.selector, { timeout: 10000 });
        break;

      case "wait":
        await page.waitForTimeout(step.ms);
        break;

      case "beginMap":
      case "endMap":
        // Handled by the caller
        break;
    }
  } catch (err) {
    console.warn(`   ⚠️  Step failed: ${stepDesc} — ${err.message}`);
    throw err;
  }
}

function describeStep(step) {
  switch (step.type) {
    case "goto":
      return `goto ${step.url}`;
    case "click":
      return `click "${step.selector}"`;
    case "fill":
      return `fill "${step.selector}" with "${step.value}"`;
    case "select":
      return `select "${step.value}" in "${step.selector}"`;
    case "check":
      return `check "${step.selector}"`;
    case "submit":
      return `submit "${step.selector}"`;
    case "waitForUrl":
      return `waitForUrl ${step.url}`;
    case "waitForSelector":
      return `waitForSelector "${step.selector}"`;
    case "wait":
      return `wait ${step.ms}ms`;
    case "beginMap":
      return `beginMap`;
    case "endMap":
      return `endMap`;
    default:
      return step.type;
  }
}

/**
 * BFS crawl from the current page, following links within scope.
 */
async function bfsCrawl(options) {
  const {
    page: initialPage,
    context,
    baseUrl,
    scenario,
    nodes,
    edges,
    edgeKeys,
    crawlStats,
    screenshotsDir,
    config,
  } = options;

  const suppressGlobalNav =
    config?.runtimeMapping?.filters?.suppressGlobalNav !== false;

  // In scenario mode, only suppress links that are clearly utility/global nav
  // by target or text — not by layout position (which catches tab nav, etc.)
  function isDefinitelyGlobalNav(link) {
    if (!suppressGlobalNav) return false;
    if (!link.isGlobalNav) return false;

    const text = (link.normalizedText || link.text || "").toLowerCase().trim();
    const globalNavTexts = new Set([
      "accessibility", "accessibility statement",
      "contact us", "contact",
      "terms and conditions",
      "log out", "logout",
      "settings",
    ]);
    if (globalNavTexts.has(text)) return true;

    const globalNavTargets = new Set([
      "/", "/accessibility-statement", "/contact",
      "/terms-and-conditions", "/settings",
    ]);
    if (globalNavTargets.has(link.target)) return true;

    return false;
  }

  const { maxPages, maxDepth } = scenario.limits;
  const visited = new Set();

  // Track how many concrete URLs we've visited per canonical pattern.
  // e.g. /participants/:id → 3 means we've visited 3 different participant pages.
  // This prevents the BFS from exhaustively visiting every entity instance.
  const MAX_PER_CANONICAL = 3;
  const canonicalVisitCounts = new Map();

  function shouldVisitUrl(url) {
    if (visited.has(url)) return false;
    const canonical = canonicalizePath(url);
    // If the canonical form equals the raw URL, it's not parameterized — always visit
    if (canonical === url) return true;
    const count = canonicalVisitCounts.get(canonical) || 0;
    return count < MAX_PER_CANONICAL;
  }

  function recordVisit(url) {
    visited.add(url);
    const canonical = canonicalizePath(url);
    if (canonical !== url) {
      canonicalVisitCounts.set(
        canonical,
        (canonicalVisitCounts.get(canonical) || 0) + 1,
      );
    }
  }

  // Queue entries: { url, depth }
  const queue = [];

  // Process the initial page (the startUrl after setup)
  const startPath = canonicalizePath(new URL(initialPage.url()).pathname);
  recordVisit(startPath);

  const startResult = await visitPage(initialPage, startPath, {
    baseUrl,
    scenario,
    screenshotsDir,
    crawlStats,
  });

  if (startResult) {
    nodes.set(startPath, startResult.node);
    for (const link of startResult.links) {
      if (isDefinitelyGlobalNav(link)) continue;
      if (isInScope(link.target, scenario) && shouldVisitUrl(link.target)) {
        queue.push({ url: link.target, depth: 1 });
      }
      if (isInScope(link.target, scenario)) {
        addEdge(edges, edgeKeys, startPath, link);
      }
    }
  }

  // BFS loop
  while (queue.length > 0 && nodes.size < maxPages) {
    const { url, depth } = queue.shift();

    if (!shouldVisitUrl(url)) continue;
    if (depth > maxDepth) continue;
    recordVisit(url);

    let page;
    try {
      page = await context.newPage();
      const response = await page.goto(`${baseUrl}${url}`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      if (!response || !response.ok()) {
        await page.close();
        continue;
      }

      // Wait briefly for JS rendering without requiring full network idle
      await Promise.race([
        page.waitForLoadState("networkidle"),
        page.waitForTimeout(3000),
      ]);

      // Check for redirects
      const landedPath = canonicalizePath(new URL(page.url()).pathname);
      if (landedPath !== url) {
        // Record redirect edge but use landed page
        if (isInScope(landedPath, scenario) && shouldVisitUrl(landedPath)) {
          addEdge(edges, edgeKeys, url, {
            target: landedPath,
            text: "",
            kind: "redirect",
          });
          // Visit the landed page if not already visited
          if (!nodes.has(landedPath)) {
            recordVisit(landedPath);
            const result = await visitPage(page, landedPath, {
              baseUrl,
              scenario,
              screenshotsDir,
              crawlStats,
            });
            if (result) {
              nodes.set(landedPath, result.node);
              for (const link of result.links) {
                if (isDefinitelyGlobalNav(link)) continue;
                if (
                  isInScope(link.target, scenario) &&
                  shouldVisitUrl(link.target) &&
                  depth + 1 <= maxDepth
                ) {
                  queue.push({ url: link.target, depth: depth + 1 });
                }
                if (isInScope(link.target, scenario)) {
                  addEdge(edges, edgeKeys, landedPath, link);
                }
              }
            }
          }
        }
        await page.close();
        continue;
      }

      const result = await visitPage(page, url, {
        baseUrl,
        scenario,
        screenshotsDir,
        crawlStats,
      });

      if (result) {
        nodes.set(url, result.node);
        for (const link of result.links) {
          if (isDefinitelyGlobalNav(link)) continue;
          if (
            isInScope(link.target, scenario) &&
            shouldVisitUrl(link.target) &&
            depth + 1 <= maxDepth
          ) {
            queue.push({ url: link.target, depth: depth + 1 });
          }
          if (isInScope(link.target, scenario)) {
            addEdge(edges, edgeKeys, url, link);
          }
        }
      }

      await page.close();
    } catch (err) {
      console.warn(`   ⚠️  Could not visit ${url}: ${err.message}`);
      if (page) await page.close().catch(() => {});
    }
  }

  crawlStats.runtimeEdgesDiscovered = edges.length;
}

/**
 * Visit a page: take screenshot, extract links.
 * Returns { node, links } or null if the page is invalid.
 */
async function visitPage(page, urlPath, options) {
  const { baseUrl, scenario, screenshotsDir, crawlStats } = options;

  crawlStats.pagesVisited++;

  // Reposition fixed elements for full-page screenshot
  try {
    await page.evaluate(() => {
      const viewportH = window.innerHeight;
      const fixedEls = Array.from(document.querySelectorAll("*")).filter(
        (el) => window.getComputedStyle(el).position === "fixed",
      );
      if (fixedEls.length === 0) return;
      document.body.style.position = "relative";
      fixedEls.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const isBottomFixed = rect.top > viewportH / 2;
        document.body.appendChild(el);
        el.style.position = "absolute";
        el.style.left = "0";
        el.style.right = "0";
        el.style.margin = "0";
        if (isBottomFixed) {
          el.style.top = "auto";
          el.style.bottom = "0";
        } else {
          el.style.bottom = "auto";
          el.style.top = "0";
        }
      });
    });
  } catch (evalErr) {
    if (evalErr.message.includes("Execution context was destroyed")) {
      return null;
    }
  }

  // Screenshot
  const filename = urlToFilename(urlPath);
  const screenshotPath = path.join(screenshotsDir, filename);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const title = await page.title();

  // Extract links
  const extraction = await extractRuntimeLinks(page, urlPath, baseUrl);
  crawlStats.runtimeLinksExtracted += extraction.acceptedCount;

  // Build node
  const node = {
    id: urlPath,
    label: title || urlPath,
    urlPath,
    filePath: null,
    screenshot: `screenshots/${filename}`,
    type: "page",
    actualTitle: title,
    scenario: scenario.name,
  };

  return { node, links: extraction.links };
}

/**
 * Check if a URL path is within the scenario's scope.
 */
function isInScope(urlPath, scenario) {
  if (!urlPath || urlPath === "#") return false;

  const { includePrefixes, excludePrefixes } = scenario.scope;

  // Check excludes first
  if (excludePrefixes.length > 0) {
    for (const prefix of excludePrefixes) {
      if (urlPath.startsWith(prefix)) return false;
    }
  }

  // If includes are defined, path must match at least one
  if (includePrefixes.length > 0) {
    return includePrefixes.some((prefix) => urlPath.startsWith(prefix));
  }

  return true;
}

/**
 * Add an edge, deduplicating by key.
 */
function addEdge(edges, edgeKeys, fromPath, link) {
  const key = `${fromPath}|${link.target}|${link.kind || "link"}|${(link.method || "GET").toUpperCase()}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);

  edges.push({
    source: fromPath,
    target: link.target,
    type: link.kind === "form" ? "form" : "link",
    label: link.text || "",
    method: link.method || "GET",
    provenance: "runtime",
    isGlobalNav: Boolean(link.isGlobalNav),
  });
}

module.exports = { runScenarios };
