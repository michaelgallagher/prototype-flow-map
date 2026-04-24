const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  extractRuntimeLinks,
  canonicalizePath,
  urlToFilename,
} = require("./crawler");

/**
 * Crawl one or more externally-hosted web prototypes that a native (iOS /
 * Android) prototype links out to, and return a graph-compatible subgraph
 * that can be spliced into the native map.
 *
 * Strategy: shallow BFS following `<a href>` links only. Per-origin browser
 * context. No form submission, no click-through. Each seed URL becomes a
 * subgraph root; internal same-origin links become further web-page nodes.
 *
 * Inputs:
 *   seedUrls   — array of absolute URL strings extracted from native parsers
 *                (typically `type: "external"` nodes from the native graph)
 *   options    — { outputDir, config, viewport }
 *                outputDir: map output dir (screenshots written to
 *                           `<outputDir>/screenshots/web/<file>.png`)
 *                config:    webJumpoffs block from flow-map.config.yml
 *                           (enabled, maxDepth, maxPages, timeoutMs,
 *                            sameOriginOnly, screenshots, allowlist)
 *                viewport:  { width, height } — reused from the native run
 *
 * Output: { nodes, edges, stats }
 *   nodes[i] = {
 *     id: canonicalUrl,                 // full URL, used for splicing
 *     label: "/path/or/host",
 *     urlPath: "/canonicalPath",
 *     origin: "https://host",
 *     type: "web-page",
 *     subgraphRoot: true | undefined,
 *     screenshot: "screenshots/web/<file>.png" | undefined,
 *     error: "message" | undefined,
 *   }
 *   edges[i] = { source: canonicalUrl, target: canonicalUrl, type: "link" }
 */
