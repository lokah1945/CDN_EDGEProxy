"use strict";

const path = require("path");
const { initLogger } = require("./lib/logger");
const { StorageEngine } = require("./lib/StorageEngine");
const { RequestHandler } = require("./lib/RequestHandler");
const { TrafficClassifier } = require("./lib/TrafficClassifier");
const defaultConfig = require("./config/default.json");

const VERSION = "5.0.0";
const MODULE_ROOT = __dirname;

class EdgeCacheRuntime {
  constructor(config = {}) {
    this.config = config;
    this.storage = null;
    this.classifier = null;
    this.handler = null;
    this.logger = null;
    this._attachedContexts = new Map();
    this._initialized = false;
    this._reportInterval = null;
  }

  async init() {
    if (this._initialized) return;

    const debugEnabled = this.config.debug !== undefined
      ? !!this.config.debug
      : (process.env.CACHE_DEBUG === "true");

    const logLevel = debugEnabled ? 4 : 0;
    const logDir = path.join(MODULE_ROOT, "logs");

    this.logger = initLogger(logLevel, logDir);
    this.logger.info("Runtime", \`CDN EdgeProxy v\${VERSION} — initializing\`);

    const cacheConfig = {
      dir: this.config.cacheDir || path.join(MODULE_ROOT, "data", "cdn-cache"),
      maxSize: this.config.maxSize || defaultConfig.cache.maxSize,
      maxAge: this.config.maxAge || defaultConfig.cache.maxAge,
    };
    const memoryConfig = this.config.memory || defaultConfig.memory || {};
    const concurrencyConfig = this.config.concurrency || defaultConfig.concurrency || {};

    this.storage = new StorageEngine(cacheConfig, memoryConfig, concurrencyConfig);
    await this.storage.init();

    const routing = this.config.routing || defaultConfig.routing;
    this.classifier = new TrafficClassifier(routing);

    const stealthConfig = this.config.stealth || defaultConfig.stealth || {};
    this.handler = new RequestHandler(this.storage, this.classifier, {
      maxAge: cacheConfig.maxAge,
    }, stealthConfig);

    this.logger.info("Runtime", \`Stealth: Via=\${stealthConfig.injectViaHeader ? "ON" : "OFF"} | DebugHeaders=\${stealthConfig.exposeDebugHeaders ? "ON" : "OFF"}\`);
    this.logger.info("Runtime", \`Concurrency: IndexFlushDebounce=\${concurrencyConfig.indexFlushDebounceMs || 2000}ms\`);

    this._initialized = true;
    this.logger.info("Runtime", \`CDN EdgeProxy v\${VERSION} — Ready\`);
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
    const logger = this.logger;

    const routeCallback = async (route) => {
      try {
        await handler.handle(route);
      } catch (err) {
        logger.warn("Handler", \`\${route.request().url().substring(0, 80)}: \${err.message}\`);
        try { await route.continue(); } catch (_) {}
      }
    };

    await context.route("**/*", routeCallback);
    this._attachedContexts.set(context, routeCallback);
    this.logger.info("Runtime", \`Attached to context (total: \${this._attachedContexts.size})\`);
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
      this.logger.warn("Runtime", \`Unroute failed: \${err.message}\`);
    }
    this._attachedContexts.delete(context);
    this.logger.info("Runtime", \`Detached (remaining: \${this._attachedContexts.size})\`);
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
      this.logger.printReport(report);
    }, intervalMs);
  }

  stopReportTimer() {
    if (this._reportInterval) {
      clearInterval(this._reportInterval);
      this._reportInterval = null;
    }
  }

  async shutdown() {
    this.stopReportTimer();

    for (const [ctx] of this._attachedContexts) {
      try { await this.detach(ctx); } catch (_) {}
    }

    if (this.storage && this.logger) {
      const finalReport = this.getReport();
      this.logger.printReport(finalReport);
      this.logger.info("Runtime", \`CDN EdgeProxy v\${VERSION} — Final flush & shutdown\`);
    }

    if (this.storage) {
      await this.storage.flush();
    }

    if (this.logger) {
      this.logger.shutdown();
    }

    this._initialized = false;
  }
}

module.exports = { EdgeCacheRuntime, VERSION };
