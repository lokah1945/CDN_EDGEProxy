"use strict";

/**
 * CDN EdgeProxy v6.2.0 — RequestHandler
 *
 * CHANGELOG v6.2.0 (2026-03-07):
 *   ✅ D1: Response size validation — _isReasonableSize(contentType, bodyLength)
 *          Skip caching oversized responses (HTML > 5MB, JSON > 10MB)
 *   ✅ D2: Stale-while-revalidate background refresh — meta.needsRefresh flag
 *          Stale entries marked for priority refresh on next request
 *   ✅ D3: Cache-Control: immutable — flows through to StorageEngine via headers
 *   ✅ D4: Web Cache Deception Protection — _validateContentType(url, contentType)
 *          Skip caching when URL extension mismatches actual content-type
 *   ✅ D5: cacheKey passed to recordHit() for GDSF hitCount tracking
 *   ✅ D6: ENGINE_VERSION bumped to "CDN_EdgeProxy/6.2"
 *
 * Changes from v6.1.0:
 *  - VERSION bumped to "CDN_EdgeProxy/6.2"
 *  - New helper: _isReasonableSize(contentType, bodyLength)
 *  - New helper: _validateContentType(url, contentType)
 *  - New helper: _backgroundRevalidate() — sets meta.needsRefresh = true
 *  - Stale path: sets meta.needsRefresh = true before serving stale
 *  - Fresh path: if meta.needsRefresh, forces revalidation instead of cache serve
 *  - Cold fetch path: size + content-type validation before storage.put()
 *  - All recordHit() calls now include cacheKey as last parameter
 */

const crypto = require("crypto");
const { log } = require("./logger");
const { URLNormalizer } = require("./URLNormalizer");

const ENGINE_VERSION = "CDN_EdgeProxy/6.2";

class RequestHandler {
  /**
   * @param {StorageEngine} storage
   * @param {TrafficClassifier} classifier
   * @param {object} cacheConfig   { maxAge }
   * @param {object} stealthConfig { injectViaHeader, viaHeaderValue, exposeDebugHeaders, debugHeaderPrefix }
   */
  constructor(storage, classifier, cacheConfig, stealthConfig = {}) {
    this.storage    = storage;
    this.classifier = classifier;
    this.cacheConfig = cacheConfig;
    this.normalizer  = new URLNormalizer();

    this.stealth = {
      injectViaHeader:    stealthConfig.injectViaHeader === true,
      viaHeaderValue:     stealthConfig.viaHeaderValue  || "1.1 EdgeProxy",
      exposeDebugHeaders: stealthConfig.exposeDebugHeaders === true,
      debugHeaderPrefix:  stealthConfig.debugHeaderPrefix  || "x-edgeproxy",
    };
  }

  // ── Resource-type filtering ────────────────────────────────────────────────

  _isCacheableType(resourceType) {
    switch (resourceType) {
      case "stylesheet": case "script": case "image":
      case "font":       case "media":
        return true;
      case "fetch":      case "xhr":
        return true;
      default:
        return false;
    }
  }

  // ── Header utilities ───────────────────────────────────────────────────────

