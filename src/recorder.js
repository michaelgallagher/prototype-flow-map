const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const {
  startServer,
  stopServer,
  extractRuntimeLinks,
  urlToFilename,
  canonicalizePath,
} = require("./crawler");
const { serializeFlow, serializeStep } = require("./flow-serializer");
const { buildViewer } = require("./build-viewer");
const { buildMermaid } = require("./build-mermaid");
const { buildIndex } = require("./build-index");

/**
 * Start an interactive recording session.
 *
 * Opens a headed browser. During the Map phase, captures screenshots and
 * extracts links in real-time as the user navigates. When done, builds
 * the flow map viewer directly from the captured data. Also saves a .flow
 * file as a secondary output.
 */
async function startRecording({
  prototypePath,
  port,
  viewport,
  outputFilename,
  outputDir,
  name,
  title,
  open,
}) {
  const { child: server, port: actualPort } = await startServer(
    prototypePath,
    port,
  );
  if (actualPort !== port) {
    console.log(`   Server started on port ${actualPort} (requested ${port})`);
  }

  const baseUrl = `http://localhost:${actualPort}`;
  const mapOutputDir = name ? path.join(outputDir, "maps", name) : outputDir;
  const screenshotsDir = path.join(mapOutputDir, "screenshots");

  let browser;

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: null });

    // Inject the recorder script into every page
    const injectPath = path.join(__dirname, "recorder-inject.js");
    await context.addInitScript({ path: injectPath });

    const page = await context.newPage();

    // ─── State ────────────────────────────────────────────────────────

    let phase = "setup";
    const setupSteps = [];
    const mapSteps = [];
    let stepNumber = 0;
    let startUrl = "/";
    let done = false;

    // Graph data — built in real-time during Map phase
    const nodes = new Map();
    const edges = [];
    const edgeKeys = new Set();
    const pageLinks = new Map();
    const visitOrder = [];
    let lastCapturedUrl = null;

    // Capture queue — serializes async captures to avoid races
    let captureChain = Promise.resolve();

    // Navigation debounce
    let navTimer = null;
    let lastNavUrl = null;
    // Track visited URLs to avoid duplicate Visit steps
    const visitedUrls = new Set();

    // ─── Helpers ──────────────────────────────────────────────────────

    function logStep(step) {
      stepNumber++;
      const line = serializeStep(step);
      console.log(`   ${String(stepNumber).padStart(2)}. ${line}`);
    }

    /**
     * Capture a page: hide toolbar, take screenshot, extract links,
     * build node. Runs async but serialized via captureChain.
     */
    async function capturePage(urlPath) {
      // Skip if already captured
      if (nodes.has(urlPath)) return;

      try {
        // Hide toolbar for screenshot
        await page.evaluate(() => {
          const bar = document.querySelector(".flow-recorder-toolbar");
          if (bar) bar.style.display = "none";
          document.body.style.marginTop = "0";
        });

        // Dismiss modals/overlays
        await page.evaluate(() => {
          document
            .querySelectorAll(
              '.app-modal__overlay, .app-modal--open, [role="dialog"], .modal-backdrop, .modal.show, .overlay',
            )
            .forEach((el) => el.remove());
          document.body.classList.remove("app-modal-open");
          document.body.style.position = "";
          document.body.style.top = "";
          document.body.style.width = "";
          document
            .querySelectorAll(
              ".app-reading-opinion-banner, .nhsuk-notification-banner, .flash-message",
            )
            .forEach((el) => el.remove());
        });

        // Reposition fixed elements for full-page screenshot
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

        // Measure page dimensions
        const pageDims = await page.evaluate(() => ({
          width: window.innerWidth,
          height: document.body.scrollHeight,
        }));

        // Take screenshot
        fs.mkdirSync(screenshotsDir, { recursive: true });
        const filename = urlToFilename(urlPath);
        const screenshotPath = path.join(screenshotsDir, filename);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        const pageTitle = await page.title();

        // Extract links
        const extraction = await extractRuntimeLinks(page, urlPath, baseUrl);

        // Build node
        const node = {
          id: urlPath,
          label: pageTitle || urlPath,
          urlPath,
          filePath: null,
          screenshot: `screenshots/${filename}`,
          type: "page",
          actualTitle: pageTitle,
          scenario: "recorded",
          screenshotAspectRatio: pageDims.height / pageDims.width,
        };

        nodes.set(urlPath, node);
        pageLinks.set(urlPath, extraction.links);
        visitOrder.push(urlPath);

        // Sequential edge from last captured page
        if (lastCapturedUrl && lastCapturedUrl !== urlPath) {
          addEdge(edges, edgeKeys, lastCapturedUrl, {
            target: urlPath,
            text: "",
            kind: "link",
          });
        }
        lastCapturedUrl = urlPath;

        console.log(`   📸 Captured: ${urlPath} (${pageTitle || "untitled"})`);
      } catch (err) {
        if (err.message.includes("Execution context was destroyed")) {
          // User navigated away during capture — skip
          return;
        }
        console.warn(`   ⚠️  Capture failed for ${urlPath}: ${err.message}`);
      } finally {
        // Restore toolbar
        try {
          await page.evaluate(() => {
            const bar = document.querySelector(".flow-recorder-toolbar");
            if (bar) bar.style.display = "flex";
            document.body.style.marginTop = "40px";
          });
        } catch {
          // Page may have navigated away — ignore
        }
      }
    }

    function queueCapture(urlPath) {
      captureChain = captureChain
        .then(() => capturePage(urlPath))
        .catch(() => {});
    }

    function handleNavigation(url) {
      try {
        const parsed = new URL(url);
        // Normalize: strip trailing slashes to prevent duplicates
        // (/clinics/wtrl7jud/ and /clinics/wtrl7jud are the same page)
        let urlPath = parsed.pathname;
        if (urlPath.length > 1 && urlPath.endsWith("/")) {
          urlPath = urlPath.replace(/\/+$/, "");
        }

        if (phase === "setup") {
          const step = { type: "goto", url: urlPath };
          setupSteps.push(step);
          logStep(step);
          startUrl = urlPath;
        } else {
          // In Map phase: record Visit step AND queue a screenshot capture
          if (!visitedUrls.has(urlPath)) {
            visitedUrls.add(urlPath);
            const step = { type: "visit", url: urlPath };
            mapSteps.push(step);
            logStep(step);
          }
          queueCapture(urlPath);
        }
      } catch {
        // Ignore invalid URLs
      }
    }

    // ─── Event listeners ──────────────────────────────────────────────

    page.on("console", (msg) => {
      if (msg.type() !== "log") return;

      let data;
      try {
        data = JSON.parse(msg.text());
      } catch {
        return;
      }
      if (!data || !data.__flowRecorder) return;

      switch (data.event) {
        case "step": {
          const step = data.step;
          (phase === "setup" ? setupSteps : mapSteps).push(step);
          logStep(step);
          break;
        }

        case "phase": {
          phase = data.phase;
          console.log(`\n   Phase: Map\n`);
          break;
        }

        case "capture": {
          // Manual Snapshot — also triggers a page capture
          const step = { type: "snapshot" };
          (phase === "setup" ? setupSteps : mapSteps).push(step);
          logStep(step);

          if (phase === "map") {
            try {
              const currentUrl = new URL(page.url());
              const urlPath = currentUrl.pathname;
              queueCapture(urlPath);
            } catch {
              // ignore
            }
          }
          break;
        }

        case "navigation": {
          handleNavigation(`${baseUrl}${data.url}`);
          break;
        }

        case "done": {
          done = true;
          break;
        }
      }
    });

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;

      const url = frame.url();
      if (!url.startsWith("http")) return;

      if (navTimer) clearTimeout(navTimer);
      lastNavUrl = url;
      navTimer = setTimeout(() => {
        handleNavigation(lastNavUrl);
        navTimer = null;
      }, 300);
    });

    // ─── Start recording ──────────────────────────────────────────────

    console.log(`\n   Phase: Setup\n`);
    await page.goto(baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Wait for done or browser close
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (done) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 200);

      context.on("close", () => {
        clearInterval(checkInterval);
        resolve();
      });

      page.on("close", () => {
        clearInterval(checkInterval);
        done = true;
        resolve();
      });
    });

    // Flush pending navigation
    if (navTimer) {
      clearTimeout(navTimer);
      handleNavigation(lastNavUrl);
    }

    // Wait for all pending captures to finish
    console.log(`\n   Finishing captures...`);
    await captureChain;

    // Close browser
    await browser.close().catch(() => {});
    browser = null;

    // ─── Build graph edges from extracted links ───────────────────────

    // Build canonicalToRaw mapping: extractRuntimeLinks returns
    // canonicalized targets (e.g. /clinics/:id) but our nodes are keyed
    // by raw paths (e.g. /clinics/wtrl7jud). This mapping resolves
    // canonical targets back to actual visited node IDs.
    const canonicalToRaw = new Map();
    for (const raw of visitOrder) {
      const canonical = canonicalizePath(raw);
      if (!canonicalToRaw.has(canonical)) {
        canonicalToRaw.set(canonical, raw);
      }
    }

    function resolveTarget(rawTarget) {
      // Direct match against raw node IDs
      if (nodes.has(rawTarget)) return rawTarget;
      // Try canonical → raw mapping
      const canonical = canonicalizePath(rawTarget);
      const mapped = canonicalToRaw.get(canonical);
      if (mapped && nodes.has(mapped)) return mapped;
      return null;
    }

    for (const [sourcePath, links] of pageLinks) {
      for (const link of links) {
        if (!link.target) continue;
        const target = resolveTarget(link.target);
        if (!target || target === sourcePath) continue;

        addEdge(edges, edgeKeys, sourcePath, {
          ...link,
          target,
        });
      }
    }

    // Compute layout ranks (layer-cake: tab siblings side-by-side)
    computeLayoutRanks(visitOrder, nodes, edges);

    // Mark first visited node as start
    if (visitOrder.length > 0) {
      const firstNode = nodes.get(visitOrder[0]);
      if (firstNode) firstNode.isStartNode = true;
    }

    // ─── Build viewer ─────────────────────────────────────────────────

    const graph = {
      nodes: Array.from(nodes.values()),
      edges,
    };

    if (graph.nodes.length > 0) {
      console.log(
        `\n   Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
      );

      // Use the viewport the user had during recording for the viewer,
      // or fall back to desktop defaults
      const viewerViewport = viewport || { width: 1280, height: 800 };

      console.log(`   Building viewer...`);
      await buildViewer(graph, mapOutputDir, true, viewerViewport, {
        name,
        rootOutputDir: name ? outputDir : null,
      });
      console.log(`   Viewer built`);

      buildMermaid(graph, mapOutputDir);
      console.log(`   Mermaid sitemap written`);

      // Write metadata
      if (name) {
        const meta = {
          name,
          title: title || path.basename(prototypePath),
          updatedAt: new Date().toISOString(),
          mode: "recorded",
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          hasScreenshots: true,
        };
        fs.writeFileSync(
          path.join(mapOutputDir, "meta.json"),
          JSON.stringify(meta, null, 2),
        );

        buildIndex(outputDir);
        console.log(`   Collection index built`);
      }

      const viewerPath = path.join(mapOutputDir, "index.html");
      console.log(`\n   Flow map: ${viewerPath}`);
    } else {
      console.log(
        `\n   No pages were captured in Map phase. Did you click "Begin mapping"?`,
      );
    }

    // ─── Save .flow file ──────────────────────────────────────────────

    const scenariosDir = path.join(prototypePath, "scenarios");
    fs.mkdirSync(scenariosDir, { recursive: true });

    let flowFilePath = path.join(scenariosDir, outputFilename);

    if (fs.existsSync(flowFilePath)) {
      const ext = path.extname(outputFilename);
      const base = path.basename(outputFilename, ext);
      let suffix = 2;
      while (
        fs.existsSync(path.join(scenariosDir, `${base}-${suffix}${ext}`))
      ) {
        suffix++;
      }
      flowFilePath = path.join(scenariosDir, `${base}-${suffix}${ext}`);
    }

    const totalSteps = setupSteps.length + mapSteps.length;

    // Post-process map steps for replay friendliness:
    // Replace Visit steps with dynamic URLs (containing session-specific IDs)
    // with Snapshot steps, since those URLs won't exist in a different session.
    // Keep Visit steps for static URLs that will work across sessions.
    const replayMapSteps = mapSteps.map((step) => {
      if (step.type === "visit" && canonicalizePath(step.url) !== step.url) {
        return { type: "snapshot" };
      }
      return step;
    });

    // Remove consecutive duplicate Snapshot steps
    const dedupedMapSteps = replayMapSteps.filter((step, i) => {
      if (step.type === "snapshot" && i > 0 && replayMapSteps[i - 1].type === "snapshot") {
        return false;
      }
      return true;
    });

    const flowContent = serializeFlow({ startUrl, setupSteps, mapSteps: dedupedMapSteps });
    fs.writeFileSync(flowFilePath, flowContent, "utf-8");

    console.log(`   Scenario saved: ${path.relative(process.cwd(), flowFilePath)}`);
    console.log(`   ${totalSteps} steps recorded, ${graph.nodes.length} pages captured.\n`);

    return {
      flowFilePath,
      viewerPath: graph.nodes.length > 0
        ? path.join(mapOutputDir, "index.html")
        : null,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
  }
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

/**
 * Compute layout ranks: group tab siblings (mutual cross-links with
 * shared URL parent) into the same rank layer, then assign incrementing
 * ranks following visit order. Produces a "layer cake" layout.
 */
function computeLayoutRanks(visitOrder, nodes, edges) {
  const edgeLookup = new Set(edges.map((e) => `${e.source}→${e.target}`));

  function areMutuallyLinked(a, b) {
    // Two pages are siblings if they link to each other in both directions.
    // No URL parent check — mutual cross-links are a strong enough signal
    // that pages are tabs/siblings (e.g. /clinics/wtrl7jud and
    // /clinics/wtrl7jud/checked-in are tabs despite different URL parents).
    return edgeLookup.has(`${a}→${b}`) && edgeLookup.has(`${b}→${a}`);
  }

  const assigned = new Set();
  const rankGroups = [];

  for (let i = 0; i < visitOrder.length; i++) {
    const nodeId = visitOrder[i];
    if (assigned.has(nodeId)) continue;

    const group = [nodeId];
    assigned.add(nodeId);

    // Look ahead for siblings — don't break on non-matching candidates,
    // so tabs visited non-consecutively can still group together.
    for (let j = i + 1; j < visitOrder.length; j++) {
      const candidate = visitOrder[j];
      if (assigned.has(candidate)) continue;
      const fitsGroup = group.every((m) => areMutuallyLinked(m, candidate));
      if (fitsGroup) {
        group.push(candidate);
        assigned.add(candidate);
      }
      // continue looking — don't break
    }

    rankGroups.push(group);
  }

  for (let rank = 0; rank < rankGroups.length; rank++) {
    for (const nodeId of rankGroups[rank]) {
      const node = nodes.get(nodeId);
      if (node) {
        node.visitOrder = visitOrder.indexOf(nodeId);
        node.layoutRank = rank;
      }
    }
  }
}

module.exports = { startRecording };
