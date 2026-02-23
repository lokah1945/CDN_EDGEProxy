"use strict";

const fs = require("fs");
const path = require("path");

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function loadConfig() {
  loadEnvFile();

  const defaultPath = path.resolve(process.cwd(), "config", "default.json");
  let defaults = { routing: {}, cache: {}, browser: {} };
  if (fs.existsSync(defaultPath)) {
    defaults = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
  }

  return {
    routing: defaults.routing || {},
    cache: {
      maxSize:  parseInt(process.env.CACHE_MAX_SIZE) || defaults.cache?.maxSize  || 2199023255552,
      maxAge:   parseInt(process.env.CACHE_MAX_AGE)  || defaults.cache?.maxAge   || 86400000,
      staleWhileRevalidate: defaults.cache?.staleWhileRevalidate || 3600000,
      dir:      process.env.CACHE_DIR || defaults.cache?.dir || "data/cdn-cache"
    },
    browser: {
      serviceWorkers: defaults.browser?.serviceWorkers || "block",
      profileBase:    defaults.browser?.profileBase    || "data/profiles"
    },
    BROWSER: process.env.BROWSER || "chromium",
    DEBUG_LEVEL: parseInt(process.env.DEBUG_LEVEL) || 3
  };
}

module.exports = { loadConfig };
