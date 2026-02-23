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

  async handle(route) {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    // Skip non-GET and navigation requests
    if (request.method() !== "GET" || resourceType === "document") {
      return route.continue();
    }

    // Classify the request
    const classification = this.classifier.classify(url, resourceType);

    // Class A & B: bypass (auction/decisioning, measurement/beacon)
    if (classification.class === "A" || classification.class === "B") {
      return route.continue();
    }

    // For fetch/xhr: we need to check content-type AFTER fetching.
    // Scripts by themselves are Class C but fetch/xhr JSON should NOT be cached.
    const isFetchXhr = (resourceType === "fetch" || resourceType === "xhr");

    // Build cache keys
    const canonicalNorm = this.normalizer.canonicalKey(url, classification.origin);
    const cacheKey = this.storage.urlToKey(canonicalNorm);
    const aliasKey = this.normalizer.aliasKey(url);
    const reqHeaders = request.headers();

    // ─── CACHE LOOKUP ───
    let meta = this.storage.peekMetaAllowStale(cacheKey);
    let metaSource = "canonical";

    // If canonical miss, try alias
    if (!meta && aliasKey) {
      meta = this.storage.peekAlias(aliasKey);
      metaSource = "alias";
    }

    if (meta) {
      const fresh = this.storage.isFresh(meta);

      // ─── FRESH HIT: serve from cache ───
      if (fresh) {
        const body = this.storage.getBlob(meta.blobHash);
        if (body) {
          this.storage.recordHit(url, resourceType, classification.origin, body.length);
          log.info("CDN-HIT", `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
          return route.fulfill({
            status: 200,
            headers: meta.headers || {},
            body
          });
        }
      }

      // ─── STALE with validators: conditional revalidation ───
      if (this.storage.hasValidators(meta)) {
        const conditionalHeaders = {};
        if (meta.etag) conditionalHeaders["If-None-Match"] = meta.etag;
        if (meta.lastModified) conditionalHeaders["If-Modified-Since"] = meta.lastModified;

        try {
          const response = await route.fetch({
            headers: { ...reqHeaders, ...conditionalHeaders }
          });

          if (response.status() === 304) {
            // 304 Not Modified — origin saw the request (publisher gets credit),
            // but body is 0 bytes (massive bandwidth saving).
            const body = this.storage.getBlob(meta.blobHash);
            if (body) {
              this.storage.refreshTTL(cacheKey);
              this.storage.recordRevalidated(url, resourceType, classification.origin, body.length);
              log.info("HIT-304", `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
              return route.fulfill({
                status: 200,
                headers: meta.headers || {},
                body
              });
            }
          }

          // 200 — new content
          const newBody = await response.body();
          const respHeaders = response.headers();

          // For fetch/xhr: only cache asset content-types
          if (isFetchXhr && !this.classifier.shouldCacheByContentType(respHeaders["content-type"])) {
            this.storage.recordMiss(url, resourceType, classification.origin, newBody.length);
            return route.fulfill({ status: response.status(), headers: respHeaders, body: newBody });
          }

          await this.storage.put(cacheKey, url, newBody, respHeaders, resourceType, classification.origin, aliasKey, reqHeaders);
          this.storage.recordMiss(url, resourceType, classification.origin, newBody.length);
          log.info("MISS-UPDATE", `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
          return route.fulfill({ status: response.status(), headers: respHeaders, body: newBody });
        } catch (err) {
          // Revalidation failed — serve stale if possible
          const body = this.storage.getBlob(meta.blobHash);
          if (body) {
            this.storage.recordHit(url, resourceType, classification.origin, body.length);
            log.info("STALE-HIT", `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
            return route.fulfill({ status: 200, headers: meta.headers || {}, body });
          }
        }
      }
    }

    // ─── MISS: fetch from origin ───
    try {
      const response = await route.fetch();
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
          log.info("Storage", `DEDUP ${url.substring(0, 80)} — same blob ${this.storage.getBlobHashShort(cacheKey)}`);
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
          return route.fulfill({ status: 200, headers: meta.headers || {}, body });
        }
      }
      throw err;
    }
  }
}

module.exports = { RequestHandler };
