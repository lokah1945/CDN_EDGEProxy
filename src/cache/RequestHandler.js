// ═══════════════════════════════════════════════════════════
// RequestHandler — CDN EdgeProxy routing pipeline
// ═══════════════════════════════════════════════════════════
//
// Pipeline:
//   1. Early bypass (non-GET, document, websocket, Range)
//   2. Classify traffic (Kelas A/B/C)
//   3. Cache lookup (fresh → HIT)
//   4. Stale + revalidatable → 304 (HIT-304)
//   5. MISS → fetch, cache if Kelas C, fulfill
// ═══════════════════════════════════════════════════════════

const crypto = require('crypto');
const { TrafficClassifier } = require('./TrafficClassifier');

// Headers that must NOT be replayed from cache
const DROP_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

class RequestHandler {
  constructor(storage, routingConfig, logger) {
    this.storage = storage;
    this.config = routingConfig;
    this.logger = logger;
    this.classifier = new TrafficClassifier(routingConfig);
    this.inflight = new Map(); // canonicalKey → Promise (dedup)
    this.stats = { hit: 0, hit304: 0, miss: 0, bypass: 0 };
  }

  async handle(route) {
    try {
      const request = route.request();
      const method = request.method();
      const url = request.url();
      const resourceType = request.resourceType();

      // ── Step 1: Early Bypass ──
      if (method !== 'GET') {
        this.stats.bypass++;
        return route.continue();
      }
      if (resourceType === 'document' || resourceType === 'websocket') {
        this.stats.bypass++;
        return route.continue();
      }
      // Range requests — pass through (partial content not cacheable simply)
      const reqHeaders = request.headers();
      if (reqHeaders['range']) {
        this.stats.bypass++;
        return route.continue();
      }

      // ── Step 2: Classify ──
      const klass = this.classifier.classify(url, resourceType, reqHeaders);

      // Kelas A (auction/decisioning) & Kelas B (beacon/measurement) → CONTINUE
      if (klass === 'A' || klass === 'B') {
        this.stats.bypass++;
        return route.continue();
      }

      // ── Kelas C: Creative bytes → cache pipeline ──
      const canonicalKey = this._canonicalKey(url);

      // Inflight dedup: if same URL is already being fetched, wait for it
      if (this.inflight.has(canonicalKey)) {
        await this.inflight.get(canonicalKey);
      }

      // ── Step 3: Cache lookup (fresh) ──
      const meta = this.storage.peekMeta(canonicalKey);

      if (meta && !this.storage.isStale(meta)) {
        // FRESH HIT — serve from cache
        const body = await this.storage.getBlob(meta.hash);
        if (body) {
          this.stats.hit++;
          this.logger.debug(`HIT ${url}`);
          return route.fulfill({
            status: meta.status,
            headers: this._safeHeaders(meta.headers),
            body,
          });
        }
      }

      // ── Step 4: Stale but revalidatable → conditional fetch ──
      if (meta && this.storage.isStale(meta) && (meta.headers['etag'] || meta.headers['last-modified'])) {
        const revalPromise = this._revalidate(route, canonicalKey, meta, url);
        this.inflight.set(canonicalKey, revalPromise);
        try {
          return await revalPromise;
        } finally {
          this.inflight.delete(canonicalKey);
        }
      }

      // ── Step 5: MISS — fetch from origin ──
      const fetchPromise = this._fetchAndCache(route, canonicalKey, url);
      this.inflight.set(canonicalKey, fetchPromise);
      try {
        return await fetchPromise;
      } finally {
        this.inflight.delete(canonicalKey);
      }

    } catch (err) {
      this.logger.error(`Handler error: ${err.message}`);
      try { return route.continue(); } catch (_) {}
    }
  }

  // ── Revalidation (If-None-Match / If-Modified-Since) ──
  async _revalidate(route, key, meta, url) {
    const condHeaders = {};
    if (meta.headers['etag']) {
      condHeaders['if-none-match'] = meta.headers['etag'];
    }
    if (meta.headers['last-modified']) {
      condHeaders['if-modified-since'] = meta.headers['last-modified'];
    }

    let response;
    try {
      response = await route.fetch({
        headers: { ...route.request().headers(), ...condHeaders },
      });
    } catch (err) {
      // Network error — serve stale if available
      const body = await this.storage.getBlob(meta.hash);
      if (body) {
        this.stats.hit++;
        return route.fulfill({ status: meta.status, headers: this._safeHeaders(meta.headers), body });
      }
      return route.continue();
    }

    if (response.status() === 304) {
      // Content unchanged — refresh TTL, serve cached
      this.storage.refreshTTL(key);
      const body = await this.storage.getBlob(meta.hash);
      this.stats.hit304++;
      this.logger.debug(`HIT-304 ${url}`);
      return route.fulfill({
        status: meta.status,
        headers: this._safeHeaders(meta.headers),
        body,
      });
    }

    // 200 — creative changed, update cache
    const body = await response.body();
    const respHeaders = response.headers();
    const contentType = respHeaders['content-type'] || '';

    if (this._isCacheableResponse(response.status(), contentType)) {
      const hash = this._hashBody(body);
      await this.storage.put(key, {
        status: response.status(),
        headers: respHeaders,
        hash,
        size: body.length,
        cachedAt: Date.now(),
      }, body);
      this.logger.debug(`MISS-UPDATE ${url}`);
    }

    this.stats.miss++;
    return route.fulfill({
      status: response.status(),
      headers: this._safeHeaders(respHeaders),
      body,
    });
  }

  // ── Fetch + Cache (cold miss) ──
  async _fetchAndCache(route, key, url) {
    let response;
    try {
      response = await route.fetch();
    } catch (err) {
      return route.continue();
    }

    const body = await response.body();
    const respHeaders = response.headers();
    const contentType = respHeaders['content-type'] || '';
    const status = response.status();

    if (this._isCacheableResponse(status, contentType)) {
      const hash = this._hashBody(body);
      await this.storage.put(key, {
        status,
        headers: respHeaders,
        hash,
        size: body.length,
        cachedAt: Date.now(),
      }, body);
      this.stats.miss++;
      this.logger.debug(`MISS-CACHED ${url}`);
    } else {
      this.stats.bypass++;
      this.logger.debug(`MISS-NOCACHE ${url} (${contentType})`);
    }

    return route.fulfill({
      status,
      headers: this._safeHeaders(respHeaders),
      body,
    });
  }

  // ── Helpers ──

  _canonicalKey(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      // Sort query params for canonical
      u.searchParams.sort();
      return u.toString();
    } catch {
      return url;
    }
  }

  _hashBody(body) {
    return crypto.createHash('sha256').update(body).digest('hex');
  }

  _isCacheableResponse(status, contentType) {
    if (status < 200 || status >= 400) return false;
    const ct = contentType.toLowerCase();
    return this.config.cacheableContentTypes.some(t => ct.includes(t));
  }

  _safeHeaders(headers) {
    const safe = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!DROP_HEADERS.has(k.toLowerCase())) {
        safe[k] = v;
      }
    }
    return safe;
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = { RequestHandler };
