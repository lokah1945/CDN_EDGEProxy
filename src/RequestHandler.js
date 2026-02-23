"use strict";

const { log } = require("./logger");
const { URLNormalizer } = require("./URLNormalizer");

/**
 * RequestHandler v4.0.0
 *
 * Key upgrades from v3.1.3:
 *   - CSS and JS cached aggressively (same tier as images/fonts)
 *   - Via header added to outgoing requests (origin sees CDN-like traffic)
 *   - Universal: works on any website without pre-configured targets
 *   - document (HTML) still bypasses cache (always fresh from origin)
 *   - Stale-while-revalidate: serve stale body + conditional revalidation
 */
class RequestHandler {
  constructor(storage, classifier, cacheConfig) {
    this.storage = storage;
    this.classifier = classifier;
    this.cacheConfig = cacheConfig;
    this.normalizer = new URLNormalizer();
  }

  /**
   * Cacheable resource types — v4 is aggressive: CSS and JS are HIGH priority cache targets.
   */
  _isCacheableType(resourceType) {
    switch (resourceType) {
      case "stylesheet":
      case "script":
      case "image":
      case "font":
      case "media":
        return true;
      case "fetch":
      case "xhr":
        return true; // will be filtered by content-type after fetching
      default:
        return false;
    }
  }

  async handle(route) {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    // Skip non-GET requests — POST/PUT/DELETE must always go to origin
    if (request.method() !== "GET") {
      return route.continue();
    }

    // ALWAYS bypass document (HTML) — user must always see fresh content
    if (resourceType === "document") {
      return route.continue();
    }

    // Skip non-cacheable resource types early
    if (!this._isCacheableType(resourceType)) {
      return route.continue();
    }

    // Classify the request
    const classification = this.classifier.classify(url, resourceType);

    // Class A (auction/decisioning): BYPASS — preserve ad revenue
    // Class B (measurement/beacon): BYPASS — preserve analytics
    if (classification.class === "A" || classification.class === "B") {
      return route.continue();
    }

    // ═══ CLASS C: CACHE PATH ═══
    const isFetchXhr = (resourceType === "fetch" || resourceType === "xhr");

    // Build cache keys
    const canonicalNorm = this.normalizer.canonicalKey(url, classification.origin);
    const cacheKey = this.storage.urlToKey(canonicalNorm);
    const aliasKey = this.normalizer.aliasKey(url);
    const reqHeaders = request.headers();

    // ─── CACHE LOOKUP ───
    let meta = this.storage.peekMetaAllowStale(cacheKey);

    // If canonical miss, try alias (cross-cachebuster revalidation)
    if (!meta && aliasKey) {
      meta = this.storage.peekAlias(aliasKey);
    }

    if (meta) {
      const fresh = this.storage.isFresh(meta);

      // ─── FRESH HIT: serve instantly from cache ───
      if (fresh) {
        const body = this.storage.getBlob(meta.blobHash);
        if (body) {
          this.storage.recordHit(url, resourceType, classification.origin, body.length);
          log.debug("CDN-HIT", `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
          return route.fulfill({
            status: 200,
            headers: this._replayHeaders(meta.headers),
            body
          });
        }
      }

      // ─── STALE with validators: conditional revalidation ───
      if (this.storage.hasValidators(meta)) {
        const conditionalHeaders = { ...reqHeaders };

        // Add Via header so origin sees CDN-like traffic pattern
        conditionalHeaders["via"] = "1.1 CDN_EdgeProxy";

        if (meta.etag) conditionalHeaders["if-none-match"] = meta.etag;
        if (meta.lastModified) conditionalHeaders["if-modified-since"] = meta.lastModified;

        try {
          const response = await route.fetch({ headers: conditionalHeaders });

          if (response.status() === 304) {
            // 304 — origin confirmed content unchanged
            // Publisher SEES the request (revenue preserved) but body = 0 bytes
            const body = this.storage.getBlob(meta.blobHash);
            if (body) {
              this.storage.refreshTTL(cacheKey);
              this.storage.recordRevalidated(url, resourceType, classification.origin, body.length);
              log.debug("HIT-304", `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
              return route.fulfill({
                status: 200,
                headers: this._replayHeaders(meta.headers),
                body
              });
            }
          }

          // 200 — content changed, store new version
          const newBody = await response.body();
          const respHeaders = response.headers();

          if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
            this.storage.recordMiss(url, resourceType, classification.origin, newBody.length);
            return route.fulfill({ status: response.status(), headers: respHeaders, body: newBody });
          }

          await this.storage.put(cacheKey, url, newBody, respHeaders, resourceType, classification.origin, aliasKey, reqHeaders);
          this.storage.recordMiss(url, resourceType, classification.origin, newBody.length);
          log.info("MISS-UPDATE", `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
          return route.fulfill({ status: response.status(), headers: respHeaders, body: newBody });
        } catch (err) {
          // Revalidation network error — serve stale as fallback
          const body = this.storage.getBlob(meta.blobHash);
          if (body) {
            this.storage.recordHit(url, resourceType, classification.origin, body.length);
            log.info("STALE-HIT", `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
            return route.fulfill({ status: 200, headers: this._replayHeaders(meta.headers), body });
          }
        }
      }
    }

    // ─── MISS: fetch from origin ───
    try {
      // Add Via header to origin request
      const fetchHeaders = { ...reqHeaders, "via": "1.1 CDN_EdgeProxy" };
      const response = await route.fetch({ headers: fetchHeaders });
      const body = await response.body();
      const respHeaders = response.headers();

      // For fetch/xhr: only cache if content-type is asset-like
      if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
        this.storage.recordMiss(url, resourceType, classification.origin, body.length);
        return route.fulfill({ status: response.status(), headers: respHeaders, body });
      }

      if (response.ok() && body.length > 0) {
        await this.storage.put(cacheKey, url, body, respHeaders, resourceType, classification.origin, aliasKey, reqHeaders);
        const dedup = this.storage.isDedup(cacheKey);
        if (dedup) {
          log.debug("Storage", `DEDUP ${url.substring(0, 80)}`);
        }
        this.storage.recordMiss(url, resourceType, classification.origin, body.length);
        log.info("CACHED", `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
      } else {
        this.storage.recordMiss(url, resourceType, classification.origin, 0);
      }

      return route.fulfill({ status: response.status(), headers: respHeaders, body });
    } catch (err) {
      // Network error — try stale cache as last resort
      if (meta) {
        const body = this.storage.getBlob(meta.blobHash);
        if (body) {
          log.info("STALE-RESCUE", `${resourceType} ${url.substring(0, 80)}`);
          return route.fulfill({ status: 200, headers: this._replayHeaders(meta.headers), body });
        }
      }
      throw err;
    }
  }

  /**
   * Replay headers with CDN observability.
   * Adds X-EdgeProxy header so DevTools shows cache status.
   */
  _replayHeaders(stored) {
    const headers = { ...(stored || {}) };
    headers["x-edgeproxy"] = "HIT";
    headers["x-edgeproxy-engine"] = "CDN_EdgeProxy/4.0";
    return headers;
  }
}

module.exports = { RequestHandler };
