"use strict";

const crypto = require("crypto");

/**
 * URLNormalizer v4.0.0
 *
 * Key upgrades from v3.1.3:
 *   - Universal alias-key for ALL static assets (CSS/JS/font/image), not just ad CDN
 *   - Strips version/hash query params (?v=, ?ver=, ?hash=) for first-party static dedup
 *   - Cross-cachebuster revalidation works on any domain
 *   - Vary-aware accept fingerprint preserved
 */
class URLNormalizer {
  constructor() {
    // Tracking params to strip from canonical key
    this.trackingParams = new Set([
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "fbclid", "gclid", "gclsrc", "yclid", "msclkid", "dclid",
      "spm", "scm", "_ga", "_gl", "mc_cid", "mc_eid",
      "ncid", "ref", "ref_", "referer", "source",
      "ns_source", "ns_mchannel", "ns_campaign",
      "twclid", "igshid", "ttclid",
      "mibextid", "hss_channel",
      "_branch_match_id", "_branch_referrer",
      "zanpid", "irclickid", "irgwc",
    ]);

    // Ad CDN-specific params to strip
    this.adCdnStripParams = new Set([
      "cb", "cachebuster", "cache_buster", "ord", "correlator",
      "gdpr_consent", "gdpr", "us_privacy", "gpp", "gpp_sid",
      "usprivacy", "addtl_consent", "consent",
      "dt", "timestamp", "ts", "t", "rnd", "rand", "random",
      "bust", "buster", "nc",
    ]);

    // v4: Static asset version params — stripped for alias key (revalidation dedup)
    this.staticVersionParams = new Set([
      "v", "ver", "version", "hash", "h", "rev", "build",
      "cb", "cachebuster", "cache_buster",
      "t", "ts", "timestamp", "_", "__",
      "rnd", "rand", "random", "nc",
    ]);

    // Domains that always use path-only canonical key
    this.pathOnlyDomains = [
      "tpc.googlesyndication.com",
      "pagead2.googlesyndication.com",
      "fonts.gstatic.com",
      "fonts.googleapis.com",
    ];

    // Ad CDN domains for aggressive alias (path-only, strip all query)
    this.adAliasDomains = [
      "tpc.googlesyndication.com",
      "pagead2.googlesyndication.com",
      "googleads.g.doubleclick.net",
      "securepubads.g.doubleclick.net",
      "ad.doubleclick.net",
      "static.xx.fbcdn.net",
      "creative.ak.fbcdn.net",
    ];

    // v4: Static file extensions that qualify for alias-key dedup
    this.staticExtensions = /\.(js|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|wasm|mp4|webm|mp3|ogg)(\?|$)/i;
  }

  /**
   * Canonical key — standard normalization (strip tracking, sort query).
   */
  canonicalKey(url, origin) {
    try {
      const u = new URL(url);
      const hostname = u.hostname.toLowerCase();
      const pathname = u.pathname;

      // Path-only domains (no query at all)
      if (this.pathOnlyDomains.some(d => hostname === d || hostname.endsWith("." + d))) {
        return `${hostname}${pathname}`;
      }

      const params = new URLSearchParams(u.searchParams);
      const toDelete = [];

      for (const [key] of params) {
        const kl = key.toLowerCase();
        if (this.trackingParams.has(kl)) { toDelete.push(key); continue; }
        if (origin === "ad" && this.adCdnStripParams.has(kl)) { toDelete.push(key); continue; }
        if (origin === "ad") {
          const val = params.get(key);
          if (val && /^\d{10,}$/.test(val)) { toDelete.push(key); continue; }
        }
      }

      for (const k of toDelete) params.delete(k);
      params.sort();
      const qs = params.toString();
      return qs ? `${hostname}${pathname}?${qs}` : `${hostname}${pathname}`;
    } catch {
      return url;
    }
  }

  /**
   * Alias key — aggressive normalization for revalidation dedup.
   *
   * v4 upgrade: TWO alias strategies:
   *   1. Ad CDN domains → path-only (strip ALL query params)
   *   2. ANY static asset URL → strip version/hash params only
   *
   * This enables cross-cachebuster conditional revalidation:
   *   - canonical key misses (query changed)
   *   - alias key hits (path is same, version param stripped)
   *   - stored validators used for If-None-Match → 304
   */
  aliasKey(url) {
    try {
      const u = new URL(url);
      const hostname = u.hostname.toLowerCase();

      // Strategy 1: Ad CDN domains → strip ALL query params
      const isAdAlias = this.adAliasDomains.some(d => hostname === d || hostname.endsWith("." + d));
      if (isAdAlias) {
        return `alias|${hostname}${u.pathname}`;
      }

      // Strategy 2: Static asset URLs → strip version/hash params
      if (this.staticExtensions.test(u.pathname)) {
        const params = new URLSearchParams(u.searchParams);
        let stripped = false;
        for (const [key] of [...params]) {
          if (this.staticVersionParams.has(key.toLowerCase())) {
            params.delete(key);
            stripped = true;
          }
        }
        // Only return alias if we actually stripped something (otherwise canonical = alias)
        if (stripped) {
          params.sort();
          const qs = params.toString();
          const normalized = qs
            ? `alias|${hostname}${u.pathname}?${qs}`
            : `alias|${hostname}${u.pathname}`;
          return normalized;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Vary-aware key suffix for cross-browser safety.
   */
  varyKey(canonicalKey, requestHeaders, responseVary) {
    if (!responseVary) return canonicalKey;
    const vary = responseVary.toLowerCase();
    if (vary.includes("accept")) {
      const accept = (requestHeaders["accept"] || "").trim();
      if (accept) {
        const fp = crypto.createHash("md5").update(accept).digest("hex").substring(0, 8);
        return `${canonicalKey}|accept=${fp}`;
      }
    }
    return canonicalKey;
  }
}

module.exports = { URLNormalizer };
