"use strict";

class TrafficClassifier {
  constructor(routing) {
    this.routing = routing || {};
    this.classAPatterns = this._compilePatterns(routing?.classA?.patterns || []);
    this.classBPatterns = this._compilePatterns(routing?.classB?.patterns || []);

    // v4.1: Tighter beacon regex — must be path segment, not substring of a word
    this.beaconKeywords = /\/(pixel|beacon|collect|impression|ping|log|fire)[\/?.#]|\/tr\?/i;

    // Known ad/tracking infrastructure domains (28 indicators)
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

    // Class A — auction/decisioning → BYPASS
    for (const re of this.classAPatterns) {
      if (re.test(url)) return { class: "A", origin, action: "bypass" };
    }

    // Class B — measurement/beacon → BYPASS
    for (const re of this.classBPatterns) {
      if (re.test(url)) return { class: "B", origin, action: "bypass" };
    }

    // v4.1: Extra beacon detection — only for pixel-like resource types, tighter regex
    if (this.beaconKeywords.test(url) &&
        (resourceType === "image" || resourceType === "ping" || resourceType === "other")) {
      return { class: "B", origin, action: "bypass" };
    }

    // Default: Class C — CACHE
    return { class: "C", origin, action: "cache" };
  }

  shouldCacheByContentType(contentType) {
    if (!contentType) return false;
    const ct = contentType.toLowerCase();
    if (ct.startsWith("image/")) return true;
    if (ct.startsWith("video/")) return true;
    if (ct.startsWith("audio/")) return true;
    if (ct.startsWith("font/") || ct.includes("font")) return true;
    if (ct.includes("css") || ct.includes("javascript")) return true;
    if (ct.includes("wasm")) return true;
    if (ct.includes("svg")) return true;
    if (ct.includes("xml") && !ct.includes("html")) return true;
    return false;
  }
}

module.exports = { TrafficClassifier };
