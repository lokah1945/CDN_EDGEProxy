# CDN EdgeProxy v4.0.0

**Aggressive Local CDN Cache Engine powered by Playwright**

## What Changed from v3.1.3

- **Universal**: No more `TARGETS` in `.env` — cache works on ALL websites
- **No auto-navigate**: Browser opens blank, user browses freely
- **Aggressive CSS/JS caching**: Alias-key dedup strips `?v=`, `?ver=`, `?hash=` for conditional revalidation
- **Via header**: Origin sees `Via: 1.1 CDN_EdgeProxy` (CDN-like traffic pattern)
- **X-EdgeProxy header**: DevTools shows `X-EdgeProxy: HIT` for cached responses
- **Expanded ad detection**: 28 ad domain indicators (vs 14 in v3.1.3)
- **Storage compatible**: v3.1.3 cache data works without migration

## Quick Start

```bash
npm install
node index.js
```

## .env Configuration

```env
BROWSER=chromium
CACHE_MAX_SIZE=2199023255552
CACHE_MAX_AGE=86400000
CACHE_DIR=data/cdn-cache
DEBUG_LEVEL=3
```

## How It Works

1. Launches browser with Playwright (disposable profile, persistent cache)
2. Installs `context.route("**/*")` to intercept ALL requests
3. **Class A** (ad auction/bidding) → bypass (preserve publisher revenue)
4. **Class B** (measurement/beacon) → bypass (preserve analytics)
5. **Class C** (static assets: CSS, JS, images, fonts, media) → aggressive cache
6. Stale assets revalidated with `If-None-Match` / `If-Modified-Since` → 304 saves bandwidth
7. Cache persists in `data/cdn-cache/` across runs

## Upgrade from v3.1.3

1. Backup `data/cdn-cache/` (compatible, no migration needed)
2. Replace all files with v4.0.0
3. Delete `lib/` directory
4. Remove `TARGETS=...` from `.env`
5. `npm install && node index.js`
