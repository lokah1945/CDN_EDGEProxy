const logger = require('./utils/logger');
const { normalizeUrl, classifyUrl } = require('./utils/url');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-encoding', 'content-length'
]);

class RequestHandler {
  constructor(config, storage, discovery, report, target) {
    this.config = config;
    this.storage = storage;
    this.discovery = discovery;
    this.report = report;
    this.target = target;
    this.inflight = new Map();
  }

  async install(page) {
    await page.route('**/*', async (route, request) => {
      try {
        await this._handle(route, request);
      } catch (err) {
        await this._safeAbort(route, err);
      }
    });
    logger.info(`[Handler] Interceptor installed for ${this.target.id}`);
  }

  async _safeAbort(route, err) {
    let url = '(unknown)';
    try { url = route.request().url().substring(0, 80); } catch (e) {}
    logger.warn(`[Handler] Recovering from error on ${url}: ${err.message}`);
    try { await route.abort('failed'); } catch (e) {}
  }

  async _safeFulfill(route, options) {
    try {
      await route.fulfill(options);
    } catch (err) {
      try { await route.abort('failed'); } catch (e) {}
    }
  }

  async _safeContinue(route) {
    try {
      await route.continue();
    } catch (err) {
      try { await route.abort('failed'); } catch (e) {}
    }
  }

  async _handle(route, request) {
    const method = request.method();
    const url = request.url();
    const resourceType = request.resourceType();

    if (method !== 'GET') {
      return this._safeContinue(route);
    }

    if (resourceType === 'document') {
      return this._safeContinue(route);
    }

    const reqHeaders = request.headers();
    if (reqHeaders['range']) {
      return this._safeContinue(route);
    }

    const cacheableTypes = new Set([
      'stylesheet', 'script', 'image', 'font', 'media', 'other', 'manifest'
    ]);
    if (!cacheableTypes.has(resourceType)) {
      return this._safeContinue(route);
    }

    const classification = classifyUrl(url, this.config, this.target);
    const canonicalKey = normalizeUrl(url, classification, this.config);

    // Cache HIT
    if (this.storage.has(canonicalKey)) {
      const cached = await this.storage.get(canonicalKey);
      if (cached) {
        const { body, meta } = cached;
        const headers = this._buildResponseHeaders(meta, 'HIT');
        this.report.recordHit(classification, resourceType, body.length, canonicalKey);
        logger.info(`[CDN-HIT] ${resourceType} ${classification} ${url.substring(0, 80)}`);
        return this._safeFulfill(route, { status: meta.status, headers, body });
      }
    }

    // Inflight dedup
    if (this.inflight.has(canonicalKey)) {
      try {
        await this.inflight.get(canonicalKey);
        const cached = await this.storage.get(canonicalKey);
        if (cached) {
          const headers = this._buildResponseHeaders(cached.meta, 'HIT');
          this.report.recordHit(classification, resourceType, cached.body.length, canonicalKey);
          return this._safeFulfill(route, { status: cached.meta.status, headers, body: cached.body });
        }
      } catch (e) {}
      return this._safeContinue(route);
    }

    // Fetch from origin
    let inflightResolve, inflightReject;
    const inflightPromise = new Promise((res, rej) => {
      inflightResolve = res;
      inflightReject = rej;
    });
    this.inflight.set(canonicalKey, inflightPromise);

    try {
      const response = await route.fetch();
      const status = response.status();
      const body = await response.body();

      // Only cache 200 OK
      if (status !== 200) {
        const passHeaders = this._filterHeaders(response.headers());
        this.report.recordMiss(classification, resourceType, body.length);
        inflightResolve();
        this.inflight.delete(canonicalKey);
        return this._safeFulfill(route, {
          status,
          headers: { ...passHeaders, 'x-edge-cache': 'BYPASS' },
          body
        });
      }

      // Skip caching empty bodies (tracking pixels, beacons)
      if (body.length === 0) {
        inflightResolve();
        this.inflight.delete(canonicalKey);
        return this._safeFulfill(route, {
          status,
          headers: { ...this._filterHeaders(response.headers()), 'x-edge-cache': 'BYPASS-EMPTY' },
          body
        });
      }

      const respHeaders = response.headers();
      const cacheControl = (respHeaders['cache-control'] || '').toLowerCase();
      const hasSetCookie = !!respHeaders['set-cookie'];
      const isNoStore = cacheControl.includes('no-store') || cacheControl.includes('private');

      const forceCache = classification === 'ad';
      const shouldCache = forceCache || (!hasSetCookie && !isNoStore);

      if (shouldCache) {
        const safeHeaders = {};
        for (const [key, value] of Object.entries(respHeaders)) {
          if (!HOP_BY_HOP.has(key.toLowerCase())) {
            safeHeaders[key] = value;
          }
        }

        await this.storage.put(canonicalKey, body, {
          contentType: respHeaders['content-type'] || 'application/octet-stream',
          status,
          headers: safeHeaders,
          origin: classification,
          resourceType
        });

        const headers = this._buildResponseHeaders({ headers: safeHeaders, status, origin: classification }, 'MISS');
        this.report.recordMiss(classification, resourceType, body.length);
        logger.info(`[CACHED] ${resourceType} ${classification} ${url.substring(0, 80)}`);
        inflightResolve();
        this.inflight.delete(canonicalKey);
        return this._safeFulfill(route, { status, headers, body });
      }

      this.report.recordMiss(classification, resourceType, body.length);
      inflightResolve();
      this.inflight.delete(canonicalKey);
      return this._safeFulfill(route, {
        status,
        headers: { ...this._filterHeaders(respHeaders), 'x-edge-cache': 'BYPASS' },
        body
      });

    } catch (err) {
      // route.fetch() failed — TLS disconnect, network error, timeout, etc.
      inflightReject(err);
      this.inflight.delete(canonicalKey);
      logger.warn(`[Handler] Fetch failed for ${url.substring(0, 80)}: ${err.message}`);
      // IMPORTANT: after route.fetch() fails, route.continue() will also throw
      // Use route.abort() instead as safe cleanup
      try { await route.abort('failed'); } catch (abortErr) {}
    }
  }

  _buildResponseHeaders(meta, cacheStatus) {
    const originHeaders = meta.headers || {};
    const cacheControl = this._getCacheControl(meta);
    return {
      ...originHeaders,
      'x-edge-cache': cacheStatus,
      'x-cdn-pop': 'edge-local',
      'x-served-by': 'EdgeProxy/3.0',
      'x-cache-origin': meta.origin || 'unknown',
      'x-cached-at': new Date().toISOString(),
      'cache-control': cacheControl
    };
  }

  _getCacheControl(meta) {
    const origin = meta.origin || 'unknown';
    if (origin === 'self') return 'public, max-age=31536000, immutable';
    if (origin === 'ad') return 'public, max-age=3600';
    return 'public, max-age=86400';
  }

  _filterHeaders(headers) {
    const result = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && v !== null && !HOP_BY_HOP.has(k.toLowerCase())) {
        result[k] = String(v);
      }
    }
    return result;
  }
}

module.exports = RequestHandler;
