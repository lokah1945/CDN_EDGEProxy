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
    this._stopping = false;
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

  _createDisposableProfileDir() {
    const rand = crypto.randomBytes(4).toString("hex");
    const ts = Date.now();
    const dir = path.resolve("data", "tmp-profiles", this.browserName, `${ts}-${rand}`);
    fs.mkdirSync(dir, { recursive: true });
    this.disposableProfileDir = dir;
    log.debug("Profile", `Disposable profile: ${dir}`);
    return dir;
  }

  _rmrf(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log.debug("Profile", `Cleaned up: ${dir}`);
    } catch (err) {
      log.warn("Profile", `Cleanup failed for ${dir}: ${err.message}`);
    }
  }

  async start() {
    // Phase 1: Storage
    log.info("Phase 1/3: Initializing storage engine...");
    this.storage = new StorageEngine(this.config.cache);
    await this.storage.init();

    // Phase 2: Browser
    log.info("Phase 2/3: Launching browser...");
    const profileDir = this._createDisposableProfileDir();
    const browserType = this._getBrowserType();
    const launchOpts = {
      headless: false,
      args: this.browserName !== "firefox"
        ? [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-site-isolation-trials",
          ]
        : undefined,
      ignoreDefaultArgs: this.browserName !== "firefox"
        ? ["--enable-automation"]
        : undefined,
    };

    const channel = this._getChannel();
    if (channel) launchOpts.channel = channel;

    this.context = await browserType.launchPersistentContext(profileDir, {
      ...launchOpts,
      serviceWorkers: this.config.browser.serviceWorkers,
      viewport: null,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });

    // v4.1: Auto-close detection — if user closes all tabs, shut down gracefully
    this.context.on("close", () => {
      if (!this._stopping) {
        log.info("Browser closed by user. Shutting down...");
        this.stop().then(() => process.exit(0));
      }
    });

    // Phase 3: Route interception
    log.info("Phase 3/3: Installing route interception...");
    const classifier = new TrafficClassifier(this.config.routing);
    const handler = new RequestHandler(this.storage, classifier, this.config.cache);

    await this.context.route("**/*", async (route) => {
      try {
        await handler.handle(route);
      } catch (err) {
        log.warn("Handler", `${route.request().url().substring(0, 80)}: ${err.message}`);
        try { await route.continue(); } catch (_) {}
      }
    });

    // Start periodic cache report
    this._startReport();

    // v4.1: No auto-navigate. Browser opens blank — user browses freely.
    log.info("────────────────────────────────────────────");
    log.info("CDN EdgeProxy READY — browse any website.");
    log.info("All static assets (CSS, JS, images, fonts) are cached.");
    log.info("Ad auction & beacon traffic flows through untouched.");
    log.info("Press Ctrl+C to stop.");
    log.info("────────────────────────────────────────────");
  }

  _startReport() {
    this.reportInterval = setInterval(() => {
      if (this.storage) {
        const report = this.storage.getReport();
        log.info("CACHE REPORT", "\n" + report);
      }
    }, 30_000);
  }

  async stop() {
    if (this._stopping) return;
    this._stopping = true;

    if (this.reportInterval) clearInterval(this.reportInterval);

    // Print final report
    if (this.storage) {
      const report = this.storage.getReport();
      log.info("FINAL CACHE REPORT", "\n" + report);
    }

    // Flush index to disk
    if (this.storage) {
      try { this.storage.flush(); } catch (_) {}
    }

    // Close browser
    if (this.context) {
      try { await this.context.close(); } catch (_) {}
    }

    // Clean disposable profile
    if (this.disposableProfileDir) {
      this._rmrf(this.disposableProfileDir);
    }
  }
}

module.exports = { BrowserRunner };
