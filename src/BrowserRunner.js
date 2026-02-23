"use strict";

const path = require("path");
const { chromium, firefox } = require("playwright");
const { RequestHandler } = require("./RequestHandler");
const { StorageEngine } = require("./StorageEngine");
const { TrafficClassifier } = require("./TrafficClassifier");
const { log } = require("./logger");

class BrowserRunner {
  constructor(browserName, config) {
    this.browserName = browserName;
    this.config = config;
    this.context = null;
    this.storage = null;
    this.reportInterval = null;
  }

  _getBrowserType() {
    switch (this.browserName) {
      case "firefox": return firefox;
      default: return chromium; // chromium, chrome, msedge
    }
  }

  _getChannel() {
    switch (this.browserName) {
      case "chrome":  return "chrome";
      case "msedge":  return "msedge";
      default:        return undefined;
    }
  }

  async start() {
    const profileDir = path.resolve(
      this.config.browser.profileBase,
      this.browserName
    );

    log.info("Phase 1: Initializing storage engine...");
    this.storage = new StorageEngine(this.config.cache);
    await this.storage.init();

    log.info("Phase 2: Launching browser...");
    const browserType = this._getBrowserType();
    const launchOpts = {
      headless: false,
      args: this.browserName !== "firefox"
        ? ["--disable-blink-features=AutomationControlled"]
        : undefined
    };

    const channel = this._getChannel();
    if (channel) launchOpts.channel = channel;

    this.context = await browserType.launchPersistentContext(profileDir, {
      ...launchOpts,
      serviceWorkers: this.config.browser.serviceWorkers,
      viewport: null,
      ignoreHTTPSErrors: true
    });

    // Collect all matchDomains from all targets for the classifier
    const allMatchDomains = [];
    for (const t of this.config.targets) {
      if (t.matchDomains) allMatchDomains.push(...t.matchDomains);
    }

    const classifier = new TrafficClassifier(this.config.routing, allMatchDomains);
    const handler = new RequestHandler(this.storage, classifier, this.config.cache);

    log.info("Phase 3: Starting cache report...");
    this._startReport();

    // Install context-level route interception (covers all tabs/iframes/popups)
    await this.context.route("**/*", async (route) => {
      try {
        await handler.handle(route);
      } catch (err) {
        log.warn("Handler", `Fetch failed for ${route.request().url().substring(0, 80)}`, err.message);
        try { await route.continue(); } catch (_) {}
      }
    });

    // Open tabs for each target
    for (let i = 0; i < this.config.targets.length; i++) {
      const target = this.config.targets[i];
      log.info(`Phase ${4 + i}: Setting up target ${target.label} → ${target.entryUrl}`);

      let page;
      const pages = this.context.pages();
      if (i === 0 && pages.length > 0) {
        page = pages[0];
      } else {
        page = await this.context.newPage();
      }

      log.info(`Phase ${5 + i}: Navigating to ${target.entryUrl}...`);
      try {
        await page.goto(target.entryUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      } catch (err) {
        log.warn("Navigation", `Timeout for ${target.label}: ${err.message}`);
      }
    }
  }

  _startReport() {
    this.reportInterval = setInterval(() => {
      if (this.storage) {
        const report = this.storage.getReport();
        log.info("CACHE REPORT", "\n" + report);
      }
    }, 30000);
  }

  async stop() {
    if (this.reportInterval) clearInterval(this.reportInterval);
    if (this.storage) {
      const report = this.storage.getReport();
      log.info("FINAL CACHE REPORT", "\n" + report);
    }
    if (this.context) {
      try { await this.context.close(); } catch (_) {}
    }
  }
}

module.exports = { BrowserRunner };
