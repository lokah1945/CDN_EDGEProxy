# CDN EdgeProxy v3.1.2

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

## Features

- **Cross-browser**: Chromium, Chrome, Edge, Firefox
- **Shared cache**: All browsers use the same content-addressable cache
- **Separate profiles**: Each browser keeps its own persistent profile
- **3-class ads routing**: Auction → bypass, Beacon → bypass, Creative → cache
- **Revalidation**: ETag/Last-Modified support with 304 handling
- **Dedup**: Content-addressable storage with SHA-256 hashing
- **LRU eviction**: Automatic cleanup when cache exceeds maxSize
- **Atomic writes**: Temp file → rename for index and blobs
- **Zero-config**: Works out of the box with `.env` defaults

## Configuration

### .env
```
TARGETS=*.detik.com,*.kompas.com
BROWSER=chromium
CACHE_MAX_SIZE=2199023255552
CACHE_MAX_AGE=86400000
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

## Target Format

Use wildcard patterns: `*.domain.com`

Add more targets by comma-separating:
```
TARGETS=*.detik.com,*.kompas.com,*.tribunnews.com
```

Unknown domains auto-generate config. Known domains (detik, kompas) include
pre-configured CDN/matchDomains for better cache reporting.

## Folder Structure

```
├── .env                    # Environment config
├── index.js                # Entry point
├── package.json            # Dependencies (playwright only)
├── config/
│   └── default.json        # Target & routing rules
├── src/
│   ├── configLoader.js     # Built-in .env parser (no dotenv needed!)
│   ├── BrowserRunner.js    # Playwright launcher
│   ├── RequestHandler.js   # HIT/304/MISS cache pipeline
│   ├── TrafficClassifier.js # 3-class ads routing
│   ├── StorageEngine.js    # Content-addressable blob store
│   └── logger.js           # Logging with levels
└── data/
    ├── cdn-cache/          # Shared cache (blobs + index)
    └── profiles/           # Per-browser profiles
        ├── chromium/
        ├── chrome/
        ├── msedge/
        └── firefox/
```

## Changelog

### v3.1.2
- **FIXED**: Removed `dotenv` dependency entirely — `.env` is now parsed with built-in Node.js code
- No more `Cannot find module 'dotenv'` error
- Only external dependency is `playwright`

### v3.1.1
- Wildcard target format (`*.detik.com,*.kompas.com`)
- Auto-config for unknown domains
- Pre-defined matchDomains for known sites
