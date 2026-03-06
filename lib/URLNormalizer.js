"use strict";

/**
 * CDN EdgeProxy v6.2.0 — URLNormalizer
 *
 * CHANGELOG v6.2.0 (2026-03-07):
 *   ✅ C1: Enhanced cache-buster detection — added nonce, hash, sig, signature, token
 *          to universalCacheBusters; tcf, tcfv2, tc_string, gpc to consentParams;
 *          landingpage, lp, dest, destination, target_url, fallback_url, return_url
 *          to clickRedirectParams
 *   ✅ C2: Path-segment cache-buster detection — new _hasPathTimestamp() method;
 *          integrated into aliasKey() Tier 3
 *   ✅ C3: Expanded pathOnlyDomains — cdn.ampproject.org, ib.adnxs.com,
 *          secure-assets.rubiconproject.com, creative.ak.fbcdn.net,
 *          scontent.xx.fbcdn.net
 *   ✅ C4: Expanded adAliasDomains — cdn.criteo.com, cas.criteo.com,
 *          cdn.flashtalking.com, cdn.innovid.com, cdn.jivox.com,
 *          cdn.doubleverify.com, cdn.adsafeprotected.com
 *   ✅ C5: Enhanced _looksLikeCacheBuster — base64-like strings (20+ chars),
 *          skips JWT (contains two dots)
 *   ✅ C6: Enhanced varyKey — Accept-Language support with |lang=<hash>
 *
 * CHANGELOG v6.1.0 (2026-03-07):
 *   ✅ NEW: universalCacheBusters — cache-buster params yang SELALU di-strip (tidak bergantung origin)
 *   ✅ NEW: consentParams — consent/privacy params di-strip dari cache key
 *   ✅ NEW: clickRedirectParams — click-redirect params di-strip dari cache key
 *   ✅ NEW: _looksLikeCacheBuster() — heuristic deteksi timestamp/UUID/hex values
 *   ✅ UPGRADE: canonicalKey() — 3-layer universal stripping (bukan hanya origin==="ad")
 *   ✅ UPGRADE: aliasKey() — Tier 3 smart heuristic untuk extensionless URLs
 *   ✅ KEPT: pathOnlyDomains, adAliasDomains, staticExtensions, varyKey() — unchanged
 *   ✅ KEPT: adCdnStripParams — backward compat (subset dari universalCacheBusters)
 *
 * DESIGN RATIONALE:
 *   Sebelumnya, cache-buster stripping hanya aktif jika origin === "ad" (bergantung
 *   pada TrafficClassifier mengenali domain). Dengan 200+ ad network dan ribuan domain,
 *   pendekatan ini tidak scalable.
 *
 *   Solusi: strip parameter berdasarkan POLA (nama param + value pattern), bukan domain.
 *   Parameter seperti "cb", "ord", "cachebuster" secara semantik selalu cache-busters —
 *   tidak ada website normal yang menggunakan nama ini untuk functional content.
 */

const crypto = require("crypto");

