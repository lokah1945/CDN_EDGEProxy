"use strict";

class TrafficClassifier {
  constructor(routing, allMatchDomains) {
    this.routing = routing || {};
    this.selfDomains = new Set((allMatchDomains || []).map(d => d.toLowerCase()));

    this.classAPatterns = this._compilePatterns(routing?.classA?.patterns || []);
    this.classBPatterns = this._compilePatterns(routing?.classB?.patterns || []);

    // Beacon detection for small payloads (bypass even if not pattern-matched)
    this.beaconKeywords = /pixel|beacon|collect|impression|view|event|track/i;
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
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  _isSelfDomain(hostname) {
    for (const d of this.selfDomains) {
      if (hostname === d || hostname.endsWith("." + d)) return true;
    }
    return false;
  }

  classify(url, resourceType) {
    const hostname = this._getDomain(url);
    let origin;
    if (this._isSelfDomain(hostname)) {
      origin = "self";
    } else {
      const adIndicators = [
        "doubleclick", "googlesyndication", "googleadservices",
        "facebook.com/tr", "analytics", "adnxs", "criteo",
        "pubmatic", "rubiconproject", "openx", "adsrvr",
        "chartbeat", "ampproject", "smaato", "seedtag"
      ];
      const isAd = adIndicators.some(ind => hostname.includes(ind) || url.includes(ind));
      origin = isAd ? "ad" : "thirdparty";
    }

    // Check Class A (auction/decisioning)
    for (const re of this.classAPatterns) {
      if (re.test(url)) return { class: "A", origin, action: "bypass" };
    }

    // Check Class B (measurement/beacon)
    for (const re of this.classBPatterns) {
      if (re.test(url)) return { class: "B", origin, action: "bypass" };
    }

    // Additional beacon detection via URL keywords
    if (this.beaconKeywords.test(url) &&
        (resourceType === "image" || resourceType === "ping" || resourceType === "other")) {
      return { class: "B", origin, action: "bypass" };
    }

    // Default: Class C — cache
    return { class: "C", origin, action: "cache" };
  }

  /**
   * Determine if a fetch/xhr response should be cached based on content-type.
   * Only cache asset-like content-types (image/*, video/*, font/*, css, js).
   * Auction/JSON/HTML responses are NOT cached.
   */
  shouldCacheByContentType(contentType) {
    if (!contentType) return false;
    const ct = contentType.toLowerCase();
    if (ct.startsWith("image/")) return true;
    if (ct.startsWith("video/")) return true;
    if (ct.startsWith("audio/")) return true;
    if (ct.startsWith("font/") || ct.includes("font")) return true;
    if (ct.includes("css") || ct.includes("javascript")) return true;
    if (ct.includes("wasm")) return true;
    return false;
  }
}

module.exports = { TrafficClassifier };
