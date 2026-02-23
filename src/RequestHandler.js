"use strict";

const { log } = require("./logger");

class RequestHandler {
  constructor(storage, classifier, cacheConfig) {
    this.storage = storage;
    this.classifier = classifier;
    this.cacheConfig = cacheConfig;
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

    // Class C: cache pipeline
    const cacheKey = this.storage.urlToKey(url);
    const meta = this.storage.peekMeta(cacheKey);

    if (meta) {
      const age = Date.now() - meta.storedAt;
      const isFresh = age < this.cacheConfig.maxAge;
      const isRevalidatable = age < (this.cacheConfig.maxAge + this.cacheConfig.staleWhileRevalidate);

      if (isFresh) {
        // Fresh HIT — serve from cache
        const body = this.storage.getBlob(meta.blobHash);
        if (body) {
          this.storage.recordHit(url, resourceType, classification.origin, body.length);
          log.info(`CDN-HIT`, `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
          return route.fulfill({
            status: 200,
            headers: meta.headers || {},
            body
          });
        }
      }

      if (isRevalidatable && (meta.etag || meta.lastModified)) {
        // Stale but revalidatable — conditional fetch
        const conditionalHeaders = {};
        if (meta.etag) conditionalHeaders["If-None-Match"] = meta.etag;
        if (meta.lastModified) conditionalHeaders["If-Modified-Since"] = meta.lastModified;

        try {
          const response = await route.fetch({
            headers: { ...request.headers(), ...conditionalHeaders }
          });

          if (response.status() === 304) {
            // 304 Not Modified — refresh TTL, serve cached
            const body = this.storage.getBlob(meta.blobHash);
            if (body) {
              this.storage.refreshTTL(cacheKey);
              this.storage.recordHit(url, resourceType, classification.origin, body.length);
              log.info(`HIT-304`, `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
              return route.fulfill({
                status: 200,
                headers: meta.headers || {},
                body
              });
            }
          }

          // 200 — new content, update cache
          const newBody = await response.body();
          const respHeaders = response.headers();
          await this.storage.put(cacheKey, url, newBody, respHeaders, resourceType, classification.origin);
          this.storage.recordMiss(url, resourceType, classification.origin, newBody.length);
          log.info(`MISS-UPDATE`, `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
          return route.fulfill({
            status: response.status(),
            headers: respHeaders,
            body: newBody
          });
        } catch (err) {
          // Revalidation failed — serve stale if possible
          const body = this.storage.getBlob(meta.blobHash);
          if (body) {
            this.storage.recordHit(url, resourceType, classification.origin, body.length);
            log.info(`STALE-HIT`, `${resourceType} ${classification.origin} ${url.substring(0, 80)}`);
            return route.fulfill({
              status: 200,
              headers: meta.headers || {},
              body
            });
          }
        }
      }
    }

    // MISS — fetch and cache
    try {
      const response = await route.fetch();
      const body = await response.body();
      const respHeaders = response.headers();

      if (response.ok() && body.length > 0) {
        await this.storage.put(cacheKey, url, body, respHeaders, resourceType, this.classifier.classify(url, resourceType).origin);
        const dedup = this.storage.isDedup(cacheKey);
        if (dedup) {
          log.info(`Storage`, `DEDUP ${url.substring(0, 80)} — same content as existing blob ${this.storage.getBlobHashShort(cacheKey)}`);
        }
        this.storage.recordMiss(url, resourceType, this.classifier.classify(url, resourceType).origin, body.length);
        log.info(`CACHED`, `${resourceType} ${this.classifier.classify(url, resourceType).origin} ${url.substring(0, 80)}`);
      } else {
        this.storage.recordMiss(url, resourceType, this.classifier.classify(url, resourceType).origin, 0);
      }

      return route.fulfill({
        status: response.status(),
        headers: respHeaders,
        body
      });
    } catch (err) {
      // Network error — try stale cache as last resort
      if (meta) {
        const body = this.storage.getBlob(meta.blobHash);
        if (body) {
          log.info(`STALE-RESCUE`, `${resourceType} ${url.substring(0, 80)}`);
          return route.fulfill({ status: 200, headers: meta.headers || {}, body });
        }
      }
      throw err;
    }
  }
}

module.exports = { RequestHandler };
