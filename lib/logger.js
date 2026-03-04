// ═══════════════════════════════════════════════════════════
// CacheModule/lib/logger.js — CDN EdgeProxy v4.1.1
// Modified for QTE Integration: FILE-ONLY Logger
// ═══════════════════════════════════════════════════════════
// DESIGN CHANGES from original CDN_EdgeProxy logger:
//   1. ZERO console output — QTE owns the terminal
//   2. All log output goes to FILE ONLY (./CacheModule/logs/)
//   3. Activated when DEBUG=true in .env (via runtime.js)
//   4. Level 0 = SILENT (no file, no console)
//   5. Level 1-4 = FILE-ONLY (error/warn/info/debug → log file)
//   6. liveReport() disabled — QTE has its own live display
//   7. printReport() → file-only, no console
//
// UNCHANGED:
//   - Logger class structure, singleton pattern, Proxy export
//   - File rotation (daily), write buffer, flush interval
//   - All method signatures: error(), warn(), info(), debug()
//   - All core files (RequestHandler, StorageEngine, etc.)
//     import { log } from "./logger" — no changes needed
// ═══════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const path = require("path");

const LEVEL_NAMES = ["SILENT", "ERROR", "WARN", "INFO", "DEBUG"];

class Logger {
  constructor(level, logDir) {
    this.level = typeof level === "number" ? level : 3;
    this.logDir = logDir || path.resolve(process.cwd(), "CacheModule", "logs");
    this.currentDate = null;
    this.fileHandle = null;
    this.writeBuffer = [];
    this.flushInterval = null;

    if (this.level >= 1) {
      fs.mkdirSync(this.logDir, { recursive: true });
      this._openLogFile();
      this.flushInterval = setInterval(() => this._flush(), 5000);
    }
  }

  /* ── File Management ── */

  _todayStr() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  _openLogFile() {
    if (this.level < 1) return;
    const today = this._todayStr();
    if (today === this.currentDate && this.fileHandle) return;

    // Close old handle
    this._flush();
    if (this.fileHandle) {
      try { fs.closeSync(this.fileHandle); } catch (_) {}
    }

    this.currentDate = today;
    const filepath = path.join(this.logDir, `edgeproxy-${today}.log`);
    this.fileHandle = fs.openSync(filepath, "a");
    const header = `\n=== CDN EdgeProxy v4.1.1 [CacheModule] — Log started ${new Date().toISOString()} ===\n`;
    fs.writeSync(this.fileHandle, header);
  }

  _writeToFile(line) {
    this.writeBuffer.push(line);
    if (this.writeBuffer.length > 100) this._flush();
  }

  _flush() {
    if (this.writeBuffer.length === 0) return;
    if (this.level < 1) { this.writeBuffer = []; return; }
    this._openLogFile(); // check date rotation
    const data = this.writeBuffer.join("");
    this.writeBuffer = [];
    try {
      fs.writeSync(this.fileHandle, data);
    } catch (_) {}
  }

  /* ── Core Logging — FILE-ONLY (no console) ── */

  _log(severity, severityNum, tag, args) {
    if (this.level < severityNum) return;

    const ts = new Date().toISOString();
    const message = `${ts} ${severity} [${tag}] ${args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;

    // FILE ONLY — no console output (QTE owns the terminal)
    if (this.level >= 1) {
      this._writeToFile(message + "\n");
    }
  }

  error(tag, ...args) { if (this.level >= 1) this._log("ERROR", 1, tag, args); }
  warn(tag, ...args)  { if (this.level >= 2) this._log("WARN", 2, tag, args); }
  info(tag, ...args)  { if (this.level >= 3) this._log("INFO", 3, tag, args); }
  debug(tag, ...args) { if (this.level >= 4) this._log("DEBUG", 4, tag, args); }

  /* ── Live Report — DISABLED (QTE owns terminal display) ── */

  liveReport(reportText) {
    // No-op: QTE handles its own terminal output
    // File log only if level >= 1
    if (this.level >= 1) {
      this._writeToFile(`${new Date().toISOString()} INFO [LIVE-REPORT] ${reportText.replace(/\n/g, "\n  ")}\n`);
    }
  }

  /* ── Print Report — FILE-ONLY ── */

  printReport(reportText) {
    // Write report to log file ONLY — no console
    if (this.level >= 1) {
      this._writeToFile(`${new Date().toISOString()} INFO [REPORT] ${reportText.replace(/\n/g, "\n  ")}\n`);
    }
  }

  /* ── Shutdown ── */

  shutdown() {
    this._flush();
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.fileHandle) {
      try { fs.closeSync(this.fileHandle); } catch (_) {}
      this.fileHandle = null;
    }
  }
}

/* ── Singleton ── */
let _instance = null;

function initLogger(level, logDir) {
  if (_instance) _instance.shutdown();
  _instance = new Logger(level, logDir);
  return _instance;
}

function getLogger() {
  if (!_instance) {
    // Fallback: SILENT — CacheModule should not log unless runtime.init() called
    _instance = new Logger(0);
  }
  return _instance;
}

// Proxy object for backward compatibility: log.info(...), log.error(...)
// All core files (RequestHandler, StorageEngine, URLNormalizer) use this
const log = new Proxy({}, {
  get(_, prop) {
    const logger = getLogger();
    if (typeof logger[prop] === "function") {
      return logger[prop].bind(logger);
    }
    return logger[prop];
  }
});

// Suppress unhandled rejections from polluting QTE console
// File-log only
process.on("unhandledRejection", (reason) => {
  getLogger().warn("UnhandledRejection", reason?.message || String(reason));
});

module.exports = { Logger, initLogger, getLogger, log };
