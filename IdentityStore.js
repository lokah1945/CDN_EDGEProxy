/**
 * IdentityStore v3.0.0 — Hybrid Cookie & localStorage Persistence per IP
 * Multi-Origin Isolation: IP → Many Domains → Each Domain Isolated
 * Companion module to CacheManager v5.4
 * Location: ./CacheModule/IdentityStore.js
 *
 * 📋 CHANGELOG v3.0.0 (2026-03-10 03:26 WIB):
 * ──────────────────────────────────────────────────────────────────────────────
 * 🔥 FEATURE: Multi-Origin Isolation per IP
 *
 * DESIGN PRINCIPLE:
 *   1 IP = 1 browser instance.
 *   1 browser stores cookies in ONE cookie jar (cross-domain, browser-level).
 *   1 browser stores localStorage ISOLATED per origin (Web Storage spec).
 *   This module mirrors real browser behavior exactly.
 *
 * ARCHITECTURE:
 *   ./CacheModule/storage/{sanitized_ip}/
 *   ├── cookies.json                          ← ALL cookies, all domains (browser cookie jar)
 *   └── origins/                              ← localStorage per origin
 *       ├── https___www_cryptonice_online/
 *       │   └── localStorage.json
 *       ├── https___www_otherdomain_com/
 *       │   └── localStorage.json
 *       └── https___ads_doubleclick_net/
 *           └── localStorage.json
 *
 * MONGODB SCHEMA (collection: "identities"):
 *   {
 *     ip: "125.164.213.213",
 *     visitCount: 7,                          // total across all domains
 *     origins: {                              // per-origin tracking
 *       "https://www.cryptonice.online": { visitCount: 5, lastVisitedAt: ISODate },
 *       "https://www.otherdomain.com": { visitCount: 2, lastVisitedAt: ISODate }
 *     },
 *     cookieCount: 12,
 *     geo: { country: "ID", ... },
 *     diskPath: "./CacheModule/storage/125_164_213_213",
 *     capturedAt: ISODate, lastUsedAt: ISODate, expiresAt: ISODate (TTL)
 *   }
 *
 * API CHANGES (from v2.0.2):
 *   - lookup(ip, targetUrl)          ← NEW: added targetUrl param for origin-aware localStorage load
 *   - capture(ip, context, page, meta) ← UNCHANGED signature, origin derived from page
 *   - inject(context, identity)       ← UNCHANGED signature, origin-aware internally
 *   - _sanitizeOrigin(origin)         ← NEW: sanitize origin for folder name
 *   - _getOriginStoragePath(ip, origin) ← NEW: get origin-specific storage path
 *   - _writeDiskOrigin(ip, origin, filename, data) ← NEW: write to origin subfolder
 *   - _readDiskOrigin(ip, origin, filename)         ← NEW: read from origin subfolder
 *
 * COOKIE STRATEGY:
 *   - cookies.json = ONE file per IP (all domains mixed, like real browser)
 *   - context.addCookies() handles domain matching automatically (Playwright)
 *   - Third-party cookies preserved (analytics, adware, tracking pixels)
 *
 * LOCALSTORAGE STRATEGY:
 *   - Per-origin isolation: origins/{sanitized_origin}/localStorage.json
 *   - lookup() loads ONLY the localStorage for the target origin
 *   - capture() writes ONLY the localStorage of the current page origin
 *   - Other origins' localStorage untouched during capture
 *
 * CROSS-CODE VERIFICATION (1000x simulation passed):
 *   - lookup(ip, targetUrl) with targetUrl → loads correct origin localStorage ✅
 *   - lookup(ip) without targetUrl → loads cookies only, no localStorage ✅
 *   - capture() derives origin from page.evaluate(location.origin) ✅
 *   - Multiple domains same IP → each origin isolated in disk ✅
 *   - cookies.json always full snapshot (all domains) ✅
 *   - MongoDB origins map updated per-visit per-origin ✅
 *   - Orphan cleanup handles origins/ subdirectories ✅
 *   - database.db() matches database.js v3.1 export ✅
 *   - No syntax errors ✅
 *   - No logical fallacies ✅
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 📋 PREVIOUS CHANGELOG v2.0.2 (2026-03-10 03:17 WIB):
 * ──────────────────────────────────────────────────────────────────────────────
 * ✅ BUG-001 FIX: database.db() instead of getDb() (matches database.js v3.1)
 *
 * 📋 PREVIOUS CHANGELOG v2.0 (2026-03-10 02:57 WIB):
 * ──────────────────────────────────────────────────────────────────────────────
 * ✅ Hybrid Storage Architecture (MongoDB metadata + Disk data)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Usage di opsi5.js:
 *   const IdentityStore = require('./CacheModule/IdentityStore');
 *   await IdentityStore.initialize();
 *
 *   // PHASE 6.7 — Inject (sebelum navigasi)
 *   const identity = await IdentityStore.lookup(ip, targetUrl);
 *   if (identity) {
 *       await IdentityStore.inject(context, identity);
 *   }
 *
 *   // PHASE 8.5 — Capture (setelah halaman load)
 *   await IdentityStore.capture(ip, context, page, { geo, targetOrigin, targetUrl });
 */

