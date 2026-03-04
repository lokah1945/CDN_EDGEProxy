# CDN EdgeProxy v6.0.0 — Panduan Implementasi QTE

## Ringkasan

CDN EdgeProxy adalah modul **Local CDN Cache Engine** yang terintegrasi dengan Playwright browser contexts. Module ini mengintercept semua HTTP request melalui `context.route("**/*")` dan menerapkan caching agresif untuk meminimalisir bandwidth internet.

### Prinsip Utama
- **Ad Network tetap dapat impression & tracking** — Class A (auction) dan Class B (beacon) selalu di-bypass
- **Creative ads & static assets di-cache lintas browser** — Class C (creative/static) di-serve dari disk/memory
- **Zero fingerprint** — Tidak ada header Via, tidak ada debug header, ad network tidak tahu content dari CDN lokal
- **Shared cache** — 100 browser Playwright berbagi cache yang sama (IPC-aware)

---

## Arsitektur

```
┌──────────────────────────────────────────────────┐
│  QTE Process (opsi4.js / engine.js)              │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Browser 1│  │ Browser 2│  │ Browser N│       │
│  │ Context  │  │ Context  │  │ Context  │       │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘       │
│        │             │             │             │
│        └──────────┬──┘─────────────┘             │
│                   ▼                              │
│  ┌────────────────────────────────────────────┐  │
│  │     EdgeCacheRuntime (SINGLETON)            │  │
│  │                                            │  │
│  │  ┌──────────────┐  ┌───────────────────┐   │  │
│  │  │RequestHandler│  │ TrafficClassifier  │   │  │
│  │  │   + stealth  │  │ A=bypass B=bypass │   │  │
│  │  │              │  │ C=cache           │   │  │
│  │  └──────┬───────┘  └───────────────────┘   │  │
│  │         ▼                                  │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │        StorageEngine (SHARED)         │  │  │
│  │  │                                      │  │  │
│  │  │  ┌─────────────┐  ┌──────────────┐   │  │  │
│  │  │  │ LRU HotBlob │  │  Disk Blobs  │   │  │  │
│  │  │  │ (256MB RAM) │  │ (2TB max)    │   │  │  │
│  │  │  └─────────────┘  └──────────────┘   │  │  │
│  │  │  ┌─────────────────────────────────┐  │  │  │
│  │  │  │ Index + Alias (RAM + disk JSON) │  │  │  │
│  │  │  │ IPC version tracking            │  │  │  │
│  │  │  └─────────────────────────────────┘  │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## Langkah Implementasi

### STEP 1: Copy Module ke Project QTE

```bash
# Copy folder CDN_EDGEProxy ke root project QTE
cp -r CDN_EDGEProxy /path/to/qte/CacheModule

# JANGAN install npm — module ini tidak membutuhkan dependensi tambahan
# Semua menggunakan Node.js built-in (fs, path, crypto)
```

Struktur folder di QTE project:
```
qte-project/
├── opsi4.js
├── engine.js
├── BrowserLauncher.js
├── device_manager.js
├── CacheModule/              ← CDN EdgeProxy module
│   ├── runtime.js
│   ├── package.json
│   ├── config/
│   │   └── default.json
│   ├── lib/
│   │   ├── StorageEngine.js
│   │   ├── RequestHandler.js
│   │   ├── TrafficClassifier.js
│   │   ├── URLNormalizer.js
│   │   └── logger.js
│   ├── data/                 ← auto-created
│   │   └── cdn-cache/
│   │       ├── blobs/
│   │       ├── index.json
│   │       ├── alias-index.json
│   │       └── index-version.json
│   └── logs/                 ← auto-created
│       └── edgeproxy-YYYY-MM-DD.log
```

### STEP 2: Modifikasi opsi4.js — Tambah Require & Singleton

**Tambahkan di bagian require (module-level, baris ~190-an):**

```javascript
// ═══════════════════════════════════════════════════════════
// CDN EdgeProxy — Local CDN Cache Engine (CacheModule)
// ═══════════════════════════════════════════════════════════
const { EdgeCacheRuntime } = require("./CacheModule/runtime");

