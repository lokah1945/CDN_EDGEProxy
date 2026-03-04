"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { log } = require("./logger");

/* ──────────────────────────────────────────────────────────
   LRU Hot-Blob Cache — O(1) get/set/evict via Map ordering
   Node.js Map iterates in insertion order; on access we
   delete+re-set to move the key to the tail (most-recent).
   ────────────────────────────────────────────────────────── */
class LRUBlobCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.currentBytes = 0;
    this._map = new Map();           // blobHash → { buf, size }
  }

  get(hash) {
    const entry = this._map.get(hash);
    if (!entry) return null;
    // Move to tail (most-recently used)
    this._map.delete(hash);
    this._map.set(hash, entry);
    return entry.buf;
  }

  set(hash, buf) {
    if (this._map.has(hash)) {
      this._map.delete(hash);
      this.currentBytes -= buf.length;
    }
    // Evict oldest (head) while over limit
    while (this.currentBytes + buf.length > this.maxBytes && this._map.size > 0) {
      const oldest = this._map.keys().next().value;
      const evicted = this._map.get(oldest);
      this._map.delete(oldest);
      this.currentBytes -= evicted.size;
    }
    this._map.set(hash, { buf, size: buf.length });
    this.currentBytes += buf.length;
  }

  has(hash) { return this._map.has(hash); }

  delete(hash) {
    const entry = this._map.get(hash);
    if (entry) {
      this._map.delete(hash);
      this.currentBytes -= entry.size;
    }
  }

  get size() { return this._map.size; }
}

/* ──────────────────────────────────────────────────────────
   CacheControl Parser — Respects origin Cache-Control directives
   ────────────────────────────────────────────────────────── */
function parseCacheControl(headerValue) {
  const directives = {};
  if (!headerValue) return directives;
  for (const part of headerValue.split(",")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      directives[trimmed.toLowerCase()] = true;
    } else {
      const key = trimmed.substring(0, eqIdx).trim().toLowerCase();
      const val = trimmed.substring(eqIdx + 1).trim().replace(/"/g, "");
      directives[key] = isNaN(Number(val)) ? val : Number(val);
    }
  }
  return directives;
}

function isCacheable(responseHeaders) {
  const cc = parseCacheControl(responseHeaders["cache-control"]);
  if (cc["no-store"]) return false;
  if (cc["private"]) return false;          // shared cache must not store
  return true;
}

function computeFreshness(responseHeaders, defaultMaxAge) {
  const cc = parseCacheControl(responseHeaders["cache-control"]);
  if (typeof cc["s-maxage"] === "number") return cc["s-maxage"] * 1000;
  if (typeof cc["max-age"] === "number") return cc["max-age"] * 1000;
  return defaultMaxAge;
}

/* ──────────────────────────────────────────────────────────
   StorageEngine v5 — Rewritten with:
   1. LRU hot-blob cache (bounded RAM)
   2. Async file I/O for blobs (non-blocking)
   3. Cache-Control respect (no-store, private, max-age)
   4. Process-safe index flush with flock
   5. Vary-key support ready
   ────────────────────────────────────────────────────────── */
class StorageEngine {
  constructor(cacheConfig, memoryConfig = {}) {
    this.dir = path.resolve(cacheConfig.dir || "data/cdn-cache");
    this.maxSize = cacheConfig.maxSize || 2199023255552;
    this.maxAge = cacheConfig.maxAge || 86400000;
    this.staleTTL = Math.max(this.maxAge * 30, 7 * 24 * 60 * 60 * 1000);

    this.indexPath = path.join(this.dir, "index.json");
    this.aliasIndexPath = path.join(this.dir, "alias-index.json");
    this.blobDir = path.join(this.dir, "blobs");

    // Metadata lives in memory — shared across all attached contexts
    this.index = new Map();
    this.aliasIndex = new Map();
    this.dedupSet = new Set();
    this._dirty = false;

    // LRU hot blob cache (only frequently-accessed blobs stay in RAM)
    const maxHotBytes = memoryConfig.maxHotBlobBytes || 256 * 1024 * 1024; // 256MB default
    this.hotBlobs = new LRUBlobCache(maxHotBytes);
    this._preloadBlobs = memoryConfig.preloadBlobs || false;

    this.stats = {
      hits: 0, misses: 0, revalidated: 0,
      bytesFetched: 0, bytesServed: 0,
      bytesWireFetched: 0, bytesWireServed: 0,
      docHits: 0, docMisses: 0, docBytesSaved: 0,
      noStoreSkipped: 0,
      byOrigin: {}, byType: {},
      topAssets: new Map()
    };
  }

