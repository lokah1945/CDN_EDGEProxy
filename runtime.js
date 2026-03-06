"use strict";

/**
 * CDN EdgeProxy v6.2.0 — Runtime
 *
 * Public API (unchanged from v5):
 *   EdgeCacheRuntime.init()
 *   EdgeCacheRuntime.attach(context)
 *   EdgeCacheRuntime.detach(context)
 *   EdgeCacheRuntime.shutdown()
 *   EdgeCacheRuntime.getReport()
 *   EdgeCacheRuntime.getStats()
 *
 * NEW in v6.2.0:
 *   EdgeCacheRuntime.getHealth()     — Quick health check data
 *   EdgeCacheRuntime.reloadConfig()  — Dynamic config reload (maxAge, logLevel, etc.)
 *
 * CHANGELOG v6.2.0 (2026-03-07):
 *  - StorageEngine: GDSF eviction, blob compression, cache partitioning, immutable support
 *  - TrafficClassifier: VAST/SIMID/OMID, Privacy Sandbox, CTV patterns, expanded domains
 *  - URLNormalizer: enhanced detection, path timestamps, expanded domains, Vary: Accept-Language
 *  - RequestHandler: stale-refresh, size validation, cache deception protection, content-type check
 *  - Logger: JSON format option, size-based log rotation
 *  - Runtime: getHealth(), reloadConfig()
 *  - VERSION bumped to "6.2.0"
 */

const path = require("path");
const { initLogger }       = require("./lib/logger");
const { StorageEngine }    = require("./lib/StorageEngine");
const { RequestHandler }   = require("./lib/RequestHandler");
const { TrafficClassifier } = require("./lib/TrafficClassifier");
const defaultConfig        = require("./config/default.json");

const VERSION     = "6.2.0";
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
    this._initTime         = null;
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

    // v6.2.0: Pass logging options (format, rotation)
    const logOptions = this.config.logging || defaultConfig.logging || {};
    this.logger = initLogger(logLevel, logDir, VERSION, {
      format:        logOptions.format        || "text",
      maxFileSizeMB: logOptions.maxFileSizeMB || 50,
      maxFiles:      logOptions.maxFiles      || 10,
    });
    this.logger.info("Runtime", `CDN EdgeProxy v${VERSION} — initializing`);

    const cacheConfig = {
      dir:          this.config.cacheDir  || path.join(MODULE_ROOT, "data", "cdn-cache"),
      maxSize:      this.config.maxSize   || defaultConfig.cache.maxSize,
      maxAge:       this.config.maxAge    || defaultConfig.cache.maxAge,
      maxEntrySize: this.config.maxEntrySize || defaultConfig.cache.maxEntrySize,
      // v6.2.0: Cache partitioning budgets
      originBudgets: this.config.originBudgets || defaultConfig.cache.originBudgets || null,
    };

    const memoryConfig      = this.config.memory      || defaultConfig.memory      || {};
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
    if (cacheConfig.originBudgets) {
      this.logger.info("Runtime", `Partitioning: ad=${(cacheConfig.originBudgets.ad * 100).toFixed(0)}% | thirdparty=${(cacheConfig.originBudgets.thirdparty * 100).toFixed(0)}% | document=${(cacheConfig.originBudgets.document * 100).toFixed(0)}%`);
    }
    this.logger.info("Runtime", `Logger: format=${logOptions.format || "text"} | maxFileSize=${logOptions.maxFileSizeMB || 50}MB | maxFiles=${logOptions.maxFiles || 10}`);

    this._initialized = true;
    this._initTime    = Date.now();
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

  /**
   * v6.2.0: Quick health check data
   * Returns lightweight health status for monitoring/alerting
   */
  getHealth() {
    if (!this._initialized || !this.storage) {
      return { status: "not_initialized", version: VERSION };
    }

    const stats = this.storage.getStats();
    const memUsage = process.memoryUsage();
    const uptimeMs = Date.now() - this._initTime;

    return {
      status: "healthy",
      version: VERSION,
      uptime: {
        ms: uptimeMs,
        human: this._formatUptime(uptimeMs),
      },
      cache: {
        entries:       stats.entries,
        hitRatio:      stats.cacheEfficiency + "%",
        diskBytes:     stats.diskBytes,
        hotBlobBytes:  stats.hotBlobBytes,
        bandwidthSaved: stats.bandwidthSavedPct + "%",
      },
      memory: {
        heapUsedMB:  (memUsage.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMB: (memUsage.heapTotal / 1024 / 1024).toFixed(1),
        rssMB:       (memUsage.rss / 1024 / 1024).toFixed(1),
      },
      contexts: this._attachedContexts.size,
    };
  }

  _formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  /**
   * v6.2.0: Dynamic config reload (partial)
   * Allows changing certain config values without restarting:
   *   - logLevel (0-4)
   *   - maxAge (ms)
   *   - debug (boolean)
   *
   * NOTE: Changes to maxSize, cacheDir, routing require full restart.
   */
  reloadConfig(newConfig = {}) {
    if (!this._initialized) return;

    if (typeof newConfig.logLevel === "number") {
      if (this.logger) {
        this.logger.level = newConfig.logLevel;
        this.logger.info("Runtime", `Log level changed to ${newConfig.logLevel}`);
      }
    }

    if (typeof newConfig.maxAge === "number" && this.storage) {
      this.storage.maxAge = newConfig.maxAge;
      if (this.handler && this.handler.cacheConfig) {
        this.handler.cacheConfig.maxAge = newConfig.maxAge;
      }
      if (this.logger) {
        this.logger.info("Runtime", `MaxAge changed to ${(newConfig.maxAge / 3600000).toFixed(1)}h`);
      }
    }

    if (typeof newConfig.debug === "boolean") {
      if (this.logger) {
        this.logger.level = newConfig.debug ? 4 : 3;
        this.logger.info("Runtime", `Debug mode ${newConfig.debug ? "enabled" : "disabled"}`);
      }
    }
  }

  startReportTimer(intervalMs = 30000) {
    this.stopReportTimer();
    this._reportInterval = setInterval(() => {
      const report = this.getReport();
      if (this.logger) this.logger.printReport(report);
    }, intervalMs);
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

    for (const [ctx] of this._attachedContexts) {
      try { await this.detach(ctx); } catch (_) {}
    }

    if (this.storage && this.logger) {
      const finalReport = this.getReport();
      this.logger.printReport(finalReport);
      this.logger.info("Runtime", `CDN EdgeProxy v${VERSION} — Final flush & shutdown`);
    }

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