// SINGLETON — shared across ALL workers in this process
let edgeCacheRuntime = null;
async function getEdgeCacheRuntime() {
  if (!edgeCacheRuntime) {
    edgeCacheRuntime = new EdgeCacheRuntime({
      // debug: process.env.CACHE_DEBUG === "true",  // Enable for debugging
      debug: false,
      logLevel: 0,        // 0=silent in production, 3=info, 4=debug
      // cacheDir: default = CacheModule/data/cdn-cache
      // maxSize: default = 2TB
      // maxAge: default = 24h
      maxEntrySize: 50 * 1024 * 1024,  // Skip files > 50MB
      memory: {
        maxHotBlobBytes: 512 * 1024 * 1024,  // 512MB hot cache in RAM
        preloadBlobs: false,
      },
      concurrency: {
        indexFlushDebounceMs: 2000,  // Batch index writes
        ipcPollMs: 5000,            // Check for updates from other processes
        staleCleanupMs: 30 * 60 * 1000,  // Clean expired entries every 30min
      },
      stealth: {
        injectViaHeader: false,       // KRITIS: jangan inject Via header
        exposeDebugHeaders: false,    // KRITIS: jangan expose debug headers
      },
    });
    await edgeCacheRuntime.init();
  }
  return edgeCacheRuntime;
}
```

### STEP 3: Modifikasi opsi4.js — Attach Setelah PHASE 6

**Di dalam `runMode4Worker()`, SETELAH PHASE 6 (setelah `browser = launchResult.browser`) dan SEBELUM PHASE 7 (navigation):**

Cari baris ini (sekitar line 748):
```javascript
activeWorkers.set(workerId, { context, profilePath });
```

Tambahkan SETELAH baris tersebut:
```javascript
        // ═══════════════════════════════════════════════════════
        // PHASE 6.5: ATTACH CDN EDGEPROXY CACHE
        // ═══════════════════════════════════════════════════════
        // EdgeCacheRuntime harus di-attach SEBELUM navigation (PHASE 7)
        // agar semua request sejak halaman pertama sudah ter-cache.
        // SINGLETON: semua context dalam process ini share 1 runtime.
        try {
          const cacheRuntime = await getEdgeCacheRuntime();
          await cacheRuntime.attach(context);
          // Optional: start periodic report logging (to file only)
          // cacheRuntime.startReportTimer(60000); // setiap 60 detik
        } catch (err) {
          console.log(`${WID} ⚠️ CDN Cache attach failed (non-fatal): ${err.message}`);
          // Non-fatal: browser tetap berjalan tanpa cache
        }
