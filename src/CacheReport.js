"use strict";

class CacheReport {
  constructor(storage, handler) {
    this.storage = storage;
    this.handler = handler;
    this._startTime = Date.now();
  }

  print() {
    const s = this.storage.getStats ? this.storage.getStats() : {};
    const uptime = ((Date.now() - this._startTime) / 60000).toFixed(1);

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  LOCAL CDN REPORT  (uptime: ${uptime} min)`);
    console.log(`${"═".repeat(60)}`);
    console.log(`  Storage   : ${s.entries || 0} entries, ${s.uniqueBlobs || 0} unique blobs`);
    console.log(`${"═".repeat(60)}\n`);
  }
}

module.exports = { CacheReport };
