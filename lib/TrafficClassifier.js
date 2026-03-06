"use strict";

/**
 * CDN EdgeProxy v6.2.0 — TrafficClassifier
 *
 * CHANGELOG v6.2.0 (2026-03-07):
 *   ✅ NEW B1: videoAdKeywords — VAST/SIMID/OMID/VPAID URL pattern detection → Class B bypass
 *   ✅ NEW B2: privacySandboxKeywords — Topics/PAAPI/FLEDGE/Attribution URL pattern detection → Class A bypass
 *   ✅ NEW B3: adStructuralPatterns expanded — tracking.*, track.*, pixel.*, beacon.*, delivery.*, tag[s].*
 *   ✅ NEW B4: ctvAdKeywords — SSAI/DAI/CSAI/ad-pod/adbreak URL pattern detection → Class B bypass
 *   ✅ NEW B5: learnAdDomain() expanded — x-ad-type, x-vast-url, x-creative-size, x-device-ip headers
 *   ✅ NEW B6: adDomainExtended expanded — 33across, triplelift, gumgum, nativo, connatix,
 *              springserve, spotx, telaria, magnite, prebid, ix.io
 *
 * CHANGELOG v6.1.0 (2026-03-07):
 *   ✅ NEW: adDomainExtended — 30+ keyword tambahan dari Google Authorized Buyers registry
 *   ✅ NEW: adStructuralPatterns — regex hostname pattern (ads.*, serve.*, creative.*, dll)
 *   ✅ NEW: learnAdDomain() — runtime learning dari response headers (session-scoped)
 *   ✅ FIX: beaconKeywords guard — tambah "fetch" dan "xhr" ke resource type check
 *   ✅ KEPT: Semua existing logic (classA/B patterns, adDomains, shouldCacheByContentType)
 *
 * REFERENSI:
 *   - Google Authorized Buyers provider dictionary (200+ provider, ribuan domain)
 *   - MRAID/OMID spec — fetch-based impression tracking
 *   - IAB VAST 4.x / SIMID 1.1 / OMID 1.3 specs
 *   - Google Privacy Sandbox — Topics API, Protected Audience API
 *   - IAB CTV/OTT SSAI spec
 */

const { log } = require("./logger");

