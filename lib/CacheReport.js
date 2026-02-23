const logger = require('./utils/logger');

class CacheReport {
  constructor(storage, intervalSec = 30) {
    this.storage = storage;
    this.intervalSec = intervalSec;
    this.timer = null;
    this.classStats = {
      self: { hits: 0, misses: 0, bytesServed: 0, bytesFetched: 0 },
      ad: { hits: 0, misses: 0, bytesServed: 0, bytesFetched: 0 },
      thirdparty: { hits: 0, misses: 0, bytesServed: 0, bytesFetched: 0 }
    };
    this.typeStats = {};
    this.topAssets = new Map();
  }

  recordHit(classification, resourceType, bytes, canonicalKey) {
    const cls = this.classStats[classification] || this.classStats.thirdparty;
    cls.hits++;
    cls.bytesServed += bytes;
    if (!this.typeStats[resourceType]) this.typeStats[resourceType] = { hits: 0, misses: 0 };
    this.typeStats[resourceType].hits++;
    const asset = this.topAssets.get(canonicalKey) || { hits: 0, bytes: 0 };
    asset.hits++;
    asset.bytes += bytes;
    this.topAssets.set(canonicalKey, asset);
  }

  recordMiss(classification, resourceType, bytes) {
    const cls = this.classStats[classification] || this.classStats.thirdparty;
    cls.misses++;
    cls.bytesFetched += bytes;
    if (!this.typeStats[resourceType]) this.typeStats[resourceType] = { hits: 0, misses: 0 };
    this.typeStats[resourceType].misses++;
  }

  start() { this.timer = setInterval(() => this._printReport(), this.intervalSec * 1000); }
  stop() { if (this.timer) clearInterval(this.timer); }

  _printReport() {
    const s = this.storage.getStats();
    const d = '='.repeat(70);
    console.log('\n' + d);
    console.log('  EDGEPROXY v3.0.1 CACHE REPORT');
    console.log(d);
    const ratio = s.hits + s.misses > 0 ? ((s.hits / (s.hits + s.misses)) * 100).toFixed(1) : '0.0';
    console.log(`  Cache entries: ${s.indexSize} | Unique blobs: ${s.uniqueBlobs} | Dedup hits: ${s.dedupeHits}`);
    console.log(`  RAM blobs: ${s.ramBlobCount} (${s.ramBlobMB}MB) | Disk: ${s.diskMB}MB`);
    console.log(`  HIT: ${s.hits} | MISS: ${s.misses} | Ratio: ${ratio}%`);
    console.log(`  Bytes fetched (quota used): ${this._f(s.bytesFetched)}`);
    console.log(`  Bytes served from cache: ${this._f(s.bytesServed)}`);
    console.log(`  \x1b[32m>>> QUOTA SAVED: ${this._f(s.bytesServed)} <<<\x1b[0m`);
    console.log('\n  --- By Origin ---');
    for (const [cls, st] of Object.entries(this.classStats)) {
      if (st.hits + st.misses === 0) continue;
      console.log(`  ${cls.padEnd(12)} HIT:${String(st.hits).padStart(6)} MISS:${String(st.misses).padStart(6)} | Saved:${this._f(st.bytesServed).padStart(10)} Fetched:${this._f(st.bytesFetched).padStart(10)}`);
    }
    console.log('\n  --- By Resource Type ---');
    for (const [type, st] of Object.entries(this.typeStats)) {
      if (st.hits + st.misses === 0) continue;
      console.log(`  ${type.padEnd(12)} HIT:${String(st.hits).padStart(6)} MISS:${String(st.misses).padStart(6)}`);
    }
    const top = [...this.topAssets.entries()].sort((a, b) => b[1].hits - a[1].hits).slice(0, 10);
    if (top.length > 0) {
      console.log('\n  --- Top 10 Cached Assets ---');
      for (const [key, stat] of top) {
        const sk = key.length > 60 ? key.substring(0, 57) + '...' : key;
        console.log(`  ${String(stat.hits).padStart(4)}x ${this._f(stat.bytes).padStart(10)} ${sk}`);
      }
    }
    console.log(d + '\n');
  }

  _f(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }
}

module.exports = CacheReport;
