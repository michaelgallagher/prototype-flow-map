const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { startServer, stopServer } = require("./crawler");
const { serializeFlow, serializeStep } = require("./flow-serializer");

/**
 * Start an interactive recording session.
 *
 * Launches the prototype server, opens a headed browser with an injected
 * toolbar script, and records user interactions as .flow steps.
 *
 * @param {Object} opts
 * @param {string} opts.prototypePath - Path to the prototype project
 * @param {number} opts.port - Port for the prototype server
 * @param {Object} opts.viewport - { width, height }
 * @param {string} opts.outputFilename - Filename for the .flow file
 * @returns {Promise<{ flowFilePath: string }>}
 */
async function startRecording({ prototypePath, port, viewport, outputFilename }) {
  const { child: server, port: actualPort } = await startServer(prototypePath, port);
  if (actualPort !== port) {
    console.log(`   Server started on port ${actualPort} (requested ${port})`);
  }

  const baseUrl = `http://localhost:${actualPort}`;
  let browser;

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: null });

    // Inject the recorder script into every page
    const injectPath = path.join(__dirname, "recorder-inject.js");
    await context.addInitScript({ path: injectPath });

    const page = await context.newPage();

    // State
    let phase = "setup";
    const setupSteps = [];
    const mapSteps = [];
    let stepNumber = 0;
    let startUrl = "/";
    const visitedUrls = new Set();
    let done = false;

    // Navigation debounce — wait 300ms before emitting to handle redirects
    let navTimer = null;
    let lastNavUrl = null;

    function currentSteps() {
      return phase === "setup" ? setupSteps : mapSteps;
    }

    function logStep(step) {
      stepNumber++;
      const line = serializeStep(step);
      console.log(`   ${String(stepNumber).padStart(2)}. ${line}`);
    }

    function handleNavigation(url) {
      try {
        const parsed = new URL(url);
        const urlPath = parsed.pathname;

        if (phase === "setup") {
          // In setup, navigations become Goto steps
          const step = { type: "goto", url: urlPath };
          setupSteps.push(step);
          logStep(step);
          startUrl = urlPath;
        } else {
          // In map, navigations become Visit steps (deduplicated)
          if (!visitedUrls.has(urlPath)) {
            visitedUrls.add(urlPath);
            const step = { type: "visit", url: urlPath };
            mapSteps.push(step);
            logStep(step);
          }
        }
      } catch {
        // Ignore invalid URLs
      }
    }

    // Listen for console messages from the injected script
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
          currentSteps().push(step);
          logStep(step);
          break;
        }

        case "phase": {
          phase = data.phase;
          console.log(`\n   Phase: Map\n`);
          break;
        }

        case "capture": {
          // Force a Snapshot of the current page
          const step = { type: "snapshot" };
          currentSteps().push(step);
          logStep(step);
          break;
        }

        case "navigation": {
          // SPA navigation from pushState/replaceState
          handleNavigation(`${baseUrl}${data.url}`);
          break;
        }

        case "done": {
          done = true;
          break;
        }
      }
    });

    // Listen for page navigations (standard navigations)
    page.on("framenavigated", (frame) => {
      // Only track the main frame
      if (frame !== page.mainFrame()) return;

      const url = frame.url();
      // Ignore about:blank and non-http
      if (!url.startsWith("http")) return;

      // Debounce to handle redirects — capture the final URL
      if (navTimer) clearTimeout(navTimer);
      lastNavUrl = url;
      navTimer = setTimeout(() => {
        handleNavigation(lastNavUrl);
        navTimer = null;
      }, 300);
    });

    // Navigate to the starting page
    console.log(`\n   Phase: Setup\n`);
    await page.goto(baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Wait for the user to finish recording
    // This resolves when: the "done" event fires, or the browser is closed
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (done) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 200);

      // Also resolve if the browser context is closed
      context.on("close", () => {
        clearInterval(checkInterval);
        resolve();
      });

      // Handle page close (user closed the tab)
      page.on("close", () => {
        clearInterval(checkInterval);
        done = true;
        resolve();
      });
    });

    // Flush any pending navigation
    if (navTimer) {
      clearTimeout(navTimer);
      handleNavigation(lastNavUrl);
    }

    // Close browser
    await browser.close().catch(() => {});
    browser = null;

    // Determine output path
    const scenariosDir = path.join(prototypePath, "scenarios");
    fs.mkdirSync(scenariosDir, { recursive: true });

    let flowFilePath = path.join(scenariosDir, outputFilename);

    // If file exists, append numeric suffix
    if (fs.existsSync(flowFilePath)) {
      const ext = path.extname(outputFilename);
      const base = path.basename(outputFilename, ext);
      let suffix = 2;
      while (fs.existsSync(path.join(scenariosDir, `${base}-${suffix}${ext}`))) {
        suffix++;
      }
      flowFilePath = path.join(scenariosDir, `${base}-${suffix}${ext}`);
    }

    // Serialize and write the .flow file
    const totalSteps = setupSteps.length + mapSteps.length;
    const flowContent = serializeFlow({ startUrl, setupSteps, mapSteps });
    fs.writeFileSync(flowFilePath, flowContent, "utf-8");

    console.log(`\n   Recording complete. ${totalSteps} steps recorded.`);
    console.log(`   Saved to: ${path.relative(process.cwd(), flowFilePath)}\n`);

    return { flowFilePath };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
  }
}

module.exports = { startRecording };
