const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = require('./utils/logger');

class WriteQueue {
  constructor(concurrency = 4) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.running++;
      fn().then(resolve).catch(reject).finally(() => {
        this.running--;
        this._drain();
      });
    }
  }
}

class StorageEngine {
  constructor(cacheConfig) {
    this.storagePath = path.resolve(cacheConfig.storagePath || './data/cachestorage');
    this.blobPath = path.join(this.storagePath, 'blobs');
    this.indexPath = path.join(this.storagePath, 'index');
    this.maxBytes = cacheConfig.maxBytes || 536870912;
    this.ramMaxBytes = cacheConfig.ramMaxBytes || 268435456;
    this.evictionPercent = cacheConfig.evictionPercent || 20;
    this.ttl = cacheConfig.ttl || 86400000;
    this.index = new Map();
    this.ramBlobs = new Map();
    this.ramBlobBytes = 0;
    this.totalDiskBytes = 0;
    this.writeQueue = new WriteQueue(cacheConfig.asyncWriteConcurrency || 4);
    this.stats = { hits: 0, misses: 0, bytesServed: 0, bytesFetched: 0, dedupeHits: 0 };
  }

  async initialize() {
    for (const dir of [this.storagePath, this.blobPath, this.indexPath]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    await this._warmUpMetadataOnly();
    logger.info(`[Storage] Initialized: ${this.index.size} entries, ${(this.totalDiskBytes / 1048576).toFixed(1)}MB on disk`);
  }

  async _warmUpMetadataOnly() {
    const files = fs.readdirSync(this.indexPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const metaStr = fs.readFileSync(path.join(this.indexPath, file), 'utf-8');
        const meta = JSON.parse(metaStr);
        if (Date.now() - meta.cachedAt > this.ttl) {
          await this._deleteDiskEntry(meta.canonicalKey, meta.hash);
          continue;
        }
        this.index.set(meta.canonicalKey, meta);
        this.totalDiskBytes += (meta.size || 0);
      } catch (e) {}
    }
  }

  _hashBody(body) {
    return crypto.createHash('sha256').update(body).digest('hex');
  }

  _indexFileKey(canonicalKey) {
    return crypto.createHash('md5').update(canonicalKey).digest('hex');
  }

  has(canonicalKey) {
    const meta = this.index.get(canonicalKey);
    if (!meta) return false;
    if (Date.now() - meta.cachedAt > this.ttl) {
      this.index.delete(canonicalKey);
      return false;
    }
    return true;
  }

  async get(canonicalKey) {
    const meta = this.index.get(canonicalKey);
    if (!meta) return null;
    if (Date.now() - meta.cachedAt > this.ttl) {
      this.index.delete(canonicalKey);
      return null;
    }
    let body = this.ramBlobs.get(meta.hash);
    if (!body) {
      const blobFile = path.join(this.blobPath, meta.hash + '.bin');
      try {
        body = await fsp.readFile(blobFile);
        this._putRamBlob(meta.hash, body);
      } catch (e) {
        logger.warn(`[Storage] Blob missing for ${canonicalKey}: ${meta.hash}`);
        this.index.delete(canonicalKey);
        return null;
      }
    } else {
      this.ramBlobs.delete(meta.hash);
      this.ramBlobs.set(meta.hash, body);
    }
    this.stats.hits++;
    this.stats.bytesServed += body.length;
    return { body, meta };
  }

  async put(canonicalKey, body, metadata) {
    const hash = this._hashBody(body);
    const size = body.length;
    const existing = this.index.get(canonicalKey);
    const blobExists = this._blobExistsOnDisk(hash);

    const meta = {
      canonicalKey, hash,
      contentType: metadata.contentType || 'application/octet-stream',
      status: metadata.status || 200,
      headers: metadata.headers || {},
      size, cachedAt: Date.now(),
      origin: metadata.origin || 'unknown',
      resourceType: metadata.resourceType || 'other'
    };

    if (blobExists && !existing) {
      this.stats.dedupeHits++;
      logger.info(`[Storage] DEDUP: ${canonicalKey.substring(0, 80)} -> same content as existing blob ${hash.substring(0, 12)}`);
    }

    this.index.set(canonicalKey, meta);
    this._putRamBlob(hash, body);
    this.stats.misses++;
    this.stats.bytesFetched += size;

    this.writeQueue.enqueue(async () => {
      if (!blobExists) {
        await fsp.writeFile(path.join(this.blobPath, hash + '.bin'), body);
        this.totalDiskBytes += size;
      }
      const indexKey = this._indexFileKey(canonicalKey);
      await fsp.writeFile(path.join(this.indexPath, indexKey + '.json'), JSON.stringify(meta));
    });

    if (this.totalDiskBytes > this.maxBytes) {
      await this._evict();
    }
  }

  _blobExistsOnDisk(hash) {
    return fs.existsSync(path.join(this.blobPath, hash + '.bin'));
  }

  _putRamBlob(hash, body) {
    if (this.ramBlobs.has(hash)) {
      this.ramBlobs.delete(hash);
      this.ramBlobs.set(hash, body);
      return;
    }
    while (this.ramBlobBytes + body.length > this.ramMaxBytes && this.ramBlobs.size > 0) {
      const oldest = this.ramBlobs.keys().next().value;
      const oldBuf = this.ramBlobs.get(oldest);
      this.ramBlobBytes -= oldBuf.length;
      this.ramBlobs.delete(oldest);
    }
    this.ramBlobs.set(hash, body);
    this.ramBlobBytes += body.length;
  }

  async _evict() {
    const entries = [...this.index.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    const removeCount = Math.ceil(entries.length * this.evictionPercent / 100);
    for (let i = 0; i < removeCount; i++) {
      const [key, meta] = entries[i];
      this.index.delete(key);
      await this._deleteDiskEntry(key, meta.hash);
    }
    logger.info(`[Storage] Evicted ${removeCount} entries. Total disk: ${(this.totalDiskBytes / 1048576).toFixed(1)}MB`);
  }

  async _deleteDiskEntry(canonicalKey, hash) {
    const indexKey = this._indexFileKey(canonicalKey);
    try { await fsp.unlink(path.join(this.indexPath, indexKey + '.json')); } catch (e) {}
    let otherRef = false;
    for (const [, meta] of this.index) {
      if (meta.hash === hash) { otherRef = true; break; }
    }
    if (!otherRef) {
      try {
        const blobFile = path.join(this.blobPath, hash + '.bin');
        const stat = await fsp.stat(blobFile).catch(() => null);
        if (stat) {
          this.totalDiskBytes -= stat.size;
          await fsp.unlink(blobFile);
        }
      } catch (e) {}
      if (this.ramBlobs.has(hash)) {
        this.ramBlobBytes -= this.ramBlobs.get(hash).length;
        this.ramBlobs.delete(hash);
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      indexSize: this.index.size,
      ramBlobCount: this.ramBlobs.size,
      ramBlobMB: (this.ramBlobBytes / 1048576).toFixed(1),
      diskMB: (this.totalDiskBytes / 1048576).toFixed(1),
      uniqueBlobs: new Set([...this.index.values()].map(m => m.hash)).size
    };
  }

  async shutdown() {
    logger.info('[Storage] Shutting down, waiting for pending writes...');
    await new Promise(resolve => {
      const check = () => {
        if (this.writeQueue.running === 0 && this.writeQueue.queue.length === 0) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
    logger.info('[Storage] All writes flushed.');
  }
}

module.exports = StorageEngine;
