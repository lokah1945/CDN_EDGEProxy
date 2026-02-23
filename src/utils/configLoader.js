// ═══════════════════════════════════════════════════════════
// Config Loader — Merge .env + default.json
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function loadConfig() {
  // Load .env first
  loadEnv();

  // Load default.json
  const defaultPath = path.resolve(__dirname, '../../config/default.json');
  let defaults = {};
  if (fs.existsSync(defaultPath)) {
    defaults = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
  }

  // Merge env overrides
  const config = {
    cache: {
      maxSizeBytes: parseFloat(process.env.CACHE_MAX_SIZE_GB || '2') * 1073741824 * 1024 || defaults.cache?.maxSizeBytes || 2199023255552,
      maxAgeMs: parseFloat(process.env.CACHE_MAX_AGE_HOURS || '24') * 3600000 || defaults.cache?.maxAgeMs || 86400000,
      directory: process.env.CACHE_DIR || defaults.cache?.directory || './data/cdn-cache',
      revalidateStale: defaults.cache?.revalidateStale !== false,
    },
    profiles: defaults.profiles || {
      chromium: './data/profiles/chromium',
      chrome: './data/profiles/chrome',
      msedge: './data/profiles/msedge',
      firefox: './data/profiles/firefox',
    },
    routing: {
      serviceWorkers: process.env.SERVICE_WORKERS || defaults.routing?.serviceWorkers || 'block',
      bypassMethods: defaults.routing?.bypassMethods || ['POST', 'PUT', 'DELETE', 'PATCH'],
      bypassResourceTypes: defaults.routing?.bypassResourceTypes || ['websocket'],
      beaconMaxBytes: defaults.routing?.beaconMaxBytes || 4096,
      beaconPatterns: defaults.routing?.beaconPatterns || [],
      cacheableContentTypes: defaults.routing?.cacheableContentTypes || [],
      adNetworkPatterns: defaults.routing?.adNetworkPatterns || [],
    },
  };

  return config;
}

module.exports = { loadConfig };
