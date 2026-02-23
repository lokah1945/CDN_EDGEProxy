# CDN EdgeProxy v3.1.1

**Local CDN cache untuk Playwright — lintas browser (Chromium/Chrome/Edge/Firefox)**

## Fitur Utama

- 🌐 **Cross-browser**: Chromium, Chrome, Edge, Firefox — pilih dari menu interaktif atau CLI
- 💾 **Shared cache**: Satu folder `cdn-cache` untuk semua browser (content-addressable by SHA-256)
- 🔒 **Profile terpisah**: Setiap browser punya `userDataDir` sendiri (cookies/login aman)
- 🎯 **3-Kelas traffic ads**: Auction (A), Beacon (B), Creative (C) — hanya C yang di-cache
- ♻️ **Revalidation 304**: Creative yang stale dikirim dengan `If-None-Match` / `If-Modified-Since`
- 🧹 **LRU eviction**: Otomatis hapus entry terlama saat capacity penuh
- 🔄 **Atomic writes**: `temp → rename` untuk index & blobs, aman dari race condition
- 📝 **Debug system**: 4 level log (silent/terminal/terminal+file/file only)

## Instalasi

```bash
npm install
```

## Cara Pakai

### Menu Interaktif
```bash
npm start
# atau
node index.js
```

### CLI Argument
```bash
node index.js --browser=chrome
node index.js --browser=firefox
node index.js --browser=msedge
node index.js --browser=chromium
```

### NPM Scripts
```bash
npm run chrome
npm run firefox
npm run msedge
npm run chromium
```

## Struktur Direktori

```
cdn-edgeproxy-v3.1.1/
├── index.js                          # Entry point + browser menu
├── package.json
├── .env                              # Environment config
├── config/
│   └── default.json                  # Default settings
├── src/
│   ├── BrowserRunner.js              # Launches browser + registers route
│   ├── cache/
│   │   ├── RequestHandler.js         # Core routing pipeline (HIT/304/MISS)
│   │   ├── TrafficClassifier.js      # Kelas A/B/C classification
│   │   └── StorageEngine.js          # Content-addressable blob store
│   └── utils/
│       ├── configLoader.js           # Merge .env + default.json
│       └── logger.js                 # Debug logging system
├── data/
│   ├── cdn-cache/                    # Shared cache (blobs + index)
│   │   ├── blobs/                    # SHA-256 sharded blob files
│   │   └── index.json                # URL → meta mapping
│   └── profiles/                     # Per-browser persistent profiles
│       ├── chromium/
│       ├── chrome/
│       ├── msedge/
│       └── firefox/
└── logs/
    └── edgeproxy.log
```

## Konsep Pipeline

```
Request masuk
    │
    ├── Non-GET / document / websocket / Range → BYPASS (continue)
    │
    ├── Kelas A (auction/decisioning) → BYPASS
    ├── Kelas B (beacon/measurement)  → BYPASS
    │
    └── Kelas C (creative bytes)
         │
         ├── Cache FRESH? → HIT (fulfill dari cache)
         │
         ├── Cache STALE + ada etag/last-modified?
         │    ├── 304 → HIT-304 (refresh TTL, serve cached)
         │    └── 200 → MISS-UPDATE (update cache)
         │
         └── MISS → fetch + cache + fulfill
```

## Win-Win Ads Concept

- **Publisher tetap dapat revenue**: Auction & beacon TIDAK di-cache
- **Hemat kuota**: Creative yang 100% sama dilayani dari cache
- **Revalidation**: Bahkan creative yang "anti-cache" bisa hemat via 304
- **Content-hash dedup**: URL berbeda tapi body sama → 1 blob file

## Konfigurasi

### .env
| Variable | Default | Keterangan |
|----------|---------|------------|
| BROWSER | chromium | Engine browser |
| TARGET_URL | https://example.com | URL awal |
| HEADLESS | false | Headless mode |
| SERVICE_WORKERS | block | block/allow |
| CACHE_MAX_SIZE_GB | 2 | Kapasitas max cache |
| CACHE_MAX_AGE_HOURS | 24 | TTL max entry cache |
| DEBUG_MODE | false | Aktifkan debug log |
| DEBUG_LOG | 3 | 0=silent, 1=term, 2=term+file, 3=file |

## Catatan Penting

⚠️ **Jangan jalankan 2 browser dengan `userDataDir` yang sama** — Playwright melarang ini.

⚠️ **Service Worker**: Direkomendasikan `block` agar semua request terintercept. Jika butuh SW, set `allow` tapi siap sebagian request bypass cache.

⚠️ **Header replay**: `content-encoding` dan `content-length` TIDAK di-replay dari cache untuk menghindari body rusak.
