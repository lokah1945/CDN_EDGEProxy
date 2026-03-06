"use strict";

/**
 * CDN EdgeProxy v6.2.0 — Logger
 *
 * CHANGELOG v6.2.0 (2026-03-07):
 *   ✅ NEW: Structured JSON log format option (config: logging.format = "json")
 *   ✅ NEW: Size-based log rotation (max 50MB per file, keep last 10 files)
 *   ✅ KEPT: Zero console output guarantee
 *   ✅ KEPT: Daily log rotation (coexists with size rotation)
 *   ✅ KEPT: Buffered async-safe writes
 *
 * Changes from v6.1.0:
 *  - initLogger() accepts 4th param `options` { format, maxFileSizeMB, maxFiles }
 *  - _writeToFile() checks file size before writing, rotates if exceeded
 *  - _log() outputs JSON or text based on format setting
 */

const fs   = require("fs");
const path = require("path");

const LEVEL_NAMES = ["SILENT", "ERROR", "WARN", "INFO", "DEBUG"];

class Logger {
  /**
   * @param {number} level    0=silent … 4=debug
   * @param {string} logDir   Absolute path to log directory
   * @param {string} version  Version string for log file header (e.g. "6.2.0")
   * @param {object} options  { format: "text"|"json", maxFileSizeMB: 50, maxFiles: 10 }
   */
  constructor(level, logDir, version, options = {}) {
    this.level      = typeof level === "number" ? level : 3;
    this.logDir     = logDir || path.resolve(process.cwd(), "CacheModule", "logs");
    this.version    = version || "6.2.0";
    this.currentDate = null;
    this.fileHandle  = null;
    this.writeBuffer = [];
    this.flushInterval = null;

    // v6.2.0: Structured logging & size rotation
    this.format         = options.format === "json" ? "json" : "text";
    this.maxFileSizeBytes = (options.maxFileSizeMB || 50) * 1024 * 1024;
    this.maxFiles        = options.maxFiles || 10;
    this._currentFileSize = 0;
    this._rotationIndex   = 0;

    if (this.level >= 1) {
      fs.mkdirSync(this.logDir, { recursive: true });
      this._openLogFile();
      this.flushInterval = setInterval(() => this._flush(), 5000);
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

    // Get current file size for rotation tracking
    try {
      const stat = fs.fstatSync(this.fileHandle);
      this._currentFileSize = stat.size;
    } catch (_) {
      this._currentFileSize = 0;
    }

    const header = `\n=== CDN EdgeProxy v${this.version} [CacheModule] — Log started ${new Date().toISOString()} ===\n`;
    fs.writeSync(this.fileHandle, header);
    this._currentFileSize += Buffer.byteLength(header);
  }

  /**
   * v6.2.0: Size-based log rotation
   * When current file exceeds maxFileSizeBytes, rotate:
   *   edgeproxy-2026-03-07.log → edgeproxy-2026-03-07.1.log
   * Keep only maxFiles rotated copies
   */
  _rotateIfNeeded() {
    if (this._currentFileSize < this.maxFileSizeBytes) return;
    if (!this.fileHandle) return;

    try { fs.closeSync(this.fileHandle); } catch (_) {}
    this.fileHandle = null;

    const today    = this._todayStr();
    const basePath = path.join(this.logDir, `edgeproxy-${today}.log`);

    // Rotate: delete oldest, shift numbers, rename current
    for (let i = this.maxFiles; i >= 1; i--) {
      const src = i === 1 ? basePath : `${basePath}.${i - 1}`;
      const dst = `${basePath}.${i}`;
      try {
        if (i === this.maxFiles) {
          fs.unlinkSync(dst);
        }
      } catch (_) {}
      try {
        fs.renameSync(src, dst);
      } catch (_) {}
    }

    // Open fresh file
    this.fileHandle = fs.openSync(basePath, "a");
    this._currentFileSize = 0;
    const header = `\n=== CDN EdgeProxy v${this.version} [CacheModule] — Log rotated ${new Date().toISOString()} ===\n`;
    fs.writeSync(this.fileHandle, header);
    this._currentFileSize += Buffer.byteLength(header);
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
      this._currentFileSize += Buffer.byteLength(data);
      // v6.2.0: Check if rotation needed after write
      this._rotateIfNeeded();
    } catch (_) {}
  }

  /**
   * v6.2.0: Supports both text and JSON formats
   */
  _log(severity, severityNum, tag, args) {
    if (this.level < severityNum) return;
    const ts = new Date().toISOString();

    let message;
    if (this.format === "json") {
      message = JSON.stringify({
        timestamp: ts,
        level: severity,
        tag,
        message: args.map(a =>
          (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "),
        version: this.version,
        pid: process.pid,
      });
    } else {
      message = `${ts} ${severity} [${tag}] ${args.map(a =>
        (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
    }

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
 * @param {string} version  Version string for log header
 * @param {object} options  { format: "text"|"json", maxFileSizeMB: 50, maxFiles: 10 }
 * @returns {Logger}
 */
function initLogger(level, logDir, version, options) {
  if (_instance) _instance.shutdown();
  _instance = new Logger(level, logDir, version, options);
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
