'use strict';

class CacheReport {
  constructor(storage, handler) {
    this.storage = storage;
    this.handler = handler;
    this._startTime = Date.now();
  }

  print() {
    const s = this.storage.getStats();
    const r = this.handler.requestStats;
    const uptime = ((Date.now() - this._startTime) / 60000).toFixed(1);
    const hitRate = r.total > 0 ? ((r.cached / r.total) * 100).toFixed(1) : '0.0';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  LOCAL CDN REPORT  (uptime: ${uptime} min)`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`  Requests  : ${r.total} total, ${r.cached} cached, ${r.fetched} fetched, ${r.bypassed} bypass, ${r.aborted} aborted`);
    console.log(`  Revalidate: ${r.revalidated} × 304 (zero-bandwidth reuse)`);
    console.log(`  Hit Rate  : ${hitRate}%`);
    console.log(`  Storage   : ${s.entries} entries, ${s.uniqueBlobs} unique blobs, ${s.dedups} dedup hits`);
    console.log(`  Disk      : ${this._fmt(s.diskBytes)}`);
    console.log(`  Served    : ${this._fmt(s.bytesServed)} from local CDN`);
    console.log(`  Fetched   : ${this._fmt(s.bytesFetchedTotal)} total from internet`);
    console.log(`  Saved     : ${this._fmt(s.bytesServed)} bandwidth saved`);
    console.log(`  ─── By Origin ───`);
    for (const [name, o] of Object.entries(r.byOrigin)) {
      console.log(`  ${name.padEnd(12)} HIT ${String(o.hit).padStart(5)}  MISS ${String(o.miss).padStart(5)}  Saved ${this._fmt(o.saved).padStart(9)}  Fetched ${this._fmt(o.fetched).padStart(9)}`);
    }
    console.log(`${'═'.repeat(60)}\n`);
  }

  _fmt(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
}

module.exports = { CacheReport };