```

### STEP 4: Modifikasi opsi4.js — Detach di Finally Block

**Di dalam `runMode4Worker()` finally block (sekitar line 800-840), tambahkan SEBELUM `context.close()`:**

```javascript
    } finally {
        // ═══ CDN EDGEPROXY: DETACH SEBELUM CLOSE ═══
        try {
          if (context && edgeCacheRuntime) {
            await edgeCacheRuntime.detach(context);
          }
        } catch (_) {}

        // ... existing cleanup code (activeWorkers.delete, context.close, dll) ...
```

### STEP 5: Modifikasi opsi4.js — Shutdown di SIGINT Handler

**Di dalam SIGINT handler (sekitar line 1060-1100), tambahkan setelah semua context ditutup:**

```javascript
        // ═══ CDN EDGEPROXY: FINAL SHUTDOWN ═══
        // Harus dipanggil SETELAH semua context di-close
        // Menulis final report dan flush index ke disk
        try {
          if (edgeCacheRuntime) {
            await edgeCacheRuntime.shutdown();
            edgeCacheRuntime = null;
          }
        } catch (_) {}
```

### STEP 6: (OPSIONAL) Modifikasi engine.js — Global Shutdown

Jika engine.js memiliki global shutdown handler, tambahkan:

```javascript
// Di bagian shutdown engine
if (edgeCacheRuntime) {
  await edgeCacheRuntime.shutdown();
  edgeCacheRuntime = null;
}
```

---

## Traffic Classification — Apa yang Di-Cache dan Apa yang Di-Bypass

### Class A: AUCTION/DECISIONING → **SELALU BYPASS**
Request ini HARUS sampai ke server untuk lelang ad yang benar.
- `*/bid*`, `*/auction*`, `*/rtb*`, `*/prebid*`
- `securepubads.g.doubleclick.net`
- `pagead2.googlesyndication.com`

### Class B: MEASUREMENT/BEACON → **SELALU BYPASS**
Request ini HARUS sampai ke server agar ad network menghitung impression/view.
- `*/pixel*`, `*/beacon*`, `*/track*`, `*/analytics*`
- `*/impression*`, `*/collect*`, `*/log?*`
- `facebook.com/tr`, `google-analytics.com/collect`
- `doubleclick.net/pcs/view*`, `doubleclick.net/pagead/adview*`

### Class C: CREATIVE/STATIC → **CACHE AGRESIF**
Konten yang identik di semua browser — aman untuk di-cache.
- **Ad creatives**: gambar iklan, video iklan, CSS/JS iklan
- **Static assets**: CSS, JS, fonts, images, wasm
- **Document/HTML**: conditional cache (selalu revalidate via ETag/Last-Modified)

### Hasil Win-Win:
- Ad network → **Semua tracking/beacon/impression tetap sampai ke server** ✅
- QTE → **Creative ads & static assets tidak perlu download ulang** ✅
- Bandwidth → **Hemat 60-80% setelah cold start** ✅

---

## Konfigurasi

### File: `CacheModule/config/default.json`

```json
{
  "cache": {
    "maxSize": 2199023255552,    // 2TB — sesuaikan dengan disk
    "maxAge": 86400000,          // 24 jam — TTL default
    "maxEntrySize": 52428800,    // 50MB — skip file yang terlalu besar
    "dir": "data/cdn-cache"      // relative to CacheModule/
  },
  "memory": {
    "maxHotBlobBytes": 268435456, // 256MB RAM hot cache
    "preloadBlobs": false         // true = load blobs ke RAM saat init
  },
  "concurrency": {
    "indexFlushDebounceMs": 2000, // Batch index writes
    "ipcPollMs": 5000,           // IPC check interval
    "staleCleanupMs": 1800000    // 30 menit — clean expired entries
  },
  "stealth": {
    "injectViaHeader": false,      // WAJIB false di production
    "exposeDebugHeaders": false    // WAJIB false di production
  }
}
```

### Konfigurasi Rekomendasi Berdasarkan Skala:

| Skenario | maxHotBlobBytes | maxSize | Workers |
|----------|----------------|---------|---------|
| Development (1-5 browser) | 128MB | 10GB | 1-5 |
| Production kecil (10-20 browser) | 256MB | 50GB | 10-20 |
| Production besar (50-100 browser) | 512MB | 500GB | 50-100 |
| Enterprise (100+ browser, multi-server) | 1GB | 2TB | 100+ |

---

## API Reference

### `EdgeCacheRuntime`

```javascript
const { EdgeCacheRuntime } = require("./CacheModule/runtime");

const runtime = new EdgeCacheRuntime(config);
await runtime.init();                    // Initialize storage, classifier, handler
await runtime.attach(playwrightContext); // Intercept all requests in this context
await runtime.detach(playwrightContext); // Stop intercepting
const report = runtime.getReport();      // Text report string
const stats = runtime.getStats();        // JSON stats object
await runtime.shutdown();                // Flush, cleanup, close
```

### `getStats()` Response

```javascript
{
  entries: 1234,                // Total cache entries
  aliases: 456,                 // Alias index entries
  uniqueBlobs: 890,             // Unique files on disk
  diskBytes: 123456789,         // Total disk usage (bytes)
  dedupHits: 100,               // Deduplicated entries (same content, diff URL)
  hotBlobCount: 200,            // Blobs currently in RAM
  hotBlobBytes: 52428800,       // RAM usage by hot cache
  noStoreSkipped: 50,           // Requests skipped due to Cache-Control: no-store
  maxEntrySizeSkipped: 5,       // Requests skipped due to maxEntrySize
  ipcVersion: 42,               // IPC version counter
  requestsPerSecond: "15.30",   // Average requests/sec since start
  bandwidthSavedPct: "72.5",    // Bandwidth saved percentage
  cacheEfficiency: "68.3",      // Weighted efficiency score
  averageResponseTimeMs: "2.5", // Average response time (cache hit vs miss)
}
```

---

## Troubleshooting

### Cache tidak bekerja (semua MISS)
1. Pastikan `EdgeCacheRuntime.attach(context)` dipanggil SEBELUM `page.goto()`
2. Check apakah request masuk Class A/B (selalu bypass)
3. Enable debug: `new EdgeCacheRuntime({ debug: true })`
4. Check log file di `CacheModule/logs/edgeproxy-YYYY-MM-DD.log`

### Memory terlalu tinggi
- Kurangi `maxHotBlobBytes` (default 256MB)
- Set `preloadBlobs: false`

### Disk penuh
- Kurangi `maxSize` di config
- `staleCleanupMs` akan auto-cleanup entries yang expired

### Ad network mendeteksi caching
- **TIDAK MUNGKIN** selama `stealth.injectViaHeader = false` dan `stealth.exposeDebugHeaders = false`
- Headers yang dikirim ke browser 100% identik dengan response asli dari server
- Hanya `content-encoding`, `content-length`, `transfer-encoding` yang di-strip (standar Playwright `route.fulfill()`)

### Multi-process: cache tidak shared
- Pastikan semua process menggunakan `cacheDir` yang sama
- IPC polling (`ipcPollMs: 5000`) akan sync index setiap 5 detik antar process
- Blobs di disk secara otomatis tersedia untuk semua process

---

## Monitoring & Debugging

### Enable Debug Logging
```javascript
const runtime = new EdgeCacheRuntime({ debug: true });
```
Semua log masuk ke file `CacheModule/logs/edgeproxy-YYYY-MM-DD.log` — **ZERO console output** (QTE owns the terminal).

### Periodic Report
```javascript
runtime.startReportTimer(60000); // Report setiap 60 detik ke log file
```

### Manual Report
```javascript
console.log(runtime.getReport());
```
Output:
```
══════════════════════════════════════════════════════════════
  CDN EdgeProxy CACHE REPORT v6
══════════════════════════════════════════════════════════════
  Entries: 2451 | Aliases: 890 | Unique blobs: 1567 | Dedup: 234
  Hot blobs: 312 (189.4/256MB) | Disk: 456.7MB
  IPC version: 42
  HIT: 18234 | MISS: 3456 | 304-reval: 567 | Ratio: 84.1%
  no-store skipped: 123 | maxSize skipped: 5

  ── Performance Metrics (v6) ──
  Cache efficiency score: 81.2%
  Bandwidth saved: 76.5% (345.6 MB)
  Requests/sec (session avg): 23.50
  Avg response time: 1.8 ms
  ...
══════════════════════════════════════════════════════════════
```

---

## Versi & Changelog

- **v6.0.0** (current) — Enterprise-grade rewrite
  - 8 bug fixes (race conditions, sync I/O, O(n²) eviction, dll)
  - Inter-process cache sharing via IPC
  - Async everything (zero blocking I/O)
  - Blob reference counting
  - Write mutex for concurrency safety
  - Max entry size guard
  - Periodic stale cleanup
  - Enhanced stats & reporting

Detail lengkap: lihat `CHANGELOG-v6.md`
