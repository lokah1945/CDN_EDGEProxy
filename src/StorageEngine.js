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
    this.staleTTL = Math.max(this.maxAge * 30, 7 * 24 * 60 * 60 * 1000);

    this.indexPath = path.join(this.dir, "index.json");
    this.aliasIndexPath = path.join(this.dir, "alias-index.json");
    this.blobDir = path.join(this.dir, "blobs");

    this.index = new Map();
    this.aliasIndex = new Map();
    this.blobs = new Map();
    this.dedupSet = new Set();
    this._dirty = false;

    this.stats = {
      hits: 0, misses: 0, revalidated: 0,
      bytesFetched: 0, bytesServed: 0,
      bytesWireFetched: 0,          // v4.1.1: compressed wire bytes
      bytesWireServed: 0,           // v4.1.1: estimated wire savings
      docHits: 0, docMisses: 0,    // v4.1.1: document-specific stats
      docBytesSaved: 0,             // v4.1.1: bytes saved by 304 doc hits
      byOrigin: {},
      byType: {},
      topAssets: new Map()
    };
  }

  async init() {
    fs.mkdirSync(this.blobDir, { recursive: true });

    if (fs.existsSync(this.indexPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
        for (const [key, val] of Object.entries(raw)) this.index.set(key, val);
      } catch (err) {
        log.warn("Storage", "Index corrupted, starting fresh");
      }
    }

    if (fs.existsSync(this.aliasIndexPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.aliasIndexPath, "utf-8"));
        for (const [key, val] of Object.entries(raw)) this.aliasIndex.set(key, val);
      } catch (err) {
        log.warn("Storage", "Alias index corrupted, starting fresh");
      }
    }

    // Pre-load blobs + remove orphan entries without blob file
    let diskSize = 0;
    const orphanKeys = [];
    for (const [key, meta] of this.index) {
      const blobPath = this._blobPath(meta.blobHash);
      if (fs.existsSync(blobPath)) {
        if (!this.blobs.has(meta.blobHash)) {
          const buf = fs.readFileSync(blobPath);
          this.blobs.set(meta.blobHash, buf);
          diskSize += buf.length;
        }
      } else {
        orphanKeys.push(key);
      }
    }
    if (orphanKeys.length > 0) {
      for (const k of orphanKeys) this.index.delete(k);
      this._saveIndex();
      log.info("Storage", `Removed ${orphanKeys.length} orphan entries (missing blob files)`);
    }

    const uniqueBlobs = new Set([...this.index.values()].map(m => m.blobHash)).size;
    log.info("Storage", `Initialized: ${this.index.size} entries, ${this.aliasIndex.size} aliases, ${uniqueBlobs} unique blobs, ${(diskSize / 1024 / 1024).toFixed(1)}MB`);
    log.info("Storage", `Body TTL: ${(this.maxAge / 3600000).toFixed(1)}h | Stale validator TTL: ${(this.staleTTL / 86400000).toFixed(0)}d`);
  }

  urlToKey(url) {
    return crypto.createHash("sha256").update(url).digest("hex");
  }

  _blobHash(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  _blobPath(hash) {
    return path.join(this.blobDir, hash.substring(0, 2), hash);
  }

  _totalRAMSize() {
    let total = 0;
    for (const [, buf] of this.blobs) total += buf.length;
    return total;
  }

  peekMeta(cacheKey) {
    return this.index.get(cacheKey) || null;
  }

  peekMetaAllowStale(cacheKey) {
    const meta = this.index.get(cacheKey);
    if (!meta) return null;
    const age = Date.now() - meta.storedAt;
    if (age < this.staleTTL) return meta;
    return null;
  }

  peekAlias(aliasKey) {
    if (!aliasKey) return null;
    const canonKey = this.aliasIndex.get(aliasKey);
    if (!canonKey) return null;
    return this.peekMetaAllowStale(canonKey);
  }

  isFresh(meta) {
    if (!meta) return false;
    return (Date.now() - meta.storedAt) < this.maxAge;
  }

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
      this._dirty = true;
    }
  }

  isDedup(cacheKey) {
    return this.dedupSet.has(cacheKey);
  }

  /* ── Put: generic (CSS/JS/img/font) ── */
  async put(cacheKey, url, body, headers, resourceType, origin, aliasKey, requestHeaders) {
    const hash = this._blobHash(body);
    const isNewBlob = !this.blobs.has(hash);

    if (isNewBlob) {
      const blobPath = this._blobPath(hash);
      fs.mkdirSync(path.dirname(blobPath), { recursive: true });
      const tmpPath = blobPath + ".tmp." + process.pid;
      fs.writeFileSync(tmpPath, body);
      fs.renameSync(tmpPath, blobPath);
      this.blobs.set(hash, body);
    } else {
      this.dedupSet.add(cacheKey);
    }

    this.index.set(cacheKey, {
      url,
      blobHash: hash,
      storedAt: Date.now(),
      headers: this._pickCacheHeaders(headers),
      etag: headers["etag"] || null,
      lastModified: headers["last-modified"] || null,
      vary: headers["vary"] || null,
      resourceType,
      origin,
      size: body.length
    });

    if (aliasKey) {
      this.aliasIndex.set(aliasKey, cacheKey);
    }

    this._dirty = true;
    this._debounceSave();
    this._evictIfNeeded();
  }

  /* ── v4.1.1: Put Document (HTML with ETag/Last-Modified) ── */
  async putDocument(cacheKey, url, body, headers) {
    const hash = this._blobHash(body);
    const isNewBlob = !this.blobs.has(hash);

    if (isNewBlob) {
      const blobPath = this._blobPath(hash);
      fs.mkdirSync(path.dirname(blobPath), { recursive: true });
      const tmpPath = blobPath + ".tmp." + process.pid;
      fs.writeFileSync(tmpPath, body);
      fs.renameSync(tmpPath, blobPath);
      this.blobs.set(hash, body);
    }

    this.index.set(cacheKey, {
      url,
      blobHash: hash,
      storedAt: Date.now(),
      headers: this._pickDocHeaders(headers),
      etag: headers["etag"] || null,
      lastModified: headers["last-modified"] || null,
      vary: headers["vary"] || null,
      resourceType: "document",
      origin: "document",
      size: body.length
    });

    this._dirty = true;
    this._debounceSave();
  }

  _pickDocHeaders(headers) {
    const keep = [
      "content-type", "cache-control", "etag", "last-modified", "vary",
      "access-control-allow-origin", "access-control-allow-credentials",
      "access-control-allow-methods", "access-control-allow-headers",
      "access-control-expose-headers", "x-content-type-options",
      "content-security-policy", "x-frame-options",
      "set-cookie", "link",
    ];
    const result = {};
    for (const k of keep) {
      if (headers[k]) result[k] = headers[k];
    }
    return result;
  }

  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) {
        this._saveIndex();
        this._saveAliasIndex();
        this._dirty = false;
      }
    }, 2000);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) {
      this._saveIndex();
      this._saveAliasIndex();
      this._dirty = false;
    }
  }

  _pickCacheHeaders(headers) {
    const keep = [
      "content-type", "cache-control", "etag", "last-modified", "vary",
      "access-control-allow-origin", "access-control-allow-credentials",
      "access-control-allow-methods", "access-control-allow-headers",
      "access-control-expose-headers", "timing-allow-origin",
      "x-content-type-options",
    ];
    const result = {};
    for (const k of keep) {
      if (headers[k]) result[k] = headers[k];
    }
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

    log.info("Storage", `Eviction triggered: ${(totalSize / 1024 / 1024).toFixed(1)}MB > ${(this.maxSize / 1024 / 1024).toFixed(1)}MB limit`);
    const entries = [...this.index.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);

    let evicted = 0;
    while (totalSize > this.maxSize * 0.9 && entries.length > 0) {
      const [key, meta] = entries.shift();
      totalSize -= (meta.size || 0);
      this.index.delete(key);
      evicted++;
      const stillUsed = [...this.index.values()].some(m => m.blobHash === meta.blobHash);
      if (!stillUsed) {
        this.blobs.delete(meta.blobHash);
        const bp = this._blobPath(meta.blobHash);
        try { fs.unlinkSync(bp); } catch (_) {}
      }
    }
    this._saveIndex();
    log.info("Storage", `Evicted ${evicted} entries. ${this.index.size} remaining.`);
  }

  /* ── Stats: generic assets ── */

  recordHit(url, resourceType, origin, bytes, wireBytes) {
    this.stats.hits++;
    this.stats.bytesServed += bytes;
    this.stats.bytesWireServed += (wireBytes || bytes);
    this._trackOrigin(origin, "hit", bytes);
    this._trackType(resourceType, "hit");
    this._trackTopAsset(url, bytes);
  }

  recordRevalidated(url, resourceType, origin, bytes, wireBytes) {
    this.stats.revalidated++;
    this.stats.hits++;
    this.stats.bytesServed += bytes;
    this.stats.bytesWireServed += (wireBytes || bytes);
    this._trackOrigin(origin, "hit", bytes);
    this._trackType(resourceType, "hit");
    this._trackTopAsset(url, bytes);
  }

  recordMiss(url, resourceType, origin, bytes, wireBytes) {
    this.stats.misses++;
    this.stats.bytesFetched += bytes;
    this.stats.bytesWireFetched += (wireBytes || bytes);
    this._trackOrigin(origin, "miss", bytes);
    this._trackType(resourceType, "miss");
  }

  /* ── v4.1.1: Stats: document cache ── */

  recordDocHit(url, bytes) {
    this.stats.docHits++;
    this.stats.docBytesSaved += bytes;
    this.stats.bytesServed += bytes;
    this._trackType("document", "hit");
  }

  recordDocMiss(url, bytes, wireBytes) {
    this.stats.docMisses++;
    this.stats.bytesFetched += bytes;
    this.stats.bytesWireFetched += (wireBytes || bytes);
    this._trackType("document", "miss");
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
    const short = url.substring(0, 120);
    const cur = this.stats.topAssets.get(short) || { count: 0, bytes: 0 };
    cur.count++;
    cur.bytes += bytes;
    this.stats.topAssets.set(short, cur);
  }

  getStats() {
    const uniqueBlobs = new Set([...this.index.values()].map(m => m.blobHash)).size;
    let diskBytes = 0;
    for (const [, meta] of this.index) diskBytes += (meta.size || 0);
    return {
      entries: this.index.size,
      aliases: this.aliasIndex.size,
      uniqueBlobs,
      diskBytes,
      dedupHits: this.dedupSet.size,
    };
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

    const fetchedMB = (this.stats.bytesFetched / 1024 / 1024).toFixed(1);
    const servedMB = (this.stats.bytesServed / 1024 / 1024).toFixed(1);
    const wireFetchedMB = (this.stats.bytesWireFetched / 1024 / 1024).toFixed(1);
    const wireServedMB = (this.stats.bytesWireServed / 1024 / 1024).toFixed(1);

    const fetchRatio = this.stats.bytesFetched > 0
      ? (this.stats.bytesServed / this.stats.bytesFetched).toFixed(1)
      : "∞";
    const wireRatio = this.stats.bytesWireFetched > 0
      ? (this.stats.bytesWireServed / this.stats.bytesWireFetched).toFixed(1)
      : "∞";

    let r = "";
    r += `${"═".repeat(60)}\n`;
    r += `  CDN EdgeProxy CACHE REPORT\n`;
    r += `${"═".repeat(60)}\n`;
    r += `  Cache entries: ${this.index.size} | Aliases: ${this.aliasIndex.size} | Unique blobs: ${uniqueBlobs} | Dedup: ${dedups}\n`;
    r += `  RAM blobs: ${this.blobs.size} (${ramMB}MB) | Disk: ${diskMB}MB\n`;
    r += `  HIT: ${this.stats.hits} | MISS: ${this.stats.misses} | 304-reval: ${this.stats.revalidated} | Ratio: ${ratio}%\n`;
    r += `\n`;
    r += `  Bandwidth (Resource / Uncompressed):\n`;
    r += `    Fetched: ${fetchedMB} MB | Served: ${servedMB} MB | Ratio: ${fetchRatio}:1\n`;
    r += `  Bandwidth (Wire / Compressed est.):\n`;
    r += `    Fetched: ~${wireFetchedMB} MB | Served: ~${wireServedMB} MB | Ratio: ~${wireRatio}:1\n`;
    r += `\n`;
    r += `  Document Cache:\n`;
    r += `    DOC-HIT (304): ${this.stats.docHits} | DOC-MISS (200): ${this.stats.docMisses} | Saved: ${(this.stats.docBytesSaved / 1024 / 1024).toFixed(1)} MB\n`;

    r += `\n  --- By Origin ---\n`;
    for (const [origin, s] of Object.entries(this.stats.byOrigin)) {
      r += `    ${origin}: HIT ${s.hit} | MISS ${s.miss} | Saved ${(s.saved / 1024 / 1024).toFixed(1)} MB | Fetched ${(s.fetched / 1024 / 1024).toFixed(1)} MB\n`;
    }

    r += `  --- By Resource Type ---\n`;
    for (const [type, s] of Object.entries(this.stats.byType)) {
      r += `    ${type}: HIT ${s.hit} | MISS ${s.miss}\n`;
    }

    const topAssets = [...this.stats.topAssets.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 10);
    if (topAssets.length > 0) {
      r += `  --- Top 10 Cached Assets ---\n`;
      for (const [url, info] of topAssets) {
        r += `    ${info.count}x ${(info.bytes / 1024).toFixed(1)} KB ${url}\n`;
      }
    }

    r += `${"═".repeat(60)}`;
    return r;
  }
}

module.exports = { StorageEngine };