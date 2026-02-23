"use strict";

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

  async handle(route) {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    // Skip non-GET
    if (request.method() !== "GET") return route.continue();

    // Always bypass document — fresh HTML every time
    if (resourceType === "document") return route.continue();

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
          this.storage.recordHit(url, resourceType, classification.origin, body.length);
          log.debug("CDN-HIT", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
          return route.fulfill({
            status: 200,
            headers: this._replayHeaders(meta.headers),
            body
          });
        }
        // Blob missing — fall through to MISS
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
              // v4.1: If we found via alias, also register under canonical key
              if (usedAlias) {
                await this.storage.put(cacheKey, url, body, meta.headers, resourceType, classification.origin, aliasKey, reqHeaders);
              }
              this.storage.recordRevalidated(url, resourceType, classification.origin, body.length);
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

          if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
            this.storage.recordMiss(url, resourceType, classification.origin, newBody.length);
            return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body: newBody });
          }

          await this.storage.put(cacheKey, url, newBody, respHeaders, resourceType, classification.origin, aliasKey, reqHeaders);
          this.storage.recordMiss(url, resourceType, classification.origin, newBody.length);
          log.info("MISS-UPDATE", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
          return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body: newBody });
        } catch (err) {
          // Network error — serve stale
          const body = this.storage.getBlob(meta.blobHash);
          if (body) {
            this.storage.recordHit(url, resourceType, classification.origin, body.length);
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

      if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
        this.storage.recordMiss(url, resourceType, classification.origin, body.length);
        return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
      }

      if (response.ok() && body.length > 0) {
        await this.storage.put(cacheKey, url, body, respHeaders, resourceType, classification.origin, aliasKey, reqHeaders);
        this.storage.recordMiss(url, resourceType, classification.origin, body.length);
        log.info("CACHED", `${resourceType} ${classification.origin} ${url.substring(0, 100)}`);
      } else {
        this.storage.recordMiss(url, resourceType, classification.origin, 0);
      }

      return route.fulfill({ status: response.status(), headers: this._stripEncoding(respHeaders), body });
    } catch (err) {
      // Network fail — last-resort stale rescue
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

  /**
   * Strip content-encoding & content-length from any response before fulfill.
   * Playwright decompresses bodies; replaying these headers causes corruption.
   */
  _stripEncoding(headers) {
    const out = { ...(headers || {}) };
    delete out["content-encoding"];
    delete out["content-length"];
    delete out["transfer-encoding"];
    return out;
  }

  /**
   * Replay stored headers + CDN observability.
   */
  _replayHeaders(stored) {
    const headers = { ...(stored || {}) };
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    headers["x-edgeproxy"] = "HIT";
    headers["x-edgeproxy-engine"] = "CDN_EdgeProxy/4.1";
    return headers;
  }
}

module.exports = { RequestHandler };