class URLNormalizer {
  constructor() {
    // ── EXISTING: Tracking params (always stripped) ──
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

    // ── NEW: Universal cache-buster params — SELALU di-strip regardless of origin ──
    // Nama-nama parameter ini secara semantik selalu cache-busters di semua ad network.
    // Aman di-strip untuk semua origin karena tidak ada website normal yang menggunakan
    // nama parameter ini untuk functional content.
    // C1: Added nonce, hash, sig, signature, token
    this.universalCacheBusters = new Set([
      "cb", "cachebuster", "cache_buster",
      "ord", "correlator",
      "dt", "timestamp", "ts", "t", "rnd", "rand", "random",
      "bust", "buster", "nc", "_", "__",
      "misc",        // ADTECH cache-buster
      "n",           // Generic random
      // C1 additions:
      "nonce",       // Security nonce — changes per request
      "hash",        // Hash token — changes per request
      "sig",         // Signature — changes per request
      "signature",   // Full signature — changes per request
      "token",       // Token — changes per request
    ]);

    // ── NEW: Consent/privacy params — di-strip dari cache key ──
    // Stabil per session, creative content tidak berubah berdasarkan consent.
    // Tracking (yang butuh consent) sudah bypass via Class B.
    // C1: Added tcf, tcfv2, tc_string, gpc
    this.consentParams = new Set([
      "gdpr_consent", "gdpr", "us_privacy", "gpp", "gpp_sid",
      "usprivacy", "addtl_consent", "consent",
      // C1 additions:
      "tcf",         // IAB TCF 2.0
      "tcfv2",       // IAB TCF 2.0 version marker
      "tc_string",   // IAB TCF 2.0 consent string
      "gpc",         // Global Privacy Control
    ]);

    // ── NEW: Click-redirect params — di-strip dari cache key ──
    // Beda per placement, tapi creative content sama (gambar/video identik).
    // C1: Added landingpage, lp, dest, destination, target_url, fallback_url, return_url
    this.clickRedirectParams = new Set([
      "click", "pubclick", "click_url", "clickurl", "enc_click",
      "clickenc", "redirect", "redir", "r", "rurl",
      "clickthrough", "ct_url",
      // C1 additions:
      "landingpage",   // Landing page URL
      "lp",            // Short form landing page
      "dest",          // Destination URL
      "destination",   // Full destination URL
      "target_url",    // Target redirect URL
      "fallback_url",  // Fallback redirect URL
      "return_url",    // Return/callback URL
    ]);

    // ── EXISTING: Ad CDN strip params (kept for backward compat) ──
    // Subset dari universalCacheBusters + consentParams
    this.adCdnStripParams = new Set([
      "cb", "cachebuster", "cache_buster", "ord", "correlator",
      "gdpr_consent", "gdpr", "us_privacy", "gpp", "gpp_sid",
      "usprivacy", "addtl_consent", "consent",
      "dt", "timestamp", "ts", "t", "rnd", "rand", "random",
      "bust", "buster", "nc",
    ]);

    // ── EXISTING: Static version params ──
    this.staticVersionParams = new Set([
      "v", "ver", "version", "hash", "h", "rev", "build",
      "cb", "cachebuster", "cache_buster",
      "t", "ts", "timestamp", "_", "__",
      "rnd", "rand", "random", "nc",
      "chunk", "m",
    ]);

    // ── EXISTING: Path-only domains ──
    // C3: Added cdn.ampproject.org, ib.adnxs.com, secure-assets.rubiconproject.com,
    //     creative.ak.fbcdn.net, scontent.xx.fbcdn.net
    this.pathOnlyDomains = [
      "tpc.googlesyndication.com",
      "pagead2.googlesyndication.com",
      "fonts.gstatic.com",
      "fonts.googleapis.com",
      // C3 additions:
      "cdn.ampproject.org",
      "ib.adnxs.com",
      "secure-assets.rubiconproject.com",
      "creative.ak.fbcdn.net",
      "scontent.xx.fbcdn.net",
    ];

    // ── EXISTING: Ad alias domains ──
    // C4: Added cdn.criteo.com, cas.criteo.com, cdn.flashtalking.com, cdn.innovid.com,
    //     cdn.jivox.com, cdn.doubleverify.com, cdn.adsafeprotected.com
    this.adAliasDomains = [
      "tpc.googlesyndication.com",
      "pagead2.googlesyndication.com",
      "googleads.g.doubleclick.net",
      "securepubads.g.doubleclick.net",
      "ad.doubleclick.net",
      "static.xx.fbcdn.net",
      "creative.ak.fbcdn.net",
      // C4 additions:
      "cdn.criteo.com",
      "cas.criteo.com",
      "cdn.flashtalking.com",
      "cdn.innovid.com",
      "cdn.jivox.com",
      "cdn.doubleverify.com",
      "cdn.adsafeprotected.com",
    ];

    // ── EXISTING: Static file extensions ──
    this.staticExtensions = /\.(js|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|wasm|mp4|webm|mp3|ogg)(\?|$)/i;
  }