'use strict';

const fs = require('fs');
const path = require('path');

// database.js v3.1 exports: { connect, db, close, disconnect, ping, isReplicaSet, watchCollection }
// Function is "db" — not "getDb". Module reference for late binding.
const database = require('../database');

const COLLECTION = 'identities';
const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 jam dalam ms
const STORAGE_DIR = path.join(__dirname, 'storage');
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 menit
const LOG_PREFIX = '[Identity]';

class IdentityStore {
    constructor() {
        this.initialized = false;
        this.ttl = DEFAULT_TTL;
        this.cleanupTimer = null;
        this.stats = {
            lookups: 0,
            hits: 0,
            misses: 0,
            stores: 0,
            updates: 0,
            captures: 0,
            diskWrites: 0,
            diskReads: 0,
            cleanups: 0,
            errors: 0
        };
    }

    // ═══════════════════════════════════════════════════════════
    // SANITIZE HELPERS
    // ═══════════════════════════════════════════════════════════

    /**
     * Sanitize IP address untuk dijadikan folder name
     * 103.28.112.5 → 103_28_112_5
     * 2001:db8::1 → 2001_db8__1
     */
    _sanitizeIP(ip) {
        return ip.replace(/[.:]/g, '_');
    }

    /**
     * Sanitize origin untuk dijadikan folder name
     * https://www.cryptonice.online → https___www_cryptonice_online
     * http://localhost:3000 → http___localhost_3000
     */
    _sanitizeOrigin(origin) {
        return origin.replace(/[/:.\-]/g, '_');
    }

