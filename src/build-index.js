const fs = require("fs");
const path = require("path");

/**
 * Scan all maps in the output directory and generate a root index page
 * that lists them with titles, dates, and links.
 */
function buildIndex(outputDir) {
  const mapsDir = path.join(outputDir, "maps");

  // Scan for all meta.json files
  const maps = [];
  if (fs.existsSync(mapsDir)) {
    const entries = fs.readdirSync(mapsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(mapsDir, entry.name, "meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          maps.push(meta);
        } catch {
          // Skip malformed meta.json
        }
      }
    }
  }

  // Sort by updatedAt descending (most recently updated first)
  maps.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  // Write the index HTML
  const htmlPath = path.join(outputDir, "index.html");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(htmlPath, generateIndexHtml(maps));
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateIndexHtml(maps) {
  const mapCards = maps
    .map((meta) => {
      const date = new Date(meta.updatedAt);
      const formattedDate = date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      return `      <a href="maps/${encodeURIComponent(meta.name)}/index.html" class="map-card">
        <div class="map-card-header">
          <h2>${escapeHtml(meta.title)}</h2>
          <span class="map-card-date">${formattedDate}</span>
        </div>
        <div class="map-card-stats">
          <span>${meta.nodeCount} pages</span>
          <span>${meta.edgeCount} connections</span>
          ${meta.hasScreenshots ? "<span>Screenshots</span>" : "<span>No screenshots</span>"}
          ${meta.scenario ? `<span class="map-card-scenario">${escapeHtml(meta.scenario)}</span>` : ""}
        </div>
        ${meta.from ? `<div class="map-card-from">From: ${escapeHtml(meta.from)}</div>` : ""}
      </a>`;
    })
    .join("\n");

  const emptyState =
    maps.length === 0
      ? '<p class="empty-state">No maps yet. Run the CLI with --name to create one.</p>'
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prototype Flow Maps</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 32px;
    }
    header {
      max-width: 800px;
      margin: 0 auto 32px;
    }
    header h1 {
      font-size: 24px;
      color: #fff;
      margin-bottom: 4px;
    }
    header p {
      font-size: 14px;
      color: #8899aa;
    }
    .maps-list {
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .map-card {
      display: block;
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 8px;
      padding: 16px 20px;
      text-decoration: none;
      color: inherit;
      transition: border-color 0.15s, background 0.15s;
    }
    .map-card:hover {
      border-color: #53d8fb;
      background: #1a2a4e;
    }
    .map-card-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 8px;
    }
    .map-card-header h2 {
      font-size: 16px;
      color: #fff;
      font-weight: 600;
    }
    .map-card-date {
      font-size: 12px;
      color: #8899aa;
      white-space: nowrap;
      margin-left: 16px;
    }
    .map-card-stats {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: #8899aa;
    }
    .map-card-scenario {
      background: #0f3460;
      padding: 1px 6px;
      border-radius: 3px;
      color: #53d8fb;
    }
    .map-card-from {
      margin-top: 6px;
      font-size: 11px;
      color: #667788;
      font-family: monospace;
    }
    .empty-state {
      text-align: center;
      color: #667788;
      padding: 48px 16px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <header>
    <h1>Prototype Flow Maps</h1>
    <p>${maps.length} map${maps.length !== 1 ? "s" : ""}</p>
  </header>
  <div class="maps-list">
    ${emptyState}
${mapCards}
  </div>
</body>
</html>`;
}

module.exports = { buildIndex };
