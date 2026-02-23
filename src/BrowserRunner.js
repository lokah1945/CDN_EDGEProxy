// ═══════════════════════════════════════════════════════════
// BrowserRunner — Launches browser with persistent profile
// ═══════════════════════════════════════════════════════════

const { chromium, firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const { RequestHandler } = require('./cache/RequestHandler');
const { StorageEngine } = require('./cache/StorageEngine');

class BrowserRunner {
  constructor(browserChoice, config, logger) {
    this.browserChoice = browserChoice;
    this.config = config;
    this.logger = logger;
    this.context = null;
    this.storage = null;
    this.handler = null;
  }

  async launch() {
    const { engine, channel, value } = this.browserChoice;
    const profileDir = path.resolve(this.config.profiles[value]);
    const cacheDir = path.resolve(this.config.cache.directory);

    // Ensure dirs exist
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });

    // Init shared cache
    this.storage = new StorageEngine(this.config.cache, this.logger);
    await this.storage.init();

    // Init request handler
    this.handler = new RequestHandler(this.storage, this.config.routing, this.logger);

    // Select engine
    const browserType = engine === 'firefox' ? firefox : chromium;

    // Build launch options
    const launchOpts = {
      headless: process.env.HEADLESS === 'true',
      serviceWorkers: this.config.routing.serviceWorkers,
    };

    // Channel for branded browsers (Chrome/Edge)
    if (channel) {
      launchOpts.channel = channel;
    }

    this.logger.info(`Launching ${value} — profile: ${profileDir}`);
    this.context = await browserType.launchPersistentContext(profileDir, launchOpts);

    // Register route intercept at CONTEXT level (covers all tabs/iframes/popups)
    await this.context.route('**/*', (route) => this.handler.handle(route));

    this.logger.info('Context route registered — all traffic intercepted');

    // Navigate initial page
    const pages = this.context.pages();
    const page = pages.length > 0 ? pages[0] : await this.context.newPage();
    const targetUrl = process.env.TARGET_URL || 'about:blank';
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    this.logger.info(`Navigated to: ${targetUrl}`);

    // Keep alive + graceful shutdown
    const shutdown = async () => {
      this.logger.info('Shutting down...');
      await this.storage.flush();
      await this.context.close();
      this.logger.info('Closed. Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise(() => {});
  }
}

module.exports = { BrowserRunner };
