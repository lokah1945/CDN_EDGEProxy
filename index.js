#!/usr/bin/env node
"use strict";

const readline = require("readline");
const { loadConfig } = require("./src/configLoader");
const { BrowserRunner } = require("./src/BrowserRunner");
const { log } = require("./src/logger");

const VERSION = "4.1.0";

const BROWSERS = [
  { key: "1", value: "chromium", label: "Chromium (default)" },
  { key: "2", value: "chrome",   label: "Google Chrome" },
  { key: "3", value: "msedge",   label: "Microsoft Edge" },
  { key: "4", value: "firefox",  label: "Firefox" },
];

function parseCLIBrowser() {
  const arg = process.argv.find(a => a.startsWith("--browser="));
  return arg ? arg.split("=")[1] : null;
}

async function promptBrowser() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║     CDN EdgeProxy  v${VERSION}               ║`);
  console.log(`  ║     Aggressive Local CDN Engine          ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
  console.log("  Select browser:\n");
  BROWSERS.forEach(b => console.log(`    [${b.key}] ${b.label}`));
  console.log();
  return new Promise(resolve => {
    rl.question("  Choice (1-4, default=1): ", answer => {
      rl.close();
      const pick = BROWSERS.find(b => b.key === answer.trim());
      resolve(pick ? pick.value : "chromium");
    });
  });
}

async function main() {
  let browser = parseCLIBrowser();
  if (!browser) {
    const envBrowser = loadConfig().BROWSER;
    if (process.argv.includes("--no-prompt") && envBrowser) {
      browser = envBrowser;
    } else if (envBrowser && process.stdin.isTTY === undefined) {
      browser = envBrowser;
    } else {
      browser = await promptBrowser();
    }
  }

  const config = loadConfig();
  log.info(`EdgeProxy v${VERSION} — Aggressive Local CDN Engine`);
  log.info(`Browser: ${browser}`);
  log.info(`Mode: Universal — all websites cached`);

  const runner = new BrowserRunner(browser, config);
  await runner.start();

  const shutdown = async () => {
    log.info("Shutting down...");
    await runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(err => {
  log.error("Fatal:", err.message);
  process.exit(1);
});
