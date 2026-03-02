const path = require("path");
const { chromium } = require("playwright");

async function exportPdf(options) {
  const { viewerHtmlPath, outputDir, mode = "canvas" } = options;
  const pdfPath = path.join(outputDir, "map.pdf");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  try {
    const page = await context.newPage();
    const fileUrl = `file://${viewerHtmlPath}`;
    await page.goto(fileUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await waitForGraphRender(page);

    if (mode === "canvas") {
      await exportCanvasPdf(page, pdfPath);
    } else if (mode === "snapshot") {
      await exportSnapshotPdf(page, pdfPath);
    } else {
      throw new Error(
        `Unsupported PDF mode "${mode}". Use "canvas" or "snapshot".`,
      );
    }

    return { pdfPath, mode };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function waitForGraphRender(page) {
  await page.waitForSelector("#flow-svg", { timeout: 60000 });

  try {
    await page.waitForFunction(
      () => {
        const svg = document.getElementById("flow-svg");
        if (!svg) return false;
        return svg.querySelectorAll(".node-group").length > 0;
      },
      { timeout: 30000 },
    );
  } catch {
    // Continue and attempt PDF export even if render detection times out.
  }
}

async function exportCanvasPdf(page, pdfPath) {
  const canvasSize = await page.evaluate(() => {
    const toolbar = document.getElementById("toolbar");
    const legend = document.getElementById("legend");
    const panel = document.getElementById("detail-panel");
    const container = document.getElementById("canvas-container");
    const svg = document.getElementById("flow-svg");
    const mainGroup = document.getElementById("main-group");

    if (!container || !svg || !mainGroup) {
      throw new Error("Missing flow-map canvas elements for PDF export");
    }

    if (toolbar) toolbar.style.display = "none";
    if (legend) legend.style.display = "none";
    if (panel) panel.style.display = "none";

    mainGroup.setAttribute("transform", "translate(0,0) scale(1)");
    const bbox = mainGroup.getBBox();
    const padding = 48;

    const width = Math.ceil(Math.max(800, bbox.width + padding * 2));
    const height = Math.ceil(Math.max(600, bbox.height + padding * 2));

    const tx = Math.round(padding - bbox.x);
    const ty = Math.round(padding - bbox.y);
    mainGroup.setAttribute("transform", `translate(${tx},${ty}) scale(1)`);

    document.documentElement.style.background = "#ffffff";
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    document.body.style.background = "#ffffff";
    document.body.style.width = `${width}px`;
    document.body.style.height = `${height}px`;
    document.body.style.overflow = "hidden";

    container.style.position = "relative";
    container.style.top = "0";
    container.style.left = "0";
    container.style.right = "auto";
    container.style.bottom = "auto";
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;

    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.style.background = "#ffffff";

    return { width, height };
  });

  await page.pdf({
    path: pdfPath,
    width: `${canvasSize.width}px`,
    height: `${canvasSize.height}px`,
    printBackground: true,
    margin: {
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
    },
    displayHeaderFooter: false,
    preferCSSPageSize: false,
  });
}

async function exportSnapshotPdf(page, pdfPath) {
  await page.evaluate(() => {
    if (typeof window.fitToScreen === "function") {
      window.fitToScreen();
    }

    const toolbar = document.getElementById("toolbar");
    const legend = document.getElementById("legend");
    const panel = document.getElementById("detail-panel");
    if (toolbar) toolbar.style.display = "none";
    if (legend) legend.style.display = "none";
    if (panel) panel.style.display = "none";
  });

  await page.pdf({
    path: pdfPath,
    format: "A3",
    landscape: true,
    printBackground: true,
    margin: {
      top: "0.2in",
      right: "0.2in",
      bottom: "0.2in",
      left: "0.2in",
    },
    displayHeaderFooter: false,
  });
}

module.exports = { exportPdf };
