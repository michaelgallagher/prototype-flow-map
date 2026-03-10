const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const NON_PAGE_PATH_PREFIXES = [
  "/assets/",
  "/public/",
  "/images/",
  "/img/",
  "/fonts/",
  "/js/",
  "/css/",
];

const NON_PAGE_EXACT_PATHS = new Set([
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
]);

const NON_PAGE_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".mjs",
  ".map",
  ".json",
  ".xml",
  ".txt",
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".pdf",
  ".zip",
]);

const GLOBAL_NAV_TEXTS = new Set([
  "accessibility",
  "accessibility statement",
  "contact us",
  "contact",
  "terms and conditions",
  "settings",
  "log out",
  "logout",
  "home",
]);

const GLOBAL_NAV_TARGETS = new Set([
  "/",
  "/accessibility-statement",
  "/contact",
  "/terms-and-conditions",
  "/settings",
]);

const GLOBAL_NAV_SOURCE_HINTS = [
  "/start",
  "/dashboard",
  "/reports",
  "/reading",
];

const LAYOUT_CONTAINER_HINTS = [
  "header",
  "footer",
  ".nhsuk-header",
  ".nhsuk-footer",
  ".nhsuk-header__navigation",
  ".nhsuk-footer__list",
];

// Selectors for global nav containers. Links inside <nav> are only treated as
// global nav if the <nav> is NOT inside <main> — this preserves in-page tab
// navigation (e.g. Today | Upcoming | Completed | All) which NHS prototypes
// render as <nav> elements inside the main content area.
const GLOBAL_NAV_CONTAINER_HINTS = [
  "nav",
  "[role='navigation']",
];

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
    runtimeLinksFiltered: 0,
    runtimeGlobalNavTagged: 0,
    runtimeGlobalNavSuppressed: 0,
  };

  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
    });

    const baseUrl = `http://localhost:${port}`;

    const startNodePaths = new Set(
      graph.nodes
        .filter((n) => n.isStartNode)
        .map((n) => canonicalizePath(n.urlPath)),
    );

    const CONCURRENCY = 6;
    let nextIndex = 0;

    async function processNext() {
      while (nextIndex < graph.nodes.length) {
        const node = graph.nodes[nextIndex++];

        try {
          const page = await context.newPage();
          const requestedPath = canonicalizePath(node.urlPath);
          if (!requestedPath) {
            await page.close();
            continue;
          }

          const url = `${baseUrl}${requestedPath}`;

          const response = await page.goto(url, {
            waitUntil: "networkidle",
            timeout: 10000,
          });

          if (response && response.ok()) {
            crawlStats.pagesVisited += 1;
          }

          await page.waitForTimeout(200);

          const finalUrl = new URL(page.url());
          const landedPath = canonicalizePath(finalUrl.pathname);

          if (landedPath !== requestedPath) {
            console.warn(
              `   ⚠️  ${requestedPath} redirected to ${landedPath} — skipping screenshot`,
            );
            await page.close();
            continue;
          }

          // Dismiss modals, overlays, and notification banners
          try {
            await page.evaluate(() => {
              document.querySelectorAll(
                '.app-modal__overlay, .app-modal--open, [role="dialog"], .modal-backdrop, .modal.show, .overlay'
              ).forEach((el) => el.remove());
              document.body.classList.remove("app-modal-open");
              document.body.style.position = "";
              document.body.style.top = "";
              document.body.style.width = "";
              document.querySelectorAll(
                '.app-reading-opinion-banner, .nhsuk-notification-banner, .flash-message'
              ).forEach((el) => el.remove());
            });
          } catch { /* ignore */ }

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

          const pageDims = await page.evaluate(() => ({
            width: window.innerWidth,
            height: document.body.scrollHeight,
          }));

          const filename = urlToFilename(requestedPath);
          const screenshotPath = path.join(screenshotsDir, filename);

          await page.screenshot({
            path: screenshotPath,
            fullPage: true,
          });

          node.screenshot = `screenshots/${filename}`;
          node.actualTitle = await page.title();
          node.screenshotAspectRatio = pageDims.height / pageDims.width;

          if (runtimeCrawl) {
            const extraction = await extractRuntimeLinks(
              page,
              requestedPath,
              baseUrl,
            );

            crawlStats.runtimeLinksExtracted += extraction.acceptedCount;
            crawlStats.runtimeLinksFiltered += extraction.filteredCount;

            for (const link of extraction.links) {
              if (
                link.target === requestedPath ||
                startNodePaths.has(link.target)
              ) {
                continue;
              }

              if (link.isGlobalNav) {
                crawlStats.runtimeGlobalNavTagged += 1;
                if (shouldSuppressGlobalNavLink(link, requestedPath)) {
                  crawlStats.runtimeGlobalNavSuppressed += 1;
                  continue;
                }
              }

              const key = createRuntimeEdgeKey({
                source: requestedPath,
                target: link.target,
                kind: link.kind,
                method: link.method,
                isGlobalNav: link.isGlobalNav,
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
                isGlobalNav: Boolean(link.isGlobalNav),
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
        const canonicalStartUrl = canonicalizePath(startUrl);
        if (canonicalStartUrl) {
          const page = await context.newPage();
          await page.goto(`${baseUrl}${canonicalStartUrl}`, {
            waitUntil: "networkidle",
            timeout: 10000,
          });
          await page.close();
        }
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
  const rawLinks = await page.evaluate(({ layoutHints, globalNavHints }) => {
    function isLikelyLayoutLink(element) {
      if (!(element instanceof Element)) return false;

      // Direct layout containers (header, footer, NHS-specific)
      for (const selector of layoutHints) {
        try {
          if (element.closest(selector)) return true;
        } catch {
          // ignore invalid selector edge cases
        }
      }

      // Nav containers — only count as layout if NOT inside <main>.
      // This preserves in-page tab navigation (e.g. clinic tabs) which
      // NHS prototypes render as <nav> elements inside the main content.
      for (const selector of globalNavHints) {
        try {
          const navAncestor = element.closest(selector);
          if (navAncestor && !navAncestor.closest('main, [role="main"], .nhsuk-main-wrapper, #main-content')) {
            return true;
          }
        } catch {
          // ignore invalid selector edge cases
        }
      }

      return false;
    }

    const links = [];

    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;

      links.push({
        href,
        text: a.textContent.trim().substring(0, 80),
        kind: "anchor",
        isLikelyLayoutLink: isLikelyLayoutLink(a),
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
        isLikelyLayoutLink: false,
      });
    });

    return links;
  }, { layoutHints: LAYOUT_CONTAINER_HINTS, globalNavHints: GLOBAL_NAV_CONTAINER_HINTS });

  const accepted = [];
  let filteredCount = 0;

  for (const link of rawLinks) {
    const normalizedTarget = resolveRuntimeTarget(
      link.href,
      currentPath,
      baseUrl,
    );

    if (!normalizedTarget) {
      filteredCount += 1;
      continue;
    }

    const normalizedText = normalizeLinkText(link.text || "");
    const isGlobalNav = classifyGlobalNavLink({
      source: currentPath,
      target: normalizedTarget,
      text: normalizedText,
      isLikelyLayoutLink: Boolean(link.isLikelyLayoutLink),
      kind: link.kind,
    });

    accepted.push({
      target: normalizedTarget,
      text: link.text || "",
      normalizedText,
      kind: link.kind,
      method: link.kind === "form" ? link.method || "GET" : undefined,
      isGlobalNav,
    });
  }

  return {
    links: accepted,
    acceptedCount: accepted.length,
    filteredCount,
  };
}

function classifyGlobalNavLink(link) {
  if (!link || link.kind === "form") return false;

  if (link.isLikelyLayoutLink) return true;

  if (GLOBAL_NAV_TARGETS.has(link.target)) return true;

  if (GLOBAL_NAV_TEXTS.has(link.normalizedText)) return true;

  if (
    GLOBAL_NAV_SOURCE_HINTS.some((prefix) => link.source.startsWith(prefix)) &&
    GLOBAL_NAV_TEXTS.has(link.normalizedText)
  ) {
    return true;
  }

  return false;
}

function shouldSuppressGlobalNavLink(link, sourcePath) {
  if (!link || !link.isGlobalNav) return false;
  if (link.kind === "form") return false;

  if (GLOBAL_NAV_TEXTS.has(link.normalizedText)) {
    return true;
  }

  if (GLOBAL_NAV_TARGETS.has(link.target)) {
    return true;
  }

  if (
    GLOBAL_NAV_SOURCE_HINTS.some((prefix) => sourcePath.startsWith(prefix)) &&
    link.isGlobalNav
  ) {
    return true;
  }

  return false;
}

function normalizeLinkText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

    return canonicalizePath(`${resolved.pathname}${resolved.search}`);
  } catch {
    return null;
  }
}

function canonicalizePath(urlPath) {
  if (!urlPath) return "/";

  let normalized = String(urlPath).trim();

  try {
    if (/^https?:\/\//i.test(normalized)) {
      const absolute = new URL(normalized);
      normalized = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    }
  } catch {
    // ignore and continue with the raw value
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  let parsed;
  try {
    parsed = new URL(normalized, "http://runtime-local");
  } catch {
    return normalizeBasicPath(normalized);
  }

  const pathname = normalizeBasicPath(parsed.pathname);
  if (!isProbablyPagePath(pathname)) {
    return null;
  }

  const params = Array.from(parsed.searchParams.entries())
    .filter(([key]) => !isIgnorableQueryParam(key))
    .sort(([a], [b]) => a.localeCompare(b));

  const sortedSearch = new URLSearchParams(params).toString();
  const canonicalPath = normalizeTemplateLikeSegments(pathname);

  return `${canonicalPath}${sortedSearch ? `?${sortedSearch}` : ""}`;
}

function normalizeBasicPath(urlPath) {
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

function normalizeTemplateLikeSegments(urlPath) {
  const pathname = normalizeBasicPath(urlPath);

  const normalizedSegments = pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;

      const decoded = safeDecodeURIComponent(segment).trim();

      if (decoded.includes("{{") || decoded.includes("{%")) {
        return ":template";
      }

      if (/^[0-9]+$/.test(decoded)) {
        return ":id";
      }

      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          decoded,
        )
      ) {
        return ":uuid";
      }

      if (/^\d{4}-\d{2}-\d{2}$/.test(decoded)) {
        return ":date";
      }

      // Short alphanumeric strings that look like generated IDs.
      // Mixed alpha+digit (e.g. w48zu3om, bc724e9f) — always an ID
      if (/^[a-z0-9]{6,12}$/i.test(decoded) && /\d/.test(decoded) && /[a-z]/i.test(decoded)) {
        return ":id";
      }

      return segment;
    })
    .join("/");

  return normalizeBasicPath(normalizedSegments);
}

function isProbablyPagePath(urlPath) {
  if (!urlPath) return false;
  if (!urlPath.startsWith("/")) return false;
  if (NON_PAGE_EXACT_PATHS.has(urlPath)) return false;
  if (NON_PAGE_PATH_PREFIXES.some((prefix) => urlPath.startsWith(prefix))) {
    return false;
  }

  const pathname = urlPath.split("?")[0].split("#")[0];
  const ext = path.extname(pathname).toLowerCase();
  if (ext && NON_PAGE_EXTENSIONS.has(ext)) {
    return false;
  }

  return true;
}

function isIgnorableQueryParam(key) {
  return /^(utm_|gclid|fbclid|_ga|_gl|cacheBust|timestamp|ts)$/i.test(key);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function createRuntimeEdgeKey(edge) {
  return [
    canonicalizePath(edge.source),
    canonicalizePath(edge.target),
    edge.kind || "",
    (edge.method || "").toUpperCase(),
    edge.isGlobalNav ? "global-nav" : "",
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
  normalizeUrlPath: canonicalizePath,
  canonicalizePath,
  isProbablyPagePath,
  startServer,
  stopServer,
  extractRuntimeLinks,
  urlToFilename,
};
