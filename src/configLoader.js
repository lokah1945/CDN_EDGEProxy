"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Built-in .env parser — replaces dotenv dependency entirely.
 * Reads .env from project root, parses KEY=VALUE pairs,
 * and merges into process.env (without overwriting existing vars).
 */
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
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function parseWildcardTargets(raw) {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function patternToConfig(pattern, knownTargets) {
  // e.g. "*.detik.com" → domain "detik.com", label "detik"
  const domain = pattern.replace(/^\*\./, "");
  const label = domain.split(".")[0];

  // Check if we have a pre-defined config in default.json
  const known = knownTargets.find(t =>
    t.pattern === pattern || t.label === label
  );
  if (known) return known;

  // Auto-generate config for unknown domains
  return {
    pattern,
    label,
    entryUrl: `https://www.${domain}`,
    matchDomains: [domain]
  };
}

function loadConfig() {
  // Parse .env first (built-in, no dotenv needed)
  loadEnvFile();

  // Load default.json
  const defaultPath = path.resolve(process.cwd(), "config", "default.json");
  let defaults = { targets: [], routing: {}, cache: {}, browser: {} };
  if (fs.existsSync(defaultPath)) {
    defaults = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
  }

  // Parse TARGETS from env
  const rawTargets = process.env.TARGETS || "";
  const patterns = rawTargets ? parseWildcardTargets(rawTargets) : [];

  let targets;
  if (patterns.length > 0) {
    targets = patterns.map(p => patternToConfig(p, defaults.targets || []));
  } else {
    targets = defaults.targets || [];
  }

  return {
    targets,
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