class TrafficClassifier {
  constructor(routing) {
    this.routing = routing || {};
    this.classAPatterns = this._compilePatterns(routing?.classA?.patterns || []);
    this.classBPatterns = this._compilePatterns(routing?.classB?.patterns || []);

    this.beaconKeywords = /\/(pixel|beacon|collect|impression|ping|log|fire)[\/?.#]|\/tr\?/i;

    // ── B1 NEW: Video ad tech URL patterns → Class B bypass ──
    // VAST XML, SIMID interactive containers, OMID verification scripts, VPAID legacy
    this.videoAdKeywords = /\/(simid|interactive\/creative|omid|omidverification|omidsessionservice|vpaid)\//i;

    // ── B2 NEW: Privacy Sandbox API URL patterns → Class A bypass ──
    // Google Topics API, Protected Audience (PAAPI/FLEDGE), Attribution Reporting,
    // Shared Storage, Private Aggregation
    this.privacySandboxKeywords = /\/(topics|protected-audience|fledge|interest-group|attribution-reporting|shared-storage|private-aggregation)\//i;

    // ── B4 NEW: CTV/OTT Server-Side Ad Insertion URL patterns → Class B bypass ──
    // SSAI, DAI, CSAI, ad-pod / adpod, ad-break / adbreak
    this.ctvAdKeywords = /\/(ssai|dai|csai|ad-pod|adpod|ad-break|adbreak)\//i;

    // ── EXISTING: Core ad domain keywords (30 keywords) ──
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

    // ── NEW (v6.1.0 + v6.2.0 B6 expanded): Extended ad domain keywords ──
    // Domain ad network yang belum ter-cover oleh adDomains existing
    this.adDomainExtended = [
      // Verification / Brand Safety
      "adform", "adloox", "adsafeprotected", "doubleverify", "iasds01",
      // RTB / Exchange
      "rtbhouse", "360yield",
      // Rich Media / DCO
      "flashtalking", "innovid", "jivox",
      // Video Ad Serving
      "freewheel", "fwmrm", "stickyadstv",
      // DSP Platforms
      "acuityplatform", "dspcdn",
      // Misc Ad Platforms
      "adgear", "ctnsnet", "adroll", "adperium", "adpredictive",
      "vindicosuite", "groovinads", "adacado", "cogmatch",
      // Data / Identity
      "w55c.net", "kdata.fr",
      // Creative Serving
      "creative-serving",
      // ── B6 NEW: Additional ad tech platforms ──
      // Native / In-feed Ad Networks
      "33across", "triplelift", "gumgum", "nativo", "connatix",
      // Video Ad Platforms / SSPs
      "springserve", "spotx", "telaria", "magnite",
      // Header Bidding / Exchange Infrastructure
      "prebid", "ix.io",
    ];

    // ── EXISTING: Runtime-learned ad domains (populated during session) ──
    // Domains yang terdeteksi sebagai ad serving berdasarkan response headers
    // Session-scoped: di-reset setiap kali CacheModule di-restart
    this._learnedAdDomains = new Set();

    // ── EXISTING + B3 EXPANDED: Structural hostname patterns ──
    // Match berdasarkan prefix/pattern hostname, bukan keyword
    this.adStructuralPatterns = [
      /^ads?\./i,             // ads.*, ad.*
      /^adserver\./i,         // adserver.*
      /^cdn\.ad/i,            // cdn.ad*
      /^creative[s]?\./i,     // creative.*, creatives.*
      /^serve[rd]?\./i,       // serve.*, served.*, server.*
      /^servedby\./i,         // servedby.*
      /^static\.ad/i,         // static.ad*
      /^img\.ad/i,            // img.ad*
      /^banner[s]?\./i,       // banner.*, banners.*
      /^display\./i,          // display.*
      /^vast\./i,             // vast.*
      /^vpaid\./i,            // vpaid.*
      // ── B3 NEW: Additional structural patterns ──
      /^tracking\./i,         // tracking.*
      /^track\./i,            // track.*
      /^pixel\./i,            // pixel.*
      /^beacon\./i,           // beacon.*
      /^delivery\./i,         // delivery.*
      /^tag[s]?\./i,          // tag.*, tags.*
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

  /**
   * Classify origin of a URL: "ad" or "thirdparty"
   *
   * 4-tier detection:
   *   1. Core ad domain keywords (existing 30)
   *   2. Extended ad domain keywords (v6.1.0 + v6.2.0 B6 expanded)
   *   3. Runtime-learned domains (dari response headers)
   *   4. Structural hostname patterns (v6.1.0 + v6.2.0 B3 expanded)
   */
  classifyOrigin(url) {
    const hostname = this._getDomain(url);
    const lowerUrl = url.toLowerCase();

    // Check 1: EXISTING — core keyword match
    for (const indicator of this.adDomains) {
      if (hostname.includes(indicator) || lowerUrl.includes(indicator)) return "ad";
    }

    // Check 2: NEW — extended keyword match
    for (const indicator of this.adDomainExtended) {
      if (hostname.includes(indicator) || lowerUrl.includes(indicator)) return "ad";
    }

    // Check 3: NEW — runtime-learned domains
    if (this._learnedAdDomains.has(hostname)) return "ad";

    // Check 4: NEW — structural hostname pattern
    for (const pattern of this.adStructuralPatterns) {
      if (pattern.test(hostname)) return "ad";
    }

    return "thirdparty";
  }

  /**
   * Classify traffic class: A (auction bypass), B (beacon bypass), C (cacheable)
   *
   * v6.2.0 additions:
   *   - B2: privacySandboxKeywords checked BEFORE classA patterns → Class A bypass
   *   - B1: videoAdKeywords checked after beaconKeywords → Class B bypass
   *   - B4: ctvAdKeywords checked after videoAdKeywords → Class B bypass
   *
   * FIX v6.1.0: beaconKeywords guard sekarang termasuk "fetch" dan "xhr"
   * Alasan: Ad network modern (MRAID, OMID) semakin banyak menggunakan
   * fetch() API untuk impression/viewability beacon, bukan <img> pixel.
   * Tanpa fix ini, beacon fetch-based bisa ter-cache → impression hilang.
   */
  classify(url, resourceType) {
    const origin = this.classifyOrigin(url);

    // ── B2 NEW: Privacy Sandbox APIs always bypass completely (Class A) ──
    // Must be checked before classAPatterns to ensure consistent bypass
    if (this.privacySandboxKeywords.test(url)) {
      return { class: "A", origin, action: "bypass" };
    }

    for (const re of this.classAPatterns) {
      if (re.test(url)) return { class: "A", origin, action: "bypass" };
    }

    for (const re of this.classBPatterns) {
      if (re.test(url)) return { class: "B", origin, action: "bypass" };
    }

    // FIX v6.1.0: Tambah "fetch" dan "xhr" ke guard condition
    if (this.beaconKeywords.test(url) &&
        (resourceType === "image" || resourceType === "ping"
         || resourceType === "other"
         || resourceType === "fetch" || resourceType === "xhr")) {
      return { class: "B", origin, action: "bypass" };
    }

    // ── B1 NEW: VAST/SIMID/OMID/VPAID video ad tech → Class B bypass ──
    // These URLs carry tracking/measurement payloads; must not be cached
    if (this.videoAdKeywords.test(url)) {
      return { class: "B", origin, action: "bypass" };
    }

    // ── B4 NEW: CTV/OTT server-side ad insertion → Class B bypass ──
    // SSAI/DAI/CSAI manifests carry personalised ad breaks; must not be cached
    if (this.ctvAdKeywords.test(url)) {
      return { class: "B", origin, action: "bypass" };
    }

    return { class: "C", origin, action: "cache" };
  }

  /**
   * Runtime learning — dipanggil dari RequestHandler setelah
   * menerima response dari cold fetch.
   *
   * Heuristic detection:
   *   1. Response headers mengandung ad-specific header
   *      (x-creative-id, x-adserver, x-ad-id,
   *       x-ad-type [B5], x-vast-url [B5], x-creative-size [B5], x-device-ip [B5])
   *   2. CORS header (access-control-allow-origin) mengarah ke known ad domain
   *
   * Session-scoped: domain yang dipelajari hanya berlaku selama runtime aktif.
   * Additive only: hanya menambah coverage, tidak mengubah existing behavior.
   */
  learnAdDomain(hostname, responseHeaders) {
    if (!hostname || !responseHeaders) return;
    if (this._learnedAdDomains.has(hostname)) return;

    // Heuristic 1: Ad-specific response headers
    // ── B5 EXPANDED: tambah x-ad-type, x-vast-url, x-creative-size, x-device-ip ──
    const xCreative = responseHeaders["x-creative-id"]
                   || responseHeaders["x-adserver"]
                   || responseHeaders["x-ad-id"]
                   || responseHeaders["x-ad-type"]
                   || responseHeaders["x-vast-url"]
                   || responseHeaders["x-creative-size"]
                   || responseHeaders["x-device-ip"];

    if (xCreative) {
      this._learnedAdDomains.add(hostname);
      log.info("AdLearn", `Learned ad domain from headers: ${hostname}`);
      return;
    }

    // Heuristic 2: CORS header pointing to known ad domain
    const accessControl = responseHeaders["access-control-allow-origin"] || "";
    if (accessControl) {
      for (const indicator of this.adDomains) {
        if (accessControl.includes(indicator)) {
          this._learnedAdDomains.add(hostname);
          log.info("AdLearn", `Learned ad domain from CORS: ${hostname}`);
          return;
        }
      }
    }
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