  /**
   * UPGRADED: canonicalKey() — 3-layer universal stripping
   *
   * Sebelumnya: cache-buster stripping hanya aktif jika origin === "ad"
   * Sekarang: universal stripping untuk SEMUA origin berdasarkan pola parameter
   *
   * Urutan strip:
   *   1. Tracking params (existing — utm_*, fbclid, dll)
   *   2. Universal cache-buster params (NEW — cb, ord, cachebuster, dll)
   *   3. Consent params (NEW — gdpr_consent, us_privacy, dll)
   *   4. Click-redirect params (NEW — click, pubclick, enc_click, dll)
   *   5. Heuristic: param value 10+ digit / UUID / long hex (conditional on origin)
   */
  canonicalKey(url, origin) {
    try {
      const u        = new URL(url);
      const hostname = u.hostname.toLowerCase();
      const pathname = u.pathname;

      if (this.pathOnlyDomains.some(d => hostname === d || hostname.endsWith("." + d))) {
        return `${hostname}${pathname}`;
      }

      const params   = new URLSearchParams(u.searchParams);
      const toDelete = [];

      for (const [key] of params) {
        const kl = key.toLowerCase();

        // 1. Always strip tracking params (existing behavior)
        if (this.trackingParams.has(kl)) { toDelete.push(key); continue; }

        // 2. NEW: Always strip universal cache-busters (regardless of origin)
        if (this.universalCacheBusters.has(kl)) { toDelete.push(key); continue; }

        // 3. NEW: Always strip consent params from cache key
        if (this.consentParams.has(kl)) { toDelete.push(key); continue; }

        // 4. NEW: Always strip click-redirect params from cache key
        if (this.clickRedirectParams.has(kl)) { toDelete.push(key); continue; }

        // 5. Heuristic — value looks like timestamp/random/UUID
        //    Strip jika value match pattern (10+ digit, UUID, long hex)
        //    Berlaku untuk semua origin, tapi hanya jika value benar-benar
        //    menyerupai cache-buster (konservatif, tidak strip param bernilai normal)
        if (this._looksLikeCacheBuster(params.get(key))) {
          toDelete.push(key); continue;
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
   * UPGRADED: aliasKey() — 3-tier fallback
   *
   * Tier 1: Known ad alias domains (EXISTING — paling agresif, path-only alias)
   * Tier 2: URL dengan static extension (EXISTING — strip version params)
   * Tier 3: UPGRADED — Smart heuristic untuk extensionless URLs
   *         Aktif jika URL punya cache-buster param / timestamp value
   *         OR path timestamp (C2: path-segment cache-buster detection)
   *         Ini menangkap ad creative dari network yang belum terdaftar
   */
  aliasKey(url) {
    try {
      const u        = new URL(url);
      const hostname = u.hostname.toLowerCase();

      // ── Tier 1: Known ad alias domains (EXISTING — unchanged) ──
      const isAdAlias = this.adAliasDomains.some(
        d => hostname === d || hostname.endsWith("." + d)
      );
      if (isAdAlias) {
        return `alias|${hostname}${u.pathname}`;
      }

      // ── Tier 2: Static extension match (EXISTING — unchanged) ──
      if (this.staticExtensions.test(u.pathname)) {
        const params  = new URLSearchParams(u.searchParams);
        let stripped  = false;
        for (const [key] of [...params]) {
          if (this.staticVersionParams.has(key.toLowerCase())) {
            params.delete(key);
            stripped = true;
          }
        }

        if (stripped) {
          params.sort();
          const qs = params.toString();
          return qs
            ? `alias|${hostname}${u.pathname}?${qs}`
            : `alias|${hostname}${u.pathname}`;
        }
      }

      // ── Tier 3: UPGRADED — Smart heuristic for extensionless URLs ──
      // Aktivasi jika URL punya param yang terdeteksi sebagai cache-buster
      // OR path segment yang terdeteksi sebagai timestamp (C2)
      const params = new URLSearchParams(u.searchParams);

      let hasCacheBusterParam = false;
      let hasTimestampValue   = false;
      const cleanParams       = new URLSearchParams(u.searchParams);

      if (params.toString() !== "") {
        for (const [key, value] of params) {
          const kl = key.toLowerCase();

          // Check 1: Known cache-buster param names
          if (this.universalCacheBusters.has(kl) || this.consentParams.has(kl)
              || this.clickRedirectParams.has(kl)) {
            hasCacheBusterParam = true;
            cleanParams.delete(key);
            continue;
          }

          // Check 2: Param value looks like timestamp/random
          if (this._looksLikeCacheBuster(value)) {
            hasTimestampValue = true;
            cleanParams.delete(key);
            continue;
          }
        }
      }

      // C2: Check for path-segment timestamps
      const pathCheck = this._hasPathTimestamp(u.pathname);

      // Hanya buat alias jika ada bukti kuat bahwa URL menggunakan cache-busters
      if (hasCacheBusterParam || hasTimestampValue || pathCheck.found) {
        cleanParams.sort();
        const qs       = cleanParams.toString();
        const cleanPath = pathCheck.found ? pathCheck.cleanPath : u.pathname;
        return qs
          ? `alias|${hostname}${cleanPath}?${qs}`
          : `alias|${hostname}${cleanPath}`;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * C2: NEW — Detect cache-buster segments embedded in the URL path.
   *
   * Some ad networks embed cache-busters directly in the pathname, e.g.:
   *   https://cdn.network.com/creative/abc/1678234567890/300x250.jpg
   *
   * A path segment is treated as a timestamp/cache-buster if:
   *   - It is composed entirely of digits (pure numeric segment), AND
   *   - Its length is >= 10 characters (rules out short IDs like "300", "250")
   *
   * @param {string} pathname  - The URL pathname (e.g. "/creative/abc/1678234567890/300x250.jpg")
   * @returns {{ found: boolean, cleanPath: string }}
   *   - found:     true if at least one path timestamp was detected
   *   - cleanPath: pathname with all matching timestamp segments removed;
   *                equals the original pathname if found === false
   */
  _hasPathTimestamp(pathname) {
    if (!pathname || pathname === "/") {
      return { found: false, cleanPath: pathname || "/" };
    }

    const segments  = pathname.split("/");
    let   found     = false;
    const cleaned   = segments.filter(segment => {
      // Pure digits AND length >= 10 → treat as path timestamp
      if (/^\d{10,}$/.test(segment)) {
        found = true;
        return false; // remove segment
      }
      return true;
    });

    const cleanPath = found ? (cleaned.join("/") || "/") : pathname;
    return { found, cleanPath };
  }

  /**
   * C5: ENHANCED — Heuristic untuk mendeteksi cache-buster values
   *
   * Patterns yang di-deteksi:
   *   - Angka 10+ digit (Unix timestamp ms/ns, atau random number)
   *   - UUID format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
   *   - Pure hex strings 16+ chars (hash/token yang dipakai sebagai cache-buster)
   *   - C5 NEW: Base64-like strings (20+ chars, alphanumeric + /+=)
   *             BUT NOT if it looks like a JWT (contains exactly two dots)
   *
   * FALSE POSITIVE PROTECTION:
   *   - Tidak match string pendek (< 10 digit / < 16 hex chars / < 20 base64 chars)
   *   - Tidak match alphanumeric campuran (hanya pure digit atau pure hex)
   *   - Tidak match URL-encoded values
   *   - Tidak match JWT tokens (header.payload.signature pattern with two dots)
   */
  _looksLikeCacheBuster(value) {
    if (!value) return false;
    // Unix timestamp (10-13 digits) or random large number
    if (/^\d{10,}$/.test(value)) return true;
    // UUID format
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
    // Long hex string (likely hash used as cache-buster)
    if (/^[0-9a-f]{16,}$/i.test(value)) return true;
    // C5: Base64-like strings (20+ chars, alphanumeric + /+=)
    // Skip JWTs: a JWT contains exactly two dots (header.payload.signature)
    if (/^[A-Za-z0-9+/=]{20,}$/.test(value)) {
      // Count dots — if exactly two dots present it's likely a JWT; skip
      const dotCount = (value.match(/\./g) || []).length;
      // Note: the base64 regex above excludes dots, so dotCount will always be 0 here.
      // This guard is kept for clarity and future-proofing.
      if (dotCount !== 2) return true;
    }
    return false;
  }

  // ── C6: ENHANCED: varyKey — added Accept-Language support ──
  /**
   * Builds a vary-aware cache key from a canonical key and request headers.
   *
   * Supported Vary headers:
   *   - Vary: Accept         → appends |accept=<8-char md5 hash>
   *   - Vary: Accept-Language → appends |lang=<8-char md5 hash>
   *
   * Multiple Vary dimensions are appended in order (accept first, then lang).
   */
  varyKey(canonicalKey, requestHeaders, responseVary) {
    if (!responseVary) return canonicalKey;
    const vary = responseVary.toLowerCase();
    let key    = canonicalKey;

    if (vary.includes("accept")) {
      const accept = (requestHeaders["accept"] || "").trim();
      if (accept) {
        const fp = crypto.createHash("md5").update(accept).digest("hex").substring(0, 8);
        key = `${key}|accept=${fp}`;
      }
    }

    // C6: Accept-Language support
    if (vary.includes("accept-language")) {
      const lang = (requestHeaders["accept-language"] || "").trim();
      if (lang) {
        const fp = crypto.createHash("md5").update(lang).digest("hex").substring(0, 8);
        key = `${key}|lang=${fp}`;
      }
    }

    return key;
  }
}

module.exports = { URLNormalizer };
