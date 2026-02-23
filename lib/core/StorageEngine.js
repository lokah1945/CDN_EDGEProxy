const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../utils/logger');

class StorageEngine {
  constructor(cacheConfig) {
    this.maxEntries = cacheConfig.maxEntries || 5000;
    this.evictionPercent = cacheConfig.evictionPercent || 20;
    this.ttlMs = cacheConfig.ttlMs || 86400000;
    this.diskPath = path.resolve(cacheConfig.diskPath || './data/cachestorage');
    this.ram = new Map();
  }

  async warmUp() {
    if (!fs.existsSync(this.diskPath)) {
      fs.mkdirSync(this.diskPath, { recursive: true });
    }

    const metaFiles = fs.readdirSync(this.diskPath).filter(f => f.endsWith('.meta.json'));
    let loaded = 0;

    for (const mf of metaFiles) {
      try {
        const metaPath = path.join(this.diskPath, mf);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

        if (Date.now() - meta.cachedAt > this.ttlMs) {
          this._removeDiskEntry(mf.replace('.meta.json', ''));
          continue;
        }

        const dataFile = path.join(this.diskPath, mf.replace('.meta.json', '.bin'));
        if (fs.existsSync(dataFile)) {
          meta.body = fs.readFileSync(dataFile);
          this.ram.set(meta.key, meta);
          loaded++;
        }
      } catch (err) {
        log.warn(`[Storage] Warm-up skip ${mf}: ${err.message}`);
      }
    }

    log.info(`[Storage] Warm-up complete - ${loaded} entries from disk`);
  }

  get(key) {
    const entry = this.ram.get(key);
    if (!entry) return null;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.ram.delete(key);
      this._removeDiskEntry(this._hash(key));
      return null;
    }

    return entry;
  }

  set(key, data) {
    if (this.ram.size >= this.maxEntries) {
      this._evict();
    }

    const entry = { ...data, key };
    this.ram.set(key, entry);
    this._writeDiskEntry(key, entry);
  }

  _evict() {
    const entries = [...this.ram.entries()]
      .sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    const removeCount = Math.ceil(this.ram.size * this.evictionPercent / 100);

    for (let i = 0; i < removeCount && i < entries.length; i++) {
      this.ram.delete(entries[i][0]);
      this._removeDiskEntry(this._hash(entries[i][0]));
    }

    log.info(`[Storage] Evicted ${removeCount} oldest entries`);
  }

  _writeDiskEntry(key, entry) {
    try {
      const hash = this._hash(key);
      const metaPath = path.join(this.diskPath, `${hash}.meta.json`);
      const dataPath = path.join(this.diskPath, `${hash}.bin`);

      const meta = { ...entry };
      const body = meta.body;
      delete meta.body;

      fs.writeFileSync(metaPath, JSON.stringify(meta));
      fs.writeFileSync(dataPath, body);
    } catch (err) {
      log.warn(`[Storage] Disk write failed: ${err.message}`);
    }
  }

  _removeDiskEntry(hash) {
    try {
      const mp = path.join(this.diskPath, `${hash}.meta.json`);
      const dp = path.join(this.diskPath, `${hash}.bin`);
      if (fs.existsSync(mp)) fs.unlinkSync(mp);
      if (fs.existsSync(dp)) fs.unlinkSync(dp);
    } catch (_) {}
  }

  _hash(key) {
    return crypto.createHash('md5').update(key).digest('hex');
  }

  async flushToDisk() {
    let count = 0;
    for (const [key, entry] of this.ram) {
      this._writeDiskEntry(key, entry);
      count++;
    }
    log.info(`[Storage] Flushed ${count} entries to disk`);
  }

  stats() {
    const ramSize = this.ram.size;
    let totalBytes = 0;
    for (const [, entry] of this.ram) {
      if (entry.body) totalBytes += entry.body.length;
    }
    return `RAM: ${ramSize} entries, ~${(totalBytes / 1024 / 1024).toFixed(2)} MB`;
  }
}

module.exports = StorageEngine;
