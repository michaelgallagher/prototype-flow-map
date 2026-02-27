#!/usr/bin/env node

const { Command } = require("commander");
const path = require("path");
const { generate } = require("../src/index");

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
  .option("--start-url <url>", "URL to begin crawling from", "/")
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
        startUrl: options.startUrl,
      });
      console.log(`\n✅ Flow map generated at ${path.resolve(options.output)}`);
      console.log(
        `   Open ${path.resolve(options.output)}/index.html in a browser\n`,
      );
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}\n`);
      if (process.env.DEBUG) console.error(err.stack);
      process.exit(1);
    }
  });

program.parse();
