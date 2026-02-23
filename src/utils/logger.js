// ═══════════════════════════════════════════════════════════
// Logger — Respects DEBUG_MODE + DEBUG_LOG from .env
// ═══════════════════════════════════════════════════════════
//
// DEBUG_LOG levels:
//   0 = SILENT
//   1 = TERMINAL ONLY
//   2 = TERMINAL + FILE
//   3 = FILE ONLY (default)
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

class Logger {
  constructor(config) {
    this.debugMode = process.env.DEBUG_MODE === 'true';
    this.logLevel = parseInt(process.env.DEBUG_LOG || '3', 10);
    this.logFile = process.env.DEBUG_LOG_FILE || './logs/edgeproxy.log';

    // Always log info/error to terminal, debug only when debugMode
    const logDir = path.dirname(path.resolve(this.logFile));
    fs.mkdirSync(logDir, { recursive: true });
  }

  info(msg) {
    const line = `[${this._ts()}] [INFO] ${msg}`;
    this._toTerminal(line);
    this._toFile(line);
  }

  error(msg) {
    const line = `[${this._ts()}] [ERROR] ${msg}`;
    this._toTerminal(line);
    this._toFile(line);
  }

  debug(msg) {
    if (!this.debugMode) return;
    const line = `[${this._ts()}] [DEBUG] ${msg}`;
    if (this.logLevel === 1 || this.logLevel === 2) {
      process.stdout.write(line + '\n');
    }
    if (this.logLevel === 2 || this.logLevel === 3) {
      this._appendFile(line);
    }
  }

  _toTerminal(line) {
    process.stdout.write(line + '\n');
  }

  _toFile(line) {
    this._appendFile(line);
  }

  _appendFile(line) {
    try {
      fs.appendFileSync(path.resolve(this.logFile), line + '\n');
    } catch (_) {}
  }

  _ts() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }
}

module.exports = { Logger };
