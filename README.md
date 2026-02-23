# CDN EdgeProxy v4.1.0

**Aggressive Local CDN Cache Engine powered by Playwright**

## What's New in v4.1

- **Debounced index writes** — batches rapid puts into single disk write (2s window), reduces I/O by ~95%
- **Explicit flush on shutdown** — no more lost cache entries on Ctrl+C
- **Orphan cleanup at startup** — removes index entries with missing blob files
- **Tighter beacon detection** — regex now requires path-segment match, prevents false-positive on words like "soundtrack", "eventbus"
- **Content-encoding safety** — strips `content-encoding`, `content-length`, `transfer-encoding` from ALL fulfill calls (not just cache replays)
- **Alias→canonical promotion** — 304 revalidation via alias also registers under canonical key for direct hits next time
- **Browser close detection** — graceful shutdown when user closes all browser tabs
- **Top asset URL display** — increased to 120 chars for better identification
- **Anti-automation flags** — `--disable-features=IsolateOrigins`, `--disable-site-isolation-trials`, `ignoreDefaultArgs: ['--enable-automation']`, `bypassCSP: true`
- **Legacy files removed** — no more `lib/`, `src/cache/`, `src/utils/`, `src/EdgeProxy.js`, `src/ConfigParser.js`

## What Changed from v3.1.3 → v4.0 → v4.1

| Feature | v3.1.3 | v4.0.0 | v4.1.0 |
|---------|--------|--------|--------|
| Targets | `.env` TARGETS required | Universal | Universal |
| Auto-navigate | Opens target tabs | No | No |
| CSS/JS cache | No (only images/fonts) | Aggressive alias-key | + alias→canonical promotion |
| Via header | No | Yes | Yes |
| Index save | Per-put (sync) | Per-put (sync) | Debounced (2s batch) |
| Shutdown flush | No flush | No flush | Explicit flush |
| Orphan cleanup | No | No | On startup |
| Beacon regex | Broad | Broad | Tight (path-segment) |
| Content-encoding strip | Cache replay only | Cache replay only | All fulfill |
| Legacy files | Present | Present (not cleaned) | Removed |

## Quick Start

```bash
npm install
node index.js
```

## .env

```env
# Browser: chromium | chrome | msedge | firefox
BROWSER=chromium

# Cache settings
CACHE_MAX_SIZE=2199023255552
CACHE_MAX_AGE=86400000
CACHE_DIR=data/cdn-cache

# Debug level: 0=off 1=error 2=warn 3=info 4=debug
DEBUG_LEVEL=3
```

## How It Works

1. Launches browser with Playwright (disposable profile, persistent cache)
2. Installs `context.route("**/*")` to intercept ALL requests
3. **Class A** (ad auction/bidding) → bypass (preserve publisher revenue)
4. **Class B** (measurement/beacon) → bypass (preserve analytics)
5. **Class C** (static: CSS, JS, images, fonts, media) → aggressive cache
6. Stale assets → conditional revalidation (If-None-Match → 304 saves bandwidth)
7. Cache persists in `data/cdn-cache/` across runs

## File Structure

```
CDN_EdgeProxy/
├── .env                    # Configuration
├── index.js                # Entry point
├── package.json            # Dependencies
├── config/
│   └── default.json        # Routing rules (Class A/B/C patterns)
├── src/
│   ├── configLoader.js     # .env + JSON parser
│   ├── logger.js           # Log levels
│   ├── BrowserRunner.js    # Launch browser, install route, lifecycle
│   ├── RequestHandler.js   # HIT/304/MISS flow, Via header
│   ├── TrafficClassifier.js# Universal 3-class routing
│   ├── URLNormalizer.js    # Canonical + alias key strategies
│   ├── StorageEngine.js    # Blob store, dedup, eviction, report
│   └── CacheReport.js      # Standalone report utility
└── data/
    ├── cdn-cache/           # Persistent (index.json, alias-index.json, blobs/)
    └── tmp-profiles/        # Disposable (deleted per run)
```

## Upgrade from v3.1.3 or v4.0

1. Backup `data/cdn-cache/` (compatible, no migration needed)
2. **Delete** `lib/`, `src/cache/`, `src/utils/`, `src/EdgeProxy.js`, `src/ConfigParser.js`
3. Replace all remaining files with v4.1.0 versions
4. Remove `TARGETS=...` from `.env` if present
5. `npm install && node index.js`
