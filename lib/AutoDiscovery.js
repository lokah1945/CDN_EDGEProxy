const logger = require('./utils/logger');

class AutoDiscovery {
  constructor(config, target) {
    this.config = config;
    this.target = target;
    this.targetOrigins = { self: new Set(), ad: new Set(), thirdparty: new Set() };
    this._initPatterns();
  }

  _initPatterns() {
    this.adPatterns = this.config.adNetworks.map(pattern => {
      const escaped = pattern.replace(/\./g, '\\.');
      return new RegExp('(^|\\.)' + escaped + '$', 'i');
    });
    this.selfPatterns = this.target.domains.map(d => {
      if (d.startsWith('*.')) {
        const base = d.slice(2).replace(/\./g, '\\.');
        return new RegExp('(^|\\.)' + base + '$', 'i');
      }
      const escaped = d.replace(/\./g, '\\.');
      return new RegExp('^' + escaped + '$', 'i');
    });
  }

  classify(hostname) {
    for (const pat of this.selfPatterns) { if (pat.test(hostname)) return 'self'; }
    for (const pat of this.adPatterns) { if (pat.test(hostname)) return 'ad'; }
    return 'thirdparty';
  }

  async discover(page) {
    try {
      await page.waitForTimeout(3000);
      const urls = await page.evaluate(() => {
        return performance.getEntriesByType('resource').map(e => e.name);
      });
      for (const url of urls) {
        try {
          const hostname = new URL(url).hostname;
          const cls = this.classify(hostname);
          this.targetOrigins[cls].add(hostname);
        } catch (e) {}
      }
      logger.info(`[Discovery:${this.target.id}] Found: self=${this.targetOrigins.self.size}, ad=${this.targetOrigins.ad.size}, thirdparty=${this.targetOrigins.thirdparty.size}`);
    } catch (err) {
      logger.warn(`[Discovery:${this.target.id}] Error: ${err.message}`);
    }
  }
}

module.exports = AutoDiscovery;
