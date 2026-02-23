"use strict";

const crypto = require("crypto");
const { log } = require("./logger");
const { URLNormalizer } = require("./URLNormalizer");

class RequestHandler {
  constructor(storage, classifier, cacheConfig) {
    this.storage = storage;
    this.classifier = classifier;
    this.cacheConfig = cacheConfig;
    this.normalizer = new URLNormalizer();
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

  /* ── v4.1.1: Extract wire size from content-length header ── */
  _wireSize(headers) {
    const cl = headers["content-length"];
    if (cl) {
      const parsed = parseInt(cl, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  async handle(route) {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    // Skip non-GET
    if (request.method() !== "GET") return route.continue();

    // v4.1.1: Document → conditional cache (always-revalidate)
    if (resourceType === "document") return this._handleDocument(route);

    // Skip non-cacheable
    if (!this._isCacheableType(resourceType)) return route.continue();

    // Classify
    const classification = this.classifier.classify(url, resourceType);

    // Class A/B → bypass
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

      // ─── FRESH HIT ───
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
        meta = null;
      }

      // ─── STALE: conditional revalidation ───
      if (meta && this.storage.hasValidators(meta)) {
        const conditionalHeaders = { ...reqHeaders, "via": "1.1 CDN_EdgeProxy" };
        if (meta.etag) conditionalHeaders["if-none-match"] = meta.etag;
        if (meta.lastModified) conditionalHeaders["if-modified-since"] = meta.lastModified;

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
      const fetchHeaders = { ...reqHeaders, "via": "1.1 CDN_EdgeProxy" };
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
     v4.1.1: Document/HTML Conditional Caching
     Always revalidate — never blind cache hit for HTML.
     Uses ETag + If-None-Match / If-Modified-Since.
     ═══════════════════════════════════════════════════════ */

  async _handleDocument(route) {
    const request = route.request();
    const url = request.url();
    const reqHeaders = request.headers();

    // Generate document cache key (prefix "doc:" to avoid collision)
    const docKey = crypto.createHash("sha256").update("doc:" + this._normalizeDocURL(url)).digest("hex");
    const meta = this.storage.peekMeta(docKey);

    // ─── Has cached version with validators? Always revalidate. ───
    if (meta && (meta.etag || meta.lastModified)) {
      const conditionalHeaders = { ...reqHeaders, "via": "1.1 CDN_EdgeProxy" };
      if (meta.etag) conditionalHeaders["if-none-match"] = meta.etag;
      if (meta.lastModified) conditionalHeaders["if-modified-since"] = meta.lastModified;

      try {
        const response = await route.fetch({ headers: conditionalHeaders });

        if (response.status() === 304) {
          // Content unchanged — serve from cache!
          const body = this.storage.getBlob(meta.blobHash);
          if (body) {
            this.storage.recordDocHit(url, body.length);
            log.info("DOC-HIT", `304 — cached HTML served: ${url.substring(0, 100)}`);
            return route.fulfill({
              status: 200,
              headers: this._replayDocHeaders(meta.headers),
              body
            });
          }
          // Blob missing — fall through to fresh fetch
        }

        // Content changed (200) or other status — update cache
        if (response.ok()) {
          const body = await response.body();
          const respHeaders = response.headers();
          const wireBytes = this._wireSize(respHeaders) || body.length;

          if (body.length > 0 && (respHeaders["etag"] || respHeaders["last-modified"])) {
            await this.storage.putDocument(docKey, url, body, respHeaders);
            log.info("DOC-UPDATE", `HTML changed, cache updated: ${url.substring(0, 100)}`);
          }
          this.storage.recordDocMiss(url, body.length, wireBytes);
          return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
        }

        // Non-200/304 — pass through
        const body = await response.body();
        return route.fulfill({ status: response.status(), headers: this._stripEncoding(response.headers()), body });

      } catch (err) {
        // Origin unreachable — serve stale HTML
        const body = this.storage.getBlob(meta.blobHash);
        if (body) {
          log.warn("DOC-STALE", `Origin down, serving cached HTML: ${url.substring(0, 100)}`);
          return route.fulfill({
            status: 200,
            headers: this._replayDocHeaders(meta.headers),
            body
          });
        }
        // No stale body — let browser handle it
        return route.continue();
      }
    }

    // ─── No cache — first visit, fresh fetch ───
    try {
      const fetchHeaders = { ...reqHeaders, "via": "1.1 CDN_EdgeProxy" };
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
      // Failsafe: let browser handle it
      return route.continue();
    }
  }

  /* Normalize document URL: strip tracking params, keep meaningful query */
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

  _replayHeaders(stored) {
    const headers = { ...(stored || {}) };
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    headers["x-edgeproxy"] = "HIT";
    headers["x-edgeproxy-engine"] = "CDN_EdgeProxy/4.1.1";
    return headers;
  }

  _replayDocHeaders(stored) {
    const headers = { ...(stored || {}) };
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    headers["x-edgeproxy"] = "DOC-HIT";
    headers["x-edgeproxy-engine"] = "CDN_EdgeProxy/4.1.1";
    return headers;
  }
}

module.exports = { RequestHandler };