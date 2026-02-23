const log = require('../utils/logger');

// ViewportScanner — cari elemen ad di halaman secara GENERIC.

class ViewportScanner {
  constructor(labels = []) {
    this.labels = labels;
    this.genericPatterns = [
      'ad', 'ads', 'advert', 'banner', 'sponsor',
      'promo', 'dfp', 'gpt-ad', 'adsense', 'adsterra',
      'taboola', 'outbrain', 'mgid', 'revcontent'
    ];
  }

  async scan(page) {
    let totalFound = 0;

    for (const label of this.labels) {
      const count = await this._scanByKeyword(page, label);
      totalFound += count;
    }

    const iframeCount = await this._scanAdIframes(page);
    totalFound += iframeCount;

    for (const pattern of this.genericPatterns) {
      if (!this.labels.includes(pattern)) {
        const count = await this._scanByKeyword(page, pattern);
        totalFound += count;
      }
    }

    return totalFound;
  }

  async _scanByKeyword(page, keyword) {
    try {
      const selector = `[id*="${keyword}" i], [class*="${keyword}" i]`;
      const elements = await page.$$(selector);

      for (const el of elements) {
        await this._triggerElement(page, el);
      }

      return elements.length;
    } catch (_) {
      return 0;
    }
  }

  async _scanAdIframes(page) {
    try {
      const iframes = await page.$$('iframe');
      let count = 0;

      for (const iframe of iframes) {
        const src = await iframe.getAttribute('src').catch(() => null);
        if (src) {
          await this._triggerElement(page, iframe);
          count++;
        }
      }

      return count;
    } catch (_) {
      return 0;
    }
  }

  async _triggerElement(page, element) {
    try {
      await element.scrollIntoViewIfNeeded({ timeout: 2000 });
      const box = await element.boundingBox();
      if (box) {
        await page.mouse.move(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
      }
      await page.waitForTimeout(150);
    } catch (_) {}
  }
}

module.exports = ViewportScanner;
