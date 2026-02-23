const logger = require('./utils/logger');

class ViewportScanner {
  constructor(config) {
    this.labels = config.viewportLabels || [];
    this.focusedPatterns = [
      'ad-slot', 'ad_slot', 'ad-container', 'ad_container',
      'ad-wrapper', 'ad_wrapper', 'adsense', 'adsterra',
      'gpt-ad', 'dfp', 'banner', 'sponsor',
      'ad-unit', 'ad_unit', 'adsbygoogle'
    ];
    this.maxPerKeyword = 30;
    this.minSize = 50;
  }

  async scan(page) {
    const allElements = new Set();
    let totalFound = 0;
    try {
      for (const label of this.labels) {
        totalFound += await this._scanKeyword(page, label, allElements);
      }
      for (const pattern of this.focusedPatterns) {
        totalFound += await this._scanKeyword(page, pattern, allElements);
      }
      totalFound += await this._scanIframes(page);
      logger.info(`[ViewportScan] Total ad elements found: ${totalFound}`);
    } catch (err) {
      logger.warn(`[ViewportScan] Error: ${err.message}`);
    }
  }

  async _scanKeyword(page, keyword, seen) {
    try {
      const selector = `[id*="${keyword}" i], [class*="${keyword}" i]`;
      const elements = await page.$$(selector);
      let count = 0;
      for (const el of elements.slice(0, this.maxPerKeyword)) {
        const box = await el.boundingBox();
        if (!box || box.width < this.minSize || box.height < this.minSize) continue;
        const id = await el.getAttribute('id') || '';
        const cls = await el.getAttribute('class') || '';
        const key = `${id}|${cls}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await el.scrollIntoViewIfNeeded().catch(() => {});
        count++;
      }
      return count;
    } catch (e) { return 0; }
  }

  async _scanIframes(page) {
    try {
      const iframes = await page.$$('iframe');
      let count = 0;
      for (const iframe of iframes.slice(0, 50)) {
        const src = await iframe.getAttribute('src') || '';
        if (src && /ad|sponsor|banner|doubleclick|googlesyndication/i.test(src)) {
          await iframe.scrollIntoViewIfNeeded().catch(() => {});
          count++;
        }
      }
      return count;
    } catch (e) { return 0; }
  }
}

module.exports = ViewportScanner;
