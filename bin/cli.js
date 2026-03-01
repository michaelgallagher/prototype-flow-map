#!/usr/bin/env node

const { Command } = require("commander");
const path = require("path");
const { execSync } = require("child_process");
const { generate } = require("../src/index");

function openInBrowser(filePath) {
  const commands = { darwin: "open", win32: "start", linux: "xdg-open" };
  const cmd = commands[process.platform] || "xdg-open";
  try {
    execSync(`${cmd} "${filePath}"`);
  } catch {
    // Silently ignore — the path is already printed to the console
  }
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
  .option(
    "--no-screenshots",
    "Skip screenshot capture (faster, template analysis only)",
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
  .option("--no-open", "Do not open the browser after generation")
  .action(async (prototypePath, options) => {
    const resolvedPath = path.resolve(prototypePath);
    console.log(`\n📐 Prototype Flow Map\n`);
    console.log(`   Prototype: ${resolvedPath}`);
    console.log(`   Output:    ${path.resolve(options.output)}\n`);

    try {
      await generate({
        prototypePath: resolvedPath,
        outputDir: path.resolve(options.output),
        port: parseInt(options.port, 10),
        viewport: {
          width: parseInt(options.width, 10),
          height: parseInt(options.height, 10),
        },
        screenshots: options.screenshots,
        basePath: options.basePath,
        exclude: options.exclude,
        from: options.from,
        startUrl: options.startUrl,
      });
      const indexPath = path.resolve(options.output, "index.html");
      console.log(`\n✅ Flow map generated at ${path.resolve(options.output)}`);
      if (options.open) {
        console.log(`   Opening ${indexPath} in your browser...\n`);
        openInBrowser(indexPath);
      } else {
        console.log(`   Open ${indexPath} in a browser\n`);
      }
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}\n`);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    }
  });

program.parse();
