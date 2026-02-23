#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// CDN EdgeProxy v3.1.1 — Entry Point (Cross-Browser)
// ═══════════════════════════════════════════════════════════

const readline = require('readline');
const path = require('path');
const { BrowserRunner } = require('./src/BrowserRunner');
const { loadConfig } = require('./src/utils/configLoader');
const { Logger } = require('./src/utils/logger');

const BROWSERS = [
  { key: '1', value: 'chromium', label: 'Chromium (Playwright bundled)',   engine: 'chromium', channel: null },
  { key: '2', value: 'chrome',   label: 'Google Chrome (channel)',        engine: 'chromium', channel: 'chrome' },
  { key: '3', value: 'msedge',   label: 'Microsoft Edge (channel)',       engine: 'chromium', channel: 'msedge' },
  { key: '4', value: 'firefox',  label: 'Firefox',                        engine: 'firefox',  channel: null },
];

function parseArgs() {
  const args = process.argv.slice(2);
  for (const arg of args) {
    const match = arg.match(/^--browser=(.+)$/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

async function promptBrowser() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║      CDN EdgeProxy v3.1.1                 ║');
  console.log('║      Select Browser Engine                ║');
  console.log('╠═══════════════════════════════════════════╣');
  BROWSERS.forEach(b => {
    console.log(`║  [${b.key}] ${b.label.padEnd(37)}║`);
  });
  console.log('╚═══════════════════════════════════════════╝\n');

  return new Promise(resolve => {
    rl.question('  Pilih browser (1-4): ', answer => {
      rl.close();
      const choice = BROWSERS.find(b => b.key === answer.trim() || b.value === answer.trim().toLowerCase());
      resolve(choice || BROWSERS[0]);
    });
  });
}

(async () => {
  try {
    const config = loadConfig();
    const logger = new Logger(config);

    // Priority: CLI arg > .env > interactive menu
    let browserChoice;
    const cliArg = parseArgs();

    if (cliArg) {
      browserChoice = BROWSERS.find(b => b.value === cliArg) || BROWSERS[0];
      logger.info(`Browser from CLI: ${browserChoice.label}`);
    } else if (process.env.BROWSER && process.env.BROWSER !== 'chromium') {
      browserChoice = BROWSERS.find(b => b.value === process.env.BROWSER) || BROWSERS[0];
      logger.info(`Browser from .env: ${browserChoice.label}`);
    } else {
      browserChoice = await promptBrowser();
    }

    logger.info(`Starting CDN EdgeProxy v3.1.1 — ${browserChoice.label}`);
    logger.info(`Cache dir : ${config.cache.directory}`);
    logger.info(`Profile   : ${config.profiles[browserChoice.value]}`);
    logger.info(`SW Policy : ${config.routing.serviceWorkers}`);

    const runner = new BrowserRunner(browserChoice, config, logger);
    await runner.launch();

  } catch (err) {
    console.error('[EdgeProxy] Fatal:', err.message);
    process.exit(1);
  }
})();
