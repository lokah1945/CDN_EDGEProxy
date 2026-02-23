"use strict";

class ConfigParser {
  static parse(raw) {
    const targets = (raw.targets || []).map(t => ConfigParser._parseTarget(t));
    const cache = ConfigParser._parseCache(raw.cache || {});
    return { targets, cache };
  }

  static _parseTarget(pattern) {
    let p = pattern.replace(/^\*\./, "");
    const escaped = p.replace(/\./g, "\\.");
    const regex = new RegExp(`(^|\\.)${escaped}$`, "i");
    return { pattern, domain: p, regex };
  }

  static _parseCache(c) {
    return {
      maxBytes: ConfigParser._parseSize(c.maxSize || "2TB"),
      maxAgeMs: ConfigParser._parseDuration(c.maxAge || "24h"),
    };
  }

  static _parseSize(s) {
    const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
    if (!m) return 2 * 1024 ** 4;
    const n = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    const mult = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
    return Math.floor(n * (mult[u] || 1));
  }

  static _parseDuration(s) {
    const m = s.match(/^([\d.]+)\s*(s|m|h|d)$/i);
    if (!m) return 24 * 3600 * 1000;
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return Math.floor(n * (mult[u] || 3600000));
  }
}

module.exports = { ConfigParser };