  _wireSize(headers) {
    const cl = headers["content-length"];
    if (cl) {
      const parsed = parseInt(cl, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  _buildUpstreamHeaders(reqHeaders) {
    const headers = { ...reqHeaders };
    if (this.stealth.injectViaHeader) {
      headers["via"] = this.stealth.viaHeaderValue;
    }
    return headers;
  }

  _buildConditionalHeaders(reqHeaders, meta) {
    const headers = this._buildUpstreamHeaders(reqHeaders);
    if (meta.etag)         headers["if-none-match"]     = meta.etag;
    if (meta.lastModified) headers["if-modified-since"] = meta.lastModified;
    return headers;
  }

  _stripEncoding(headers) {
    const out = { ...(headers || {}) };
    delete out["content-encoding"];
    delete out["content-length"];
    delete out["transfer-encoding"];
    return out;
  }

  _replayHeaders(stored) {
    const headers = { ...(stored || {}) };
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    if (this.stealth.exposeDebugHeaders) {
      headers[this.stealth.debugHeaderPrefix]              = "HIT";
      headers[this.stealth.debugHeaderPrefix + "-engine"]  = ENGINE_VERSION;
    }
    return headers;
  }

  _replayDocHeaders(stored) {
    const headers = { ...(stored || {}) };
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    if (this.stealth.exposeDebugHeaders) {
      headers[this.stealth.debugHeaderPrefix]             = "DOC-HIT";
      headers[this.stealth.debugHeaderPrefix + "-engine"] = ENGINE_VERSION;
    }
    return headers;
  }

  // ── D1: Response size validation ───────────────────────────────────────────

  /**
   * Returns false if the response body is unreasonably large for its content-type.
   * Prevents caching of bloated error pages or data dumps.
   *
   * @param {string} contentType  - value of content-type response header (may be null/undefined)
   * @param {number} bodyLength   - byte length of response body
   * @returns {boolean}
   */
  _isReasonableSize(contentType, bodyLength) {
    if (!contentType) return true;
    const ct = contentType.toLowerCase();
    if (ct.includes("text/html") && bodyLength > 5 * 1024 * 1024) return false;
    if (ct.includes("application/json") && bodyLength > 10 * 1024 * 1024) return false;
    return true;
  }

  // ── D4: Web Cache Deception Protection ────────────────────────────────────

  /**
   * Validates that the actual content-type matches what the URL extension implies.
   * Prevents cache deception attacks where a malicious URL tricks the proxy into
   * caching sensitive content under an unexpected content-type.
   *
   * @param {string} url          - full request URL
   * @param {string} contentType  - value of content-type response header (may be null/undefined)
   * @returns {boolean} true = safe to cache, false = mismatch detected
   */
  _validateContentType(url, contentType) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      const dotIdx = pathname.lastIndexOf(".");
      if (dotIdx === -1) return true; // no extension — allow

      const ext = pathname.slice(dotIdx); // e.g. ".js"
      const ct  = (contentType || "").toLowerCase();

      switch (ext) {
        case ".js":
          // Must contain "javascript"
          return ct.includes("javascript");

        case ".css":
          return ct.includes("text/css");

        case ".html":
        case ".htm":
          return ct.includes("text/html");

        case ".json":
          return ct.includes("application/json");

        case ".xml":
          return ct.includes("text/xml") || ct.includes("application/xml");

        case ".svg":
          return ct.includes("image/svg");

        case ".png":
        case ".jpg":
        case ".jpeg":
        case ".gif":
        case ".webp":
          return ct.includes("image/");

        case ".woff":
        case ".woff2":
        case ".ttf":
          return ct.includes("font/") || ct.includes("application/font");

        default:
          return true; // unrecognized extension — allow
      }
    } catch (_) {
      return true; // URL parse failure — allow (defensive)
    }
  }

  // ── D2: Background revalidation helper ────────────────────────────────────

  /**
   * Marks the cache entry for priority refresh on the next request.
   * In Playwright we cannot clone routes for fire-and-forget fetches, so the
   * "background revalidation" is implemented as a needsRefresh flag:
   *  - Set here (fire-and-forget, no await)
   *  - Consumed in the fresh path: if needsRefresh, treat as stale → revalidate
   *
   * All errors are silently swallowed — this must never throw.
   */
  _backgroundRevalidate(route, url, cacheKey, meta, reqHeaders, classification, isFetchXhr, aliasKey) {
    // Fire-and-forget: mark the entry so the next request revalidates it.
    // We do this synchronously (no async needed) but wrapped in try-catch.
    try {
      if (meta) {
        meta.needsRefresh = true;
      }
    } catch (_) {}
  }

  // ── Main route handler ─────────────────────────────────────────────────────

  /**
   * Primary entry point called by EdgeCacheRuntime.attach() route callback.
   * MUST NEVER throw an unhandled error — always falls through to route.continue().
   */
  async handle(route) {
    const startMs = Date.now();

    const request      = route.request();
    const url          = request.url();
    const resourceType = request.resourceType();

    if (request.method() !== "GET") return route.continue();

    if (resourceType === "document") {
      return this._handleDocument(route, startMs);
    }

    if (!this._isCacheableType(resourceType)) return route.continue();

    const classification = this.classifier.classify(url, resourceType);
    if (classification.class !== "C") return route.continue();

    const isFetchXhr   = (resourceType === "fetch" || resourceType === "xhr");
    const canonicalNorm = this.normalizer.canonicalKey(url, classification.origin);
    const cacheKey     = this.storage.urlToKey(canonicalNorm);
    const aliasKey     = this.normalizer.aliasKey(url);
    const reqHeaders   = request.headers();

    let meta       = this.storage.peekMetaAllowStale(cacheKey);
    let usedAlias  = false;

    if (!meta && aliasKey) {
      meta = this.storage.peekAlias(aliasKey);
      if (meta) usedAlias = true;
    }

    if (meta) {
      const fresh = this.storage.isFresh(meta);

      // ── D2: If fresh but needsRefresh flag is set, force revalidation ──
      if (fresh && !meta.needsRefresh) {
        const body = await this.storage.getBlob(meta.blobHash);
        if (body) {
          // D5: pass cacheKey as last parameter to recordHit
          this.storage.recordHit(url, resourceType, classification.origin, body.length, body.length, cacheKey);
          this.storage.recordResponseTime(Date.now() - startMs);
          log.debug("CDN-HIT", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
          return route.fulfill({
            status: 200,
            headers: this._replayHeaders(meta.headers),
            body,
          });
        }
        // Graceful degradation: blob missing from disk — remove from index
        this.storage.index.delete(cacheKey);
        meta = null;
      }

      // ── D2: Stale path — set needsRefresh before serving stale HIT ──
      if (meta && !fresh) {
        // Mark for background revalidation on next request
        this._backgroundRevalidate(route, url, cacheKey, meta, reqHeaders, classification, isFetchXhr, aliasKey);
      }

      if (meta && (this.storage.hasValidators(meta) || meta.needsRefresh)) {
        // Clear needsRefresh before revalidating so we don't loop
        meta.needsRefresh = false;

        const conditionalHeaders = this._buildConditionalHeaders(reqHeaders, meta);

        try {
          const response = await route.fetch({ headers: conditionalHeaders });

          if (response.status() === 304) {
            const body = await this.storage.getBlob(meta.blobHash);
            if (body) {
              this.storage.refreshTTL(cacheKey);
              if (usedAlias) {
                await this.storage.put(cacheKey, url, body, meta.headers, resourceType, classification.origin, aliasKey, reqHeaders);
              }
              this.storage.recordRevalidated(url, resourceType, classification.origin, body.length, body.length);
              this.storage.recordResponseTime(Date.now() - startMs);
              log.debug("HIT-304", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
              return route.fulfill({
                status: 200,
                headers: this._replayHeaders(meta.headers),
                body,
              });
            }
          }

          const newBody     = await response.body();
          const respHeaders = response.headers();
          const wireBytes   = this._wireSize(respHeaders) || newBody.length;

          // ── v6.1.0: Runtime ad domain learning (revalidation path) ──
          try {
            const fetchHostname = new URL(url).hostname.toLowerCase();
            this.classifier.learnAdDomain(fetchHostname, respHeaders);
          } catch (_) {}

          if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
            this.storage.recordMiss(url, resourceType, classification.origin, newBody.length, wireBytes);
            this.storage.recordResponseTime(Date.now() - startMs);
            return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body: newBody });
          }

          // ── v6.1.0: Content-type based alias for fetch/xhr ──
          let effectiveAliasKey = aliasKey;
          if (isFetchXhr && !effectiveAliasKey
              && this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
            effectiveAliasKey = this.normalizer.aliasKey(url);
          }

          await this.storage.put(cacheKey, url, newBody, respHeaders, resourceType, classification.origin, effectiveAliasKey, reqHeaders);
          this.storage.recordMiss(url, resourceType, classification.origin, newBody.length, wireBytes);
          this.storage.recordResponseTime(Date.now() - startMs);
          log.info("MISS-UPDATE", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
          return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body: newBody });

        } catch (err) {
          // Stale-while-revalidate fallback
          const body = await this.storage.getBlob(meta.blobHash);
          if (body) {
            // D5: pass cacheKey as last parameter to recordHit
            this.storage.recordHit(url, resourceType, classification.origin, body.length, body.length, cacheKey);
            this.storage.recordResponseTime(Date.now() - startMs);
            log.info("STALE-HIT", `${resourceType} ${url.substring(0, 100)}`);
            return route.fulfill({ status: 200, headers: this._replayHeaders(meta.headers), body });
          }
        }
      } else if (meta && fresh && meta.needsRefresh) {
        // needsRefresh was set but no validators — serve stale and let cold fetch handle refresh
        const body = await this.storage.getBlob(meta.blobHash);
        if (body) {
          meta.needsRefresh = false;
          // D5: pass cacheKey as last parameter to recordHit
          this.storage.recordHit(url, resourceType, classification.origin, body.length, body.length, cacheKey);
          this.storage.recordResponseTime(Date.now() - startMs);
          log.debug("CDN-HIT", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
          return route.fulfill({
            status: 200,
            headers: this._replayHeaders(meta.headers),
            body,
          });
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Cold fetch path
    // ═════════════════════════════════════════════════════════════════════════
    try {
      const fetchHeaders = this._buildUpstreamHeaders(reqHeaders);
      const response     = await route.fetch({ headers: fetchHeaders });
      const body         = await response.body();
      const respHeaders  = response.headers();
      const wireBytes    = this._wireSize(respHeaders) || body.length;

      // ── v6.1.0: Runtime ad domain learning ──
      // Dipanggil setelah SETIAP cold fetch untuk "belajar" dari response headers.
      // Jika domain yang belum dikenal mengirim ad-specific header (x-creative-id,
      // x-adserver) atau CORS header ke known ad domain, domain tersebut di-flag
      // sebagai ad domain untuk request berikutnya dalam session ini.
      try {
        const fetchHostname = new URL(url).hostname.toLowerCase();
        this.classifier.learnAdDomain(fetchHostname, respHeaders);
      } catch (_) {}

      if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
        this.storage.recordMiss(url, resourceType, classification.origin, body.length, wireBytes);
        this.storage.recordResponseTime(Date.now() - startMs);
        return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
      }

      if (response.ok() && body.length > 0) {
        // ── v6.1.0: Content-type based alias for fetch/xhr ──
        // Jika fetch/xhr response punya cacheable content-type (image/*, video/*, dll)
        // tapi tanpa aliasKey dari normalizer awal, coba buat alias via Tier 3 heuristic.
        // Ini menangkap ad creative yang dikirim via fetch() tanpa file extension di URL.
        let effectiveAliasKey = aliasKey;
        if (isFetchXhr && !effectiveAliasKey
            && this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
          effectiveAliasKey = this.normalizer.aliasKey(url);
        }

        const contentType = respHeaders["content-type"] || "";

        // ── D1: Response size validation ──
        // Skip caching if the body is unreasonably large for its content-type.
        // Still serve the response to the browser.
        if (!this._isReasonableSize(contentType, body.length)) {
          this.storage.recordMiss(url, resourceType, classification.origin, body.length, wireBytes);
          this.storage.recordResponseTime(Date.now() - startMs);
          return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
        }

        // ── D4: Web Cache Deception Protection ──
        // Skip caching if URL file extension doesn't match actual content-type.
        // Still serve the response to the browser.
        if (!this._validateContentType(url, contentType)) {
          log.debug("CACHE-DECEPTION-SKIP", `content-type mismatch ${url.substring(0, 100)}`);
          this.storage.recordMiss(url, resourceType, classification.origin, body.length, wireBytes);
          this.storage.recordResponseTime(Date.now() - startMs);
          return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
        }

        // ── D3: Cache-Control: immutable — flows through via respHeaders ──
        // StorageEngine.computeFreshness() reads Cache-Control from the stored headers,
        // so passing respHeaders (which include "cache-control: immutable") to put()
        // is sufficient for the long TTL to be applied automatically.
        await this.storage.put(cacheKey, url, body, respHeaders, resourceType, classification.origin, effectiveAliasKey, reqHeaders);
        this.storage.recordMiss(url, resourceType, classification.origin, body.length, wireBytes);
        log.info("CACHED", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
      } else {
        this.storage.recordMiss(url, resourceType, classification.origin, 0, 0);
      }

      this.storage.recordResponseTime(Date.now() - startMs);
      return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });

    } catch (err) {
      if (meta) {
        // Last-resort stale rescue
        const body = await this.storage.getBlob(meta.blobHash);
        if (body) {
          this.storage.recordResponseTime(Date.now() - startMs);
          log.info("STALE-RESCUE", `${resourceType} ${url.substring(0, 100)}`);
          return route.fulfill({ status: 200, headers: this._replayHeaders(meta.headers), body });
        }
      }
      // Final fallback — always continue, never crash the browser
      try { return await route.continue(); } catch (_) {}
    }
  }

  // ── Document handler ───────────────────────────────────────────────────────

  async _handleDocument(route, startMs) {
    const request    = route.request();
    const url        = request.url();
    const reqHeaders = request.headers();

    if (!startMs) startMs = Date.now();

    const docKey = crypto.createHash("sha256")
      .update("doc:" + this._normalizeDocURL(url))
      .digest("hex");

    const meta = this.storage.peekMeta(docKey);

    if (meta && (meta.etag || meta.lastModified)) {
      const conditionalHeaders = this._buildConditionalHeaders(reqHeaders, meta);

      try {
        const response = await route.fetch({ headers: conditionalHeaders });

        if (response.status() === 304) {
          const body = await this.storage.getBlob(meta.blobHash);
          if (body) {
            this.storage.recordDocHit(url, body.length);
            this.storage.recordResponseTime(Date.now() - startMs);
            log.info("DOC-HIT", `304 — cached HTML: ${url.substring(0, 100)}`);
            return route.fulfill({
              status: 200,
              headers: this._replayDocHeaders(meta.headers),
              body,
            });
          }
          // Graceful degradation: blob gone, fall through to full fetch below
        }

        if (response.ok()) {
          const body        = await response.body();
          const respHeaders = response.headers();
          const wireBytes   = this._wireSize(respHeaders) || body.length;

          if (body.length > 0 && (respHeaders["etag"] || respHeaders["last-modified"])) {
            await this.storage.putDocument(docKey, url, body, respHeaders);
            log.info("DOC-UPDATE", `HTML changed: ${url.substring(0, 100)}`);
          }
          this.storage.recordDocMiss(url, body.length, wireBytes);
          this.storage.recordResponseTime(Date.now() - startMs);
          return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
        }

        const body = await response.body();
        this.storage.recordResponseTime(Date.now() - startMs);
        return route.fulfill({ status: response.status(), headers: this._stripEncoding(response.headers()), body });

      } catch (err) {
        // Origin down — serve stale HTML
        const body = await this.storage.getBlob(meta.blobHash);
        if (body) {
          log.warn("DOC-STALE", `Origin down, serving cached: ${url.substring(0, 100)}`);
          this.storage.recordResponseTime(Date.now() - startMs);
          return route.fulfill({
            status: 200,
            headers: this._replayDocHeaders(meta.headers),
            body,
          });
        }
        return route.continue();
      }
    }

    // First-visit document fetch
    try {
      const fetchHeaders = this._buildUpstreamHeaders(reqHeaders);
      const response     = await route.fetch({ headers: fetchHeaders });
      const body         = await response.body();
      const respHeaders  = response.headers();
      const wireBytes    = this._wireSize(respHeaders) || body.length;

      if (response.ok() && body.length > 0 && (respHeaders["etag"] || respHeaders["last-modified"])) {
        await this.storage.putDocument(docKey, url, body, respHeaders);
        log.info("DOC-CACHED", `First visit HTML cached: ${url.substring(0, 100)}`);
      }
      this.storage.recordDocMiss(url, body.length, wireBytes);
      this.storage.recordResponseTime(Date.now() - startMs);
      return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });

    } catch (err) {
      return route.continue();
    }
  }

  // ── URL normalization ──────────────────────────────────────────────────────

  _normalizeDocURL(url) {
    try {
      const u = new URL(url);
      const params = new URLSearchParams(u.searchParams);
      const tracking = [
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "fbclid", "gclid", "gclsrc", "yclid", "msclkid", "dclid",
        "_ga", "_gl", "mc_cid", "mc_eid", "ref", "ref_",
        "twclid", "igshid", "ttclid",
      ];
      for (const k of tracking) params.delete(k);
      params.sort();
      const qs = params.toString();
      return qs ? `${u.hostname}${u.pathname}?${qs}` : `${u.hostname}${u.pathname}`;
    } catch {
      return url;
    }
  }
}

module.exports = { RequestHandler };
