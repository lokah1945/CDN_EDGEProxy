"use strict";

/**
 * TrafficClassifier v4.0.0
 *
 * Universal classifier — works on ANY website without pre-configured targets.
 * Classifies traffic into:
 *   Class A: auction/decisioning → bypass (preserve ad revenue)
 *   Class B: measurement/beacon  → bypass (preserve analytics/attribution)
 *   Class C: static/cacheable    → cache aggressively
 *
 * Origin detection is now dynamic (ad vs thirdparty) — no selfDomains needed.
 */
class TrafficClassifier {
  constructor(routing) {
    this.routing = routing || {};
    this.classAPatterns = this._compilePatterns(routing?.classA?.patterns || []);
    this.classBPatterns = this._compilePatterns(routing?.classB?.patterns || []);
    this.beaconKeywords = /pixel|beacon|collect|impression|view|event|track/i;

    // Known ad/tracking infrastructure domains (expanded from v3.1.3)
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
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  /**
   * Dynamic origin classification.
   * Since v4 has no pre-configured targets, we classify origin as:
   *   "ad"         — known ad/tracking infrastructure
   *   "thirdparty" — everything else (including the site itself)
   *
   * This is sufficient because the cache/bypass decision is based on
   * Class A/B/C patterns, not on origin. Origin is for stats only.
   */
  _classifyOrigin(url) {
    const hostname = this._getDomain(url);
    const isAd = this.adDomains.some(ind => hostname.includes(ind) || url.includes(ind));
    return isAd ? "ad" : "thirdparty";
  }

  classify(url, resourceType) {
    const origin = this._classifyOrigin(url);

    // Check Class A (auction/decisioning) — BYPASS for ad revenue
    for (const re of this.classAPatterns) {
      if (re.test(url)) return { class: "A", origin, action: "bypass" };
    }

    // Check Class B (measurement/beacon) — BYPASS for analytics
    for (const re of this.classBPatterns) {
      if (re.test(url)) return { class: "B", origin, action: "bypass" };
    }

    // Additional beacon detection: small tracking pixels / pings
    if (this.beaconKeywords.test(url) &&
        (resourceType === "image" || resourceType === "ping" || resourceType === "other")) {
      return { class: "B", origin, action: "bypass" };
    }

    // Default: Class C — CACHE aggressively
    return { class: "C", origin, action: "cache" };
  }

  /**
   * Content-type check for fetch/xhr responses.
   * v4: expanded to include more asset types for aggressive caching.
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
    if (ct.includes("svg")) return true;
    if (ct.includes("xml") && !ct.includes("html")) return true;
    return false;
  }
}

module.exports = { TrafficClassifier };
