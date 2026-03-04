"use strict";

const crypto = require("crypto");

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

    // v4.1: Added "chunk", "m" (common in webpack/vite builds)
    this.staticVersionParams = new Set([
      "v", "ver", "version", "hash", "h", "rev", "build",
      "cb", "cachebuster", "cache_buster",
      "t", "ts", "timestamp", "_", "__",
      "rnd", "rand", "random", "nc",
      "chunk", "m",
    ]);

    this.pathOnlyDomains = [
      "tpc.googlesyndication.com",
      "pagead2.googlesyndication.com",
      "fonts.gstatic.com",
      "fonts.googleapis.com",
    ];

    this.adAliasDomains = [
      "tpc.googlesyndication.com",
      "pagead2.googlesyndication.com",
      "googleads.g.doubleclick.net",
      "securepubads.g.doubleclick.net",
      "ad.doubleclick.net",
      "static.xx.fbcdn.net",
      "creative.ak.fbcdn.net",
    ];

    this.staticExtensions = /\.(js|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|wasm|mp4|webm|mp3|ogg)(\?|$)/i;
  }

  canonicalKey(url, origin) {
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

  aliasKey(url) {
    try {
      const u = new URL(url);
      const hostname = u.hostname.toLowerCase();

      // Strategy 1: Ad CDN → path-only
      const isAdAlias = this.adAliasDomains.some(d => hostname === d || hostname.endsWith("." + d));
      if (isAdAlias) {
        return `alias|${hostname}${u.pathname}`;
      }

      // Strategy 2: Static assets → strip version params
      if (this.staticExtensions.test(u.pathname)) {
        const params = new URLSearchParams(u.searchParams);
        let stripped = false;
        for (const [key] of [...params]) {
          if (this.staticVersionParams.has(key.toLowerCase())) {
            params.delete(key);
            stripped = true;
          }
        }
        if (stripped) {
          params.sort();
          const qs = params.toString();
          return qs ? `alias|${hostname}${u.pathname}?${qs}` : `alias|${hostname}${u.pathname}`;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

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
