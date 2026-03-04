// ═══════════════════════════════════════════════════════════
// CacheModule/runtime.js — CDN EdgeProxy v4.1.1 Runtime
// QTE Integration Layer
// ═══════════════════════════════════════════════════════════
// DESIGN:
//   - Wraps StorageEngine + TrafficClassifier + RequestHandler
//   - Logger controlled by QTE's CACHE_DEBUG env: file-only to ./CacheModule/logs
//   - Zero console output from CacheModule (QTE owns the terminal)
//   - All core lib files (RequestHandler, StorageEngine, etc.) are UNTOUCHED
//
// USAGE:
//   const { EdgeCacheRuntime } = require("./CacheModule/runtime");
//   const cache = new EdgeCacheRuntime({ cacheDir, maxAge, routing });
//   await cache.init();
//   await cache.attach(context);       // Playwright BrowserContext
//   await cache.detach(context);       // Remove route interception
//   const report = cache.getReport();
//   await cache.shutdown();
//
// ENV:
//   CACHE_DEBUG=true   → Logger active (file-only, ./CacheModule/logs)
//   CACHE_DEBUG=false  → Logger silent (default)
// ═══════════════════════════════════════════════════════════

"use strict";

const path = require("path");
const { initLogger, getLogger } = require("./lib/logger");
const { StorageEngine } = require("./lib/StorageEngine");
const { RequestHandler } = require("./lib/RequestHandler");
const { TrafficClassifier } = require("./lib/TrafficClassifier");
const defaultConfig = require("./config/default.json");

const VERSION = "4.1.1";
const MODULE_ROOT = __dirname;

class EdgeCacheRuntime {

  /**
   * @param {Object} config
   * @param {string}  [config.cacheDir]    — Cache storage directory (default: ./CacheModule/data/cdn-cache)
   * @param {number}  [config.maxSize]     — Max cache size in bytes (default: 2TB)
   * @param {number}  [config.maxAge]      — Cache TTL in ms (default: 24h)
   * @param {Object}  [config.routing]     — Traffic routing patterns (default: from default.json)
   * @param {boolean} [config.debug]       — Override: force logger on/off (default: reads process.env.CACHE_DEBUG)
   */
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

  /* ══════════════════════════════════════════════════════════
   *  INIT — Must be called before attach()
   * ══════════════════════════════════════════════════════════ */

  async init() {
    if (this._initialized) return;

    // ── Step 1: Logger ──────────────────────────────────────
    // Follows QTE pattern: CACHE_DEBUG=true in .env → enable logging
    // CacheModule logger: FILE-ONLY, no console output
    // Writes to ./CacheModule/logs/edgeproxy-YYYY-MM-DD.log
    const debugEnabled = this.config.debug !== undefined
      ? !!this.config.debug
      : (process.env.CACHE_DEBUG === "true");

    const logLevel = debugEnabled ? 4 : 0;  // 4=DEBUG (all), 0=SILENT
    const logDir = path.join(MODULE_ROOT, "logs");

    this.logger = initLogger(logLevel, logDir);
    this.logger.info("Runtime", `CDN EdgeProxy v${VERSION} — CacheModule initializing`);
    this.logger.info("Runtime", `Debug: ${debugEnabled} | LogDir: ${logDir}`);

    // ── Step 2: Storage Engine ──────────────────────────────
    const cacheConfig = {
      dir: this.config.cacheDir || path.join(MODULE_ROOT, "data", "cdn-cache"),
      maxSize: this.config.maxSize || defaultConfig.cache.maxSize,
      maxAge: this.config.maxAge || defaultConfig.cache.maxAge,
    };

    this.storage = new StorageEngine(cacheConfig);
    await this.storage.init();
    this.logger.info("Runtime", `Storage initialized: ${cacheConfig.dir}`);

    // ── Step 3: Traffic Classifier ──────────────────────────
    const routing = this.config.routing || defaultConfig.routing;
    this.classifier = new TrafficClassifier(routing);
    this.logger.info("Runtime", `Classifier ready: ${Object.keys(routing).length} traffic classes`);

    // ── Step 4: Request Handler ─────────────────────────────
    this.handler = new RequestHandler(this.storage, this.classifier, {
      maxAge: cacheConfig.maxAge,
    });
    this.logger.info("Runtime", "RequestHandler ready");

    this._initialized = true;
    this.logger.info("Runtime", `CDN EdgeProxy v${VERSION} — Ready`);
  }

