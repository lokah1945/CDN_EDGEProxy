'use strict';

const { chromium } = require('playwright');
const path = require('path');
const { ConfigParser } = require('./ConfigParser');
const { StorageEngine } = require('./StorageEngine');
const { RequestHandler } = require('./RequestHandler');
const { CacheReport } = require('./CacheReport');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
const CACHE_DIR = path.join(DATA_DIR, 'cachestorage');

class EdgeProxy {
  constructor(rawConfig, opts = {}) {
    this.config = ConfigParser.parse(rawConfig);
    this.headed = opts.headed || false;
    this.storage = null;
    this.handler = null;
    this.context = null;
    this.report = null;
  }

  async start() {
    const { targets, cache } = this.config;
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║     Local CDN Engine  v3.1.0         ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
    console.log(`  Targets  : ${targets.map(t => t.pattern).join(', ')}`);
    console.log(`  Max Size : ${(cache.maxBytes / 1024**3).toFixed(1)} GB`);
    console.log(`  Max Age  : ${(cache.maxAgeMs / 3600000).toFixed(1)} hours`);
    console.log(`  Cache Dir: ${CACHE_DIR}`);
    console.log(`  Profile  : ${PROFILE_DIR}\n`);

    // ── Storage ──
    this.storage = new StorageEngine(CACHE_DIR, cache);
    await this.storage.init();
    const stats = this.storage.getStats();
    console.log(`  Cache loaded: ${stats.entries} entries, ${stats.uniqueBlobs} blobs, ${(stats.diskBytes / 1024 / 1024).toFixed(1)} MB on disk\n`);

    // ── Handler ──
    this.handler = new RequestHandler(this.storage, targets, cache);

    // ── Report ──
    this.report = new CacheReport(this.storage, this.handler);

    // ── Browser ──
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: !this.headed,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
      ],
      viewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      bypassCSP: true,
    });

    // ── Route ALL requests ──
    await this.context.route('**/*', (route, request) => this.handler.handle(route, request));

    // ── Open targets ──
    const pages = this.context.pages();
    const startPage = pages[0] || await this.context.newPage();
    const firstTarget = targets[0]?.domain || 'kompas.com';
    await startPage.goto(`https://www.${firstTarget}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // ── Report interval ──
    this._reportTimer = setInterval(() => this.report.print(), 60000);

    // ── Graceful shutdown ──
    const shutdown = async () => {
      clearInterval(this._reportTimer);
      this.report.print();
      await this.storage.flush();
      await this.context.close().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log(`  ✓ Local CDN Engine running. Press Ctrl+C to stop.\n`);
  }
}

module.exports = { EdgeProxy };
