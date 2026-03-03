"use strict";

const fs = require("fs");
const path = require("path");

const LEVEL_NAMES = ["SILENT", "ERROR", "WARN", "INFO", "DEBUG"];

class Logger {
  constructor(level, logDir) {
    this.level = typeof level === "number" ? level : 3;
    this.logDir = logDir || path.resolve(process.cwd(), "logs");
    this.currentDate = null;
    this.fileHandle = null;
    this.writeBuffer = [];
    this.flushInterval = null;
    this._liveLines = 0;

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
    const header = `\n=== CDN EdgeProxy v4.1.1 — Log started ${new Date().toISOString()} ===\n`;
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

  /* ── Core Logging ── */

  _log(severity, severityNum, tag, args) {
    const ts = new Date().toISOString();
    const message = `${ts} ${severity} [${tag}] ${args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;

    // Console output — only if level > 0 (level 0 = silent, no event logs)
    if (this.level > 0 && this.level >= severityNum) {
      switch (severity) {
        case "ERROR": console.error(message); break;
        case "WARN":  console.warn(message); break;
        default:      console.log(message); break;
      }
    }

    // File output — level 1+ and severity passes threshold
    if (this.level >= 1 && this.level >= severityNum) {
      this._writeToFile(message + "\n");
    }
  }

  error(tag, ...args) { if (this.level >= 1) this._log("ERROR", 1, tag, args); }
  warn(tag, ...args)  { if (this.level >= 2) this._log("WARN", 2, tag, args); }
  info(tag, ...args)  { if (this.level >= 3) this._log("INFO", 3, tag, args); }
  debug(tag, ...args) { if (this.level >= 4) this._log("DEBUG", 4, tag, args); }

  /* ── Level 0: Live Report (overwrite terminal) ── */

  liveReport(reportText) {
    if (this.level !== 0) return;
    // Move cursor up to overwrite previous report
    if (this._liveLines > 0) {
      process.stdout.write(`\x1b[${this._liveLines}A`);
    }
    // Clear lines and write new report
    const lines = reportText.split("\n");
    for (const line of lines) {
      process.stdout.write(`\x1b[2K${line}\n`);
    }
    this._liveLines = lines.length;
  }

  /* ── Level 3+: Normal Report (append to console) ── */

  printReport(reportText) {
    if (this.level === 0) {
      this.liveReport(reportText);
    } else if (this.level >= 3) {
      console.log(reportText);
    }
    // Always write report to log file if level >= 1
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
    // Fallback: level 3 (info) — backwards compatible
    _instance = new Logger(parseInt(process.env.DEBUG_LEVEL) || 3);
  }
  return _instance;
}

// Proxy object for backward compatibility: log.info(...), log.error(...)
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