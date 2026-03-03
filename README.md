# CDN EdgeProxy v4.1.1

Aggressive Local CDN Cache Engine with Playwright — caches all static assets (CSS, JS, images, fonts) and HTML documents with conditional revalidation.

## What's New in v4.1.1

### 1. HTML Document Caching (Conditional Revalidation)
- HTML pages are now cached with **always-revalidate** strategy using ETag + If-None-Match
- First visit: HTML is fetched and cached with ETag/Last-Modified metadata
- Subsequent visits: Conditional request sent; **304 Not Modified** serves cached HTML (saves bandwidth)
- Origin unreachable: Serves stale cached HTML as fallback
- Static assets (CSS/JS/font/image) remain aggressively cached with 24h TTL

### 2. Dual Byte Metrics (Wire vs Resource)
- **Bytes Resource** (uncompressed): `response.body()` size — what Playwright returns after decompression
- **Bytes Wire** (compressed estimate): `content-length` header value — actual network transfer size
- Report now shows both metrics for accurate bandwidth analysis

### 3. Tiered Logging System (Level 0-4)
| Level | Name | Terminal | Log File |
|-------|------|----------|----------|
| 0 | Silent | Live report only (auto-refresh 30s) | None |
| 1 | Error | Errors only | `./logs/edgeproxy-YYYY-MM-DD.log` |
| 2 | Warn | Errors + Warnings | `./logs/edgeproxy-YYYY-MM-DD.log` |
| 3 | Info | Full info (default) | `./logs/edgeproxy-YYYY-MM-DD.log` |
| 4 | Debug | Everything + headers | `./logs/edgeproxy-YYYY-MM-DD.log` |

- **Midnight rotation**: Log file automatically rotates at 00:00
- **Buffered writes**: Flushes every 5 seconds for performance
- Configure via `.env`: `DEBUG_LEVEL=0`

## Quick Start

```bash
npm install
# Copy and edit environment config
cp .env.example .env

# Run
npm start
# or specific browser
npm run chrome
npm run edge
npm run firefox
```

## Configuration

See `.env.example` for all options. Key settings:

```env
DEBUG_LEVEL=3       # 0=silent, 1=error, 2=warn, 3=info, 4=debug
BROWSER=chromium    # chromium, chrome, msedge, firefox
CACHE_DIR=data/cdn-cache
LOG_DIR=logs
```

## Architecture

```
Browser Request → Playwright Intercept → RequestHandler
  ├── document    → handleDocument() [always-revalidate via ETag]
  ├── cacheable   → handleCacheable() [aggressive 24h TTL]
  ├── Class A/B   → bypass (ads/beacons)
  └── other       → route.continue()
```

## License

MIT