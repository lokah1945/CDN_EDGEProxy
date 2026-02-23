"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { log } = require("./logger");

class StorageEngine {
  constructor(cacheConfig) {
    this.dir = path.resolve(cacheConfig.dir || "data/cdn-cache");
    this.maxSize = cacheConfig.maxSize || 2199023255552;
    this.maxAge = cacheConfig.maxAge || 86400000;

    // Stale TTL — validators survive much longer than body freshness.
    // Derived internally: max(maxAge * 30, 7 days). No .env change needed.
    this.staleTTL = Math.max(this.maxAge * 30, 7 * 24 * 60 * 60 * 1000);

    this.indexPath = path.join(this.dir, "index.json");
    this.aliasIndexPath = path.join(this.dir, "alias-index.json");
    this.blobDir = path.join(this.dir, "blobs");

    // In-memory index: cacheKey → meta
    this.index = new Map();
    // Alias index: aliasKey → cacheKey (for cross-cachebuster revalidation)
    this.aliasIndex = new Map();
    // In-memory blob cache: blobHash → Buffer
    this.blobs = new Map();
    // Dedup tracker
    this.dedupSet = new Set();

    // Stats
    this.stats = {
      hits: 0, misses: 0, revalidated: 0,
      bytesFetched: 0, bytesServed: 0,
      byOrigin: {},
      byType: {},
      topAssets: new Map()
    };
  }

