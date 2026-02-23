// ═══════════════════════════════════════════════════════════
// TrafficClassifier — Classify traffic into Kelas A/B/C
// ═══════════════════════════════════════════════════════════
//
// Kelas A: Auction/decisioning (scripts, xhr JSON to adservers)  → CONTINUE
// Kelas B: Measurement/beacon (pixel, small tracking requests)   → CONTINUE
// Kelas C: Creative bytes (images, video, font, large assets)    → CACHE
// ═══════════════════════════════════════════════════════════

class TrafficClassifier {
  constructor(config) {
    this.beaconPatterns = config.beaconPatterns || [];
    this.beaconMaxBytes = config.beaconMaxBytes || 4096;
    this.adNetworks = config.adNetworkPatterns || [];
    this.cacheableTypes = config.cacheableContentTypes || [];
  }

  /**
   * @param {string} url
   * @param {string} resourceType - Playwright resource type
   * @param {object} headers - request headers
   * @returns {'A'|'B'|'C'} traffic class
   */
  classify(url, resourceType, headers) {
    const urlLower = url.toLowerCase();
    const isAd = this._isAdNetwork(urlLower);

    // ── Kelas B: Beacon/measurement ──
    // Small tracking pixels, event collectors
    if (this._isBeacon(urlLower, resourceType)) {
      return 'B';
    }

    // ── Kelas A: Auction/decisioning ──
    // Script or XHR/fetch to ad network (JSON responses, auction logic)
    if (resourceType === 'script' || resourceType === 'xhr' || resourceType === 'fetch') {
      // If it's an ad network and likely JSON/script (not a large creative fetch)
      if (isAd && !this._likelyCacheableByUrl(urlLower)) {
        return 'A';
      }
    }

    // ── Kelas C: Creative bytes (cacheable) ──
    // Images, video, font, CSS, JS assets, large creative via fetch
    if (this._isLikelyCacheable(resourceType, urlLower)) {
      return 'C';
    }

    // Default: if resource type is image/font/media → always C
    if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
      return 'C';
    }

    // Unknown or non-cacheable → treat as A (let through)
    return 'A';
  }

  _isAdNetwork(url) {
    return this.adNetworks.some(pattern => url.includes(pattern));
  }

  _isBeacon(url, resourceType) {
    // Check URL patterns
    const hasBeaconPattern = this.beaconPatterns.some(p => url.includes(p));
    if (hasBeaconPattern && (resourceType === 'image' || resourceType === 'ping' || resourceType === 'xhr' || resourceType === 'fetch')) {
      return true;
    }
    // 1x1 pixel pattern in URL
    if (/[\/\?&](1x1|pixel|blank)\.(gif|png|jpg)/i.test(url)) {
      return true;
    }
    return false;
  }

  _likelyCacheableByUrl(url) {
    // URL hints that this is a creative asset, not auction JSON
    return /\.(jpg|jpeg|png|gif|webp|avif|svg|mp4|webm|woff2?|ttf|otf|eot|css|js)(\?|$)/i.test(url);
  }

  _isLikelyCacheable(resourceType, url) {
    if (['image', 'media', 'font', 'stylesheet', 'script'].includes(resourceType)) {
      return true;
    }
    return this._likelyCacheableByUrl(url);
  }
}

module.exports = { TrafficClassifier };
