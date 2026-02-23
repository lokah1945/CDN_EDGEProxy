"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
    this.disposableProfileDir = null;
  }

  _getBrowserType() {
    switch (this.browserName) {
      case "firefox": return firefox;
      default: return chromium;
    }
  }

  _getChannel() {
    switch (this.browserName) {
      case "chrome":  return "chrome";
      case "msedge":  return "msedge";
      default:        return undefined;
    }
  }

  /**
   * Generate a unique disposable profile directory per run.
   * Format: data/tmp-profiles/<browser>/<timestamp>-<random>/
   * This directory is deleted on stop().
   */
  _createDisposableProfileDir() {
    const rand = crypto.randomBytes(4).toString("hex");
    const ts = Date.now();
    const dir = path.resolve("data", "tmp-profiles", this.browserName, `${ts}-${rand}`);
    fs.mkdirSync(dir, { recursive: true });
    this.disposableProfileDir = dir;
    log.info("Profile", `Disposable profile: ${dir}`);
    return dir;
  }

  /**
   * Recursively remove a directory (rm -rf equivalent).
   */
  _rmrf(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log.info("Profile", `Cleaned up: ${dir}`);
    } catch (err) {
      log.warn("Profile", `Cleanup failed for ${dir}: ${err.message}`);
    }
  }

  async start() {
    // Phase 1: Init storage (shared CDN cache — persists across runs)
    log.info("Phase 1: Initializing storage engine...");
    this.storage = new StorageEngine(this.config.cache);
    await this.storage.init();

    // Phase 2: Create disposable profile & launch browser
    log.info("Phase 2: Launching browser with disposable profile...");
    const profileDir = this._createDisposableProfileDir();
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

    // v4: Universal classifier — no selfDomains needed
    const classifier = new TrafficClassifier(this.config.routing);
    const handler = new RequestHandler(this.storage, classifier, this.config.cache);

    log.info("Phase 3: Starting cache report...");
    this._startReport();

    // Install context-level route interception for ALL requests
    await this.context.route("**/*", async (route) => {
      try {
        await handler.handle(route);
      } catch (err) {
        log.warn("Handler", `Fetch failed for ${route.request().url().substring(0, 80)}`, err.message);
        try { await route.continue(); } catch (_) {}
      }
    });

    // v4: Do NOT open any website — let user browse freely
    log.info("Phase 4: Browser ready — browse any website, CDN cache is active.");
    log.info("         All static assets (CSS, JS, images, fonts, media) will be cached.");
    log.info("         Ad auction/beacon traffic flows through untouched (publisher revenue preserved).");
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
    // Clean up disposable profile directory
    if (this.disposableProfileDir) {
      this._rmrf(this.disposableProfileDir);
    }
  }
}

module.exports = { BrowserRunner };
