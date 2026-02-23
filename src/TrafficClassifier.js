"use strict";

class TrafficClassifier {
  constructor(routing, allMatchDomains) {
    this.routing = routing || {};
    this.selfDomains = new Set((allMatchDomains || []).map(d => d.toLowerCase()));

    // Pre-compile patterns for Class A and B
    this.classAPatterns = this._compilePatterns(routing?.classA?.patterns || []);
    this.classBPatterns = this._compilePatterns(routing?.classB?.patterns || []);
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
    // Determine origin
    const hostname = this._getDomain(url);
    let origin;
    if (this._isSelfDomain(hostname)) {
      origin = "self";
    } else {
      // Check if it's an ad domain
      const adIndicators = [
        "doubleclick", "googlesyndication", "googleadservices",
        "facebook.com/tr", "analytics", "adnxs", "criteo",
        "pubmatic", "rubiconproject", "openx", "adsrvr",
        "chartbeat", "ampproject", "smaato", "seedtag"
      ];
      const isAd = adIndicators.some(ind => hostname.includes(ind) || url.includes(ind));
      origin = isAd ? "ad" : "thirdparty";
    }

    // Check Class A
    for (const re of this.classAPatterns) {
      if (re.test(url)) return { class: "A", origin, action: "bypass" };
    }

    // Check Class B
    for (const re of this.classBPatterns) {
      if (re.test(url)) return { class: "B", origin, action: "bypass" };
    }

    // Default: Class C — cache
    return { class: "C", origin, action: "cache" };
  }
}

module.exports = { TrafficClassifier };