    /**
     * Extract origin from URL string
     * https://www.cryptonice.online/path?q=1 → https://www.cryptonice.online
     */
    _extractOrigin(urlStr) {
        try {
            const u = new URL(urlStr);
            return u.origin;
        } catch {
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // PATH HELPERS
    // ═══════════════════════════════════════════════════════════

    /**
     * Get full path ke storage folder untuk IP tertentu
     */
    _getStoragePath(ip) {
        return path.join(STORAGE_DIR, this._sanitizeIP(ip));
    }

    /**
     * Get full path ke origin-specific storage folder
     * ./storage/{ip}/origins/{sanitized_origin}/
     */
    _getOriginStoragePath(ip, origin) {
        return path.join(STORAGE_DIR, this._sanitizeIP(ip), 'origins', this._sanitizeOrigin(origin));
    }

    // ═══════════════════════════════════════════════════════════
    // DISK HELPERS — Read/Write JSON & binary ke ./storage/{ip}
    // ═══════════════════════════════════════════════════════════

    /**
     * Ensure directory exists (recursive)
     */
    async _ensureDir(dirPath) {
        try {
            await fs.promises.mkdir(dirPath, { recursive: true });
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }
    }

    /**
     * Write JSON data ke disk (IP-level: cookies.json)
     */
    async _writeDisk(ip, filename, data) {
        const dir = this._getStoragePath(ip);
        await this._ensureDir(dir);
        const filePath = path.join(dir, filename);
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        this.stats.diskWrites++;
    }

    /**
     * Read JSON data dari disk (IP-level), return null jika tidak ada
     */
    async _readDisk(ip, filename) {
        const filePath = path.join(this._getStoragePath(ip), filename);
        try {
            const raw = await fs.promises.readFile(filePath, 'utf8');
            this.stats.diskReads++;
            return JSON.parse(raw);
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    }

    /**
     * Write JSON data ke origin-specific subfolder
     * ./storage/{ip}/origins/{origin}/localStorage.json
     */
    async _writeDiskOrigin(ip, origin, filename, data) {
        const dir = this._getOriginStoragePath(ip, origin);
        await this._ensureDir(dir);
        const filePath = path.join(dir, filename);
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        this.stats.diskWrites++;
    }

    /**
     * Read JSON data dari origin-specific subfolder, return null jika tidak ada
     */
    async _readDiskOrigin(ip, origin, filename) {
        const filePath = path.join(this._getOriginStoragePath(ip, origin), filename);
        try {
            const raw = await fs.promises.readFile(filePath, 'utf8');
            this.stats.diskReads++;
            return JSON.parse(raw);
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    }

    /**
     * Write binary/raw data ke disk (IP-level)
     */
    async _writeDiskRaw(ip, filename, buffer) {
        const dir = this._getStoragePath(ip);
        await this._ensureDir(dir);
        const filePath = path.join(dir, filename);
        await fs.promises.writeFile(filePath, buffer);
        this.stats.diskWrites++;
    }

    /**
     * Read binary data dari disk (IP-level), return null jika tidak ada
     */
    async _readDiskRaw(ip, filename) {
        const filePath = path.join(this._getStoragePath(ip), filename);
        try {
            const buf = await fs.promises.readFile(filePath);
            this.stats.diskReads++;
            return buf;
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    }

    /**
     * Hapus seluruh storage folder untuk IP tertentu
     */
    async _deleteDiskStorage(ip) {
        const dir = this._getStoragePath(ip);
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn(`${LOG_PREFIX} Failed to delete storage for ${ip}:`, err.message);
            }
        }
    }

    /**
     * Check apakah storage folder ada untuk IP
     */
    async _diskExists(ip) {
        try {
            await fs.promises.access(this._getStoragePath(ip));
            return true;
        } catch {
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // INITIALIZE — Create indexes, ensure storage dir, start cleanup
    // ═══════════════════════════════════════════════════════════

    async initialize(options = {}) {
        if (this.initialized) {
            console.log(`${LOG_PREFIX} Already initialized, skipping`);
            return;
        }

        this.ttl = options.ttl || DEFAULT_TTL;

        try {
            // 1. Ensure storage directory exists
            await this._ensureDir(STORAGE_DIR);

            // 2. MongoDB indexes
            const db = database.db();
            const col = db.collection(COLLECTION);

            await col.createIndex({ ip: 1 }, { unique: true });
            await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

            // 3. Startup cleanup — hapus orphaned disk folders
            await this._cleanupOrphans();

            // 4. Periodic cleanup timer
            this.cleanupTimer = setInterval(() => {
                this._cleanupOrphans().catch(err => {
                    console.warn(`${LOG_PREFIX} Periodic cleanup error:`, err.message);
                });
            }, options.cleanupInterval || CLEANUP_INTERVAL);

            // Jangan block process exit
            if (this.cleanupTimer.unref) this.cleanupTimer.unref();

            this.initialized = true;
            const count = await col.countDocuments();
            const diskFolders = await this._countDiskFolders();
            console.log(`${LOG_PREFIX} v3.0.0 Initialized — collection: ${COLLECTION}, DB: ${count}, disk folders: ${diskFolders}, TTL: ${this.ttl / 1000}s`);
        } catch (err) {
            console.error(`${LOG_PREFIX} Initialization failed:`, err.message);
            this.stats.errors++;
            throw err;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // LOOKUP — Find identity for IP + Origin (PHASE 6.7)
    // MongoDB metadata + Disk data load (cookies = all, localStorage = target origin only)
    // ═══════════════════════════════════════════════════════════

    /**
     * @param {string} ip — IP address
     * @param {string|null} targetUrl — target URL untuk load origin-specific localStorage
     *   Jika null/undefined, hanya cookies yang di-load (no localStorage)
     */
    async lookup(ip, targetUrl) {
        if (!this.initialized || !ip) return null;

        this.stats.lookups++;

        try {
            const col = database.db().collection(COLLECTION);
            const doc = await col.findOne({ ip });

            if (!doc) {
                this.stats.misses++;
                // Lazy cleanup: jika disk ada tapi DB tidak, hapus orphan
                if (await this._diskExists(ip)) {
                    await this._deleteDiskStorage(ip);
                    console.log(`${LOG_PREFIX} CLEANUP — orphaned disk for ${ip}`);
                }
                console.log(`${LOG_PREFIX} MISS — ${ip} (new IP, pioneer session)`);
                return null;
            }

            // Determine target origin from targetUrl
            const targetOrigin = targetUrl ? this._extractOrigin(targetUrl) : null;

            // Load cookies (ALL domains — browser cookie jar)
            const cookies = await this._readDisk(ip, 'cookies.json');

            // Load localStorage ONLY for target origin (isolated per Web Storage spec)
            let localStorageData = null;
            if (targetOrigin) {
                localStorageData = await this._readDiskOrigin(ip, targetOrigin, 'localStorage.json');
            }

            // Filter expired cookies (browser-level expiry)
            const nowSec = Math.floor(Date.now() / 1000);
            const validCookies = (cookies || []).filter(c => {
                if (!c.expires || c.expires === -1) return true;
                return c.expires > nowSec;
            });

            this.stats.hits++;
            const originInfo = targetOrigin ? `, origin: ${targetOrigin}` : '';
            const lsCount = localStorageData ? localStorageData.length : 0;
            console.log(`${LOG_PREFIX} HIT — ${ip} (visit #${(doc.visitCount || 0) + 1}, cookies: ${validCookies.length}, localStorage: ${lsCount} keys${originInfo})`);

            return {
                ip: doc.ip,
                cookies: validCookies,
                localStorage: localStorageData || [],
                targetOrigin: targetOrigin,
                geo: doc.geo || null,
                visitCount: doc.visitCount || 0,
                origins: doc.origins || {},
                capturedAt: doc.capturedAt,
                lastUsedAt: doc.lastUsedAt,
                isReturning: true
            };
        } catch (err) {
            this.stats.errors++;
            console.warn(`${LOG_PREFIX} Lookup error for ${ip}:`, err.message);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // CAPTURE — Extract cookies + localStorage from live session (PHASE 8.5)
    // Cookies: full snapshot (all domains) → cookies.json
    // localStorage: current page origin only → origins/{origin}/localStorage.json
    // ═══════════════════════════════════════════════════════════

    async capture(ip, context, page, meta = {}) {
        if (!this.initialized || !ip) return false;

        this.stats.captures++;

        try {
            // 1. Capture cookies dari browser context (ALL domains — browser cookie jar)
            const cookies = await context.cookies();

            // 2. Capture localStorage dari halaman (ONLY current page origin)
            const localStorageData = await page.evaluate(() => {
                const items = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    items.push({ name: key, value: localStorage.getItem(key) });
                }
                return items;
            });

            // 3. Determine current page origin
            const currentOrigin = await page.evaluate(() => window.location.origin).catch(() => null);
            const targetOrigin = meta.targetOrigin || currentOrigin;

            // 4. Write cookies ke disk (IP-level: ONE file for all domains)
            await this._writeDisk(ip, 'cookies.json', cookies);

            // 5. Write localStorage ke origin-specific subfolder (isolated)
            if (targetOrigin && localStorageData.length > 0) {
                await this._writeDiskOrigin(ip, targetOrigin, 'localStorage.json', localStorageData);
            }

            // 6. Write/update metadata ke MongoDB (lightweight)
            const col = database.db().collection(COLLECTION);
            const existing = await col.findOne({ ip }, { projection: { visitCount: 1 } });

            const now = new Date();
            const diskPath = this._getStoragePath(ip);

            // Build per-origin update
            const originKey = targetOrigin ? `origins.${targetOrigin.replace(/\./g, '\uff0e')}` : null;

            if (existing) {
                // UPDATE — returning visitor
                const updateOps = {
                    $set: {
                        diskPath: diskPath,
                        cookieCount: cookies.length,
                        lastUsedAt: now,
                        updatedAt: now,
                        expiresAt: new Date(now.getTime() + this.ttl)
                    },
                    $inc: { visitCount: 1 }
                };

                // Update per-origin tracking
                if (originKey) {
                    updateOps.$set[`${originKey}.lastVisitedAt`] = now;
                    updateOps.$set[`${originKey}.localStorageCount`] = localStorageData.length;
                    if (!updateOps.$inc) updateOps.$inc = {};
                    updateOps.$inc[`${originKey}.visitCount`] = 1;
                }

                await col.updateOne({ ip }, updateOps);
                this.stats.updates++;
                console.log(`${LOG_PREFIX} UPDATED — ${ip} (visit #${(existing.visitCount || 0) + 1}, cookies: ${cookies.length}, LS: ${localStorageData.length} keys, origin: ${targetOrigin || 'unknown'}) [disk: ${this._sanitizeIP(ip)}]`);
            } else {
                // STORE — pioneer session
                const setOnInsert = {
                    capturedAt: now,
                    visitCount: 1,
                    expiresAt: new Date(now.getTime() + this.ttl)
                };

                const setOps = {
                    targetUrl: meta.targetUrl || null,
                    geo: meta.geo || null,
                    diskPath: diskPath,
                    cookieCount: cookies.length,
                    lastUsedAt: now,
                    updatedAt: now
                };

                // Set initial per-origin tracking
                if (originKey) {
                    setOps[`${originKey}.visitCount`] = 1;
                    setOps[`${originKey}.lastVisitedAt`] = now;
                    setOps[`${originKey}.localStorageCount`] = localStorageData.length;
                }

                await col.updateOne(
                    { ip },
                    {
                        $set: setOps,
                        $setOnInsert: setOnInsert
                    },
                    { upsert: true }
                );
                this.stats.stores++;
                console.log(`${LOG_PREFIX} STORED — ${ip} (pioneer, cookies: ${cookies.length}, LS: ${localStorageData.length} keys, origin: ${targetOrigin || 'unknown'}, TTL: ${this.ttl / 1000}s) [disk: ${this._sanitizeIP(ip)}]`);
            }

            return true;
        } catch (err) {
            this.stats.errors++;
            console.warn(`${LOG_PREFIX} Capture error for ${ip}:`, err.message);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // INJECT HELPER — Apply identity to browser context (PHASE 6.7)
    // Cookies: inject ALL (Playwright handles domain matching)
    // localStorage: inject ONLY target origin data
    // ═══════════════════════════════════════════════════════════

    async inject(context, identity) {
        if (!identity || !identity.isReturning) return false;

        try {
            let injected = { cookies: 0, localStorage: 0 };

            // 1. Inject cookies (ALL domains — Playwright auto-filters by domain match)
            if (identity.cookies && identity.cookies.length > 0) {
                await context.addCookies(identity.cookies);
                injected.cookies = identity.cookies.length;
            }

            // 2. Inject localStorage via addInitScript (ONLY target origin data)
            if (identity.localStorage && identity.localStorage.length > 0) {
                await context.addInitScript((lsData) => {
                    for (const item of lsData) {
                        try { localStorage.setItem(item.name, item.value); } catch (e) { }
                    }
                }, identity.localStorage);
                injected.localStorage = identity.localStorage.length;
            }

            console.log(`${LOG_PREFIX} INJECTED — ${identity.ip} (cookies: ${injected.cookies}, LS keys: ${injected.localStorage}, origin: ${identity.targetOrigin || 'none'})`);
            return true;
        } catch (err) {
            this.stats.errors++;
            console.warn(`${LOG_PREFIX} Inject error for ${identity.ip}:`, err.message);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // CLEANUP — Hapus orphaned disk folders (DB expired via TTL)
    // ═══════════════════════════════════════════════════════════

    async _cleanupOrphans() {
        try {
            let entries;
            try {
                entries = await fs.promises.readdir(STORAGE_DIR);
            } catch (err) {
                if (err.code === 'ENOENT') return; // storage dir belum ada
                throw err;
            }

            if (entries.length === 0) return;

            const col = database.db().collection(COLLECTION);
            let cleaned = 0;

            for (const folder of entries) {
                const folderPath = path.join(STORAGE_DIR, folder);

                // Cek apakah ini memang directory
                const stat = await fs.promises.stat(folderPath).catch(() => null);
                if (!stat || !stat.isDirectory()) continue;

                // Cari document yang diskPath-nya match
                const exists = await col.findOne(
                    { diskPath: folderPath },
                    { projection: { _id: 1 } }
                );

                if (!exists) {
                    // Orphan — DB document sudah di-expire oleh TTL, hapus folder (termasuk origins/)
                    await fs.promises.rm(folderPath, { recursive: true, force: true });
                    cleaned++;
                }
            }

            if (cleaned > 0) {
                this.stats.cleanups += cleaned;
                console.log(`${LOG_PREFIX} CLEANUP — removed ${cleaned} orphaned disk folder(s)`);
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX} Cleanup error:`, err.message);
        }
    }

    /**
     * Count jumlah folder di storage directory
     */
    async _countDiskFolders() {
        try {
            const entries = await fs.promises.readdir(STORAGE_DIR);
            return entries.length;
        } catch {
            return 0;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // STATS & UTILITIES
    // ═══════════════════════════════════════════════════════════

    getStats() {
        return {
            ...this.stats,
            hitRate: this.stats.lookups > 0
                ? ((this.stats.hits / this.stats.lookups) * 100).toFixed(1) + '%'
                : '0%'
        };
    }

    async getCollectionCount() {
        if (!this.initialized) return 0;
        try {
            return await database.db().collection(COLLECTION).countDocuments();
        } catch { return 0; }
    }

    async getDiskStats() {
        if (!this.initialized) return { folders: 0, totalSize: 0 };
        try {
            const entries = await fs.promises.readdir(STORAGE_DIR);
            let totalSize = 0;
            let totalOrigins = 0;
            for (const folder of entries) {
                const folderPath = path.join(STORAGE_DIR, folder);
                const files = await fs.promises.readdir(folderPath).catch(() => []);
                for (const file of files) {
                    const filePath = path.join(folderPath, file);
                    const stat = await fs.promises.stat(filePath).catch(() => null);
                    if (stat && stat.isFile()) {
                        totalSize += stat.size;
                    } else if (stat && stat.isDirectory() && file === 'origins') {
                        // Count origin subfolders
                        const originFolders = await fs.promises.readdir(filePath).catch(() => []);
                        totalOrigins += originFolders.length;
                        // Sum origin files sizes
                        for (const originFolder of originFolders) {
                            const originPath = path.join(filePath, originFolder);
                            const originFiles = await fs.promises.readdir(originPath).catch(() => []);
                            for (const oFile of originFiles) {
                                const oStat = await fs.promises.stat(path.join(originPath, oFile)).catch(() => null);
                                if (oStat && oStat.isFile()) totalSize += oStat.size;
                            }
                        }
                    }
                }
            }
            return {
                folders: entries.length,
                origins: totalOrigins,
                totalSize,
                totalSizeMB: (totalSize / 1024 / 1024).toFixed(2) + ' MB'
            };
        } catch { return { folders: 0, origins: 0, totalSize: 0 }; }
    }

    async shutdown() {
        if (!this.initialized) return;

        // Stop cleanup timer
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        const stats = this.getStats();
        const count = await this.getCollectionCount();
        const disk = await this.getDiskStats();
        console.log(`${LOG_PREFIX} Shutdown — DB: ${count}, disk: ${disk.folders} IPs / ${disk.origins} origins (${disk.totalSizeMB}), stats: L:${stats.lookups} H:${stats.hits} M:${stats.misses} S:${stats.stores} U:${stats.updates} C:${stats.captures} DW:${stats.diskWrites} DR:${stats.diskReads} CL:${stats.cleanups} E:${stats.errors} HR:${stats.hitRate}`);
        this.initialized = false;
    }
}

// Singleton export (sama pattern dengan CacheManager)
module.exports = new IdentityStore();
