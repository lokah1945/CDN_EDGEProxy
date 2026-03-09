/**
 * CacheManager.js v5.4.1 — High-Performance HTTP Cache with Content Deduplication
 * 
 * CHANGELOG v5.4.1 (2026-03-10):
 * - BUG-009 FIX: Unhandled promise rejection in quickLookup fire-and-forget _decrementRef (added .catch handler)
 * - BUG-010 FIX: Infinite loop in _runEviction when allKeys array depleted before low watermark reached (added empty guard break)
 *
 * CHANGELOG v5.4 (2026-03-10):
 * - BUG-004 FIX: Atomic hash state management in storeBodyDedup (prevents duplicate writes)
 * - BUG-005 FIX: Safe unlink with error handling in _decrementRef (prevents orphan files)
 * - BUG-007 FIX: Correct orphan cleanup in getServeData (uses provided cacheKey)
 * - BUG-008 FIX: Debounced lastAccess batching (eliminates write contention on hot entries)
 * 
 * Features:
 * - Content-based deduplication (SHA-256 hash)
 * - Domain blacklist with wildcard support (v5.3+)
 * - TTL-based expiration
 * - LRU eviction with Redis-style sampling
 * - Request coalescing (prevent duplicate fetches)
 * - Bounded store queue (max 8 concurrent disk writes)
 * - Atomic disk writes (tmp → rename)
 * - Graceful shutdown with persistence
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AsyncLock = require('async-lock');
const pLimit = require('p-limit');

class CacheManager {
  static VERSION = "5.4.1";

  constructor() {
    // Directories
    this.sharedDir = path.join(__dirname, 'shared');
    this.bodiesDir = path.join(this.sharedDir, 'bodies');
    this.indexPath = path.join(this.sharedDir, 'index.json');
    this.statsPath = path.join(this.sharedDir, 'stats.json');

    // In-memory state
    this.entries = new Map(); // cacheKey → entry metadata
    this.hashMeta = new Map(); // hash → {size, refCount, state, createdAt, updatedAt}
    this.inFlight = new Map(); // cacheKey → Promise (request coalescing)
    this.domainPatterns = []; // compiled regex for skipDomains (v5.3)

    // Config defaults
    this.config = {
      maxBodySizeMB: 50,
      maxTotalSizeMB: 500,
      maxEntries: 50000,
      defaultTTL: 86400000, // 24h
      patternLearning: false,
      forceCache: true,
      dedup: true,
      selectiveResourceTypes: ['Image', 'Script', 'Stylesheet', 'Font'],
      onlyMethods: ['GET'],
      skipExtensions: ['.m3u8', '.mpd', '.ts', '.mp4', '.webm', '.mp3', '.m4a'],
      skipDomains: [], // v5.3
      bypassRequestHeaders: ['authorization', 'range'],
      bypassResponseHeaders: ['set-cookie'],
      bypassCacheControl: ['no-store', 'private'],
      honorImmutable: true,
      storeQueueConcurrency: 8,
      evictionHighWatermark: 0.90,
      evictionLowWatermark: 0.75,
      saveDebounceMs: 5000,
      maxSaveIntervalMs: 60000,
      singleProcessOnly: true
    };

    // Runtime state
    this.stats = {
      hits: 0,
      misses: 0,
      stores: 0,
      evictions: 0,
      coalesced: 0,
      bytesCached: 0,
      bytesServed: 0,
      startTime: Date.now()
    };

    this.dirty = false;
    this.saveTimer = null;
    this.lastSaveTime = 0;
    this.pendingStores = new Set();
    this.evictionRunning = false;
    this.storeQueue = null; // initialized in loadFromDisk

    // Locks
    this.keyLock = new AsyncLock({ maxPending: 200, timeout: 10000 });
    this.globalLock = new AsyncLock({ timeout: 15000 });

    // BUG-008 FIX: Debounced lastAccess batching (v5.4)
    this.lastAccessQueue = new Set(); // cacheKeys pending update
    this.lastAccessFlushInterval = 1000; // 1s batch
    this.lastAccessTimer = null;
  }

  /**
   * Load config + restore cache from disk
   */
  async loadFromDisk() {
    console.log(`[Cache] Initializing CacheManager v${CacheManager.VERSION}...`);

    // Ensure directories exist
    await fs.promises.mkdir(this.bodiesDir, { recursive: true });

    // Load config
    const configPath = path.join(__dirname, 'config.json');
    try {
      const configData = await fs.promises.readFile(configPath, 'utf-8');
      const userConfig = JSON.parse(configData);
      this.config = { ...this.config, ...userConfig };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[Cache] Config load failed, using defaults:', err.message);
      }
    }

    // Initialize store queue
    this.storeQueue = pLimit(this.config.storeQueueConcurrency);

    // Compile domain patterns (v5.3)
    this._compileDomainPatterns();

    // Load index
    try {
      const indexData = await fs.promises.readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(indexData);

      // Restore entries
      if (parsed.entries) {
        for (const [key, entry] of Object.entries(parsed.entries)) {
          this.entries.set(key, entry);
        }
      }

      // Restore hashMeta
      if (parsed.hashMeta) {
        for (const [hash, meta] of Object.entries(parsed.hashMeta)) {
          this.hashMeta.set(hash, meta);
        }
      } else if (this.entries.size > 0) {
        // Migration: rebuild hashMeta from entries
        this._rebuildHashMeta();
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[Cache] Index load failed:', err.message);
      }
    }

    // Cleanup expired + orphans
    await this._cleanupOnStartup();

    // Load stats
    try {
      const statsData = await fs.promises.readFile(this.statsPath, 'utf-8');
      const savedStats = JSON.parse(statsData);
      this.stats = { ...this.stats, ...savedStats, startTime: Date.now() };
    } catch (err) {
      // Stats not critical
    }

    const entriesCount = this.entries.size;
    const bodiesCount = this.hashMeta.size;
    const diskMB = (this.stats.bytesCached / (1024 * 1024)).toFixed(1);

    console.log(`[Cache] v${CacheManager.VERSION} Loaded: ${entriesCount} entries, ${bodiesCount} unique bodies, ${diskMB}MB disk`);
    console.log(`[Cache] Config: TTL=${this.config.defaultTTL / 1000}s, quota=${this.config.maxTotalSizeMB}MB`);
    console.log(`[Cache] Types: ${this.config.selectiveResourceTypes.join(', ')}`);
    console.log(`[Cache] Bypass: req=[${this.config.bypassRequestHeaders.join(',')}], res=[${this.config.bypassResponseHeaders.join(',')}], cc=[${this.config.bypassCacheControl.join(',')}]`);

    if (this.config.skipExtensions.length > 0 || this.domainPatterns.length > 0) {
      console.log(`[Cache] Blacklist: ext=[${this.config.skipExtensions.join(',')}], domains=${this.domainPatterns.length} patterns`);
    }

    console.log('[Cache] ✅ CacheManager ready');
  }

  /**
   * v5.3: Compile domain patterns into RegExp for fast matching
   */
  _compileDomainPatterns() {
    if (!this.config.skipDomains || this.config.skipDomains.length === 0) {
      return;
    }

    for (const pattern of this.config.skipDomains) {
      try {
        // Escape dots: . → \.
        let regexPattern = pattern.replace(/\./g, '\\.');

        // Convert wildcards: * → .+
        regexPattern = regexPattern.replace(/\*/g, '.+');

        // Anchor + case-insensitive
        const regex = new RegExp(`^${regexPattern}$`, 'i');

        this.domainPatterns.push({ pattern, regex });
      } catch (err) {
        console.warn(`[Cache] Invalid domain pattern: ${pattern}`, err.message);
      }
    }
  }

  /**
   * Migration helper: rebuild hashMeta from entries
   */
  _rebuildHashMeta() {
    const hashCounts = new Map();

    for (const entry of this.entries.values()) {
      if (entry.hash) {
        const count = hashCounts.get(entry.hash) || 0;
        hashCounts.set(entry.hash, count + 1);
      }
    }

    for (const [hash, refCount] of hashCounts) {
      const entry = Array.from(this.entries.values()).find(e => e.hash === hash);
      this.hashMeta.set(hash, {
        size: entry?.size || 0,
        refCount,
        state: 'ready',
        createdAt: entry?.cachedAt || Date.now(),
        updatedAt: Date.now()
      });
    }
  }

  /**
   * Cleanup expired entries + orphans on startup
   */
  async _cleanupOnStartup() {
    const now = Date.now();
    const toDelete = [];

    for (const [cacheKey, entry] of this.entries) {
      // Check TTL
      if (now - entry.cachedAt > entry.ttl) {
        toDelete.push(cacheKey);
        continue;
      }

      // Check body exists
      const bodyPath = path.join(this.bodiesDir, `${entry.hash}.bin`);
      try {
        await fs.promises.access(bodyPath);
      } catch {
        toDelete.push(cacheKey);
      }
    }

    for (const key of toDelete) {
      const entry = this.entries.get(key);
      this.entries.delete(key);
      if (entry) {
        await this._decrementRef(entry.hash);
      }
    }

    if (toDelete.length > 0) {
      console.log(`[Cache] Startup cleanup: ${toDelete.length} entries removed`);
      this._markDirty();
    }
  }

  /**
   * Build composite cache key
   */
  buildKey(url, method = 'GET', resourceType = 'unknown') {
    return `${method}|${resourceType}|${url}`;
  }

  /**
   * Quick synchronous lookup (no lock)
   */
  quickLookup(cacheKey) {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return { hit: false };
    }

    const now = Date.now();

    // Check TTL
    if (now - entry.cachedAt > entry.ttl) {
      this.entries.delete(cacheKey);
      this._decrementRef(entry.hash).catch(err => { console.warn('[Cache] decrementRef cleanup error:', err.message); }); // Fire-and-forget (async in v5.4)
      this._markDirty();
      return { hit: false };
    }

    // Check hash state
    const meta = this.hashMeta.get(entry.hash);
    if (!meta || meta.state !== 'ready') {
      return { hit: false };
    }

    // BUG-008 FIX: Queue for batched update (non-blocking)
    this.lastAccessQueue.add(cacheKey);

    // Start flush timer if not running
    if (!this.lastAccessTimer) {
      this.lastAccessTimer = setTimeout(() => {
        this._flushLastAccess();
        this.lastAccessTimer = null;
      }, this.lastAccessFlushInterval);
    }

    this.stats.bytesServed += entry.size;
    this.stats.hits++;

    return { hit: true, entry };
  }

  /**
   * Lookup with in-flight coalescing
   */
  async lookupOrWait(url, method = 'GET', resourceType = 'unknown') {
    const cacheKey = this.buildKey(url, method, resourceType);

    // Quick check
    const quick = this.quickLookup(cacheKey);
    if (quick.hit) {
      return quick;
    }

    // Check in-flight
    if (this.inFlight.has(cacheKey)) {
      await this.inFlight.get(cacheKey);
      this.stats.coalesced++;

      // Re-check after wait
      const recheck = this.quickLookup(cacheKey);
      if (recheck.hit) {
        return recheck;
      }
    }

    this.stats.misses++;
    return { hit: false, source: 'miss' };
  }

  /**
   * Get serve data (body + entry)
   */
  async getServeData(cacheKey) {
    const entry = this.entries.get(cacheKey);
    if (!entry) return null;

    const bodyPath = path.join(this.bodiesDir, `${entry.hash}.bin`);

    try {
      const body = await fs.promises.readFile(bodyPath);
      return { body, entry };
    } catch (err) {
      if (err.code === 'ENOENT') {
        // BUG-007 FIX: Body missing — cleanup THIS entry (use provided cacheKey)
        this.entries.delete(cacheKey); // ✅ Correct key
        await this._decrementRef(entry.hash);
        this._markDirty();
        console.warn(`[Cache] Orphan entry cleaned: ${cacheKey.substring(0, 80)} (body missing)`);
      }
      return null;
    }
  }

  /**
   * v5.3: Check if URL should be bypassed (extension or domain blacklist)
   */
  shouldBypassUrl(url) {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase();

      // Extension check
      for (const ext of this.config.skipExtensions) {
        if (pathname.endsWith(ext.toLowerCase())) {
          return { bypass: true, reason: `extension ${ext}` };
        }
      }

      // Domain check
      for (const { pattern, regex } of this.domainPatterns) {
        if (regex.test(hostname)) {
          return { bypass: true, reason: `domain matches ${pattern}` };
        }
      }

      return { bypass: false };
    } catch {
      // Invalid URL
      return { bypass: false };
    }
  }

  /**
   * Check if response should be bypassed
   */
  shouldBypassResponse(headers) {
    const lowerHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      lowerHeaders[key.toLowerCase()] = value;
    }

    // Check response headers
    for (const header of this.config.bypassResponseHeaders) {
      if (lowerHeaders[header.toLowerCase()]) {
        return true;
      }
    }

    // Check cache-control
    const cc = lowerHeaders['cache-control'] || '';
    for (const directive of this.config.bypassCacheControl) {
      if (cc.toLowerCase().includes(directive.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  /**
   * Analyze cacheability and extract TTL
   */
  analyzeCacheability(headers) {
    const cc = (headers['cache-control'] || '').toLowerCase();

    // Check immutable
    if (this.config.honorImmutable && cc.includes('immutable')) {
      return { ttl: 365 * 24 * 60 * 60 * 1000 }; // 1 year
    }

    // Extract max-age
    const maxAgeMatch = cc.match(/max-age=(\d+)/);
    if (maxAgeMatch) {
      return { ttl: parseInt(maxAgeMatch[1], 10) * 1000 };
    }

    // Parse Expires
    if (headers.expires) {
      const expiresDate = new Date(headers.expires);
      if (!isNaN(expiresDate)) {
        const ttl = expiresDate.getTime() - Date.now();
        if (ttl > 0) {
          return { ttl };
        }
      }
    }

    // Default
    return { ttl: this.config.defaultTTL };
  }

  /**
   * Clean headers (remove encoding-related)
   */
  cleanHeaders(headers) {
    const cleaned = { ...headers };
    delete cleaned['content-encoding'];
    delete cleaned['transfer-encoding'];
    delete cleaned['content-length'];
    return cleaned;
  }

  /**
   * BUG-004 FIX: Atomic hash state management
   * Entire check-set-write operation inside lock
   */
  async storeBodyDedup(hash, bodyBuffer) {
    await this.keyLock.acquire(`hash:${hash}`, async () => {
      const meta = this.hashMeta.get(hash);

      if (meta) {
        if (meta.state === 'ready') {
          meta.refCount++;
          meta.updatedAt = Date.now();
          return; // Dedup — no disk I/O
        }
        if (meta.state === 'writing') {
          // Another worker holds lock — shouldn't happen, but handle gracefully
          const waitStart = Date.now();
          while (this.hashMeta.get(hash)?.state === 'writing') {
            if (Date.now() - waitStart > 30000) {
              throw new Error(`[Cache] Hash ${hash} stuck in writing state`);
            }
            await new Promise(r => setTimeout(r, 100));
          }
          const finalMeta = this.hashMeta.get(hash);
          if (finalMeta?.state === 'ready') {
            finalMeta.refCount++;
            finalMeta.updatedAt = Date.now();
          }
          return;
        }
      }

      // New hash — write to disk (still inside lock)
      this.hashMeta.set(hash, {
        state: 'writing',
        size: bodyBuffer.length,
        refCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      const bodyPath = path.join(this.bodiesDir, `${hash}.bin`);
      const tmpPath = `${bodyPath}.tmp`;

      try {
        await fs.promises.writeFile(tmpPath, bodyBuffer);
        await fs.promises.rename(tmpPath, bodyPath);

        const finalMeta = this.hashMeta.get(hash);
        if (finalMeta) {
          finalMeta.state = 'ready';
          finalMeta.updatedAt = Date.now();
        }
      } catch (err) {
        // Cleanup on failure
        this.hashMeta.delete(hash);
        try { await fs.promises.unlink(tmpPath); } catch {}
        throw err;
      }
    });
  }

  /**
   * BUG-005 FIX: Safe unlink with error handling
   */
  async _decrementRef(hash) {
    const meta = this.hashMeta.get(hash);
    if (!meta) return;

    meta.refCount--;
    meta.updatedAt = Date.now();

    if (meta.refCount <= 0) {
      meta.state = 'deleting';
      const bodyPath = path.join(this.bodiesDir, `${hash}.bin`);

      try {
        await fs.promises.unlink(bodyPath);
        this.hashMeta.delete(hash);
        this.stats.bytesCached -= meta.size;
        this._markDirty();
      } catch (err) {
        if (err.code === 'ENOENT') {
          this.hashMeta.delete(hash);
          this.stats.bytesCached -= meta.size;
        } else {
          console.error(`[Cache] Failed to unlink ${hash}:`, err.message);
          meta.refCount = 0;
          meta.state = 'orphan';
        }
        this._markDirty();
      }
    }
  }

  /**
   * Store response to cache
   */
  async store(url, meta, bodyBuffer, responseHeaders, cacheKey = null) {
    if (!cacheKey) {
      cacheKey = this.buildKey(url, meta.method || 'GET', meta.resourceType || 'unknown');
    }

    return await this.keyLock.acquire(`store:${cacheKey}`, async () => {
      // v5.3: URL bypass check
      const urlBypass = this.shouldBypassUrl(url);
      if (urlBypass.bypass) {
        return { stored: false, reason: urlBypass.reason };
      }

      // Response bypass
      if (this.shouldBypassResponse(responseHeaders)) {
        return { stored: false, reason: 'response bypass' };
      }

      // Cacheability
      const { ttl } = this.analyzeCacheability(responseHeaders);

      // Size check
      const sizeMB = bodyBuffer.length / (1024 * 1024);
      if (sizeMB > this.config.maxBodySizeMB) {
        return { stored: false, reason: `size ${sizeMB.toFixed(1)}MB > ${this.config.maxBodySizeMB}MB` };
      }

      // Hash
      const hash = crypto.createHash('sha256').update(bodyBuffer).digest('hex');

      // Decrement old hash if updating
      const oldEntry = this.entries.get(cacheKey);
      if (oldEntry && oldEntry.hash !== hash) {
        await this._decrementRef(oldEntry.hash);
      }

      // Store body (dedup)
      await this.storeBodyDedup(hash, bodyBuffer);

      // Create entry
      const entry = {
        hash,
        statusCode: meta.statusCode || 200,
        headers: this.cleanHeaders(responseHeaders),
        size: bodyBuffer.length,
        cachedAt: Date.now(),
        ttl,
        lastAccess: Date.now(),
        resourceType: meta.resourceType || 'unknown',
        method: meta.method || 'GET'
      };

      this.entries.set(cacheKey, entry);
      this.stats.stores++;
      this.stats.bytesCached += bodyBuffer.length;
      this._markDirty();

      // Eviction check
      this._maybeEvict();

      return { stored: true, hash, size: bodyBuffer.length };
    });
  }

  /**
   * Enqueue store (bounded concurrency)
   */
  enqueueStore(url, meta, bodyBuffer, responseHeaders, cacheKey = null) {
    const promise = this.storeQueue(() => 
      this.store(url, meta, bodyBuffer, responseHeaders, cacheKey)
    );

    this.pendingStores.add(promise);
    promise.finally(() => this.pendingStores.delete(promise));

    return promise;
  }

  /**
   * Register in-flight request
   */
  registerInFlight(cacheKey, promise) {
    this.inFlight.set(cacheKey, promise);
    promise.finally(() => this.inFlight.delete(cacheKey));
  }

  /**
   * BUG-008 FIX: Flush batched lastAccess updates
   */
  _flushLastAccess() {
    if (this.lastAccessQueue.size === 0) return;

    const now = Date.now();
    let flushed = 0;

    for (const cacheKey of this.lastAccessQueue) {
      const entry = this.entries.get(cacheKey);
      if (entry) {
        entry.lastAccess = now;
        flushed++;
      }
    }

    this.lastAccessQueue.clear();

    if (flushed > 0) {
      this._markDirty();
    }
  }

  /**
   * Mark cache as dirty (debounced save)
   */
  _markDirty() {
    this.dirty = true;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveToDisk();
    }, this.config.saveDebounceMs);

    // Force save if too long
    const timeSinceLastSave = Date.now() - this.lastSaveTime;
    if (timeSinceLastSave > this.config.maxSaveIntervalMs) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveToDisk();
    }
  }

  /**
   * Save index to disk
   */
  async saveToDisk() {
    if (!this.dirty) return;

    await this.globalLock.acquire('save', async () => {
      const data = {
        version: CacheManager.VERSION,
        savedAt: Date.now(),
        entries: Object.fromEntries(this.entries),
        hashMeta: Object.fromEntries(this.hashMeta)
      };

      const tmpPath = `${this.indexPath}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2));
      await fs.promises.rename(tmpPath, this.indexPath);

      // Save stats
      await fs.promises.writeFile(this.statsPath, JSON.stringify(this.stats, null, 2));

      this.dirty = false;
      this.lastSaveTime = Date.now();
    });
  }

  /**
   * Maybe trigger eviction
   */
  _maybeEvict() {
    if (this.evictionRunning) return;

    const entryRatio = this.entries.size / this.config.maxEntries;
    const diskRatio = this.stats.bytesCached / (this.config.maxTotalSizeMB * 1024 * 1024);

    if (entryRatio > this.config.evictionHighWatermark || diskRatio > this.config.evictionHighWatermark) {
      setImmediate(() => this._runEviction());
    }
  }

  /**
   * Run LRU eviction (Redis-style sampling)
   */
  async _runEviction() {
    if (this.evictionRunning) return;
    this.evictionRunning = true;

    await this.globalLock.acquire('eviction', async () => {
      // Flush lastAccess before sampling
      this._flushLastAccess();

      const sampleSize = 100;
      const allKeys = Array.from(this.entries.keys());

      while (this.entries.size > this.config.maxEntries * this.config.evictionLowWatermark) {
        if (allKeys.length === 0) break;
        const sample = [];
        for (let i = 0; i < sampleSize && allKeys.length > 0; i++) {
          const idx = Math.floor(Math.random() * allKeys.length);
          sample.push(allKeys.splice(idx, 1)[0]);
        }

        sample.sort((a, b) => {
          const entryA = this.entries.get(a);
          const entryB = this.entries.get(b);
          return (entryA?.lastAccess || 0) - (entryB?.lastAccess || 0);
        });

        const toEvict = sample.slice(0, Math.ceil(sample.length * 0.25));

        for (const key of toEvict) {
          const entry = this.entries.get(key);
          if (entry) {
            this.entries.delete(key);
            await this._decrementRef(entry.hash);
            this.stats.evictions++;
          }
        }
      }

      this._markDirty();
    });

    this.evictionRunning = false;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('[Cache] Shutdown initiated...');

    // BUG-008 FIX: Flush pending lastAccess updates
    if (this.lastAccessTimer) {
      clearTimeout(this.lastAccessTimer);
      this.lastAccessTimer = null;
    }
    this._flushLastAccess();

    // Drain pending stores
    console.log(`[Cache] Draining ${this.pendingStores.size} pending stores...`);
    await Promise.allSettled(Array.from(this.pendingStores));

    // Clear timers
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // Final save
    if (this.dirty) {
      console.log('[Cache] Saving index...');
      await this.saveToDisk();
    }

    console.log('[Cache] ✅ CacheManager shutdown complete');
  }
}

// Export singleton
module.exports = new CacheManager();
