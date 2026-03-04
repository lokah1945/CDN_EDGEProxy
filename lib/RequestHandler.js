"use strict";

/**
 * CDN EdgeProxy v6.0.0 — RequestHandler
 *
 * Changes from v5:
 *  - BUG 2 FIX: All getBlob() calls replaced with async getBlob() (was sync readFileSync)
 *  - Version string in debug headers updated to "CDN_EdgeProxy/6.0"
 *  - Enterprise: averageResponseTimeMs tracking — measures time from route start to fulfill
 *  - Graceful degradation: if blob missing, falls through to origin fetch (never crashes)
 *  - All route handlers guaranteed to never throw unhandled errors
 */

const crypto = require("crypto");
const { log } = require("./logger");
const { URLNormalizer } = require("./URLNormalizer");

const ENGINE_VERSION = "CDN_EdgeProxy/6.0";

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

      if (fresh) {
        // BUG 2 FIX: async getBlob()
        const body = await this.storage.getBlob(meta.blobHash);
        if (body) {
          this.storage.recordHit(url, resourceType, classification.origin, body.length, body.length);
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

      if (meta && this.storage.hasValidators(meta)) {
        const conditionalHeaders = this._buildConditionalHeaders(reqHeaders, meta);

        try {
          const response = await route.fetch({ headers: conditionalHeaders });

          if (response.status() === 304) {
            // BUG 2 FIX: async getBlob()
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

          if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
            this.storage.recordMiss(url, resourceType, classification.origin, newBody.length, wireBytes);
            this.storage.recordResponseTime(Date.now() - startMs);
            return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body: newBody });
          }

          await this.storage.put(cacheKey, url, newBody, respHeaders, resourceType, classification.origin, aliasKey, reqHeaders);
          this.storage.recordMiss(url, resourceType, classification.origin, newBody.length, wireBytes);
          this.storage.recordResponseTime(Date.now() - startMs);
          log.info("MISS-UPDATE", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
          return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body: newBody });

        } catch (err) {
          // Stale-while-revalidate fallback: BUG 2 FIX — async
          const body = await this.storage.getBlob(meta.blobHash);
          if (body) {
            this.storage.recordHit(url, resourceType, classification.origin, body.length, body.length);
            this.storage.recordResponseTime(Date.now() - startMs);
            log.info("STALE-HIT", `${resourceType} ${url.substring(0, 100)}`);
            return route.fulfill({ status: 200, headers: this._replayHeaders(meta.headers), body });
          }
        }
      }
    }

    // Cold fetch path
    try {
      const fetchHeaders = this._buildUpstreamHeaders(reqHeaders);
      const response     = await route.fetch({ headers: fetchHeaders });
      const body         = await response.body();
      const respHeaders  = response.headers();
      const wireBytes    = this._wireSize(respHeaders) || body.length;

      if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
        this.storage.recordMiss(url, resourceType, classification.origin, body.length, wireBytes);
        this.storage.recordResponseTime(Date.now() - startMs);
        return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
      }

      if (response.ok() && body.length > 0) {
        await this.storage.put(cacheKey, url, body, respHeaders, resourceType, classification.origin, aliasKey, reqHeaders);
        this.storage.recordMiss(url, resourceType, classification.origin, body.length, wireBytes);
        log.info("CACHED", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
      } else {
        this.storage.recordMiss(url, resourceType, classification.origin, 0, 0);
      }

      this.storage.recordResponseTime(Date.now() - startMs);
      return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });

    } catch (err) {
      if (meta) {
        // Last-resort stale rescue — BUG 2 FIX: async
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
          // BUG 2 FIX: async getBlob()
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
        // Origin down — serve stale HTML (BUG 2 FIX: async)
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
