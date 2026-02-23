"use strict";

const crypto = require("crypto");

/**
 * URL normalization for canonical + alias cache keys.
 * v3.1.3: Added aliasKey for aggressive ad/CDN dedup,
 *         and Vary-aware accept fingerprint for cross-browser safety.
 */
class URLNormalizer {
  constructor() {
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

    this.adCdnStripParams = new Set([
      "cb", "cachebuster", "cache_buster", "ord", "correlator",
      "gdpr_consent", "gdpr", "us_privacy", "gpp", "gpp_sid",
      "usprivacy", "addtl_consent", "consent",
      "dt", "timestamp", "ts", "t", "rnd", "rand", "random",
      "bust", "buster", "nc",
    ]);

    this.pathOnlyDomains = [
      "tpc.googlesyndication.com",
      "pagead2.googlesyndication.com",
      "fonts.gstatic.com",
      "fonts.googleapis.com",
    ];

    // Domains where alias-key strips even more aggressively
    this.aliasDomains = [
      "tpc.googlesyndication.com",
      "pagead2.googlesyndication.com",
      "googleads.g.doubleclick.net",
      "securepubads.g.doubleclick.net",
      "ad.doubleclick.net",
      "static.xx.fbcdn.net",
      "creative.ak.fbcdn.net",
    ];
  }

  /**
   * Canonical key — standard normalization (strip tracking, sort query).
   */
  canonicalKey(url, classification) {
    try {
      const u = new URL(url);
      const hostname = u.hostname.toLowerCase();
      const pathname = u.pathname;

      if (this.pathOnlyDomains.some(d => hostname === d || hostname.endsWith("." + d))) {
        return `${hostname}${pathname}`;
      }

      const params = new URLSearchParams(u.searchParams);
      const toDelete = [];

      for (const [key] of params) {
        const kl = key.toLowerCase();
        if (this.trackingParams.has(kl)) { toDelete.push(key); continue; }
        if (classification === "ad" && this.adCdnStripParams.has(kl)) { toDelete.push(key); continue; }
        if (classification === "ad") {
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
   * Alias key — aggressive normalization for ad/CDN domains.
   * Strips ALL query params (path-only) on known alias domains,
   * enabling cross-cachebuster dedup + conditional revalidation.
   * Returns null if no alias applies.
   */
  aliasKey(url) {
    try {
      const u = new URL(url);
      const hostname = u.hostname.toLowerCase();
      const isAlias = this.aliasDomains.some(d => hostname === d || hostname.endsWith("." + d));
      if (!isAlias) return null;
      return `alias|${hostname}${u.pathname}`;
    } catch {
      return null;
    }
  }

  /**
   * Vary-aware key suffix for cross-browser safety.
   * Appends accept fingerprint when response has Vary: Accept.
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
