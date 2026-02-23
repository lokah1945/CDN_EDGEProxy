const { URL } = require('url');
const log = require('../utils/logger');

// AutoDiscovery — otomatis deteksi semua origin dari sebuah halaman.
// Gunakan domcontentloaded (bukan networkidle) agar tidak timeout
// di website berat seperti detik.com, kompas.com, tribunnews.com.

class AutoDiscovery {
  constructor(knownAdPatterns = []) {
    this.knownAdPatterns = knownAdPatterns.map(p => this._patternToRegex(p));
    this.knownAdRaw = new Set(knownAdPatterns);
    this.discoveredOrigins = new Map();
    this.targetOrigins = new Set();
  }

  async discoverFromPage(page, targetUrl, timeout) {
    const targetHost = new URL(targetUrl).hostname;
    const rootDomain = this._getRootDomain(targetHost);
    this.targetOrigins.add(targetHost);

    const collected = [];

    // Listen SEMUA request yang terjadi
    const listener = (req) => {
      try {
        const u = new URL(req.url());
        collected.push({
          hostname: u.hostname,
          resourceType: req.resourceType(),
          url: req.url()
        });
      } catch (_) {}
    };

    page.on('request', listener);

    // Gunakan domcontentloaded — JANGAN networkidle
    // Website berita punya polling/analytics terus-menerus, networkidle tak pernah tercapai
    log.info(`[AutoDiscovery] Loading ${targetUrl} (domcontentloaded)...`);
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeout || 60000
    });

    // Tunggu manual agar resource tambahan (images, ads, scripts) sempat load
    log.info(`[AutoDiscovery] Waiting for assets to load...`);
    await page.waitForTimeout(5000);

    // Scroll halaman untuk trigger lazy-loaded ads & images
    log.info(`[AutoDiscovery] Scrolling page to trigger lazy content...`);
    let scrollHeight;
    try {
      scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    } catch (_) {
      scrollHeight = 3000;
    }

    for (let y = 0; y < scrollHeight; y += 400) {
      try {
        await page.evaluate((sy) => window.scrollTo(0, sy), y);
        await page.waitForTimeout(250);
      } catch (_) {
        break;
      }
    }

    // Tunggu lagi setelah scroll agar semua lazy-loaded content ter-request
    await page.waitForTimeout(5000);

    // Scan iframes
    let iframeSrcs = [];
    try {
      iframeSrcs = await page.evaluate(() => {
        return [...document.querySelectorAll('iframe')].map(f => f.src).filter(Boolean);
      });
    } catch (_) {}

    for (const src of iframeSrcs) {
      try {
        const u = new URL(src);
        collected.push({ hostname: u.hostname, resourceType: 'iframe', url: src });
      } catch (_) {}
    }

    page.off('request', listener);

    // Klasifikasi semua hostname
    for (const item of collected) {
      const host = item.hostname;
      if (!host) continue;

      const isSameOrigin = host === targetHost || host.endsWith('.' + rootDomain);
      const isKnownAd = this._matchesAdPattern(host);

      let type;
      if (isSameOrigin) {
        type = 'self';
        this.targetOrigins.add(host);
      } else if (isKnownAd) {
        type = 'ad';
      } else {
        type = 'thirdparty';
      }

      if (!this.discoveredOrigins.has(host)) {
        this.discoveredOrigins.set(host, {
          type,
          count: 1,
          resourceTypes: new Set([item.resourceType]),
          firstSeen: Date.now()
        });
      } else {
        const entry = this.discoveredOrigins.get(host);
        entry.count++;
        entry.resourceTypes.add(item.resourceType);
      }
    }

    log.info(`[AutoDiscovery] === Discovery Results for ${targetUrl} ===`);
    log.info(`  Total requests captured : ${collected.length}`);
    log.info(`  Unique hosts found      : ${this.discoveredOrigins.size}`);
    log.info(`  Self origins            : ${[...this.targetOrigins].length}`);
    log.info(`  Ad origins              : ${this._countByType('ad')}`);
    log.info(`  Third-party origins     : ${this._countByType('thirdparty')}`);

    // Log discovered self origins
    for (const host of this.targetOrigins) {
      log.info(`  [self] ${host}`);
    }

    // Log discovered ad origins
    for (const [host, data] of this.discoveredOrigins) {
      if (data.type === 'ad') {
        log.info(`  [ad]   ${host} (${data.count} requests)`);
      }
    }

    return this.discoveredOrigins;
  }

  classify(hostname) {
    const entry = this.discoveredOrigins.get(hostname);
    if (entry) return entry.type;

    if (this._matchesAdPattern(hostname)) return 'ad';

    for (const tgt of this.targetOrigins) {
      const root = this._getRootDomain(tgt);
      if (hostname.endsWith('.' + root) || hostname === root) return 'self';
    }

    return 'unknown';
  }

  isCacheableType(resourceType) {
    const cacheable = new Set([
      'image', 'stylesheet', 'font', 'media', 'script', 'other'
    ]);
    return cacheable.has(resourceType);
  }

  isTransparentType(resourceType) {
    const passthrough = new Set(['document', 'xhr', 'fetch', 'websocket', 'eventsource']);
    return !passthrough.has(resourceType);
  }

  getDiscoveredCount() {
    return this.discoveredOrigins.size;
  }

  _countByType(type) {
    let c = 0;
    for (const [, v] of this.discoveredOrigins) {
      if (v.type === type) c++;
    }
    return c;
  }

  _matchesAdPattern(hostname) {
    for (const regex of this.knownAdPatterns) {
      if (regex.test(hostname)) return true;
    }
    return false;
  }

  _patternToRegex(pattern) {
    const escaped = pattern
      .replace(/[.]/g, '\\.')
      .replace(/[*]/g, '.+');
    return new RegExp('^' + escaped + '$');
  }

  _getRootDomain(hostname) {
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    const twoBack = parts.slice(-2).join('.');
    const knownSlds = ['co.id', 'com.br', 'co.uk', 'co.jp', 'com.au', 'co.in', 'com.sg'];
    if (knownSlds.includes(twoBack)) {
      return parts.slice(-3).join('.');
    }
    return twoBack;
  }

  exportDiscovered() {
    const result = {};
    for (const [host, data] of this.discoveredOrigins) {
      result[host] = {
        type: data.type,
        count: data.count,
        resourceTypes: [...data.resourceTypes]
      };
    }
    return result;
  }
}

module.exports = AutoDiscovery;
