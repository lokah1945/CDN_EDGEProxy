const { URL } = require('url');
const log = require('../utils/logger');
const { normalizeUrl } = require('../utils/url');

// RequestHandler — intercept semua request via page.route
// document/xhr/fetch/websocket -> PASSTHROUGH (website gak sadar)
// image/css/font/script/media -> cek cache -> serve atau fetch+cache

class RequestHandler {
  constructor(storage, discovery, target) {
    this.storage = storage;
    this.discovery = discovery;
    this.target = target;
    this.stats = { served: 0, cached: 0, passthrough: 0 };
  }

  async attach(page) {
    await page.route('**/*', async (route) => {
      try {
        await this._handle(route);
      } catch (err) {
        log.error(`[Handler:${this.target.id}] ${err.message}`);
        try { await route.continue(); } catch (_) {}
      }
    });
    log.info(`[Handler:${this.target.id}] Interception ACTIVE on all requests`);
  }

  async _handle(route) {
    const request = route.request();
    const url = request.url();
    const resourceType = request.resourceType();

    // Passthrough: document, xhr, fetch, websocket — INVISIBLE ke website
    if (!this.discovery.isTransparentType(resourceType)) {
      this.stats.passthrough++;
      return route.continue();
    }

    // Skip tipe non-cacheable
    if (!this.discovery.isCacheableType(resourceType)) {
      this.stats.passthrough++;
      return route.continue();
    }

    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch (_) {
      return route.continue();
    }

    const classification = this.discovery.classify(hostname);
    const cacheKey = this._buildCacheKey(url, classification);

    // Cek cache — kalau ada, serve langsung (ini BUKTI CDN bekerja)
    const cached = this.storage.get(cacheKey);
    if (cached) {
      this.stats.served++;

      // Log setiap cache hit sebagai bukti
      if (this.stats.served % 50 === 1 || this.stats.served <= 5) {
        log.info(`[CDN-HIT] [${classification}] ${resourceType} << ${this._shortUrl(url)}`);
      }

      return route.fulfill({
        status: 200,
        headers: this._buildHeaders(cached.contentType, classification),
        body: cached.body
      });
    }

    // Cache miss — fetch dari origin, simpan, serve
    try {
      const response = await route.fetch();
      const status = response.status();

      if (status >= 200 && status < 400) {
        const body = await response.body();
        const contentType = response.headers()['content-type'] || 'application/octet-stream';

        this.storage.set(cacheKey, {
          body,
          contentType,
          resourceType,
          classification,
          url: this._shortUrl(url),
          cachedAt: Date.now()
        });

        this.stats.cached++;

        if (this.stats.cached % 20 === 1 || this.stats.cached <= 5) {
          log.info(`[CACHED]  [${classification}] ${resourceType} >> ${this._shortUrl(url)} (${(body.length / 1024).toFixed(1)} KB)`);
        }

        return route.fulfill({
          status: 200,
          headers: this._buildHeaders(contentType, classification),
          body
        });
      }

      return route.fulfill({ response });
    } catch (err) {
      log.warn(`[MISS] Fetch failed: ${this._shortUrl(url)}`);
      return route.continue();
    }
  }

  _buildCacheKey(url, classification) {
    if (classification === 'ad') {
      return normalizeUrl(url, { stripTracking: true });
    }
    return normalizeUrl(url, { stripTracking: false });
  }

  _buildHeaders(contentType, classification) {
    const headers = { 'content-type': contentType };
    if (classification === 'self') {
      // Website target melihat header CDN — bukti dilayani CDN
      headers['cache-control'] = 'public, max-age=31536000, immutable';
      headers['x-edge-cache'] = 'HIT';
      headers['x-cdn-pop'] = 'edge-local';
      headers['x-served-by'] = 'EdgeProxy/2.1';
    } else if (classification === 'ad') {
      headers['cache-control'] = 'public, max-age=3600';
      headers['x-edge-cache'] = 'HIT';
    } else {
      headers['cache-control'] = 'public, max-age=86400';
    }
    return headers;
  }

  _shortUrl(url) {
    try {
      const u = new URL(url);
      const p = u.pathname.length > 60 ? u.pathname.substring(0, 60) + '...' : u.pathname;
      return u.hostname + p;
    } catch (_) {
      return url.substring(0, 80);
    }
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = RequestHandler;
