#!/usr/bin/env node

const { Command } = require("commander");
const path = require("path");
const { execSync } = require("child_process");
const { generate, generateNative } = require("../src/index");
const { isIosProject } = require("../src/swift-scanner");
const {
  loadConfig,
  listScenarios,
  VALID_MODES,
} = require("../src/flow-map-config");

function openInBrowser(filePath) {
  const commands = { darwin: "open", win32: "start", linux: "xdg-open" };
  const cmd = commands[process.platform] || "xdg-open";
  try {
    execSync(`${cmd} "${filePath}"`);
  } catch {
    // Silently ignore — the path is already printed to the console
  }
}

function toSlug(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "prototype-map";
}

const program = new Command();

program
  .name("prototype-flow-map")
  .description(
    "Generate an interactive flow map from an Express/Nunjucks prototype",
  )
  .argument("<prototype-path>", "Path to the prototype project root")
  .option("-o, --output <dir>", "Output directory", "./flow-map-output")
  .option("-p, --port <number>", "Port to start the prototype on", "4321")
  .option("--width <number>", "Screenshot viewport width", "375")
  .option("--height <number>", "Screenshot viewport height", "812")
  .option("--desktop", "Use desktop viewport (1280x800) instead of mobile")
  .option(
    "--no-screenshots",
    "Skip screenshot capture (faster, template analysis only)",
  )
  .option(
    "--runtime-crawl",
    "Supplement static analysis with runtime DOM link extraction during crawl",
    false,
  )
  .option(
    "--base-path <path>",
    "Only map pages under this path (e.g. /pages)",
    "",
  )
  .option(
    "--exclude <paths>",
    "Exclude pages matching these paths (comma-separated, supports globs)",
    "",
  )
  .option(
    "--from <url>",
    "Only show pages reachable from these pages (comma-separated, e.g. /pages/home-p9,/pages/messages-p9)",
    "",
  )
  .option("--start-url <url>", "URL to begin crawling from", "/")
  .option(
    "--name <slug>",
    "Name for this map (enables multi-map collection mode, e.g. nhsapp-nav)",
  )
  .option(
    "--title <title>",
    "Human-readable title for the map (defaults to prototype directory name)",
  )
  .option("--export-pdf", "Generate a PDF export of the flow map (map.pdf)")
  .option(
    "--pdf-mode <mode>",
    'PDF mode: "canvas" (full-canvas, default) or "snapshot" (A3 fit-to-screen)',
    "canvas",
  )
  .option(
    "--platform <platform>",
    'Project platform: "web" (default) or "ios". Auto-detected if omitted.',
    "",
  )
  .option("--no-open", "Do not open the browser after generation")
  .option(
    "--mode <mode>",
    'Mapping mode: "static" (default), "scenario", or "audit"',
    "",
  )
  .option(
    "--scenario <name>",
    "Run a single named scenario (implies --mode scenario)",
  )
  .option(
    "--scenario-set <name>",
    "Run a named set of scenarios (implies --mode scenario)",
  )
  .option(
    "--list-scenarios",
    "List available scenarios from the config file and exit",
  )
  .option(
    "--record [filename]",
    "Record a scenario interactively (opens a browser). Optional filename, default: recorded.flow",
  )
  .action(async (prototypePath, options) => {
    const resolvedPath = path.resolve(prototypePath);
    const prototypeDirName = path.basename(resolvedPath);

    // Handle --record mode
    if (options.record !== undefined) {
      // Validate incompatible flags
      if (options.mode || options.scenario || options.scenarioSet) {
        console.error(
          `\n❌ Error: --record cannot be used with --mode, --scenario, or --scenario-set\n`,
        );
        process.exit(1);
      }

      const { startRecording } = require("../src/recorder");
      const recordFilename =
        typeof options.record === "string" ? options.record : "recorded.flow";
      // Ensure filename ends with .flow
      const outputFilename = recordFilename.endsWith(".flow")
        ? recordFilename
        : `${recordFilename}.flow`;

      const recordViewport = options.desktop
        ? { width: 1280, height: 800 }
        : { width: parseInt(options.width, 10), height: parseInt(options.height, 10) };

      console.log(`\n📐 Prototype Flow Map — Recorder\n`);
      console.log(`   Prototype: ${resolvedPath}`);
      console.log(`   Recording scenario... (browser opened)\n`);

      try {
        await startRecording({
          prototypePath: resolvedPath,
          port: parseInt(options.port, 10),
          viewport: recordViewport,
          outputFilename,
        });
      } catch (err) {
        console.error(`\n❌ Error: ${err.message}\n`);
        if (process.env.DEBUG) console.error(err.stack);
        process.exit(1);
      }
      return;
    }

    // Validate --name slug if provided
    if (options.name && !/^[a-z0-9][a-z0-9-]*$/.test(options.name)) {
      console.error(
        `\n❌ Error: --name must be lowercase alphanumeric with hyphens (e.g. "nhsapp-nav")\n`,
      );
      process.exit(1);
    }

    const mapName = options.name || toSlug(prototypeDirName);
    const mapTitle = options.title || prototypeDirName;

    const pdfMode = String(options.pdfMode || "canvas").toLowerCase();
    if (!new Set(["canvas", "snapshot"]).has(pdfMode)) {
      console.error(`\n❌ Error: --pdf-mode must be "canvas" or "snapshot"\n`);
      process.exit(1);
    }

    // Determine platform (explicit flag > auto-detect)
    let platform = (options.platform || "").toLowerCase();
    if (!platform) {
      platform = isIosProject(resolvedPath) ? "ios" : "web";
    }
    if (!["web", "ios"].includes(platform)) {
      console.error(`\n❌ Error: --platform must be "web" or "ios"\n`);
      process.exit(1);
    }

    // Load config from prototype directory
    const config = loadConfig(resolvedPath);

    // Handle --list-scenarios
    if (options.listScenarios) {
      console.log(`\n📐 Prototype Flow Map — Scenarios\n`);
      console.log(`   Prototype: ${resolvedPath}\n`);
      console.log(listScenarios(config));
      console.log();
      return;
    }

    // Determine mode: explicit flag > implied by --scenario/--scenario-set > config file > static
    let mode = "";
    if (options.mode) {
      mode = options.mode.toLowerCase();
    } else if (options.scenario || options.scenarioSet) {
      mode = "scenario";
    } else if (config.mode && config.mode !== "static") {
      mode = config.mode;
    } else {
      mode = "static";
    }

    if (!VALID_MODES.includes(mode)) {
      console.error(
        `\n❌ Error: --mode must be one of: ${VALID_MODES.join(", ")}\n`,
      );
      process.exit(1);
    }

    // Validate scenario mode has scenarios defined
    if (mode === "scenario" && config.scenarios.length === 0) {
      console.error(
        `\n❌ Error: scenario mode requires scenarios defined in flow-map.config.yml\n`,
      );
      process.exit(1);
    }

    console.log(`\n📐 Prototype Flow Map\n`);
    console.log(`   Prototype: ${resolvedPath}`);
    console.log(`   Platform:  ${platform}`);
    console.log(`   Mode:      ${mode}`);
    console.log(`   Output:    ${path.resolve(options.output)}`);
    console.log(`   Map:       ${mapName}`);
    console.log();

    try {
      if (platform === "ios") {
        await generateNative({
          prototypePath: resolvedPath,
          outputDir: path.resolve(options.output),
          name: mapName,
          title: mapTitle,
          screenshots: options.screenshots,
        });
      } else {
        await generate({
          prototypePath: resolvedPath,
          outputDir: path.resolve(options.output),
          port: parseInt(options.port, 10),
          viewport: options.desktop
            ? { width: 1280, height: 800 }
            : { width: parseInt(options.width, 10), height: parseInt(options.height, 10) },
          screenshots: options.screenshots,
          runtimeCrawl: Boolean(options.runtimeCrawl),
          basePath: options.basePath,
          exclude: options.exclude,
          from: options.from,
          startUrl: options.startUrl,
          name: mapName,
          title: mapTitle,
          exportPdf: Boolean(options.exportPdf),
          pdfMode,
          mode,
          config,
          scenario: options.scenario,
          scenarioSet: options.scenarioSet,
        });
      }

      const viewerPath = path.resolve(
        options.output,
        "maps",
        mapName,
        "index.html",
      );

      console.log(`\n✅ Flow map generated at ${path.resolve(options.output)}`);
      if (options.open) {
        console.log(`   Opening ${viewerPath} in your browser...\n`);
        openInBrowser(viewerPath);
      } else {
        console.log(`   Open ${viewerPath} in a browser\n`);
      }
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}\n`);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    }
  });

program.parse();
