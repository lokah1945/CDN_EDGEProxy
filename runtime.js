"use strict";

/**
 * CDN EdgeProxy v6.0.0 — Runtime
 *
 * Public API (unchanged from v5):
 *   EdgeCacheRuntime.init()
 *   EdgeCacheRuntime.attach(context)
 *   EdgeCacheRuntime.detach(context)
 *   EdgeCacheRuntime.shutdown()
 *   EdgeCacheRuntime.getReport()
 *   EdgeCacheRuntime.getStats()
 *
 * Changes from v5:
 *  - VERSION bumped to "6.0.0"
 *  - BUG 3 FIX: concurrencyConfig passed as 3rd arg to StorageEngine constructor
 *  - BUG 8 FIX: version string passed to initLogger() so log headers match
 *  - startReportTimer / stopReportTimer preserved
 *  - shutdown() now calls storage.shutdown() for clean interval teardown
 */

const path = require("path");
const { initLogger }       = require("./lib/logger");
const { StorageEngine }    = require("./lib/StorageEngine");
const { RequestHandler }   = require("./lib/RequestHandler");
const { TrafficClassifier } = require("./lib/TrafficClassifier");
const defaultConfig        = require("./config/default.json");

const VERSION     = "6.0.0";
const MODULE_ROOT = __dirname;

class EdgeCacheRuntime {
  constructor(config = {}) {
    this.config            = config;
    this.storage           = null;
    this.classifier        = null;
    this.handler           = null;
    this.logger            = null;
    this._attachedContexts = new Map();
    this._initialized      = false;
    this._reportInterval   = null;
  }

  async init() {
    if (this._initialized) return;

    const debugEnabled = this.config.debug !== undefined
      ? !!this.config.debug
      : (process.env.CACHE_DEBUG === "true");

    const logLevel = debugEnabled ? 4 : (this.config.logLevel !== undefined ? this.config.logLevel : 3);
    const logDir   = this.config.logDir
      ? path.resolve(this.config.logDir)
      : path.join(MODULE_ROOT, "logs");

    // BUG 8 FIX: pass VERSION to initLogger so log file header says "v6.0.0"
    this.logger = initLogger(logLevel, logDir, VERSION);
    this.logger.info("Runtime", `CDN EdgeProxy v${VERSION} — initializing`);

    const cacheConfig = {
      dir:          this.config.cacheDir  || path.join(MODULE_ROOT, "data", "cdn-cache"),
      maxSize:      this.config.maxSize   || defaultConfig.cache.maxSize,
      maxAge:       this.config.maxAge    || defaultConfig.cache.maxAge,
      // Enterprise: max entry size from config
      maxEntrySize: this.config.maxEntrySize || defaultConfig.cache.maxEntrySize,
    };

    const memoryConfig      = this.config.memory      || defaultConfig.memory      || {};
    // BUG 3 FIX: concurrencyConfig is now correctly passed as the 3rd argument
    const concurrencyConfig = this.config.concurrency || defaultConfig.concurrency || {};

    this.storage = new StorageEngine(cacheConfig, memoryConfig, concurrencyConfig);
    await this.storage.init();

    const routing   = this.config.routing || defaultConfig.routing;
    this.classifier = new TrafficClassifier(routing);

    const stealthConfig = this.config.stealth || defaultConfig.stealth || {};
    this.handler = new RequestHandler(this.storage, this.classifier, {
      maxAge: cacheConfig.maxAge,
    }, stealthConfig);

    this.logger.info("Runtime", `Stealth: Via=${stealthConfig.injectViaHeader ? "ON" : "OFF"} | DebugHeaders=${stealthConfig.exposeDebugHeaders ? "ON" : "OFF"}`);
    this.logger.info("Runtime", `Concurrency: IndexFlushDebounce=${concurrencyConfig.indexFlushDebounceMs || 2000}ms | IpcPoll=${concurrencyConfig.ipcPollMs || 5000}ms`);
    this.logger.info("Runtime", `Cache: MaxSize=${(cacheConfig.maxSize / 1024 / 1024 / 1024).toFixed(1)}GB | MaxEntrySize=${(cacheConfig.maxEntrySize / 1024 / 1024).toFixed(0)}MB | MaxAge=${(cacheConfig.maxAge / 3600000).toFixed(1)}h`);

    this._initialized = true;
    this.logger.info("Runtime", `CDN EdgeProxy v${VERSION} — Ready`);
  }

  async attach(context) {
    if (!this._initialized) {
      throw new Error("EdgeCacheRuntime: call init() before attach()");
    }
    if (this._attachedContexts.has(context)) {
      this.logger.warn("Runtime", "Context already attached, skipping");
      return;
    }

    const handler = this.handler;
    const logger  = this.logger;

    const routeCallback = async (route) => {
      try {
        await handler.handle(route);
      } catch (err) {
        logger.warn("Handler", `${route.request().url().substring(0, 80)}: ${err.message}`);
        try { await route.continue(); } catch (_) {}
      }
    };

    await context.route("**/*", routeCallback);
    this._attachedContexts.set(context, routeCallback);
    this.logger.info("Runtime", `Attached to context (total: ${this._attachedContexts.size})`);
  }

  async detach(context) {
    const callback = this._attachedContexts.get(context);
    if (!callback) {
      this.logger.warn("Runtime", "Context not attached, nothing to detach");
      return;
    }
    try {
      await context.unroute("**/*", callback);
    } catch (err) {
      this.logger.warn("Runtime", `Unroute failed: ${err.message}`);
    }
    this._attachedContexts.delete(context);
    this.logger.info("Runtime", `Detached (remaining: ${this._attachedContexts.size})`);
  }

  getReport() {
    if (!this.storage) return "CacheModule: Not initialized";
    return this.storage.getReport();
  }

  getStats() {
    if (!this.storage) return null;
    return this.storage.getStats();
  }

  startReportTimer(intervalMs = 30000) {
    this.stopReportTimer();
    this._reportInterval = setInterval(() => {
      const report = this.getReport();
      if (this.logger) this.logger.printReport(report);
    }, intervalMs);
    // Don't hold the process open for reporting alone
    if (this._reportInterval.unref) this._reportInterval.unref();
  }

  stopReportTimer() {
    if (this._reportInterval) {
      clearInterval(this._reportInterval);
      this._reportInterval = null;
    }
  }

  async shutdown() {
    this.stopReportTimer();

    // Detach all contexts
    for (const [ctx] of this._attachedContexts) {
      try { await this.detach(ctx); } catch (_) {}
    }

    if (this.storage && this.logger) {
      const finalReport = this.getReport();
      this.logger.printReport(finalReport);
      this.logger.info("Runtime", `CDN EdgeProxy v${VERSION} — Final flush & shutdown`);
    }

    // StorageEngine.shutdown() stops IPC poll + stale cleanup intervals, then flushes
    if (this.storage) {
      await this.storage.shutdown();
    }

    if (this.logger) {
      this.logger.shutdown();
    }

    this._initialized = false;
  }
}

module.exports = { EdgeCacheRuntime, VERSION };
