"use strict";

const LEVEL_MAP = { error: 1, warn: 2, info: 3, debug: 4 };

function getLevel() {
  return parseInt(process.env.DEBUG_LEVEL) || 3;
}

function ts() {
  return new Date().toISOString();
}

const log = {
  error(...args) { if (getLevel() >= 1) console.error(`${ts()} ERROR`, ...args); },
  warn(...args)  { if (getLevel() >= 2) console.warn(`${ts()} WARN`, ...args); },
  info(...args)  { if (getLevel() >= 3) console.log(`${ts()} INFO`, ...args); },
  debug(...args) { if (getLevel() >= 4) console.log(`${ts()} DEBUG`, ...args); }
};

// Global unhandled rejection handler
process.on("unhandledRejection", (reason) => {
  log.warn("UnhandledRejection", reason?.message || reason);
});

module.exports = { log };
