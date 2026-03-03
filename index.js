#!/usr/bin/env node
"use strict";

const readline = require("readline");
const { loadConfig } = require("./src/configLoader");
const { BrowserRunner } = require("./src/BrowserRunner");
const { initLogger, log } = require("./src/logger");

const VERSION = "4.1.1";

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

async function promptBrowser(debugLevel) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║     CDN EdgeProxy  v${VERSION}               ║`);
  console.log(`  ║     Aggressive Local CDN Engine          ║`);
  console.log(`  ║     Log Level: ${debugLevel} (${["silent","error","warn","info","debug"][debugLevel]})${" ".repeat(22 - ["silent","error","warn","info","debug"][debugLevel].length)}║`);
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
  // Load config first to get DEBUG_LEVEL
  const config = loadConfig();
  const debugLevel = config.DEBUG_LEVEL;

  // v4.1.1: Initialize logger with proper level and directory
  const logger = initLogger(debugLevel, config.logging.dir);

  let browser = parseCLIBrowser();
  if (!browser) {
    const envBrowser = config.BROWSER;
    if (process.argv.includes("--no-prompt") && envBrowser) {
      browser = envBrowser;
    } else if (envBrowser && process.stdin.isTTY === undefined) {
      browser = envBrowser;
    } else {
      browser = await promptBrowser(debugLevel);
    }
  }

  log.info("EdgeProxy", `v${VERSION} — Aggressive Local CDN Engine`);
  log.info("EdgeProxy", `Browser: ${browser}`);
  log.info("EdgeProxy", `Mode: Universal — all websites cached + HTML conditional`);
  log.info("EdgeProxy", `Log Level: ${debugLevel} (${["silent","error","warn","info","debug"][debugLevel]})`);

  const runner = new BrowserRunner(browser, config);
  await runner.start();

  const shutdown = async () => {
    log.info("EdgeProxy", "Shutting down...");
    await runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(err => {
  log.error("Fatal", err.message);
  process.exit(1);
});