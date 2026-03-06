"use strict";

/**
 * CDN EdgeProxy v6.0.0 — TrafficClassifier
 *
 * No bug fixes required in this module.
 * Preserved exactly from v5 — all routing logic, ad-domain lists,
 * beacon keyword patterns, and content-type checks unchanged.
 */

class TrafficClassifier {
  constructor(routing) {
    this.routing = routing || {};
    this.classAPatterns = this._compilePatterns(routing?.classA?.patterns || []);
    this.classBPatterns = this._compilePatterns(routing?.classB?.patterns || []);

    this.beaconKeywords = /\/(pixel|beacon|collect|impression|ping|log|fire)[\/?.#]|\/tr\?/i;

    this.adDomains = [
      "doubleclick", "googlesyndication", "googleadservices",
      "google-analytics", "googletagmanager", "adnxs", "criteo",
      "pubmatic", "rubiconproject", "openx", "adsrvr",
      "chartbeat", "ampproject", "smaato", "seedtag",
      "facebook.com/tr", "moatads", "taboola", "outbrain",
      "amazon-adsystem", "media.net", "bidswitch", "casalemedia",
      "contextweb", "indexexchange", "lijit", "sharethrough",
      "smartadserver", "sovrn", "yieldmo", "teads",
    ];
  }

  _compilePatterns(patterns) {
    return patterns.map(p => {
      const escaped = p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      return new RegExp(escaped, "i");
    });
  }

  _getDomain(url) {
    try { return new URL(url).hostname.toLowerCase(); }
    catch { return ""; }
  }

  classifyOrigin(url) {
    const hostname = this._getDomain(url);
    const lowerUrl = url.toLowerCase();
    for (const indicator of this.adDomains) {
      if (hostname.includes(indicator) || lowerUrl.includes(indicator)) return "ad";
    }
    return "thirdparty";
  }

  classify(url, resourceType) {
    const origin = this.classifyOrigin(url);

    for (const re of this.classAPatterns) {
      if (re.test(url)) return { class: "A", origin, action: "bypass" };
    }

    for (const re of this.classBPatterns) {
      if (re.test(url)) return { class: "B", origin, action: "bypass" };
    }

    if (this.beaconKeywords.test(url) &&
        (resourceType === "image" || resourceType === "ping" || resourceType === "other")) {
      return { class: "B", origin, action: "bypass" };
    }

    return { class: "C", origin, action: "cache" };
  }

  shouldCacheByContentType(contentType) {
    if (!contentType) return false;
    const ct = contentType.toLowerCase();
    if (ct.startsWith("image/"))  return true;
    if (ct.startsWith("video/"))  return true;
    if (ct.startsWith("audio/"))  return true;
    if (ct.startsWith("font/") || ct.includes("font")) return true;
    if (ct.includes("css") || ct.includes("javascript")) return true;
    if (ct.includes("wasm"))      return true;
    if (ct.includes("svg"))       return true;
    if (ct.includes("xml") && !ct.includes("html")) return true;
    return false;
  }
}

module.exports = { TrafficClassifier };
