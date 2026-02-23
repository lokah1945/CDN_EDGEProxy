// ═══════════════════════════════════════════════════════════
// StorageEngine — Content-addressable blob store + index
// ═══════════════════════════════════════════════════════════
//
// - Shared across browsers (single cache dir)
// - Content-addressable: hash(body) → blob file
// - Index: canonicalURL → { status, headers, hash, size, cachedAt }
// - peekMeta: returns meta even if stale (for revalidation)
// - Atomic writes: temp → rename (safe for concurrent access)
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class StorageEngine {
  constructor(cacheConfig, logger) {
    this.cacheDir = path.resolve(cacheConfig.directory || './data/cdn-cache');
    this.blobDir = path.join(this.cacheDir, 'blobs');
    this.indexFile = path.join(this.cacheDir, 'index.json');
    this.maxSize = cacheConfig.maxSizeBytes || 2199023255552; // 2TB
    this.maxAge = cacheConfig.maxAgeMs || 86400000; // 24h
    this.logger = logger;
    this.index = {};
    this.totalSize = 0;
    this._dirty = false;
    this._flushTimer = null;
  }

  async init() {
    fs.mkdirSync(this.blobDir, { recursive: true });

    // Load existing index
    if (fs.existsSync(this.indexFile)) {
      try {
        const raw = fs.readFileSync(this.indexFile, 'utf8');
        this.index = JSON.parse(raw);
        this._recalcSize();
        this.logger.info(`Cache loaded: ${Object.keys(this.index).length} entries, ${this._humanSize(this.totalSize)}`);
      } catch (err) {
        this.logger.error(`Index corrupt, starting fresh: ${err.message}`);
        this.index = {};
      }
    }

    // Auto-flush index every 30s
    this._flushTimer = setInterval(() => this.flush(), 30000);
  }

  /**
   * peekMeta — Returns meta even if stale (crucial for revalidation).
   * Does NOT delete stale entries.
   */
  peekMeta(key) {
    return this.index[key] || null;
  }

  /**
   * isStale — Check if entry has exceeded maxAge
   */
  isStale(meta) {
    if (!meta || !meta.cachedAt) return true;
    return (Date.now() - meta.cachedAt) > this.maxAge;
  }

  /**
   * refreshTTL — Reset cachedAt to now (after successful 304)
   */
  refreshTTL(key) {
    if (this.index[key]) {
      this.index[key].cachedAt = Date.now();
      this._dirty = true;
    }
  }

  /**
   * getBlob — Read blob file by hash
   */
  async getBlob(hash) {
    if (!hash) return null;
    const blobPath = this._blobPath(hash);
    try {
      return fs.readFileSync(blobPath);
    } catch {
      return null;
    }
  }

  /**
   * put — Store meta + blob atomically
   */
  async put(key, meta, body) {
    const hash = meta.hash;
    const blobPath = this._blobPath(hash);

    // Atomic write: temp file → rename
    if (!fs.existsSync(blobPath)) {
      const tmpPath = blobPath + '.tmp.' + crypto.randomBytes(4).toString('hex');
      try {
        fs.writeFileSync(tmpPath, body);
        fs.renameSync(tmpPath, blobPath);
      } catch (err) {
        // Clean up temp on error
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        this.logger.error(`Blob write error: ${err.message}`);
        return;
      }
    }

    // Update index
    const oldMeta = this.index[key];
    if (oldMeta) {
      this.totalSize -= (oldMeta.size || 0);
    }

    // Store only safe headers in index
    const safeHeaders = this._pickHeaders(meta.headers);

    this.index[key] = {
      status: meta.status,
      headers: safeHeaders,
      hash: meta.hash,
      size: meta.size,
      cachedAt: meta.cachedAt || Date.now(),
    };
    this.totalSize += meta.size;
    this._dirty = true;

    // Eviction check
    if (this.totalSize > this.maxSize) {
      this._evict();
    }
  }

  /**
   * flush — Persist index to disk
   */
  async flush() {
    if (!this._dirty) return;
    const tmpIndex = this.indexFile + '.tmp.' + crypto.randomBytes(4).toString('hex');
    try {
      fs.writeFileSync(tmpIndex, JSON.stringify(this.index, null, 0));
      fs.renameSync(tmpIndex, this.indexFile);
      this._dirty = false;
      this.logger.debug(`Index flushed: ${Object.keys(this.index).length} entries`);
    } catch (err) {
      try { fs.unlinkSync(tmpIndex); } catch (_) {}
      this.logger.error(`Index flush error: ${err.message}`);
    }
  }

  // ── Private ──

  _blobPath(hash) {
    // Shard into 2-level dirs: ab/cd/abcdef...
    const shard1 = hash.substring(0, 2);
    const shard2 = hash.substring(2, 4);
    const dir = path.join(this.blobDir, shard1, shard2);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, hash);
  }

  _pickHeaders(headers) {
    // Only store headers useful for revalidation and serving
    const keep = [
      'content-type', 'etag', 'last-modified', 'cache-control',
      'access-control-allow-origin', 'access-control-allow-methods',
      'access-control-allow-headers', 'access-control-expose-headers',
      'vary', 'x-content-type-options',
    ];
    const picked = {};
    for (const k of keep) {
      if (headers[k]) picked[k] = headers[k];
    }
    return picked;
  }

  _recalcSize() {
    this.totalSize = 0;
    for (const key of Object.keys(this.index)) {
      this.totalSize += (this.index[key].size || 0);
    }
  }

  _evict() {
    // LRU eviction: remove oldest entries until under maxSize
    const entries = Object.entries(this.index)
      .sort((a, b) => (a[1].cachedAt || 0) - (b[1].cachedAt || 0));

    let removed = 0;
    while (this.totalSize > this.maxSize * 0.9 && entries.length > 0) {
      const [key, meta] = entries.shift();
      this.totalSize -= (meta.size || 0);
      // Try to remove blob (only if no other entry references it)
      const hashCount = Object.values(this.index).filter(m => m.hash === meta.hash).length;
      if (hashCount <= 1) {
        try { fs.unlinkSync(this._blobPath(meta.hash)); } catch (_) {}
      }
      delete this.index[key];
      removed++;
    }

    this._dirty = true;
    this.logger.info(`Evicted ${removed} entries, cache now: ${this._humanSize(this.totalSize)}`);
  }

  _humanSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)}MB`;
    return `${(bytes / 1073741824).toFixed(2)}GB`;
  }
}

module.exports = { StorageEngine };
