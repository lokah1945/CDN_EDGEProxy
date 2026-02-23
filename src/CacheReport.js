"use strict";

class CacheReport {
  constructor(storage) {
    this.storage = storage;
    this._startTime = Date.now();
  }

  print() {
    const s = this.storage.getStats ? this.storage.getStats() : {};
    const uptime = ((Date.now() - this._startTime) / 60000).toFixed(1);

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  CDN EdgeProxy REPORT  (uptime: ${uptime} min)`);
    console.log(`${"═".repeat(60)}`);
    console.log(`  Entries : ${s.entries || 0} | Aliases: ${s.aliases || 0} | Unique blobs: ${s.uniqueBlobs || 0}`);
    console.log(`  Disk    : ${((s.diskBytes || 0) / 1024 / 1024).toFixed(1)} MB`);
    console.log(`${"═".repeat(60)}\n`);
  }
}

module.exports = { CacheReport };
