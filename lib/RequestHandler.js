"use strict";

const crypto = require("crypto");
const { log } = require("./logger");
const { URLNormalizer } = require("./URLNormalizer");

class RequestHandler {
  constructor(storage, classifier, cacheConfig, stealthConfig = {}) {
    this.storage = storage;
    this.classifier = classifier;
    this.cacheConfig = cacheConfig;
    this.normalizer = new URLNormalizer();

    // Stealth configuration (defaults: maximum stealth)
    this.stealth = {
      injectViaHeader: stealthConfig.injectViaHeader === true,          // default OFF
      viaHeaderValue: stealthConfig.viaHeaderValue || "1.1 EdgeProxy",
      exposeDebugHeaders: stealthConfig.exposeDebugHeaders === true,    // default OFF
      debugHeaderPrefix: stealthConfig.debugHeaderPrefix || "x-edgeproxy",
    };
  }

  _isCacheableType(resourceType) {
    switch (resourceType) {
      case "stylesheet": case "script": case "image":
      case "font": case "media":
        return true;
      case "fetch": case "xhr":
        return true;
      default:
        return false;
    }
  }

  _wireSize(headers) {
    const cl = headers["content-length"];
    if (cl) {
      const parsed = parseInt(cl, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  /* ── Build upstream headers — stealth-safe by default ── */
  _buildUpstreamHeaders(reqHeaders) {
    const headers = { ...reqHeaders };
    if (this.stealth.injectViaHeader) {
      headers["via"] = this.stealth.viaHeaderValue;
    }
    return headers;
  }

  /* ── Build conditional headers for revalidation ── */
  _buildConditionalHeaders(reqHeaders, meta) {
    const headers = this._buildUpstreamHeaders(reqHeaders);
    if (meta.etag) headers["if-none-match"] = meta.etag;
    if (meta.lastModified) headers["if-modified-since"] = meta.lastModified;
    return headers;
  }

  async handle(route) {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    // Skip non-GET
    if (request.method() !== "GET") return route.continue();

    // Document → conditional cache (always-revalidate)
    if (resourceType === "document") return this._handleDocument(route);

    // Skip non-cacheable resource types
    if (!this._isCacheableType(resourceType)) return route.continue();

    // Classify traffic
    const classification = this.classifier.classify(url, resourceType);

    // Class A/B → bypass (auction, beacon)
    if (classification.class !== "C") return route.continue();

    // ═══ CLASS C: CACHE PATH ═══
    const isFetchXhr = (resourceType === "fetch" || resourceType === "xhr");
    const canonicalNorm = this.normalizer.canonicalKey(url, classification.origin);
    const cacheKey = this.storage.urlToKey(canonicalNorm);
    const aliasKey = this.normalizer.aliasKey(url);
    const reqHeaders = request.headers();

    // ─── CACHE LOOKUP ───
    let meta = this.storage.peekMetaAllowStale(cacheKey);
    let usedAlias = false;

    if (!meta && aliasKey) {
      meta = this.storage.peekAlias(aliasKey);
      if (meta) usedAlias = true;
    }

    if (meta) {
      const fresh = this.storage.isFresh(meta);

      // ─── FRESH HIT → serve from cache (no upstream, browser-like) ───
      if (fresh) {
        const body = this.storage.getBlob(meta.blobHash);
        if (body) {
          this.storage.recordHit(url, resourceType, classification.origin, body.length, body.length);
          log.debug("CDN-HIT", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
          return route.fulfill({
            status: 200,
            headers: this._replayHeaders(meta.headers),
            body
          });
        }
        meta = null; // blob missing, fall through
      }

      // ─── STALE: conditional revalidation (browser-like 304 pattern) ───
      if (meta && this.storage.hasValidators(meta)) {
        const conditionalHeaders = this._buildConditionalHeaders(reqHeaders, meta);

        try {
          const response = await route.fetch({ headers: conditionalHeaders });

          if (response.status() === 304) {
            const body = this.storage.getBlob(meta.blobHash);
            if (body) {
              this.storage.refreshTTL(cacheKey);
              if (usedAlias) {
                await this.storage.put(cacheKey, url, body, meta.headers, resourceType, classification.origin, aliasKey, reqHeaders);
              }
              this.storage.recordRevalidated(url, resourceType, classification.origin, body.length, body.length);
              log.debug("HIT-304", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
              return route.fulfill({
                status: 200,
                headers: this._replayHeaders(meta.headers),
                body
              });
            }
          }

          // 200 — content changed
          const newBody = await response.body();
          const respHeaders = response.headers();
          const wireBytes = this._wireSize(respHeaders) || newBody.length;

          if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
            this.storage.recordMiss(url, resourceType, classification.origin, newBody.length, wireBytes);
            return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body: newBody });
          }

          await this.storage.put(cacheKey, url, newBody, respHeaders, resourceType, classification.origin, aliasKey, reqHeaders);
          this.storage.recordMiss(url, resourceType, classification.origin, newBody.length, wireBytes);
          log.info("MISS-UPDATE", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
          return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body: newBody });
        } catch (err) {
          // Network error → serve stale (resilience)
          const body = this.storage.getBlob(meta.blobHash);
          if (body) {
            this.storage.recordHit(url, resourceType, classification.origin, body.length, body.length);
            log.info("STALE-HIT", `${resourceType} ${url.substring(0, 100)}`);
            return route.fulfill({ status: 200, headers: this._replayHeaders(meta.headers), body });
          }
        }
      }
    }

    // ─── MISS: fetch from origin ───
    try {
      const fetchHeaders = this._buildUpstreamHeaders(reqHeaders);
      const response = await route.fetch({ headers: fetchHeaders });
      const body = await response.body();
      const respHeaders = response.headers();
      const wireBytes = this._wireSize(respHeaders) || body.length;

      if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
        this.storage.recordMiss(url, resourceType, classification.origin, body.length, wireBytes);
        return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
      }

      if (response.ok() && body.length > 0) {
        await this.storage.put(cacheKey, url, body, respHeaders, resourceType, classification.origin, aliasKey, reqHeaders);
        this.storage.recordMiss(url, resourceType, classification.origin, body.length, wireBytes);
        log.info("CACHED", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
      } else {
        this.storage.recordMiss(url, resourceType, classification.origin, 0, 0);
      }

      return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
    } catch (err) {
      if (meta) {
        const body = this.storage.getBlob(meta.blobHash);
        if (body) {
          log.info("STALE-RESCUE", `${resourceType} ${url.substring(0, 100)}`);
          return route.fulfill({ status: 200, headers: this._replayHeaders(meta.headers), body });
        }
      }
      throw err;
    }
  }

  /* ═══════════════════════════════════════════════════════
     Document/HTML Conditional Caching
     Always revalidate — never blind cache hit for HTML.
     ═══════════════════════════════════════════════════════ */

  async _handleDocument(route) {
    const request = route.request();
    const url = request.url();
    const reqHeaders = request.headers();

    const docKey = crypto.createHash("sha256").update("doc:" + this._normalizeDocURL(url)).digest("hex");
    const meta = this.storage.peekMeta(docKey);

    // ─── Has cached version with validators? Always revalidate. ───
    if (meta && (meta.etag || meta.lastModified)) {
      const conditionalHeaders = this._buildConditionalHeaders(reqHeaders, meta);

      try {
        const response = await route.fetch({ headers: conditionalHeaders });

        if (response.status() === 304) {
          const body = this.storage.getBlob(meta.blobHash);
          if (body) {
            this.storage.recordDocHit(url, body.length);
            log.info("DOC-HIT", `304 — cached HTML: ${url.substring(0, 100)}`);
            return route.fulfill({
              status: 200,
              headers: this._replayDocHeaders(meta.headers),
              body
            });
          }
        }

        if (response.ok()) {
          const body = await response.body();
          const respHeaders = response.headers();
          const wireBytes = this._wireSize(respHeaders) || body.length;

          if (body.length > 0 && (respHeaders["etag"] || respHeaders["last-modified"])) {
            await this.storage.putDocument(docKey, url, body, respHeaders);
            log.info("DOC-UPDATE", `HTML changed: ${url.substring(0, 100)}`);
          }
          this.storage.recordDocMiss(url, body.length, wireBytes);
          return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
        }

        const body = await response.body();
        return route.fulfill({ status: response.status(), headers: this._stripEncoding(response.headers()), body });

      } catch (err) {
        const body = this.storage.getBlob(meta.blobHash);
        if (body) {
          log.warn("DOC-STALE", `Origin down, serving cached: ${url.substring(0, 100)}`);
          return route.fulfill({
            status: 200,
            headers: this._replayDocHeaders(meta.headers),
            body
          });
        }
        return route.continue();
      }
    }

    // ─── No cache — first visit ───
    try {
      const fetchHeaders = this._buildUpstreamHeaders(reqHeaders);
      const response = await route.fetch({ headers: fetchHeaders });
      const body = await response.body();
      const respHeaders = response.headers();
      const wireBytes = this._wireSize(respHeaders) || body.length;

      if (response.ok() && body.length > 0 && (respHeaders["etag"] || respHeaders["last-modified"])) {
        await this.storage.putDocument(docKey, url, body, respHeaders);
        log.info("DOC-CACHED", `First visit HTML cached: ${url.substring(0, 100)}`);
      }
      this.storage.recordDocMiss(url, body.length, wireBytes);
      return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });

    } catch (err) {
      return route.continue();
    }
  }

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

  _stripEncoding(headers) {
    const out = { ...(headers || {}) };
    delete out["content-encoding"];
    delete out["content-length"];
    delete out["transfer-encoding"];
    return out;
  }

  /* ── Replay headers — stealth-safe: no debug headers by default ── */
  _replayHeaders(stored) {
    const headers = { ...(stored || {}) };
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    if (this.stealth.exposeDebugHeaders) {
      headers[this.stealth.debugHeaderPrefix] = "HIT";
      headers[this.stealth.debugHeaderPrefix + "-engine"] = "CDN_EdgeProxy/5.0";
    }
    return headers;
  }

  _replayDocHeaders(stored) {
    const headers = { ...(stored || {}) };
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    if (this.stealth.exposeDebugHeaders) {
      headers[this.stealth.debugHeaderPrefix] = "DOC-HIT";
      headers[this.stealth.debugHeaderPrefix + "-engine"] = "CDN_EdgeProxy/5.0";
    }
    return headers;
  }
}

module.exports = { RequestHandler };