  async init() {
    fs.mkdirSync(this.blobDir, { recursive: true });

    // Load main index
    if (fs.existsSync(this.indexPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
        for (const [key, val] of Object.entries(raw)) {
          this.index.set(key, val);
        }
      } catch (err) {
        log.warn("Storage", "Index corrupted, starting fresh");
      }
    }

    // Load alias index
    if (fs.existsSync(this.aliasIndexPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.aliasIndexPath, "utf-8"));
        for (const [key, val] of Object.entries(raw)) {
          this.aliasIndex.set(key, val);
        }
      } catch (err) {
        log.warn("Storage", "Alias index corrupted, starting fresh");
      }
    }

    // Pre-load blobs into RAM
    let diskSize = 0;
    for (const [, meta] of this.index) {
      const blobPath = this._blobPath(meta.blobHash);
      if (fs.existsSync(blobPath) && !this.blobs.has(meta.blobHash)) {
        const buf = fs.readFileSync(blobPath);
        this.blobs.set(meta.blobHash, buf);
        diskSize += buf.length;
      }
    }

    log.info("Storage", `Initialized: ${this.index.size} entries, ${this.aliasIndex.size} aliases, ${(diskSize / 1024 / 1024).toFixed(1)}MB on disk`);
    log.info("Storage", `Body TTL: ${(this.maxAge / 3600000).toFixed(1)}h | Stale validator TTL: ${(this.staleTTL / 86400000).toFixed(0)}d`);
  }

  urlToKey(url) {
    return crypto.createHash("sha256").update(url).digest("hex");
  }

  _blobHash(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  _blobPath(hash) {
    const shard = hash.substring(0, 2);
    return path.join(this.blobDir, shard, hash);
  }

  _totalRAMSize() {
    let total = 0;
    for (const [, buf] of this.blobs) total += buf.length;
    return total;
  }

  /**
   * peekMeta — NON-DESTRUCTIVE read. Never deletes stale entries.
   * Returns meta even if body TTL is expired (stale validators needed for 304).
   */
  peekMeta(cacheKey) {
    return this.index.get(cacheKey) || null;
  }

  /**
   * peekMetaAllowStale — returns meta if within staleTTL.
   * This is the key innovation: validators survive far beyond body freshness
   * so we can still send If-None-Match / If-Modified-Since and get 304s.
   */
  peekMetaAllowStale(cacheKey) {
    const meta = this.index.get(cacheKey);
    if (!meta) return null;
    const age = Date.now() - meta.storedAt;
    if (age < this.staleTTL) return meta;
    // Truly expired beyond stale TTL — clean up
    return null;
  }

  /**
   * Look up alias index to find a related cache entry for revalidation.
   * Returns meta from the alias's canonical key (if it has validators).
   */
  peekAlias(aliasKey) {
    if (!aliasKey) return null;
    const canonKey = this.aliasIndex.get(aliasKey);
    if (!canonKey) return null;
    return this.peekMetaAllowStale(canonKey);
  }

  /**
   * Check if body is fresh (within CACHE_MAX_AGE).
   */
  isFresh(meta) {
    if (!meta) return false;
    return (Date.now() - meta.storedAt) < this.maxAge;
  }

  /**
   * Check if meta has validators for conditional revalidation.
   */
  hasValidators(meta) {
    return meta && (meta.etag || meta.lastModified);
  }

  getBlob(blobHash) {
    if (this.blobs.has(blobHash)) return this.blobs.get(blobHash);
    const p = this._blobPath(blobHash);
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      this.blobs.set(blobHash, buf);
      return buf;
    }
    return null;
  }

  refreshTTL(cacheKey) {
    const meta = this.index.get(cacheKey);
    if (meta) {
      meta.storedAt = Date.now();
      this._saveIndex();
    }
  }

  isDedup(cacheKey) {
    return this.dedupSet.has(cacheKey);
  }

  getBlobHashShort(cacheKey) {
    const meta = this.index.get(cacheKey);
    return meta ? meta.blobHash.substring(0, 12) : "unknown";
  }

  async put(cacheKey, url, body, headers, resourceType, origin, aliasKey, requestHeaders) {
    const hash = this._blobHash(body);
    const isNewBlob = !this.blobs.has(hash);

    if (isNewBlob) {
      const blobPath = this._blobPath(hash);
      const dir = path.dirname(blobPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = blobPath + ".tmp." + process.pid;
      fs.writeFileSync(tmpPath, body);
      fs.renameSync(tmpPath, blobPath);
      this.blobs.set(hash, body);
    } else {
      this.dedupSet.add(cacheKey);
    }

    // Determine vary-aware key suffix
    const vary = headers["vary"] || null;

    this.index.set(cacheKey, {
      url,
      blobHash: hash,
      storedAt: Date.now(),
      headers: this._pickCacheHeaders(headers),
      etag: headers["etag"] || null,
      lastModified: headers["last-modified"] || null,
      vary: vary || null,
      resourceType,
      origin,
      size: body.length
    });

    // Register alias for cross-cachebuster revalidation
    if (aliasKey) {
      this.aliasIndex.set(aliasKey, cacheKey);
      this._saveAliasIndex();
    }

    this._saveIndex();
    this._evictIfNeeded();
  }

  /**
   * Pick safe headers for replay.
   * CRITICAL: Drop content-encoding & content-length.
   * Replaying these causes content corruption (Playwright decompresses bodies).
   */
  _pickCacheHeaders(headers) {
    const keep = [
      "content-type",
      "cache-control",
      "etag",
      "last-modified",
      "vary",
      "access-control-allow-origin",
      "access-control-allow-credentials",
      "access-control-allow-methods",
      "access-control-allow-headers",
      "access-control-expose-headers",
      "timing-allow-origin",
      "x-content-type-options",
    ];
    const result = {};
    for (const k of keep) {
      if (headers[k]) result[k] = headers[k];
    }
    // NEVER include content-encoding or content-length
    return result;
  }

  _saveIndex() {
    const obj = {};
    for (const [k, v] of this.index) obj[k] = v;
    const tmpPath = this.indexPath + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(obj));
    fs.renameSync(tmpPath, this.indexPath);
  }

  _saveAliasIndex() {
    const obj = {};
    for (const [k, v] of this.aliasIndex) obj[k] = v;
    const tmpPath = this.aliasIndexPath + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(obj));
    fs.renameSync(tmpPath, this.aliasIndexPath);
  }

  _evictIfNeeded() {
    let totalSize = 0;
    for (const [, meta] of this.index) totalSize += (meta.size || 0);
    if (totalSize <= this.maxSize) return;

    const entries = [...this.index.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
    while (totalSize > this.maxSize * 0.9 && entries.length > 0) {
      const [key, meta] = entries.shift();
      totalSize -= (meta.size || 0);
      this.index.delete(key);
      // Refcount-aware blob deletion
      const stillUsed = [...this.index.values()].some(m => m.blobHash === meta.blobHash);
      if (!stillUsed) {
        this.blobs.delete(meta.blobHash);
        const bp = this._blobPath(meta.blobHash);
        try { fs.unlinkSync(bp); } catch (_) {}
      }
    }
    this._saveIndex();
    log.info("Storage", `Eviction complete. ${this.index.size} entries remaining.`);
  }

  // --- Stats ---
  recordHit(url, resourceType, origin, bytes) {
    this.stats.hits++;
    this.stats.bytesServed += bytes;
    this._trackOrigin(origin, "hit", bytes);
    this._trackType(resourceType, "hit");
    this._trackTopAsset(url, bytes);
  }

  recordRevalidated(url, resourceType, origin, bytes) {
    this.stats.revalidated++;
    this.stats.hits++;
    this.stats.bytesServed += bytes;
    this._trackOrigin(origin, "hit", bytes);
    this._trackType(resourceType, "hit");
    this._trackTopAsset(url, bytes);
  }

  recordMiss(url, resourceType, origin, bytes) {
    this.stats.misses++;
    this.stats.bytesFetched += bytes;
    this._trackOrigin(origin, "miss", bytes);
    this._trackType(resourceType, "miss");
  }

  _trackOrigin(origin, hitOrMiss, bytes) {
    if (!this.stats.byOrigin[origin]) {
      this.stats.byOrigin[origin] = { hit: 0, miss: 0, saved: 0, fetched: 0 };
    }
    this.stats.byOrigin[origin][hitOrMiss]++;
    if (hitOrMiss === "hit") this.stats.byOrigin[origin].saved += bytes;
    else this.stats.byOrigin[origin].fetched += bytes;
  }

  _trackType(type, hitOrMiss) {
    if (!this.stats.byType[type]) this.stats.byType[type] = { hit: 0, miss: 0 };
    this.stats.byType[type][hitOrMiss]++;
  }

  _trackTopAsset(url, bytes) {
    const short = url.substring(0, 80);
    const cur = this.stats.topAssets.get(short) || { count: 0, bytes: 0 };
    cur.count++;
    cur.bytes += bytes;
    this.stats.topAssets.set(short, cur);
  }

  getReport() {
    const total = this.stats.hits + this.stats.misses;
    const ratio = total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) : "0.0";
    const uniqueBlobs = new Set([...this.index.values()].map(m => m.blobHash)).size;
    const dedups = this.dedupSet.size;
    const ramMB = (this._totalRAMSize() / 1024 / 1024).toFixed(1);

    let diskSize = 0;
    for (const [, meta] of this.index) diskSize += (meta.size || 0);
    const diskMB = (diskSize / 1024 / 1024).toFixed(1);

    let report = `Cache entries: ${this.index.size} | Aliases: ${this.aliasIndex.size} | Unique blobs: ${uniqueBlobs} | Dedup hits: ${dedups}\n`;
    report += `RAM blobs: ${this.blobs.size} (${ramMB}MB) | Disk: ${diskMB}MB\n`;
    report += `HIT: ${this.stats.hits} | MISS: ${this.stats.misses} | 304-revalidated: ${this.stats.revalidated} | Ratio: ${ratio}%\n`;
    report += `Bytes fetched (quota used): ${(this.stats.bytesFetched / 1024 / 1024).toFixed(1)} MB\n`;
    report += `Bytes served from cache: ${(this.stats.bytesServed / 1024 / 1024).toFixed(1)} MB\n`;
    report += `QUOTA SAVED: ${(this.stats.bytesServed / 1024 / 1024).toFixed(1)} MB\n`;

    report += `--- By Origin ---\n`;
    for (const [origin, s] of Object.entries(this.stats.byOrigin)) {
      report += `  ${origin}: HIT ${s.hit} | MISS ${s.miss} | Saved ${(s.saved / 1024 / 1024).toFixed(1)} MB | Fetched ${(s.fetched / 1024 / 1024).toFixed(1)} MB\n`;
    }

    report += `--- By Resource Type ---\n`;
    for (const [type, s] of Object.entries(this.stats.byType)) {
      report += `  ${type}: HIT ${s.hit} | MISS ${s.miss}\n`;
    }

    const topAssets = [...this.stats.topAssets.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 10);
    if (topAssets.length > 0) {
      report += `--- Top 10 Cached Assets ---\n`;
      for (const [url, info] of topAssets) {
        report += `  ${info.count}x ${(info.bytes / 1024).toFixed(1)} KB ${url}\n`;
      }
    }

    return report;
  }
}

module.exports = { StorageEngine };
