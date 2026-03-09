const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * Start the prototype server, crawl all known pages, and take screenshots.
 * Adds screenshot paths to graph nodes and returns runtime-discovered edges.
 */
async function crawlAndScreenshot(graph, options) {
  const {
    prototypePath,
    port,
    viewport,
    outputDir,
    startUrl,
    runtimeCrawl = false,
  } = options;

  const screenshotsDir = path.join(outputDir, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const server = await startServer(prototypePath, port);

  let browser;
  const runtimeEdges = [];
  const runtimeEdgeKeys = new Set();
  const crawlStats = {
    pagesVisited: 0,
    runtimeLinksExtracted: 0,
    runtimeEdgesDiscovered: 0,
  };

  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
    });

    const baseUrl = `http://localhost:${port}`;

    const startNodePaths = new Set(
      graph.nodes.filter((n) => n.isStartNode).map((n) => n.urlPath),
    );

    const CONCURRENCY = 6;
    let nextIndex = 0;

    async function processNext() {
      while (nextIndex < graph.nodes.length) {
        const node = graph.nodes[nextIndex++];

        try {
          const page = await context.newPage();
          const url = `${baseUrl}${node.urlPath}`;

          const response = await page.goto(url, {
            waitUntil: "networkidle",
            timeout: 10000,
          });

          if (response && response.ok()) {
            crawlStats.pagesVisited += 1;
          }

          await page.waitForTimeout(200);

          const finalUrl = new URL(page.url());
          const requestedPath = node.urlPath;
          const landedPath = normalizeUrlPath(finalUrl.pathname);

          if (landedPath !== requestedPath) {
            console.warn(
              `   ⚠️  ${requestedPath} redirected to ${landedPath} — skipping screenshot`,
            );
            await page.close();
            continue;
          }

          try {
            await page.evaluate(() => {
              const viewportH = window.innerHeight;
              const fixedEls = Array.from(
                document.querySelectorAll("*"),
              ).filter(
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

          if (runtimeCrawl) {
            const discoveredLinks = await extractRuntimeLinks(
              page,
              requestedPath,
              baseUrl,
            );

            crawlStats.runtimeLinksExtracted += discoveredLinks.length;

            for (const link of discoveredLinks) {
              if (
                link.target === requestedPath ||
                startNodePaths.has(link.target)
              ) {
                continue;
              }

              const key = createRuntimeEdgeKey({
                source: requestedPath,
                target: link.target,
                kind: link.kind,
                method: link.method,
              });

              if (runtimeEdgeKeys.has(key)) continue;
              runtimeEdgeKeys.add(key);

              runtimeEdges.push({
                from: requestedPath,
                to: link.target,
                source: requestedPath,
                target: link.target,
                type: link.kind === "form" ? "form" : "link",
                kind: link.kind,
                method: link.method,
                label: link.text || "",
                provenance: "runtime",
                sourceOrigin: "runtime",
                discoveredByCrawler: true,
              });
            }
          }

          await page.close();
        } catch (err) {
          console.warn(
            `   ⚠️  Could not capture ${node.urlPath}: ${err.message}`,
          );
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => processNext()));

    crawlStats.runtimeEdgesDiscovered = runtimeEdges.length;

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

  graph.runtimeEdges = runtimeEdges;
  graph.crawlStats = {
    ...(graph.crawlStats || {}),
    ...crawlStats,
  };

  return graph;
}

async function extractRuntimeLinks(page, currentPath, baseUrl) {
  const rawLinks = await page.evaluate(() => {
    const links = [];

    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;

      links.push({
        href,
        text: a.textContent.trim().substring(0, 60),
        kind: "anchor",
      });
    });

    document.querySelectorAll("form[action]").forEach((form) => {
      const action = form.getAttribute("action");
      if (!action) return;

      links.push({
        href: action,
        text:
          "[form] " +
          (form.querySelector("button")?.textContent?.trim() || "Submit"),
        kind: "form",
        method: (form.getAttribute("method") || "GET").toUpperCase(),
      });
    });

    return links;
  });

  return rawLinks
    .map((link) => {
      const normalizedTarget = resolveRuntimeTarget(
        link.href,
        currentPath,
        baseUrl,
      );

      if (!normalizedTarget) return null;

      return {
        target: normalizedTarget,
        text: link.text || "",
        kind: link.kind,
        method: link.kind === "form" ? link.method || "GET" : undefined,
      };
    })
    .filter(Boolean);
}

function resolveRuntimeTarget(rawHref, currentPath, baseUrl) {
  if (!rawHref) return null;

  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return null;
  if (/^(javascript:|mailto:|tel:)/i.test(trimmed)) return null;

  try {
    const base = new URL(currentPath, `${baseUrl}/`);
    const resolved = new URL(trimmed, base);
    const baseOrigin = new URL(baseUrl).origin;

    if (resolved.origin !== baseOrigin) {
      return null;
    }

    return normalizeUrlPath(resolved.pathname);
  } catch {
    return null;
  }
}

function normalizeUrlPath(urlPath) {
  if (!urlPath) return "/";

  let normalized = String(urlPath).replace(/\/{2,}/g, "/");

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.replace(/\/+$/, "");
  }

  return normalized || "/";
}

function createRuntimeEdgeKey(edge) {
  return [
    normalizeUrlPath(edge.source),
    normalizeUrlPath(edge.target),
    edge.kind || "",
    (edge.method || "").toUpperCase(),
  ].join("|");
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
        setTimeout(() => resolve(child), 1000);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", reject);

    setTimeout(() => {
      if (!started) {
        started = true;
        resolve(child);
      }
    }, 15000);
  });
}

/**
 * Stop the prototype server
 */
function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    child.on("exit", finish);
    child.kill("SIGTERM");

    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
      finish();
    }, 3000);
  });
}

/**
 * Convert URL path to a safe screenshot filename
 */
function urlToFilename(urlPath) {
  const safeName =
    String(urlPath || "")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "-") || "home";

  return `${safeName}.png`;
}

module.exports = {
  crawlAndScreenshot,
  normalizeUrlPath,
};