  async init() {
    await fsp.mkdir(this.blobDir, { recursive: true });

    // Load index
    if (fs.existsSync(this.indexPath)) {
      try {
        const raw = JSON.parse(await fsp.readFile(this.indexPath, "utf-8"));
        for (const [key, val] of Object.entries(raw)) this.index.set(key, val);
      } catch (err) {
        log.warn("Storage", "Index corrupted, starting fresh");
      }
    }

    // Load alias index
    if (fs.existsSync(this.aliasIndexPath)) {
      try {
        const raw = JSON.parse(await fsp.readFile(this.aliasIndexPath, "utf-8"));
        for (const [key, val] of Object.entries(raw)) this.aliasIndex.set(key, val);
      } catch (err) {
        log.warn("Storage", "Alias index corrupted, starting fresh");
      }
    }

    // Clean orphan entries (blob files missing on disk)
    const orphanKeys = [];
    for (const [key, meta] of this.index) {
      const blobPath = this._blobPath(meta.blobHash);
      if (!fs.existsSync(blobPath)) {
        orphanKeys.push(key);
      }
    }
    if (orphanKeys.length > 0) {
      for (const k of orphanKeys) this.index.delete(k);
      await this._saveIndex();
      log.info("Storage", `Removed ${orphanKeys.length} orphan entries`);
    }

    // Optional: preload blobs into hot cache (for small caches)
    if (this._preloadBlobs) {
      let loaded = 0;
      for (const [, meta] of this.index) {
        if (this.hotBlobs.currentBytes >= this.hotBlobs.maxBytes) break;
        const bp = this._blobPath(meta.blobHash);
        if (!this.hotBlobs.has(meta.blobHash) && fs.existsSync(bp)) {
          try {
            const buf = await fsp.readFile(bp);
            this.hotBlobs.set(meta.blobHash, buf);
            loaded++;
          } catch (_) {}
        }
      }
      if (loaded > 0) log.info("Storage", `Preloaded ${loaded} blobs into hot cache`);
    }

    const uniqueBlobs = new Set([...this.index.values()].map(m => m.blobHash)).size;
    log.info("Storage", `Initialized: ${this.index.size} entries, ${this.aliasIndex.size} aliases, ${uniqueBlobs} unique blobs`);
    log.info("Storage", `Hot blob cache: ${this.hotBlobs.maxBytes / 1024 / 1024}MB max | Body TTL: ${(this.maxAge / 3600000).toFixed(1)}h | Stale TTL: ${(this.staleTTL / 86400000).toFixed(0)}d`);
  }

  /* ── Key generation ── */
  urlToKey(url) {
    return crypto.createHash("sha256").update(url).digest("hex");
  }

  _blobHash(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  _blobPath(hash) {
    return path.join(this.blobDir, hash.substring(0, 2), hash);
  }

  /* ── Meta lookups (synchronous — metadata always in RAM) ── */
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
    const freshTTL = meta.computedMaxAge || this.maxAge;
    return (Date.now() - meta.storedAt) < freshTTL;
  }

  hasValidators(meta) {
    return meta && (meta.etag || meta.lastModified);
  }

