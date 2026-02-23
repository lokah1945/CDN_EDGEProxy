const log = require('../utils/logger');

// CacheReport — tampilkan bukti bahwa website target dilayani oleh cache kita.
// Menampilkan statistik cache hit/miss, breakdown per tipe, dan top cached URLs.

class CacheReport {
  static printReport(targetId, handler, storage, discovery) {
    const stats = handler.stats;
    const total = stats.served + stats.cached + stats.passthrough;
    const cacheHitRate = total > 0
      ? ((stats.served / (stats.served + stats.cached)) * 100).toFixed(1)
      : '0.0';

    log.info('');
    log.info(`====================================================`);
    log.info(` CACHE REPORT — Target: ${targetId}`);
    log.info(`====================================================`);
    log.info(` Total requests intercepted : ${total}`);
    log.info(` Served from CACHE (RAM)    : ${stats.served}  <<< BUKTI CDN`);
    log.info(` Fetched & cached (new)     : ${stats.cached}`);
    log.info(` Passthrough (document/xhr) : ${stats.passthrough}`);
    log.info(` Cache Hit Rate             : ${cacheHitRate}%`);
    log.info(` ${storage.stats()}`);
    log.info(`----------------------------------------------------`);

    // Breakdown per classification
    const breakdown = { self: 0, ad: 0, thirdparty: 0, unknown: 0 };
    const typeBytes = { self: 0, ad: 0, thirdparty: 0, unknown: 0 };
    const resBreakdown = {};

    for (const [, entry] of storage.ram) {
      const cls = entry.classification || 'unknown';
      const rt = entry.resourceType || 'other';

      if (breakdown[cls] !== undefined) {
        breakdown[cls]++;
        if (entry.body) typeBytes[cls] += entry.body.length;
      }

      if (!resBreakdown[rt]) resBreakdown[rt] = 0;
      resBreakdown[rt]++;
    }

    log.info(` Cache by origin type:`);
    log.info(`   [self]       ${breakdown.self} entries (${(typeBytes.self / 1024).toFixed(0)} KB) — target site assets via LOCAL CDN`);
    log.info(`   [ad]         ${breakdown.ad} entries (${(typeBytes.ad / 1024).toFixed(0)} KB) — ad network assets CACHED`);
    log.info(`   [thirdparty] ${breakdown.thirdparty} entries (${(typeBytes.thirdparty / 1024).toFixed(0)} KB)`);
    log.info(`   [unknown]    ${breakdown.unknown} entries (${(typeBytes.unknown / 1024).toFixed(0)} KB)`);
    log.info(`----------------------------------------------------`);

    log.info(` Cache by resource type:`);
    for (const [rt, count] of Object.entries(resBreakdown).sort((a, b) => b[1] - a[1])) {
      log.info(`   ${rt.padEnd(12)} : ${count} entries`);
    }
    log.info(`----------------------------------------------------`);

    // Top 10 cached URLs sebagai bukti
    const entries = [...storage.ram.values()]
      .sort((a, b) => (b.body ? b.body.length : 0) - (a.body ? a.body.length : 0))
      .slice(0, 10);

    if (entries.length > 0) {
      log.info(` Top 10 cached assets (by size):`);
      for (const e of entries) {
        const size = e.body ? (e.body.length / 1024).toFixed(1) : '0';
        const cls = (e.classification || '???').padEnd(10);
        const rt = (e.resourceType || '???').padEnd(10);
        log.info(`   [${cls}] [${rt}] ${size} KB — ${e.url || '(unknown)'}`);
      }
    }

    log.info(`====================================================`);
    log.info('');
  }
}

module.exports = CacheReport;