async function crawlWebJumpoffs(seedUrls, { outputDir, config, viewport } = {}) {
  const {
    maxDepth = 3,
    maxPages = 40,
    timeoutMs = 15000,
    sameOriginOnly = true,
    screenshots: screenshotsEnabled = true,
    allowlist = [],
  } = config || {};

  const stats = {
    seedsRequested: seedUrls.length,
    seedsCrawled: 0,
    pagesVisited: 0,
    pagesFailed: 0,
    originsSkipped: [],
  };

  // Partition seeds into allowed vs. skipped based on the origin allowlist.
  const allowedOrigins = new Set(allowlist);
  const seedsByOrigin = new Map(); // origin -> Set<canonicalUrl>
  for (const raw of seedUrls) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const origin = parsed.origin;
    if (allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
      if (!stats.originsSkipped.includes(origin)) {
        stats.originsSkipped.push(origin);
      }
      continue;
    }
    const canonical = canonicalizeAbsolute(raw);
    if (!canonical) continue;
    if (!seedsByOrigin.has(origin)) seedsByOrigin.set(origin, new Set());
    seedsByOrigin.get(origin).add(canonical);
  }

  if (seedsByOrigin.size === 0) {
    return { nodes: [], edges: [], stats };
  }

  const screenshotsDir = screenshotsEnabled
    ? path.join(outputDir, "screenshots", "web")
    : null;
  if (screenshotsDir) fs.mkdirSync(screenshotsDir, { recursive: true });

  const nodes = [];
  const edges = [];
  const nodeById = new Map();
  const edgeKeys = new Set();
  let totalPagesCrawled = 0;

  const browser = await chromium.launch();

  try {
    for (const [origin, seedSet] of seedsByOrigin) {
      if (totalPagesCrawled >= maxPages) break;

      const context = await browser.newContext({
        viewport: viewport || { width: 375, height: 812 },
        deviceScaleFactor: 2,
      });
      const visited = new Set(); // canonical URLs visited on this origin
      const queue = [];

      for (const seed of seedSet) {
        queue.push({ canonical: seed, depth: 0, isSeed: true });
      }

      try {
        while (queue.length > 0) {
          if (totalPagesCrawled >= maxPages) break;
          const { canonical, depth, isSeed } = queue.shift();
          if (visited.has(canonical)) continue;
          visited.add(canonical);

          const page = await context.newPage();
          const urlPath = canonicalPathFor(canonical);
          const nodeId = canonical;
          let node = nodeById.get(nodeId);
          if (!node) {
            node = {
              id: nodeId,
              label: labelFor(canonical),
              urlPath,
              origin,
              type: "web-page",
              hub: null,
              filePath: null,
              screenshot: null,
            };
            if (isSeed) node.subgraphRoot = true;
            nodes.push(node);
            nodeById.set(nodeId, node);
          } else if (isSeed) {
            node.subgraphRoot = true;
          }

          try {
            const response = await page.goto(canonical, {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });
            await Promise.race([
              page.waitForLoadState("networkidle").catch(() => {}),
              page.waitForTimeout(2000),
            ]);

            if (response && !response.ok()) {
              node.error = `HTTP ${response.status()}`;
            }

            stats.pagesVisited += 1;
            totalPagesCrawled += 1;
            if (isSeed) stats.seedsCrawled += 1;

            // Give the page a title if we can
            try {
              const title = (await page.title())?.trim();
              if (title) node.label = title.slice(0, 80);
            } catch {
              /* ignore */
            }

            if (screenshotsDir) {
              try {
                const filename = webScreenshotName(canonical);
                const outPath = path.join(screenshotsDir, filename);
                await dismissOverlays(page);
                await page.screenshot({ path: outPath, fullPage: true });
                node.screenshot = `screenshots/web/${filename}`;
              } catch (shotErr) {
                // Screenshot failures don't fail the whole crawl.
                node.screenshotError = shotErr.message;
              }
            }

            // Follow same-origin <a href> links only, up to maxDepth.
            if (depth < maxDepth) {
              const { links } = await extractRuntimeLinks(
                page,
                urlPath,
                origin,
              );
              for (const link of links) {
                if (link.kind !== "anchor") continue;
                const childUrl = origin + link.target;
                const childCanonical = canonicalizeAbsolute(childUrl);
                if (!childCanonical) continue;
                if (sameOriginOnly) {
                  try {
                    if (new URL(childCanonical).origin !== origin) continue;
                  } catch {
                    continue;
                  }
                }
                addEdge(edges, edgeKeys, {
                  source: canonical,
                  target: childCanonical,
                  type: "link",
                });
                if (!visited.has(childCanonical)) {
                  queue.push({
                    canonical: childCanonical,
                    depth: depth + 1,
                    isSeed: false,
                  });
                }
              }
            }
          } catch (err) {
            stats.pagesFailed += 1;
            node.error = err.message || String(err);
          } finally {
            await page.close().catch(() => {});
          }
        }
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { nodes, edges, stats };
}

function addEdge(edges, edgeKeys, edge) {
  if (edge.source === edge.target) return;
  const key = `${edge.source}|${edge.target}|${edge.type}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push(edge);
}

function canonicalizeAbsolute(raw) {
  try {
    const u = new URL(raw);
    const pathPart = canonicalizePath(`${u.pathname}${u.search}`);
    if (!pathPart) return null;
    return `${u.origin}${pathPart}`;
  } catch {
    return null;
  }
}

function canonicalPathFor(absolute) {
  try {
    const u = new URL(absolute);
    return canonicalizePath(`${u.pathname}${u.search}`) || "/";
  } catch {
    return "/";
  }
}

function labelFor(absolute) {
  try {
    const u = new URL(absolute);
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return u.hostname.replace(/^www\./, "");
    return segments[segments.length - 1];
  } catch {
    return absolute;
  }
}

function webScreenshotName(absolute) {
  try {
    const u = new URL(absolute);
    const host = u.hostname.replace(/^www\./, "").replace(/[^a-zA-Z0-9-]/g, "-");
    const pathName = urlToFilename(u.pathname + u.search); // ends with .png
    return `${host}--${pathName}`;
  } catch {
    return urlToFilename(absolute);
  }
}

async function dismissOverlays(page) {
  try {
    await page.evaluate(() => {
      document
        .querySelectorAll(
          '.app-modal__overlay, .app-modal--open, [role="dialog"], .modal-backdrop, .modal.show, .overlay, .nhsuk-notification-banner'
        )
        .forEach((el) => el.remove());
      document.body.classList.remove("app-modal-open");
    });
  } catch {
    /* ignore */
  }
}

module.exports = { crawlWebJumpoffs };