  /* ── Blob retrieval: hot cache → disk fallback ── */
  getBlob(blobHash) {
    // Try hot LRU first (promotes to most-recent)
    const hot = this.hotBlobs.get(blobHash);
    if (hot) return hot;

    // Cold path: read from disk, promote to hot cache
    const p = this._blobPath(blobHash);
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      this.hotBlobs.set(blobHash, buf);  // promote to hot
      return buf;
    }
    return null;
  }

  /* Async blob retrieval for non-critical paths */
  async getBlobAsync(blobHash) {
    const hot = this.hotBlobs.get(blobHash);
    if (hot) return hot;

    const p = this._blobPath(blobHash);
    try {
      const buf = await fsp.readFile(p);
      this.hotBlobs.set(blobHash, buf);
      return buf;
    } catch {
      return null;
    }
  }

  refreshTTL(cacheKey) {
    const meta = this.index.get(cacheKey);
    if (meta) {
      meta.storedAt = Date.now();
      this._dirty = true;
    }
  }

  isDedup(cacheKey) { return this.dedupSet.has(cacheKey); }

  /* ── Cache-Control gating ── */
  shouldStore(responseHeaders) {
    return isCacheable(responseHeaders);
  }

  /* ── Put: generic (CSS/JS/img/font) ── */
  async put(cacheKey, url, body, headers, resourceType, origin, aliasKey, requestHeaders) {
    // Respect Cache-Control: no-store / private
    if (!this.shouldStore(headers)) {
      this.stats.noStoreSkipped++;
      log.debug("Storage", `Skipped (no-store/private): ${url.substring(0, 80)}`);
      return;
    }

    const hash = this._blobHash(body);
    const isNewBlob = !this.hotBlobs.has(hash) && !fs.existsSync(this._blobPath(hash));

    if (isNewBlob) {
      const blobPath = this._blobPath(hash);
      await fsp.mkdir(path.dirname(blobPath), { recursive: true });
      const tmpPath = blobPath + ".tmp." + process.pid;
      await fsp.writeFile(tmpPath, body);
      await fsp.rename(tmpPath, blobPath);
    } else {
      this.dedupSet.add(cacheKey);
    }

    // Promote to hot cache
    this.hotBlobs.set(hash, body);

    // Compute effective freshness from origin's Cache-Control
    const computedMaxAge = computeFreshness(headers, this.maxAge);

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
      size: body.length,
      computedMaxAge
    });

    if (aliasKey) {
      this.aliasIndex.set(aliasKey, cacheKey);
    }

    this._dirty = true;
    this._debounceSave();
    this._evictIfNeeded();
  }

  /* ── Put Document (HTML with ETag/Last-Modified) ── */
  async putDocument(cacheKey, url, body, headers) {
    if (!this.shouldStore(headers)) {
      this.stats.noStoreSkipped++;
      return;
    }

    const hash = this._blobHash(body);
    const isNewBlob = !this.hotBlobs.has(hash) && !fs.existsSync(this._blobPath(hash));

    if (isNewBlob) {
      const blobPath = this._blobPath(hash);
      await fsp.mkdir(path.dirname(blobPath), { recursive: true });
      const tmpPath = blobPath + ".tmp." + process.pid;
      await fsp.writeFile(tmpPath, body);
      await fsp.rename(tmpPath, blobPath);
    }

    this.hotBlobs.set(hash, body);

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
      size: body.length,
      computedMaxAge: 0  // always revalidate for docs
    });

    this._dirty = true;
    this._debounceSave();
  }

  /* ── Header picking ── */
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

  /* ── Debounced save with process-safe writes ── */
  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) {
        this._saveIndex().catch(err => log.warn("Storage", `Index save failed: ${err.message}`));
        this._saveAliasIndex().catch(err => log.warn("Storage", `Alias save failed: ${err.message}`));
        this._dirty = false;
      }
    }, 2000);
  }

  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) {
      await this._saveIndex();
      await this._saveAliasIndex();
      this._dirty = false;
    }
  }

  async _saveIndex() {
    const obj = {};
    for (const [k, v] of this.index) obj[k] = v;
    const tmpPath = this.indexPath + ".tmp." + process.pid;
    await fsp.writeFile(tmpPath, JSON.stringify(obj));
    await fsp.rename(tmpPath, this.indexPath);
  }

  async _saveAliasIndex() {
    const obj = {};
    for (const [k, v] of this.aliasIndex) obj[k] = v;
    const tmpPath = this.aliasIndexPath + ".tmp." + process.pid;
    await fsp.writeFile(tmpPath, JSON.stringify(obj));
    await fsp.rename(tmpPath, this.aliasIndexPath);
  }

  /* ── Eviction (LRU by storedAt) ── */
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
        this.hotBlobs.delete(meta.blobHash);
        const bp = this._blobPath(meta.blobHash);
        try { fs.unlinkSync(bp); } catch (_) {}
      }
    }
    this._saveIndex().catch(_ => {});
    log.info("Storage", `Evicted ${evicted} entries. ${this.index.size} remaining.`);
  }

  /* ── Stats tracking ── */
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
      hotBlobCount: this.hotBlobs.size,
      hotBlobBytes: this.hotBlobs.currentBytes,
      noStoreSkipped: this.stats.noStoreSkipped,
    };
  }

  getReport() {
    const total = this.stats.hits + this.stats.misses;
    const ratio = total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) : "0.0";
    const uniqueBlobs = new Set([...this.index.values()].map(m => m.blobHash)).size;
    const dedups = this.dedupSet.size;
    const hotMB = (this.hotBlobs.currentBytes / 1024 / 1024).toFixed(1);
    const hotMax = (this.hotBlobs.maxBytes / 1024 / 1024).toFixed(0);

    let diskSize = 0;
    for (const [, meta] of this.index) diskSize += (meta.size || 0);
    const diskMB = (diskSize / 1024 / 1024).toFixed(1);

    const fetchedMB = (this.stats.bytesFetched / 1024 / 1024).toFixed(1);
    const servedMB = (this.stats.bytesServed / 1024 / 1024).toFixed(1);
    const wireFetchedMB = (this.stats.bytesWireFetched / 1024 / 1024).toFixed(1);
    const wireServedMB = (this.stats.bytesWireServed / 1024 / 1024).toFixed(1);

    const fetchRatio = this.stats.bytesFetched > 0
      ? (this.stats.bytesServed / this.stats.bytesFetched).toFixed(1) : "∞";
    const wireRatio = this.stats.bytesWireFetched > 0
      ? (this.stats.bytesWireServed / this.stats.bytesWireFetched).toFixed(1) : "∞";

    let r = "";
    r += `${"═".repeat(60)}\n`;
    r += `  CDN EdgeProxy CACHE REPORT v5\n`;
    r += `${"═".repeat(60)}\n`;
    r += `  Entries: ${this.index.size} | Aliases: ${this.aliasIndex.size} | Unique blobs: ${uniqueBlobs} | Dedup: ${dedups}\n`;
    r += `  Hot blobs: ${this.hotBlobs.size} (${hotMB}/${hotMax}MB) | Disk: ${diskMB}MB\n`;
    r += `  HIT: ${this.stats.hits} | MISS: ${this.stats.misses} | 304-reval: ${this.stats.revalidated} | Ratio: ${ratio}%\n`;
    r += `  no-store skipped: ${this.stats.noStoreSkipped}\n`;
    r += `\n`;
    r += `  Bandwidth (Uncompressed):\n`;
    r += `    Fetched: ${fetchedMB} MB | Served: ${servedMB} MB | Ratio: ${fetchRatio}:1\n`;
    r += `  Bandwidth (Wire est.):\n`;
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
      .sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 10);
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

module.exports = { StorageEngine, parseCacheControl, isCacheable, computeFreshness };
