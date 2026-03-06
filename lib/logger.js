"use strict";

/**
 * CDN EdgeProxy v6.0.0 — Logger
 *
 * Changes from v5:
 *  - BUG 8 FIX: Version string is no longer hard-coded as "v4.1.1".
 *    initLogger() now accepts an optional `version` parameter (3rd arg).
 *    If not passed, falls back to the VERSION constant imported by callers.
 *  - Zero console output guarantee maintained.
 *  - File-only logging with daily log rotation.
 */

const fs   = require("fs");
const path = require("path");

const LEVEL_NAMES = ["SILENT", "ERROR", "WARN", "INFO", "DEBUG"];

class Logger {
  /**
   * @param {number} level    0=silent … 4=debug
   * @param {string} logDir   Absolute path to log directory
   * @param {string} version  Version string for log file header (e.g. "6.0.0")
   */
  constructor(level, logDir, version) {
    this.level      = typeof level === "number" ? level : 3;
    this.logDir     = logDir || path.resolve(process.cwd(), "CacheModule", "logs");
    this.version    = version || "6.0.0";
    this.currentDate = null;
    this.fileHandle  = null;
    this.writeBuffer = [];
    this.flushInterval = null;

    if (this.level >= 1) {
      fs.mkdirSync(this.logDir, { recursive: true });
      this._openLogFile();
      this.flushInterval = setInterval(() => this._flush(), 5000);
      // Prevent the interval from keeping the process alive indefinitely
      if (this.flushInterval.unref) this.flushInterval.unref();
    }
  }

  _todayStr() {
    const d  = new Date();
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  _openLogFile() {
    if (this.level < 1) return;
    const today = this._todayStr();
    if (today === this.currentDate && this.fileHandle) return;

    this._flush();
    if (this.fileHandle) {
      try { fs.closeSync(this.fileHandle); } catch (_) {}
    }

    this.currentDate = today;
    const filepath   = path.join(this.logDir, `edgeproxy-${today}.log`);
    this.fileHandle  = fs.openSync(filepath, "a");
    // BUG 8 FIX: use dynamic version string, not hard-coded "v4.1.1"
    const header = `\n=== CDN EdgeProxy v${this.version} [CacheModule] — Log started ${new Date().toISOString()} ===\n`;
    fs.writeSync(this.fileHandle, header);
  }

  _writeToFile(line) {
    this.writeBuffer.push(line);
    if (this.writeBuffer.length > 100) this._flush();
  }

  _flush() {
    if (this.writeBuffer.length === 0) return;
    if (this.level < 1) { this.writeBuffer = []; return; }
    this._openLogFile();
    const data = this.writeBuffer.join("");
    this.writeBuffer = [];
    try {
      fs.writeSync(this.fileHandle, data);
    } catch (_) {}
  }

  _log(severity, severityNum, tag, args) {
    if (this.level < severityNum) return;
    const ts      = new Date().toISOString();
    const message = `${ts} ${severity} [${tag}] ${args.map(a =>
      (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
    if (this.level >= 1) {
      this._writeToFile(message + "\n");
    }
    // NOTE: zero console output — no console.log/warn/error calls
  }

  error(tag, ...args) { if (this.level >= 1) this._log("ERROR", 1, tag, args); }
  warn(tag, ...args)  { if (this.level >= 2) this._log("WARN",  2, tag, args); }
  info(tag, ...args)  { if (this.level >= 3) this._log("INFO",  3, tag, args); }
  debug(tag, ...args) { if (this.level >= 4) this._log("DEBUG", 4, tag, args); }

  liveReport(reportText) {
    if (this.level >= 1) {
      this._writeToFile(
        `${new Date().toISOString()} INFO [LIVE-REPORT] ${reportText.replace(/\n/g, "\n  ")}\n`
      );
    }
  }

  printReport(reportText) {
    if (this.level >= 1) {
      this._writeToFile(
        `${new Date().toISOString()} INFO [REPORT] ${reportText.replace(/\n/g, "\n  ")}\n`
      );
    }
  }

  shutdown() {
    this._flush();
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.fileHandle) {
      try { fs.closeSync(this.fileHandle); } catch (_) {}
      this.fileHandle = null;
    }
  }
}

let _instance = null;

/**
 * Initialize (or re-initialize) the singleton logger.
 *
 * @param {number} level    Log level (0–4)
 * @param {string} logDir   Path to log directory
 * @param {string} version  Version string for log header (BUG 8 fix)
 * @returns {Logger}
 */
function initLogger(level, logDir, version) {
  if (_instance) _instance.shutdown();
  _instance = new Logger(level, logDir, version);
  return _instance;
}

function getLogger() {
  if (!_instance) {
    _instance = new Logger(0);
  }
  return _instance;
}

/**
 * Convenience proxy — any module can do:
 *   const { log } = require("./logger");
 *   log.info("tag", "message");
 */
const log = new Proxy({}, {
  get(_, prop) {
    const logger = getLogger();
    if (typeof logger[prop] === "function") {
      return logger[prop].bind(logger);
    }
    return logger[prop];
  }
});

process.on("unhandledRejection", (reason) => {
  getLogger().warn("UnhandledRejection", reason?.message || String(reason));
});

module.exports = { Logger, initLogger, getLogger, log };
