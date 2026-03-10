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
 * Two modes:
 * - Visit-driven: map steps contain `visit` steps — the script defines exactly
 *   which pages to map, in order. Edges are built from the links each page
 *   actually contains, but only to other visited pages.
 * - BFS-crawl: no `visit` steps — crawls from startUrl following links in scope.
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

    // Check if this is a visit-driven scenario
    const hasVisitSteps = mapSteps.some((s) => s.type === "visit");

    if (hasVisitSteps) {
      // Visit-driven mode: follow the script exactly
      await visitDrivenMap({
        page,
        baseUrl,
        scenario,
        mapSteps,
        nodes,
        edges,
        edgeKeys,
        crawlStats,
        screenshotsDir: scenarioScreenshotsDir,
      });
    } else {
      // BFS-crawl mode: navigate to startUrl, then crawl
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

      // Execute any post-beginMap non-visit steps before crawling
      for (const step of mapSteps) {
        if (step.type === "endMap") break;
        await executeStep(page, step, baseUrl);
      }

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
    }

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
 * Visit-driven mapping: follow the script's visit steps exactly.
 *
 * 1. Collect all visit URLs to know the full set of pages to map.
 * 2. Visit each in order, taking a screenshot on first visit.
 * 3. On each page, extract links from the DOM.
 * 4. Create edges only between pages that are both in the visit set.
 *
 * This produces a graph that reflects the user's actual journey with
 * cross-links between sibling pages (e.g. tab navigation).
 */
async function visitDrivenMap(options) {
  const {
    page,
    baseUrl,
    scenario,
    mapSteps,
    nodes,
    edges,
    edgeKeys,
    crawlStats,
    screenshotsDir,
  } = options;

  // Collect all visit URLs (the full set of pages to include in the map)
  const visitUrls = mapSteps
    .filter((s) => s.type === "visit")
    .map((s) => canonicalizePath(s.url));
  const visitSet = new Set(visitUrls);

  // Track links extracted from each page (for building cross-edges)
  const pageLinks = new Map();

  for (const step of mapSteps) {
    if (step.type === "endMap") break;

    if (step.type === "visit") {
      const urlPath = canonicalizePath(step.url);

      // Navigate to the page
      try {
        await page.goto(`${baseUrl}${step.url}`, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await Promise.race([
          page.waitForLoadState("networkidle"),
          page.waitForTimeout(3000),
        ]);
      } catch (err) {
        console.warn(`   Could not visit ${urlPath}: ${err.message}`);
        continue;
      }

      // Only screenshot and extract links on first visit
      if (!nodes.has(urlPath)) {
        const result = await visitPage(page, urlPath, {
          baseUrl,
          scenario,
          screenshotsDir,
          crawlStats,
        });

        if (result) {
          nodes.set(urlPath, result.node);
          pageLinks.set(urlPath, result.links);
        }
      }
    } else {
      // Execute non-visit steps (click, fill, etc.) inline
      try {
        await executeStep(page, step, baseUrl);
      } catch (err) {
        console.warn(`   Step failed: ${describeStep(step)} — ${err.message}`);
      }
    }
  }

  // Build edges: for each visited page, check which of its DOM links
  // point to other visited pages
  for (const [sourcePath, links] of pageLinks) {
    for (const link of links) {
      // Canonicalize the link target and check if it's in our visit set
      const target = canonicalizePath(link.target);
      if (!target || target === sourcePath) continue;
      if (!visitSet.has(target)) continue;

      addEdge(edges, edgeKeys, sourcePath, {
        ...link,
        target,
      });
    }
  }

  crawlStats.runtimeEdgesDiscovered = edges.length;
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
    case "visit":
      return `visit ${step.url}`;
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
  // For an experience map we only need one instance of each pattern —
  // every clinic or patient has identical screens, just different content.
  const MAX_PER_CANONICAL = 1;
  const canonicalVisitCounts = new Map();

  function shouldVisitUrl(url) {
    if (visited.has(url)) return false;
    const canonical = canonicalizePath(url);
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

  // Dismiss modals, overlays, and notification banners before screenshotting
  try {
    await page.evaluate(() => {
      // Remove modal overlays and dialogs
      document.querySelectorAll(
        '.app-modal__overlay, .app-modal--open, [role="dialog"], .modal-backdrop, .modal.show, .overlay'
      ).forEach((el) => el.remove());
      document.body.classList.remove("app-modal-open");
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";

      // Remove notification/flash banners that may overlay content
      document.querySelectorAll(
        '.app-reading-opinion-banner, .nhsuk-notification-banner, .flash-message'
      ).forEach((el) => el.remove());
    });
  } catch { /* ignore */ }

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

  // Measure actual page dimensions for dynamic node sizing
  const pageDims = await page.evaluate(() => ({
    width: window.innerWidth,
    height: document.body.scrollHeight,
  }));

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
    screenshotAspectRatio: pageDims.height / pageDims.width,
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
