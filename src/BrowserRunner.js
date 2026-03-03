"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium, firefox } = require("playwright");
const { RequestHandler } = require("./RequestHandler");
const { StorageEngine } = require("./StorageEngine");
const { TrafficClassifier } = require("./TrafficClassifier");
const { log, getLogger } = require("./logger");

class BrowserRunner {
  constructor(browserName, config) {
    this.browserName = browserName;
    this.config = config;
    this.context = null;
    this.storage = null;
    this.reportInterval = null;
    this.disposableProfileDir = null;
    this._stopping = false;
    this._startTime = Date.now();
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
    const logger = getLogger();
    const debugLevel = logger.level;

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

    // Ready message — show for all levels except 0
    if (debugLevel > 0) {
      log.info("────────────────────────────────────────────");
      log.info("CDN EdgeProxy v4.1.1 READY — browse any website.");
      log.info("All static assets + HTML (conditional) are cached.");
      log.info("Ad auction & beacon traffic flows through untouched.");
      log.info("Press Ctrl+C to stop.");
      log.info("────────────────────────────────────────────");
    }

    // Level 0: show initial live report immediately
    if (debugLevel === 0) {
      console.log("\n  CDN EdgeProxy v4.1.1 — Silent Mode (Level 0)");
      console.log("  Press Ctrl+C to stop.\n");
      this._printLiveReport();
    }
  }

  _startReport() {
    this.reportInterval = setInterval(() => {
      if (!this.storage) return;
      const logger = getLogger();

      if (logger.level === 0) {
        this._printLiveReport();
      } else {
        const report = this.storage.getReport();
        logger.printReport("\n" + report);
      }
    }, 30_000);
  }

  _printLiveReport() {
    const s = this.storage.stats;
    const st = this.storage.getStats();
    const uptime = ((Date.now() - this._startTime) / 60000).toFixed(1);
    const total = s.hits + s.misses;
    const ratio = total > 0 ? ((s.hits / total) * 100).toFixed(1) : "0.0";
    const fetchedMB = (s.bytesFetched / 1024 / 1024).toFixed(1);
    const servedMB = (s.bytesServed / 1024 / 1024).toFixed(1);
    const fetchRatio = s.bytesFetched > 0 ? (s.bytesServed / s.bytesFetched).toFixed(1) : "∞";
    const wireFetchedMB = (s.bytesWireFetched / 1024 / 1024).toFixed(1);
    const docSavedMB = (s.docBytesSaved / 1024 / 1024).toFixed(1);
    const now = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });

    const report = [
      `╔══════════════════════════════════════════════════════════╗`,
      `║  CDN EdgeProxy v4.1.1 — LIVE REPORT                    ║`,
      `║  Uptime: ${uptime.padEnd(8)} min | Browser: ${this.browserName.padEnd(16)}    ║`,
      `╠══════════════════════════════════════════════════════════╣`,
      `║  HIT: ${String(s.hits).padEnd(6)} MISS: ${String(s.misses).padEnd(6)} Ratio: ${ratio.padEnd(7)}% Reval: ${String(s.revalidated).padEnd(4)}║`,
      `║  Served: ${servedMB.padEnd(8)} MB  Fetched: ${fetchedMB.padEnd(8)} MB  ${fetchRatio}:1${" ".repeat(Math.max(0, 9 - fetchRatio.length))}║`,
      `║  Wire fetched: ~${wireFetchedMB.padEnd(8)} MB                              ║`,
      `║  Entries: ${String(st.entries).padEnd(7)} Blobs: ${String(st.uniqueBlobs).padEnd(7)} Dedup: ${String(st.dedupHits).padEnd(7)}    ║`,
      `║  DOC-HIT: ${String(s.docHits).padEnd(5)} DOC-MISS: ${String(s.docMisses).padEnd(5)} DOC saved: ${docSavedMB.padEnd(6)} MB  ║`,
      `╠══════════════════════════════════════════════════════════╣`,
      `║  Last update: ${now.padEnd(42)}║`,
      `╚══════════════════════════════════════════════════════════╝`,
    ].join("\n");

    getLogger().liveReport(report);
  }

  async stop() {
    if (this._stopping) return;
    this._stopping = true;

    if (this.reportInterval) clearInterval(this.reportInterval);

    // Print final report
    if (this.storage) {
      const report = this.storage.getReport();
      const logger = getLogger();
      // For level 0, switch to normal print for final report
      if (logger.level === 0) {
        console.log("\n\n  ═══ FINAL REPORT ═══");
        console.log(report);
      } else {
        logger.printReport("\n  ═══ FINAL CACHE REPORT ═══\n" + report);
      }
    }

    // Flush storage + logger
    if (this.storage) {
      try { this.storage.flush(); } catch (_) {}
    }
    getLogger().shutdown();

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