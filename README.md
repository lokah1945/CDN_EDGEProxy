# CacheModule — CDN EdgeProxy v4.1.1

> **QTE Integration Module** — Transparent CDN-level caching layer for Playwright browser automation.
> Zero console output. File-only logging. Plug-and-play with QuantumTrafficEngine.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Directory Structure](#directory-structure)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Config File](#config-file)
  - [Constructor Options](#constructor-options)
- [Integration Guide](#integration-guide)
  - [Quick Start](#quick-start)
  - [Integration with opsi4.js](#integration-with-opsi4js)
  - [Integration with BrowserLauncher.js](#integration-with-browserlauncherjs)
  - [CDN Transparent Cache — Shared Architecture](#cdn-transparent-cache--shared-architecture)
- [API Reference](#api-reference)
  - [EdgeCacheRuntime](#edgecacheruntime)
  - [Methods](#methods)
  - [Events & Lifecycle](#events--lifecycle)
- [How Caching Works](#how-caching-works)
  - [Traffic Classification](#traffic-classification)
  - [Cache Flow](#cache-flow)
  - [Document Caching (HTML)](#document-caching-html)
  - [Deduplication](#deduplication)
  - [Eviction Policy](#eviction-policy)
- [Logging System](#logging-system)
  - [QTE Logger Compatibility](#qte-logger-compatibility)
  - [Log Levels](#log-levels)
  - [Log File Format](#log-file-format)
- [Cache Report](#cache-report)
- [Stealth Compatibility](#stealth-compatibility)
- [Troubleshooting](#troubleshooting)

---

## Overview

**CacheModule** is an extracted and adapted version of [CDN_EDGEProxy](https://github.com/lokah1945/CDN_EDGEProxy) v4.1.1, repackaged as a self-contained module for integration with QuantumTrafficEngine (QTE).

### What it does

- Intercepts all network requests via Playwright's `context.route("**/*")` API
- Caches static assets (CSS, JS, images, fonts, media) with content-addressable blob storage
- Conditional caching for HTML documents (ETag / Last-Modified revalidation)
- Bypasses ad/tracking/beacon requests (auction, measurement, analytics)
- Deduplicates identical resources across different URLs (SHA-256 content hash)
- Provides bandwidth savings reports with per-origin and per-type breakdowns

### Design Principles for QTE Integration

| Principle | Implementation |
|-----------|----------------|
| **Zero console output** | Logger writes to file ONLY — QTE owns the terminal |
| **Self-contained** | All files under `./CacheModule/` — no global side effects |
| **No dependency conflicts** | Uses only Node.js built-in modules (fs, path, crypto) |
| **Opt-in activation** | Controlled by `CACHE_DEBUG=true` in QTE's `.env` file |
| **Non-blocking** | Cache miss → transparent pass-through, zero delay |
| **Stealth-safe** | No fingerprint-detectable headers or behavior changes |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    QuantumTrafficEngine (QTE)                    │
│                                                                 │
│  opsi4.js v20.x                                                 │
│    ├── PHASE 6: BrowserLauncher.launchBrowser(...)               │
│    │     └── returns { browser, context, page }                  │
│    │                                                             │
│    ├── ★ NEW: CacheModule Integration Point                      │
│    │     ├── const cache = new EdgeCacheRuntime(config)           │
│    │     ├── await cache.init()                                  │
│    │     ├── await cache.attach(context)  ← hooks route("**/*") │
│    │     │                                                       │
│    │     │   ┌─────────────────────────────────────┐             │
│    │     │   │         CacheModule/runtime.js       │             │
│    │     │   │                                      │             │
│    │     │   │  TrafficClassifier                   │             │
│    │     │   │    ├── Class A (auction) → BYPASS     │             │
│    │     │   │    ├── Class B (beacon)  → BYPASS     │             │
│    │     │   │    └── Class C (static)  → CACHE      │             │
│    │     │   │                                      │             │
│    │     │   │  RequestHandler                      │             │
│    │     │   │    ├── Fresh HIT    → route.fulfill() │             │
│    │     │   │    ├── Stale 304    → revalidate      │             │
│    │     │   │    ├── MISS         → route.fetch()   │             │
│    │     │   │    └── Document     → conditional GET  │             │
│    │     │   │                                      │             │
│    │     │   │  StorageEngine                       │             │
│    │     │   │    ├── SHA-256 content-addressable    │             │
│    │     │   │    ├── Blob deduplication             │             │
│    │     │   │    ├── LRU eviction                   │             │
│    │     │   │    └── Alias index (URL variants)     │             │
│    │     │   │                                      │             │
│    │     │   │  Logger (FILE-ONLY)                  │             │
│    │     │   │    └── ./CacheModule/logs/            │             │
│    │     │   └─────────────────────────────────────┘             │
│    │     │                                                       │
│    │     └── await cache.shutdown()                               │
│    │                                                             │
│    ├── PHASE 7: page.goto(targetUrl)                              │
│    └── PHASE 8: runRuntimeValidation(page, fp, workerId)          │
└─────────────────────────────────────────────────────────────────┘
```

### Request Flow

```
Browser Request
      │
      ▼
context.route("**/*") ─── RequestHandler.handle(route)
      │
      ├── method !== GET? ──────────────────────── route.continue()
      ├── resourceType === "document"? ──────────── _handleDocument()
      │     ├── Has ETag/Last-Modified in cache? → conditional GET (If-None-Match / If-Modified-Since)
      │     │     ├── 304 Not Modified → serve from cache (DOC-HIT)
      │     │     └── 200 Changed → update cache, serve new body
      │     └── No cache entry → fetch, cache if has validators
      │
      ├── Non-cacheable type? ──────────────────── route.continue()
      │
      ├── TrafficClassifier.classify()
      │     ├── Class A (auction/decisioning) ──── route.continue() [BYPASS]
      │     ├── Class B (measurement/beacon) ───── route.continue() [BYPASS]
      │     └── Class C (creative/static) ──────── CACHE PATH ▼
      │
      ├── Cache Lookup (key + alias)
      │     ├── FRESH HIT ──────────────────────── route.fulfill() [from blob]
      │     ├── STALE + validators ─────────────── conditional revalidation
      │     │     ├── 304 → refresh TTL, serve cached [HIT-304]
      │     │     ├── 200 → update blob, serve new [MISS-UPDATE]
      │     │     └── Error → serve stale [STALE-HIT]
      │     └── No entry ──────────────────────── fetch + store [MISS]
      │
      └── Error in handler? ────────────────────── route.continue() [failsafe]
```

---

## Directory Structure

```
project-root/                      ← QTE root (where opsi4.js lives)
├── .env                           ← QTE environment (CACHE_DEBUG=true activates CacheModule logger)
├── opsi4.js                       ← QTE main entry (v20.0.34)
├── BrowserLauncher.js             ← QTE browser launcher (v8.21.0)
│
└── CacheModule/                   ← ★ Self-contained cache module
    ├── runtime.js                 ← Public API — EdgeCacheRuntime class
    ├── README.md                  ← This file
    │
    ├── config/
    │   └── default.json           ← Traffic routing patterns + cache defaults
    │
    ├── lib/                       ← Core engine files (from CDN_EDGEProxy v4.1.1)
    │   ├── logger.js              ← Modified: FILE-ONLY, no console output
    │   ├── RequestHandler.js      ← Unchanged from repo
    │   ├── StorageEngine.js       ← Unchanged from repo
    │   ├── TrafficClassifier.js   ← Unchanged from repo
    │   └── URLNormalizer.js       ← Unchanged from repo
    │
    ├── logs/                      ← Auto-created when CACHE_DEBUG=true
    │   ├── edgeproxy-2026-03-03.log
    │   └── edgeproxy-2026-03-04.log
    │
    └── data/
        └── cdn-cache/             ← Auto-created on init()
            ├── index.json         ← Cache metadata index
            ├── alias-index.json   ← URL alias → canonical key mapping
            └── blobs/             ← Content-addressable blob storage
                ├── a1/
                │   └── a1b2c3...  ← SHA-256 named blob files
                └── f7/
                    └── f7e8d9...
```

---

## Installation

### Step 1: Copy Files

```bash
# From QTE project root
mkdir -p CacheModule/config CacheModule/lib

# Copy runtime (new file)
cp /path/to/runtime.js CacheModule/runtime.js

# Copy config
cp /path/to/CDN_EDGEProxy/config/default.json CacheModule/config/default.json

# Copy lib files
cp /path/to/logger.js   CacheModule/lib/logger.js    # ← Modified version
cp /path/to/CDN_EDGEProxy/lib/RequestHandler.js    CacheModule/lib/
cp /path/to/CDN_EDGEProxy/lib/StorageEngine.js     CacheModule/lib/
cp /path/to/CDN_EDGEProxy/lib/TrafficClassifier.js CacheModule/lib/
cp /path/to/CDN_EDGEProxy/lib/URLNormalizer.js     CacheModule/lib/
```

### Step 2: Verify Structure

```bash
# Quick verification
node -e "const { EdgeCacheRuntime } = require('./CacheModule/runtime'); console.log('✅ CacheModule loaded successfully');"
```

### Step 3: No npm install needed

CacheModule uses **zero external dependencies**. All imports are Node.js built-in modules:

| Module | Usage |
|--------|-------|
| `fs` | File I/O for blob storage, index persistence, log writing |
| `path` | Path resolution for cross-platform compatibility |
| `crypto` | SHA-256 hashing for cache keys and blob deduplication |

---

## Configuration

### Environment Variables

Add to your QTE `.env` file:

```env
# ══════════════════════════════════════════════════
# CacheModule Configuration
# ══════════════════════════════════════════════════

# CacheModule Logger — dedicated env var (does NOT conflict with QTE DEBUG/DEBUGMODE)
# When true  → logs written to ./CacheModule/logs/edgeproxy-YYYY-MM-DD.log
# When false → completely silent (default)
CACHE_DEBUG=true

# Optional: Override cache directory (default: ./CacheModule/data/cdn-cache)
# CACHE_DIR=./CacheModule/data/cdn-cache

# Optional: Override max cache size in bytes (default: 2TB)
# CACHE_MAX_SIZE=2199023255552

# Optional: Override cache TTL in ms (default: 86400000 = 24h)
# CACHE_MAX_AGE=86400000
```

> **Important:** `CACHE_DEBUG` is a dedicated env var for CacheModule only — it does NOT conflict with QTE's own `DEBUG` or `DEBUGMODE` env vars. When `CACHE_DEBUG` is not set or is `false`, CacheModule produces **zero output** — no files, no console, no side effects.

### Config File

`CacheModule/config/default.json` — Traffic routing patterns:

```json
{
  "routing": {
    "classA": {
      "name": "auction/decisioning",
      "action": "bypass",
      "patterns": [
        "*/ad?*", "*/ads?*", "*/adx?*", "*/bid*",
        "*/auction*", "*/rtb*", "*/prebid*",
        "*/header-bidding*", "*securepubads*gpt.js*",
        "*pagead2*googlesyndication*", "*openx.net/w/*"
      ]
    },
    "classB": {
      "name": "measurement/beacon",
      "action": "bypass",
      "patterns": [
        "*/pixel*", "*/beacon*", "*/track*",
        "*/analytics*", "*/collect*", "*/log?*",
        "*/event?*", "*/impression*",
        "*facebook.com/tr*", "*google-analytics.com/collect*",
        "*doubleclick.net/pcs/view*",
        "*doubleclick.net/pagead/adview*"
      ]
    },
    "classC": {
      "name": "creative/static",
      "action": "cache",
      "description": "All cacheable static assets + HTML (conditional)"
    }
  },
  "cache": {
    "maxSize": 2199023255552,
    "maxAge": 86400000,
    "dir": "data/cdn-cache"
  }
}
```

You can customize routing patterns to match your target sites. Class A/B requests are **always bypassed** (never cached), ensuring ad auctions and tracking pixels work correctly.

### Constructor Options

```javascript
const cache = new EdgeCacheRuntime({
  // Cache storage directory
  // Default: ./CacheModule/data/cdn-cache
  cacheDir: "./CacheModule/data/cdn-cache",

  // Maximum cache size in bytes
  // Default: 2199023255552 (2 TB)
  maxSize: 2199023255552,

  // Cache TTL in milliseconds
  // Default: 86400000 (24 hours)
  maxAge: 86400000,

  // Traffic routing patterns (overrides default.json)
  // Default: loaded from ./CacheModule/config/default.json
  routing: { /* classA, classB, classC */ },

  // Force logger on/off (overrides process.env.CACHE_DEBUG)
  // Default: reads from process.env.CACHE_DEBUG
  debug: true,
});
```

---

## Integration Guide

### Quick Start

Minimal integration — 4 lines of code:

```javascript
const { EdgeCacheRuntime } = require("./CacheModule/runtime");

const cache = new EdgeCacheRuntime();
await cache.init();
await cache.attach(context);  // Playwright BrowserContext

// ... browser automation runs, cache is transparently active ...

await cache.shutdown();
```

### Integration with opsi4.js

CacheModule menggunakan **singleton pattern** — satu instance `EdgeCacheRuntime` dibuat di `main()` dan di-share ke semua worker. Lihat [CDN Transparent Cache — Shared Architecture](#cdn-transparent-cache--shared-across-all-workers) untuk detail lengkap.

**Summary integration points:**

| Location | Change | Code |
|----------|--------|------|
| `main()` — sebelum launch workers | Init cache singleton | `const cdnCache = new EdgeCacheRuntime(); await cdnCache.init();` |
| `main()` — launch worker call | Pass cache ke worker | `runMode4Worker(i+1, browser, useProxy, url, cdnCache)` |
| `runMode4Worker()` — PHASE 6.5 | Attach context | `await cdnCache.attach(context);` |
| `runMode4Worker()` — finally | Detach context only | `await cdnCache.detach(context);` |
| `main()` — after all workers | Shutdown + report | `console.log(cdnCache.getReport()); await cdnCache.shutdown();` |
| `process.on("SIGINT")` | Graceful flush | `await cdnCache.shutdown();` |

> **Penting:** Worker memanggil `detach()`, bukan `shutdown()`. Cache tetap hidup selama ada worker lain yang masih berjalan. `shutdown()` hanya dipanggil SEKALI di `main()`.

### Integration with BrowserLauncher.js

**No changes needed to BrowserLauncher.js.** CacheModule operates at the `context` level, not at the browser launch level. The integration happens in the caller (opsi4.js) after `launchBrowser()` returns.

This is by design:
- BrowserLauncher handles **stealth injection** (CDP, scripts, fingerprint emulation)
- CacheModule handles **network caching** (route interception, blob storage)
- Both operate on the same `BrowserContext` without conflict

### Route Interception Order

Playwright processes route handlers in **LIFO (Last In, First Out)** order. Since CacheModule attaches AFTER BrowserLauncher finishes:

```
Request → CacheModule.handle() → [Cache HIT? serve] → [MISS? route.continue()]
                                                              │
                                                              ▼
                                                    (falls through to browser)
```

CacheModule's `route.continue()` lets the request proceed normally to the network. BrowserLauncher's CDP-level injections (stealth, emulation) operate at a different layer (protocol level) and are **not affected** by route interception.

### CDN Transparent Cache — Shared Across All Workers

CacheModule beroperasi sebagai **CDN transparent layer** — satu instance cache melayani semua worker, semua profile, semua session. Ini persis seperti cara CDN sungguhan bekerja: Cloudflare/Fastly tidak membuat cache terpisah per visitor — satu edge node menyimpan resource untuk semua orang.

```
┌─────────────────────────────────────────────────────────────────┐
│                    QTE main() — Single Process                   │
│                                                                 │
│  ┌───────────────────────────────────────────────────┐          │
│  │  EdgeCacheRuntime (SINGLETON)                      │          │
│  │  ┌─────────────────────────────────────────────┐   │          │
│  │  │ StorageEngine                                │   │          │
│  │  │  index.json ← all entries, all workers       │   │          │
│  │  │  blobs/     ← SHA-256 content-addressable    │   │          │
│  │  │  alias-index.json ← URL variant → canonical  │   │          │
│  │  └─────────────────────────────────────────────┘   │          │
│  └────────┬──────────┬──────────┬─────────────────────┘          │
│           │          │          │                                 │
│     attach(ctx1) attach(ctx2) attach(ctx3)                       │
│           │          │          │                                 │
│  ┌────────▼──┐ ┌─────▼────┐ ┌──▼─────────┐                      │
│  │ Worker W1 │ │ Worker W2 │ │ Worker W3  │                      │
│  │ Profile-A │ │ Profile-B │ │ Profile-C  │                      │
│  │ Edge/US   │ │ Chrome/ID │ │ Firefox/JP │                      │
│  └───────────┘ └──────────┘ └────────────┘                      │
│                                                                 │
│  W1 visits browserscan.net → MISS → fetch + store blob          │
│  W2 visits browserscan.net → HIT  → serve from same blob        │
│  W3 visits browserscan.net → HIT  → serve from same blob        │
│                                                                 │
│  All workers benefit from each other's cache entries.            │
│  Cross-profile, cross-session, cross-browser — one CDN cache.   │
└─────────────────────────────────────────────────────────────────┘
```

#### Why Shared Cache?

| Benefit | Explanation |
|---------|-------------|
| **Maximum dedup** | Same jQuery/React/font served to W1 and W2 → stored once, served twice |
| **Instant warm-up** | W2 launches 30s after W1 → W2 immediately gets cache HITs from W1's fetches |
| **Cross-session persistence** | Cache survives browser restart — next `node opsi4.js` run starts with warm cache |
| **Cross-profile** | Different fingerprint profiles (US Edge, ID Chrome, JP Firefox) share the same CDN layer |
| **Bandwidth savings compound** | 10 workers visiting the same site → 1× fetch + 9× cache HIT |
| **Disk efficiency** | Content-addressable blobs — identical files stored once regardless of URL |

#### Integration Pattern — Singleton in main()

The cache instance is created **once** in `main()` and passed to all workers:

```javascript
// ═══════════════════════════════════════════════════════════
// opsi4.js — main() function
// ═══════════════════════════════════════════════════════════

const { EdgeCacheRuntime } = require("./CacheModule/runtime");

async function main() {
  // ... STEP 1-6 (existing QTE init: DB, DeviceManager, Proxy, etc.) ...

  // ★ STEP 6.5: Initialize CDN Cache (ONCE, before any worker)
  const cdnCache = new EdgeCacheRuntime();
  await cdnCache.init();
  console.log("[CDN] EdgeProxy cache initialized — transparent CDN active");

  // STEP 7: LAUNCH WORKERS — pass shared cache
  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(runMode4Worker(i + 1, browser, useProxy, url, cdnCache));
    if (i < count - 1) await new Promise(r => setTimeout(r, 2000));
  }
  await Promise.all(promises);

  // ★ FINAL: Print report + shutdown (after all workers done)
  console.log(cdnCache.getReport());
  await cdnCache.shutdown();
}
```

#### Worker Function — Attach Context

Each worker attaches its own `BrowserContext` to the shared cache:

```javascript
// ═══════════════════════════════════════════════════════════
// opsi4.js — runMode4Worker function
// ═══════════════════════════════════════════════════════════

async function runMode4Worker(workerId, browserType, useProxy, targetUrl, cdnCache) {
  const WID = `W${workerId}`;

  // ... PHASE 1-6 unchanged (slot, fingerprint, proxy, browser launch) ...

  const launchResult = await BrowserLauncher.launchBrowser(/* ... */);
  ({ browser } = launchResult);
  context = launchResult.context;
  page = launchResult.page;

  // ══════════════════════════════════════════════════════════
  // ★ PHASE 6.5: Attach to shared CDN Cache
  // ══════════════════════════════════════════════════════════
  if (cdnCache) {
    try {
      await cdnCache.attach(context);
      console.log(`${WID} ✓ CDN cache attached (shared transparent layer)`);
    } catch (cacheErr) {
      console.warn(`${WID} ⚠ CDN cache attach failed: ${cacheErr.message} (non-fatal)`);
    }
  }

  // PHASE 7: NAVIGATION (unchanged)
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // PHASE 8: RUNTIME VALIDATION (unchanged)
  await runRuntimeValidation(page, fp, workerId);

  // ... rest unchanged ...
}
```

#### Cleanup — Detach in finally, Shutdown in main

```javascript
// In runMode4Worker's finally block:
finally {
  // ★ Detach this worker's context from shared cache (NOT shutdown)
  if (cdnCache && context) {
    try { await cdnCache.detach(context); } catch (_) {}
  }

  // ... existing cleanup (page.close, context.close, browser.close, etc.) ...
}

// In main() — AFTER all workers finish:
// ★ Shutdown cache ONCE (flushes index, closes logger)
console.log(cdnCache.getReport());
await cdnCache.shutdown();
```

> **Critical distinction:** Each worker calls `detach(context)` — this removes the route interception from that specific context. But `shutdown()` is called only ONCE in `main()` after all workers are done. This ensures the cache index stays alive while any worker is still running.

#### SIGINT Handler Update

```javascript
// Update existing SIGINT handler in opsi4.js:
process.on("SIGINT", async () => {
  console.log("GRACEFUL CLEANUP (SIGINT)");
  try {
    // ★ CDN Cache final flush
    if (cdnCache) {
      console.log(cdnCache.getReport());
      await cdnCache.shutdown();
    }
    // ... existing cleanup (ClashManager, ProxyAPI, DeviceManager, etc.) ...
  } catch (e) {
    console.error("Cleanup error:", e.message);
  }
  process.exit(0);
});
```

#### Session Persistence

Cache data persists on disk between QTE runs:

```
Run 1: node opsi4.js (10 workers visit browserscan.net)
  → 500 resources fetched from network (MISS)
  → Cache: 500 entries, 340 unique blobs, 45MB

Run 2: node opsi4.js (10 workers visit browserscan.net again)
  → 12 resources fetched (changed since Run 1)
  → 488 resources served from cache (HIT)
  → Cache: 512 entries, 348 unique blobs, 46MB
  → Bandwidth saved: ~97%

Run 3: node opsi4.js (10 workers visit different pages on same site)
  → Shared CSS/JS/fonts → HIT (already cached from Run 1-2)
  → Page-specific images → MISS (new)
  → Cache keeps growing, dedup keeps saving
```

#### Standalone Test (No opsi4.js Changes)

Test the shared cache concept without modifying QTE:

```javascript
// test-cdn-cache.js
const { EdgeCacheRuntime } = require("./CacheModule/runtime");
const { chromium } = require("playwright");

(async () => {
  const cache = new EdgeCacheRuntime({ debug: true });
  await cache.init();

  // Launch 3 "workers" — all share the same CDN cache
  const browser = await chromium.launch({ headless: false });

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const ctx3 = await browser.newContext();

  await cache.attach(ctx1);
  await cache.attach(ctx2);
  await cache.attach(ctx3);

  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();
  const p3 = await ctx3.newPage();

  // Worker 1 fetches first — all MISS
  await p1.goto("https://browserscan.net");
  console.log("W1 done:", cache.getStats());

  // Worker 2 same site — mostly HIT from W1's cache
  await p2.goto("https://browserscan.net");
  console.log("W2 done:", cache.getStats());

  // Worker 3 same site — all HIT
  await p3.goto("https://browserscan.net");
  console.log("W3 done:", cache.getStats());

  // Full report
  console.log(cache.getReport());

  await cache.shutdown();
  await browser.close();
})();
```
---

## API Reference

### EdgeCacheRuntime

```javascript
const { EdgeCacheRuntime, VERSION } = require("./CacheModule/runtime");
```

### Methods

#### `constructor(config?)`

Creates a new EdgeCacheRuntime instance. Does NOT initialize anything — call `init()` first.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.cacheDir` | `string` | `./CacheModule/data/cdn-cache` | Cache storage directory |
| `config.maxSize` | `number` | `2199023255552` (2 TB) | Maximum cache size in bytes |
| `config.maxAge` | `number` | `86400000` (24h) | Cache TTL in milliseconds |
| `config.routing` | `object` | from `default.json` | Traffic routing patterns |
| `config.debug` | `boolean` | `process.env.CACHE_DEBUG` | Override logger activation |

---

#### `async init()`

Initializes the logger, storage engine, traffic classifier, and request handler. Must be called before `attach()`. Safe to call multiple times (idempotent).

```javascript
await cache.init();
```

**What happens during init:**
1. Logger initialized (file-only if CACHE_DEBUG=true, silent if false)
2. Cache directory created (`mkdirSync recursive`)
3. Existing cache index loaded from disk
4. Orphan entries cleaned up (blob files missing)
5. Alias index loaded
6. All blobs pre-loaded into RAM
7. Classifier + Handler instantiated

---

#### `async attach(context)`

Hooks CDN cache route interception onto a Playwright `BrowserContext`. Intercepts ALL requests via `context.route("**/*")`.

```javascript
await cache.attach(context);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `context` | `BrowserContext` | Playwright browser context |

**Throws** if `init()` has not been called.
**No-op** if context is already attached (safe to call multiple times).

---

#### `async detach(context)`

Removes CDN cache route interception from a `BrowserContext`.

```javascript
await cache.detach(context);
```

---

#### `getReport()`

Returns a formatted cache report string.

```javascript
const report = cache.getReport();
console.log(report);
```

Returns `"CacheModule: Not initialized"` if called before `init()`.

---

#### `getStats()`

Returns raw cache statistics object.

```javascript
const stats = cache.getStats();
// { entries, aliases, uniqueBlobs, diskBytes, dedupHits }
```

---

#### `startReportTimer(intervalMs?)`

Starts periodic report logging to the log file.

```javascript
cache.startReportTimer(30000);  // Every 30 seconds
```

---

#### `stopReportTimer()`

Stops periodic report logging.

---

#### `async shutdown()`

Graceful shutdown: detaches all contexts, logs final report, flushes storage index to disk, closes logger file handle.

```javascript
await cache.shutdown();
```

**Always call this** in your cleanup/finally block to prevent data loss.

---

### Events & Lifecycle

```
constructor() → init() → attach(ctx) → [requests flow] → detach(ctx) → shutdown()
                  │                                              ▲
                  │         attach(ctx2) → [more requests] ──────┘
                  │
                  └── Multiple contexts can be attached simultaneously
```

CacheModule is **non-blocking** in all paths:
- Cache HIT: `route.fulfill()` with cached body (no network call)
- Cache MISS: `route.fetch()` → store → `route.fulfill()` (transparent)
- Error: `route.continue()` (failsafe, zero interference)

---

## How Caching Works

### Traffic Classification

Every request is classified before caching:

| Class | Name | Action | Examples |
|-------|------|--------|----------|
| **A** | Auction/Decisioning | BYPASS | `/bid*`, `/auction*`, `/rtb*`, `securepubads*`, `pagead2*` |
| **B** | Measurement/Beacon | BYPASS | `/pixel*`, `/beacon*`, `/track*`, `/analytics*`, `facebook.com/tr` |
| **C** | Creative/Static | CACHE | CSS, JS, images, fonts, media, XHR/fetch (with content-type check) |

Additionally, known ad infrastructure domains (28 patterns) are auto-detected:
`doubleclick`, `googlesyndication`, `googleadservices`, `google-analytics`, `googletagmanager`, `criteo`, `pubmatic`, `taboola`, `outbrain`, etc.

### Cache Flow

```
URL → URLNormalizer.canonicalKey() → SHA-256 → cache key
                                         │
                    ┌────────────────────┘
                    ▼
              StorageEngine.peekMeta(key)
                    │
        ┌───────────┼───────────────┐
        ▼           ▼               ▼
     FRESH       STALE+ETag      NO ENTRY
        │           │               │
   route.fulfill   conditional    route.fetch
   (from blob)     GET (304?)     + store blob
```

**URL Normalization** (via `URLNormalizer`):
- Strips tracking parameters (`utm_*`, `fbclid`, `gclid`, `_ga`, `_gl`, etc.)
- Normalizes query parameter order
- Creates alias keys for URL variants pointing to the same resource

### Document Caching (HTML)

HTML documents use a **always-revalidate** strategy:

1. First visit: Fetch normally. If response has `ETag` or `Last-Modified`, cache it.
2. Subsequent visits: Send conditional request with `If-None-Match` / `If-Modified-Since`.
3. Server returns `304 Not Modified` → serve cached body (saves bandwidth).
4. Server returns `200` → content changed, update cache.

This ensures HTML content is always fresh while saving bandwidth on unchanged pages.

### Deduplication

StorageEngine uses **content-addressable storage**:

```
URL-A → SHA-256(body) → hash: "a1b2c3..." → blob stored once
URL-B → SHA-256(body) → hash: "a1b2c3..." → same blob, dedup detected
```

If two different URLs serve identical content (common with CDNs that use multiple hostnames), the blob is stored only once. The `dedupSet` tracks which cache keys share blobs.

### Eviction Policy

When total cache size exceeds `maxSize`:
1. Sort all entries by `storedAt` (oldest first)
2. Evict oldest entries until size drops to 90% of `maxSize`
3. Delete orphan blob files (no remaining references)
4. Save updated index to disk

**Stale TTL**: Entries with validators (ETag/Last-Modified) are kept for `staleTTL` (30× maxAge or 7 days, whichever is greater) for conditional revalidation, even after body TTL expires.

---

## Logging System

### QTE Logger Compatibility

CacheModule's logger follows the QTE pattern:

| Aspect | QTE Logger | CacheModule Logger |
|--------|------------|-------------------|
| Activation | `CACHE_DEBUG=true` in `.env` | Same `CACHE_DEBUG=true` in `.env` |
| Console output | QTE manages terminal | **ZERO** — file only |
| File output | QTE has its own logs | `./CacheModule/logs/` (separate) |
| Live display | QTE's live dashboard | Disabled (`liveReport` is no-op) |
| Report | QTE's format | `printReport()` → file only |

**Why file-only?** QTE owns the terminal for its multi-worker output. CacheModule must not pollute console with cache HIT/MISS logs. All diagnostic information goes to log files that can be reviewed later.

### Log Levels

| Level | Name | What's logged |
|-------|------|---------------|
| 0 | SILENT | Nothing (default when `CACHE_DEBUG=false`) |
| 1 | ERROR | Storage corruption, critical failures |
| 2 | WARN | Stale-hit fallbacks, cleanup issues |
| 3 | INFO | Cache HIT/MISS/304, eviction, reports |
| 4 | DEBUG | Every request classification, URL normalization |

CacheModule uses level 4 (all) when CACHE_DEBUG=true, level 0 (silent) when false.

### Log File Format

```
=== CDN EdgeProxy v4.1.1 [CacheModule] — Log started 2026-03-03T10:25:00.000Z ===
2026-03-03T10:25:00.001Z INFO [Runtime] CDN EdgeProxy v4.1.1 — CacheModule initializing
2026-03-03T10:25:00.015Z INFO [Storage] Initialized: 847 entries, 312 aliases, 654 unique blobs, 127.3MB
2026-03-03T10:25:01.234Z DEBUG [CDN-HIT] stylesheet thirdparty https://cdn.example.com/style.css
2026-03-03T10:25:01.456Z INFO [MISS-UPDATE] script thirdparty https://cdn.example.com/app.js
2026-03-03T10:25:02.789Z DEBUG [HIT-304] image thirdparty https://cdn.example.com/hero.webp
```

Log files rotate daily: `edgeproxy-2026-03-03.log`, `edgeproxy-2026-03-04.log`, etc.

---

## Cache Report

Call `cache.getReport()` to get a formatted report:

```
════════════════════════════════════════════════════════════
 CDN EdgeProxy CACHE REPORT
════════════════════════════════════════════════════════════
 Cache entries: 847 | Aliases: 312 | Unique blobs: 654 | Dedup: 23
 RAM blobs: 654 (127.3MB) | Disk: 142.8MB
 HIT: 1,247 | MISS: 89 | 304-reval: 34 | Ratio: 93.3%

 Bandwidth (Resource / Uncompressed):
   Fetched: 23.4 MB | Served: 312.7 MB | Ratio: 13.4x

 By Origin:
   thirdparty  HIT: 1,102  MISS: 67  Saved: 278.5 MB
   ad          HIT: 145    MISS: 22  Saved: 34.2 MB

 By Type:
   stylesheet  HIT: 234  MISS: 12
   script      HIT: 456  MISS: 23
   image       HIT: 389  MISS: 34
   font        HIT: 89   MISS: 8
   document    HIT: 79   MISS: 12
════════════════════════════════════════════════════════════
```

---

## Stealth Compatibility

CacheModule is designed to be **stealth-safe** — it does not create any detectable fingerprint:

| Concern | Status | Detail |
|---------|--------|--------|
| Custom headers on cached responses | ✅ Safe | `x-edgeproxy: HIT` header is only on fulfilled responses, not visible to page JS (Playwright internal) |
| `Via: 1.1 CDN_EdgeProxy` | ✅ Safe | Added to outgoing conditional requests only, stripped from cached responses |
| Content-Encoding mismatch | ✅ Safe | `content-encoding`, `content-length`, `transfer-encoding` stripped from all fulfilled responses |
| Service Worker interference | ✅ Safe | QTE blocks service workers via `serviceWorkers: "block"` config |
| CDP emulation conflict | ✅ Safe | CacheModule uses `route()` API (network layer), CDP operates at protocol layer — orthogonal |
| Fingerprint script injection | ✅ Safe | CacheModule does NOT inject any scripts into pages |
| WebRTC / WebSocket | ✅ Safe | Only GET requests are intercepted; WS/WebRTC bypassed |
| CORS headers | ✅ Safe | `access-control-*` headers preserved in cached responses |

### Route Priority with Stealth

BrowserLauncher's stealth operates via:
- **CDP**: `Page.addScriptToEvaluateOnNewDocument`, `Emulation.*`, `Target.setAutoAttach`
- **Context**: `context.addInitScript()`

CacheModule operates via:
- **Context**: `context.route("**/*")`

These are **different Playwright APIs** and do not conflict. The CDP-level emulation runs before any page JS executes, while route interception operates at the network transport layer.

---

## Troubleshooting

### Cache not working — all requests are MISS

1. **Check init()**: Ensure `await cache.init()` completes before `cache.attach()`.
2. **Check attach order**: `cache.attach(context)` must be called BEFORE `page.goto()`.
3. **Check request method**: Only `GET` requests are cached. POST/PUT/DELETE pass through.
4. **Check traffic class**: Ad/tracking URLs are intentionally bypassed (Class A/B).
5. **Check resource type**: Only `stylesheet`, `script`, `image`, `font`, `media`, `fetch`, `xhr`, and `document` are cacheable.

### Log files not created

1. **Check `.env`**: Ensure `CACHE_DEBUG=true` is set (not `CACHE_DEBUG=1` or `CACHE_DEBUG=yes` — must be exactly `true`).
2. **Check permissions**: CacheModule needs write access to `./CacheModule/logs/`.
3. **Check init()**: Logger is only initialized during `cache.init()`.

### High memory usage

StorageEngine pre-loads all blob files into RAM on `init()`. For large caches:

```javascript
// Limit cache size to 512 MB
const cache = new EdgeCacheRuntime({
  maxSize: 512 * 1024 * 1024,  // 512 MB
});
```

### Cache persists across sessions (stale data)

The cache is designed to persist. To start fresh:

```bash
# Delete cache data
rm -rf ./CacheModule/data/cdn-cache

# Or just delete the index (keeps blobs, rebuilds on next init)
rm ./CacheModule/data/cdn-cache/index.json
rm ./CacheModule/data/cdn-cache/alias-index.json
```

### shutdown() not called — data loss

If your process crashes without calling `shutdown()`, the cache index may be slightly behind. StorageEngine uses a **debounced save** (2-second delay after writes) and writes to a temp file first (atomic rename). Most data is safe, but the last ~2 seconds of writes may be lost.

Always wrap in try/finally:

```javascript
try {
  await cache.attach(context);
  // ... work ...
} finally {
  await cache.shutdown();  // ← ALWAYS called
}
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 4.1.1-QTE | 2026-03-03 | Initial QTE integration: runtime.js, logger.js (file-only), README |
| 4.1.1 | — | Upstream: Document caching, wire bytes tracking, doc-specific stats |
| 4.1.0 | — | Upstream: Beacon detection, ad domain list, URL normalization |

---

## License

CDN EdgeProxy is maintained at [github.com/lokah1945/CDN_EDGEProxy](https://github.com/lokah1945/CDN_EDGEProxy).
CacheModule is an extracted integration module for QuantumTrafficEngine internal use.
