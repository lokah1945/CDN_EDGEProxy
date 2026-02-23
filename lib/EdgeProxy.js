const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const RequestHandler = require('./RequestHandler');
const StorageEngine = require('./StorageEngine');
const AutoDiscovery = require('./AutoDiscovery');
const ViewportScanner = require('./ViewportScanner');
const CacheReport = require('./CacheReport');
const logger = require('./utils/logger');

class EdgeProxy {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.contexts = new Map();
    this.storage = new StorageEngine(config.cache);
    this.report = new CacheReport(this.storage, config.engine.reportIntervalSec);
    this.running = false;
  }

  async start() {
    logger.info('=== EdgeProxy v3.0.1 (Local CDN Engine) ===');
    logger.info(`Targets: ${this.config.targets.map(t => t.id).join(', ')}`);

    // Safety net: catch any unhandled rejections globally instead of crashing
    process.on('unhandledRejection', (reason) => {
      logger.warn(`[UnhandledRejection] ${reason && reason.message ? reason.message : reason}`);
    });

    // Phase 1: Initialize storage (metadata-only warm-up)
    logger.info('[Phase 1] Initializing storage engine...');
    await this.storage.initialize();

    // Phase 2: Launch browser with persistent context
    logger.info('[Phase 2] Launching browser...');
    const userDataDir = path.resolve(this.config.engine.userDataDir || './data/browser-profile');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    this.browser = await chromium.launchPersistentContext(userDataDir, {
      headless: this.config.engine.headless,
      viewport: this.config.engine.viewport,
      args: ['--disable-blink-features=AutomationControlled']
    });

    // Phase 3: Start cache report
    logger.info('[Phase 3] Starting cache report...');
    this.report.start();

    // Phase 4: Setup targets
    this.running = true;
    for (const target of this.config.targets) {
      await this._setupTarget(target);
    }

    logger.info('[Phase 6] EdgeProxy v3.0.1 running. Press Ctrl+C to stop.');
  }

  async _setupTarget(target) {
    logger.info(`[Phase 4] Setting up target: ${target.id} (${target.url})`);

    const discovery = new AutoDiscovery(this.config, target);
    const handler = new RequestHandler(this.config, this.storage, discovery, this.report, target);
    const scanner = new ViewportScanner(this.config);

    const page = await this.browser.newPage();
    await handler.install(page);

    logger.info(`[Phase 5] Navigating to ${target.url}...`);
    try {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    } catch (err) {
      logger.warn(`Navigation warning for ${target.id}: ${err.message}`);
    }

    if (this.config.engine.autoDiscoverOnStart) {
      logger.info(`[AutoDiscovery] Scanning ${target.id}...`);
      await discovery.discover(page);
    }

    logger.info(`[ViewportScan] Scanning ads for ${target.id}...`);
    await scanner.scan(page);

    await this._scrollPage(page);
    this.contexts.set(target.id, { page, handler, discovery, scanner });
  }

  async _scrollPage(page) {
    const { scrollStep, scrollDelay } = this.config.engine;
    try {
      const height = await page.evaluate(() => document.body.scrollHeight);
      for (let y = 0; y < height; y += scrollStep) {
        await page.evaluate((pos) => window.scrollTo(0, pos), y);
        await page.waitForTimeout(scrollDelay);
      }
      await page.waitForTimeout(5000);
      await page.evaluate(() => window.scrollTo(0, 0));
    } catch (e) {
      logger.warn(`Scroll error: ${e.message}`);
    }
  }

  async stop() {
    this.running = false;
    this.report.stop();
    if (this.browser) {
      await this.browser.close();
    }
    await this.storage.shutdown();
    logger.info('[EdgeProxy] Stopped.');
  }
}

module.exports = EdgeProxy;
