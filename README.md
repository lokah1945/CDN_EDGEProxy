# CDN EdgeProxy v3.1.3

Local CDN cache engine powered by Playwright. Intercepts and caches static assets
(images, scripts, stylesheets, fonts) from target websites to save bandwidth.

## Quick Start

```bash
# 1. Install playwright (only dependency!)
npm install

# 2. Install browser binaries (first time only)
npx playwright install

# 3. Run
node index.js
```

## What's New in v3.1.3

### Disposable Browser Profile
- Each run creates a unique temporary profile (`data/tmp-profiles/<browser>/<ts>-<rand>/`)
- Profile is automatically deleted on shutdown
- CDN cache (`data/cdn-cache/`) persists across all runs and browsers
- No .env change required

### Stale Validator Retention (7–30 day staleTTL)
- Body freshness still follows `CACHE_MAX_AGE` (24h by default)
- But ETag/Last-Modified validators survive **much longer** (derived internally)
- Result: most requests after day 1 become **304 revalidations** (0 body bytes from origin)
- Publisher still sees the request → revenue preserved, bandwidth saved

### Alias-Key Revalidation for Ads/CDN
- Known ad CDN domains (DoubleClick, googlesyndication, etc.) get an aggressive alias key
- Strips all query params (cachebuster, nonce, timestamp) to path-only
- If canonical key misses but alias has validators → conditional revalidation
- Turns ad creative "dedup misses" into 304 cache hits

### Vary-Aware Cross-Browser Cache
- When response has `Vary: Accept`, cache key includes Accept header fingerprint
- Prevents AVIF-to-Firefox or WebP-to-old-browser format mismatch
- Safe to share `CACHE_DIR` across Chromium/Chrome/Edge/Firefox

### Content-Type Based Caching for fetch/xhr
- `fetch` and `xhr` requests are only cached if response is asset-like
- `image/*`, `video/*`, `font/*`, CSS, JS → cached
- JSON, HTML, text auction responses → bypass cache
- Prevents auction/bidding data from being cached

### Safe Header Replay
- Cached headers no longer include `content-encoding` or `content-length`
- Prevents content corruption when Playwright auto-decompresses gzip/br

## Features

- **Cross-browser**: Chromium, Chrome, Edge, Firefox
- **Shared cache**: All browsers use the same content-addressable cache
- **Disposable profiles**: Fresh profile each run, shared CDN cache persists
- **3-class ads routing**: Auction → bypass, Beacon → bypass, Creative → cache+revalidate
- **Stale revalidation**: ETag/Last-Modified validators survive 7-30 days
- **Alias dedup**: Cross-cachebuster revalidation for ad CDNs
- **Vary-aware**: Accept-fingerprinted keys prevent format mismatch
- **Content-addressable**: SHA-256 blob dedup
- **LRU eviction**: Automatic cleanup when cache exceeds maxSize
- **Atomic writes**: Temp file → rename for index and blobs
- **Zero-config**: Works out of the box with `.env` defaults

## Configuration

### .env (unchanged from v3.1.2)
```
TARGETS=*.detik.com,*.kompas.com
BROWSER=chromium
CACHE_MAX_SIZE=2199023255552
CACHE_MAX_AGE=86400000
CACHE_DIR=data/cdn-cache
DEBUG_LEVEL=3
```

### CLI
```bash
node index.js --browser=chrome
node index.js --browser=msedge
node index.js --browser=firefox
```

### npm scripts
```bash
npm run chrome
npm run edge
npm run firefox
```

## Folder Structure

```
├── .env                    # Environment config (UNCHANGED)
├── index.js                # Entry point
├── package.json            # Dependencies (playwright only)
├── config/
│   └── default.json        # Target & routing rules
├── src/
│   ├── configLoader.js     # Built-in .env parser (no dotenv)
│   ├── BrowserRunner.js    # Disposable profile launcher
│   ├── RequestHandler.js   # HIT/304/MISS + stale revalidation
│   ├── TrafficClassifier.js # 3-class routing + content-type check
│   ├── StorageEngine.js    # Blob store + alias index + staleTTL
│   ├── URLNormalizer.js    # Canonical + alias key normalization
│   ├── ConfigParser.js     # Target/cache parser
│   ├── CacheReport.js      # Report formatter
│   └── logger.js           # Logging with levels
└── data/
    ├── cdn-cache/          # Shared cache (persists across runs)
    │   ├── index.json
    │   ├── alias-index.json
    │   └── blobs/
    └── tmp-profiles/       # Disposable (deleted per run)
        ├── chromium/
        ├── chrome/
        ├── msedge/
        └── firefox/
```

## Changelog

### v3.1.3
- **NEW**: Disposable browser profile (auto-created & deleted per run)
- **NEW**: Stale validator retention (staleTTL = 7-30 days internally derived)
- **NEW**: Alias-key revalidation for ad/CDN cross-cachebuster dedup
- **NEW**: Vary-aware cache key (Accept fingerprint) for cross-browser safety
- **NEW**: Content-type based caching for fetch/xhr (only assets, not auction JSON)
- **FIXED**: Dropped content-encoding & content-length from cached headers
- **FIXED**: Enhanced beacon detection (URL keywords + resource type)
- **.env**: UNCHANGED — fully backward compatible with v3.1.2

### v3.1.2
- Removed `dotenv` dependency — `.env` parsed with built-in Node.js code
- Only external dependency is `playwright`

### v3.1.1
- Wildcard target format (`*.detik.com,*.kompas.com`)
- Auto-config for unknown domains
- Pre-defined matchDomains for known sites