  /* ══════════════════════════════════════════════════════════
   *  ATTACH — Hook route interception onto a BrowserContext
   * ══════════════════════════════════════════════════════════ */

  /**
   * Attaches CDN cache route interception to a Playwright BrowserContext.
   * Intercepts all network requests via context.route("**\/*").
   *
   * @param {import('playwright').BrowserContext} context
   * @returns {Promise<void>}
   */
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
        logger.warn("Handler", `${route.request().url().substring(0, 80)}: ${err.message}`);
        try { await route.continue(); } catch (_) {}
      }
    };

    await context.route("**/*", routeCallback);
    this._attachedContexts.set(context, routeCallback);
    this.logger.info("Runtime", `Attached to context (total: ${this._attachedContexts.size})`);
  }

  /* ══════════════════════════════════════════════════════════
   *  DETACH — Remove route interception from a BrowserContext
   * ══════════════════════════════════════════════════════════ */

  /**
   * Removes CDN cache route interception from a BrowserContext.
   *
   * @param {import('playwright').BrowserContext} context
   * @returns {Promise<void>}
   */
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
    this.logger.info("Runtime", `Detached from context (remaining: ${this._attachedContexts.size})`);
  }

  /* ══════════════════════════════════════════════════════════
   *  REPORTING & STATS
   * ══════════════════════════════════════════════════════════ */

  /**
   * Returns formatted cache report string.
   * @returns {string}
   */
  getReport() {
    if (!this.storage) return "CacheModule: Not initialized";
    return this.storage.getReport();
  }

  /**
   * Returns raw cache statistics object.
   * @returns {Object}
   */
  getStats() {
    if (!this.storage) return null;
    return this.storage.getStats();
  }

  /**
   * Starts periodic report logging (file-only).
   * @param {number} [intervalMs=30000] — Report interval in ms (default: 30s)
   */
  startReportTimer(intervalMs = 30000) {
    this.stopReportTimer();
    this._reportInterval = setInterval(() => {
      const report = this.getReport();
      this.logger.printReport(report);
    }, intervalMs);
    this.logger.info("Runtime", `Report timer started (every ${intervalMs / 1000}s)`);
  }

  /**
   * Stops periodic report logging.
   */
  stopReportTimer() {
    if (this._reportInterval) {
      clearInterval(this._reportInterval);
      this._reportInterval = null;
    }
  }

  /* ══════════════════════════════════════════════════════════
   *  SHUTDOWN — Flush and cleanup
   * ══════════════════════════════════════════════════════════ */

  /**
   * Graceful shutdown: flush storage, stop timers, shutdown logger.
   * @returns {Promise<void>}
   */
  async shutdown() {
    this.stopReportTimer();

    // Detach all remaining contexts
    for (const [ctx] of this._attachedContexts) {
      try { await this.detach(ctx); } catch (_) {}
    }

    // Final report to log
    if (this.storage && this.logger) {
      const finalReport = this.getReport();
      this.logger.printReport(finalReport);
      this.logger.info("Runtime", `CDN EdgeProxy v${VERSION} — Final flush & shutdown`);
    }

    // Flush storage index to disk
    if (this.storage) {
      this.storage.flush();
    }

    // Shutdown logger (flush buffer + close file handle)
    if (this.logger) {
      this.logger.shutdown();
    }

    this._initialized = false;
  }
}

module.exports = { EdgeCacheRuntime, VERSION };
