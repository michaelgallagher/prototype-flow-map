const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * Start the prototype server, crawl all known pages, and take screenshots.
 * Adds screenshot paths to the graph nodes.
 */
async function crawlAndScreenshot(graph, options) {
  const { prototypePath, port, viewport, outputDir, startUrl } = options;

  // Create screenshots directory
  const screenshotsDir = path.join(outputDir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // Start the prototype server
  const server = await startServer(prototypePath, port);

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
    });

    const baseUrl = `http://localhost:${port}`;

    // Collect start-node paths once so the crawl loop can skip nav-bar links
    const startNodePaths = new Set(
      graph.nodes.filter((n) => n.isStartNode).map((n) => n.urlPath),
    );

    // Visit each node and take a screenshot
    for (const node of graph.nodes) {
      try {
        const page = await context.newPage();
        const url = `${baseUrl}${node.urlPath}`;

        const response = await page.goto(url, {
          waitUntil: "networkidle",
          timeout: 10000,
        });

        // Wait a moment for any animations/transitions
        await page.waitForTimeout(500);

        // Check if the page navigated away (JS redirect)
        const finalUrl = new URL(page.url());
        const requestedPath = node.urlPath;
        const landedPath = finalUrl.pathname;
        if (landedPath !== requestedPath) {
          console.warn(
            `   ⚠️  ${requestedPath} redirected to ${landedPath} — skipping screenshot`,
          );
          await page.close();
          continue;
        }

        // Reposition fixed elements so they appear correctly in full-page screenshots.
        // Fixed footers (bottom-anchored) are moved to the document bottom;
        // fixed headers (top-anchored) stays at the document top.
        // Without this, a fixed footer appears mid-image on tall pages.
        // Wrapped in try/catch because late-firing JS redirects can destroy the context.
        try {
          await page.evaluate(() => {
            const viewportH = window.innerHeight;
            const fixedEls = Array.from(document.querySelectorAll("*")).filter(
              (el) => window.getComputedStyle(el).position === "fixed",
            );
            if (fixedEls.length === 0) return;

            // Make body a positioning context so `bottom: 0` = bottom of document
            document.body.style.position = "relative";

            fixedEls.forEach((el) => {
              const rect = el.getBoundingClientRect();
              const isBottomFixed = rect.top > viewportH / 2;

              document.body.appendChild(el); // re-parent to avoid containing-block issues
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
            console.warn(
              `   ⚠️  ${requestedPath} navigated away during processing — skipping screenshot`,
            );
            await page.close();
            continue;
          }
          throw evalErr;
        }

        const filename = urlToFilename(node.urlPath);
        const screenshotPath = path.join(screenshotsDir, filename);

        await page.screenshot({
          path: screenshotPath,
          fullPage: true,
        });

        node.screenshot = `screenshots/${filename}`;
        node.actualTitle = await page.title();

        // Also extract any links we might have missed in static analysis
        const discoveredLinks = await page.evaluate(() => {
          const links = [];
          document.querySelectorAll("a[href]").forEach((a) => {
            const href = a.getAttribute("href");
            if (href && href.startsWith("/") && !href.startsWith("//")) {
              links.push({
                target: href.split("?")[0].split("#")[0],
                text: a.textContent.trim().substring(0, 60),
              });
            }
          });
          document.querySelectorAll("form[action]").forEach((form) => {
            const action = form.getAttribute("action");
            if (action && action.startsWith("/")) {
              links.push({
                target: action.split("?")[0],
                text:
                  "[form] " +
                  (form.querySelector("button")?.textContent?.trim() ||
                    "Submit"),
                isForm: true,
              });
            }
          });
          return links;
        });

        // Add any edges discovered during crawl that weren't found in static analysis.
        // Links targeting start nodes are skipped — those are nav-bar links already
        // represented by synthetic "nav" edges, not meaningful page-flow links.
        const existingTargets = new Set(
          graph.edges
            .filter((e) => e.source === node.urlPath)
            .map((e) => e.target),
        );

        for (const link of discoveredLinks) {
          if (
            !existingTargets.has(link.target) &&
            link.target !== node.urlPath &&
            !startNodePaths.has(link.target)
          ) {
            graph.edges.push({
              source: node.urlPath,
              target: link.target,
              type: link.isForm ? "form" : "link",
              label: link.text || "",
              discoveredByCrawler: true,
            });
            existingTargets.add(link.target);
          }
        }

        await page.close();
      } catch (err) {
        console.warn(
          `   ⚠️  Could not capture ${node.urlPath}: ${err.message}`,
        );
      }
    }

    // Also try to crawl the start URL to discover the entry point
    if (startUrl && startUrl !== "/") {
      try {
        const page = await context.newPage();
        await page.goto(`${baseUrl}${startUrl}`, {
          waitUntil: "networkidle",
          timeout: 10000,
        });
        await page.close();
      } catch {
        // ignore
      }
    }
  } finally {
    if (browser) await browser.close();
    await stopServer(server);
  }

  return graph;
}

/**
 * Start the prototype's Express server
 */
function startServer(prototypePath, port) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "development",
      USE_AUTH: "false",
      WATCH: "false",
    };

    const child = spawn("node", ["app.js"], {
      cwd: prototypePath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let started = false;

    const onData = (data) => {
      const output = data.toString();
      if (
        !started &&
        (output.includes("Running at") || output.includes("localhost"))
      ) {
        started = true;
        // Give it a moment to fully initialise
        setTimeout(() => resolve(child), 1000);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", reject);

    // Timeout after 15 seconds
    setTimeout(() => {
      if (!started) {
        started = true;
        // Assume it's running even without the log message
        resolve(child);
      }
    }, 15000);
  });
}

/**
 * Stop the server process
 */
function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    child.on("exit", resolve);
    child.kill("SIGTERM");
    // Force kill after 5 seconds
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 5000);
  });
}

/**
 * Convert a URL path to a safe filename
 */
function urlToFilename(urlPath) {
  if (urlPath === "/") return "index.png";
  return urlPath.replace(/^\//, "").replace(/\//g, "--") + ".png";
}

module.exports = { crawlAndScreenshot };
