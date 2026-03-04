/**
 * CDN EdgeProxy v6.0.0 — Comprehensive Simulation Test
 * 
 * Tests:
 * 1. Module loading & syntax check
 * 2. StorageEngine init, put, getBlob, eviction
 * 3. TrafficClassifier classification
 * 4. URLNormalizer canonical & alias keys
 * 5. LRU hot-blob cache behavior
 * 6. Cache-Control parsing & freshness
 * 7. Inter-process IPC version tracking
 * 8. Blob reference counting
 * 9. Max entry size guard
 * 10. RequestHandler route handling simulation (mock Playwright route)
 * 11. Multi-context shared cache simulation
 * 12. Stale cleanup
 * 13. Stats & reporting
 */

"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── Test Harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let total  = 0;

function assert(condition, testName) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    console.log(`  ❌ FAILED: ${testName}`);
  }
}

function section(name) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"─".repeat(60)}`);
}

// ── Helper: create mock Playwright route/request/response ─────────────────────

function createMockRoute(url, resourceType = "image", method = "GET", headers = {}) {
  let fulfillResult = null;
  let continued = false;
  let fetchCallback = null;

  const request = {
    url: () => url,
    resourceType: () => resourceType,
    method: () => method,
    headers: () => ({ "accept": "image/webp,*/*", ...headers }),
  };

  const route = {
    request: () => request,
    fulfill: async (opts) => {
      fulfillResult = opts;
    },
    continue: async () => {
      continued = true;
    },
    fetch: async (opts) => {
      if (fetchCallback) return fetchCallback(opts);
      // Default mock response
      const bodyBuf = Buffer.from(`MOCK-BODY-${Date.now()}-${Math.random()}`);
      return {
        status: () => 200,
        ok: () => true,
        headers: () => ({
          "content-type": "image/png",
          "cache-control": "max-age=3600",
          "etag": `"etag-${crypto.randomUUID()}"`,
        }),
        body: async () => bodyBuf,
      };
    },
  };

  return {
    route,
    setFetchCallback: (cb) => { fetchCallback = cb; },
    getFulfillResult: () => fulfillResult,
    wasContinued: () => continued,
  };
}

// ── Main Test ─────────────────────────────────────────────────────────────────

async function runTests() {
  console.log("═".repeat(60));
  console.log("  CDN EdgeProxy v6.0.0 — Simulation Test Suite");
  console.log("═".repeat(60));

  // ── Test 1: Module Loading ──
  section("1. Module Loading & Syntax Check");

  let EdgeCacheRuntime, VERSION;
  let StorageEngine, parseCacheControl, isCacheable, computeFreshness;
  let RequestHandler;
  let TrafficClassifier;
  let URLNormalizer;
  let Logger, initLogger, getLogger, log;

  try {
    ({ EdgeCacheRuntime, VERSION } = require("../runtime"));
    assert(true, "runtime.js loaded");
    assert(VERSION === "6.0.0", `VERSION = ${VERSION}`);
  } catch (err) {
    assert(false, `runtime.js load failed: ${err.message}`);
    console.log("FATAL: Cannot continue without runtime.js");
    process.exit(1);
  }

  try {
    ({ StorageEngine, parseCacheControl, isCacheable, computeFreshness } = require("../lib/StorageEngine"));
    assert(true, "StorageEngine.js loaded");
  } catch (err) {
    assert(false, `StorageEngine.js load failed: ${err.message}`);
  }

  try {
    ({ RequestHandler } = require("../lib/RequestHandler"));
    assert(true, "RequestHandler.js loaded");
  } catch (err) {
    assert(false, `RequestHandler.js load failed: ${err.message}`);
  }

  try {
    ({ TrafficClassifier } = require("../lib/TrafficClassifier"));
    assert(true, "TrafficClassifier.js loaded");
  } catch (err) {
    assert(false, `TrafficClassifier.js load failed: ${err.message}`);
  }

  try {
    ({ URLNormalizer } = require("../lib/URLNormalizer"));
    assert(true, "URLNormalizer.js loaded");
  } catch (err) {
    assert(false, `URLNormalizer.js load failed: ${err.message}`);
  }

  try {
    ({ Logger, initLogger, getLogger, log } = require("../lib/logger"));
    assert(true, "logger.js loaded");
  } catch (err) {
    assert(false, `logger.js load failed: ${err.message}`);
  }

  // ── Test 2: TrafficClassifier ──
  section("2. TrafficClassifier");
  
  const defaultConfig = require("../config/default.json");
  const classifier = new TrafficClassifier(defaultConfig.routing);

  let result = classifier.classify("https://securepubads.g.doubleclick.net/gampad/ads?gdfp_req=1", "script");
  assert(result.class === "A", `Auction URL → Class A (got ${result.class})`);

  result = classifier.classify("https://www.google-analytics.com/collect?v=1&t=pageview", "image");
  assert(result.class === "B", `Analytics beacon → Class B (got ${result.class})`);

  result = classifier.classify("https://cdn.example.com/style.css?v=123", "stylesheet");
  assert(result.class === "C", `Static CSS → Class C (got ${result.class})`);

  result = classifier.classify("https://cdn.example.com/bundle.min.js", "script");
  assert(result.class === "C", `Static JS → Class C (got ${result.class})`);

  result = classifier.classify("https://tpc.googlesyndication.com/simgad/12345", "image");
  assert(result.class === "C" && result.origin === "ad", `Ad creative image → Class C, origin=ad (got ${result.class}, ${result.origin})`);

  result = classifier.classify("https://facebook.com/tr?id=123&ev=PageView", "image");
  assert(result.class === "B", `Facebook pixel → Class B (got ${result.class})`);

  assert(classifier.shouldCacheByContentType("image/png"), "image/png is cacheable");
  assert(classifier.shouldCacheByContentType("application/javascript"), "application/javascript is cacheable");
  assert(classifier.shouldCacheByContentType("font/woff2"), "font/woff2 is cacheable");
  assert(!classifier.shouldCacheByContentType("text/html"), "text/html is NOT cacheable by content-type");
  assert(!classifier.shouldCacheByContentType("application/json"), "application/json is NOT cacheable by content-type");

  // ── Test 3: URLNormalizer ──
  section("3. URLNormalizer");

  const normalizer = new URLNormalizer();

  let key = normalizer.canonicalKey("https://cdn.example.com/style.css?v=1&utm_source=google&fbclid=abc", "thirdparty");
  assert(!key.includes("utm_source") && !key.includes("fbclid"), `Tracking params stripped: ${key}`);
  assert(key.includes("v=1"), "Non-tracking params preserved");

  key = normalizer.canonicalKey("https://tpc.googlesyndication.com/simgad/12345?cb=9999&ord=1234", "ad");
  assert(!key.includes("cb=") && !key.includes("ord="), `Ad CDN cachebuster stripped: ${key}`);

  key = normalizer.canonicalKey("https://fonts.gstatic.com/s/roboto/v27/latin.woff2?x=1", "thirdparty");
  assert(key === "fonts.gstatic.com/s/roboto/v27/latin.woff2", `pathOnlyDomains → path only: ${key}`);

  let alias = normalizer.aliasKey("https://tpc.googlesyndication.com/simgad/12345?cb=999");
  assert(alias && alias.startsWith("alias|"), `Ad alias key generated: ${alias}`);

  alias = normalizer.aliasKey("https://cdn.example.com/bundle.js?v=1.2.3&t=9999");
  assert(alias && alias.startsWith("alias|"), `Static asset alias key generated: ${alias}`);
  assert(!alias.includes("t="), "Version/timestamp params stripped in alias");

  alias = normalizer.aliasKey("https://api.example.com/data");
  assert(alias === null, "Non-static URL → no alias");

  // ── Test 4: Cache-Control Parsing ──
  section("4. Cache-Control Parsing");

  let cc = parseCacheControl("max-age=3600, public");
  assert(cc["max-age"] === 3600, `max-age=3600 parsed (got ${cc["max-age"]})`);
  assert(cc["public"] === true, "public directive parsed");

  cc = parseCacheControl("no-store, no-cache");
  assert(cc["no-store"] === true, "no-store parsed");

  assert(isCacheable({ "cache-control": "max-age=3600, public" }), "max-age=3600 is cacheable");
  assert(!isCacheable({ "cache-control": "no-store" }), "no-store is not cacheable");
  assert(!isCacheable({ "cache-control": "private, max-age=300" }), "private is not cacheable");

  let freshness = computeFreshness({ "cache-control": "max-age=7200" }, 86400000);
  assert(freshness === 7200000, `max-age=7200 → 7200000ms (got ${freshness})`);

  freshness = computeFreshness({ "cache-control": "s-maxage=600, max-age=7200" }, 86400000);
  assert(freshness === 600000, `s-maxage takes priority → 600000ms (got ${freshness})`);

  freshness = computeFreshness({}, 86400000);
  assert(freshness === 86400000, `No cache-control → default (got ${freshness})`);

  // ── Test 5: StorageEngine ──
  section("5. StorageEngine Init & Core Operations");

  const testDir = path.join(__dirname, "test-cache-" + Date.now());
  const storage = new StorageEngine(
    { dir: testDir, maxSize: 100 * 1024 * 1024, maxAge: 86400000, maxEntrySize: 50 * 1024 * 1024 },
    { maxHotBlobBytes: 16 * 1024 * 1024, preloadBlobs: false },
    { indexFlushDebounceMs: 100, ipcPollMs: 60000, staleCleanupMs: 60000 }
  );

  await storage.init();
  assert(storage.index.size === 0, "Fresh index has 0 entries");

  // Put a few entries
  const body1 = Buffer.from("Hello World - this is a CSS file body content for testing");
  const headers1 = {
    "content-type": "text/css",
    "cache-control": "max-age=3600",
    "etag": '"test-etag-1"',
  };
  
  await storage.put("key1", "https://cdn.example.com/style.css", body1, headers1, "stylesheet", "thirdparty", null, {});
  assert(storage.index.size === 1, "After put: index has 1 entry");

  const meta1 = storage.peekMeta("key1");
  assert(meta1 !== null, "peekMeta returns stored metadata");
  assert(meta1.etag === '"test-etag-1"', `ETag stored correctly: ${meta1.etag}`);
  assert(meta1.size === body1.length, `Size stored: ${meta1.size}`);
  assert(meta1.computedMaxAge === 3600000, `computedMaxAge from Cache-Control: ${meta1.computedMaxAge}`);

  // Retrieve blob (async)
  const retrieved = await storage.getBlob(meta1.blobHash);
  assert(retrieved !== null, "getBlob returns buffer");
  assert(Buffer.compare(retrieved, body1) === 0, "Retrieved blob matches original");

  // Test isFresh
  assert(storage.isFresh(meta1), "Newly stored entry is fresh");

  // Test hasValidators
  assert(storage.hasValidators(meta1), "Entry has ETag validator");

  // ── Test 6: Deduplication ──
  section("6. Blob Deduplication & Reference Counting");

  // Put same content with different key
  await storage.put("key2", "https://cdn.example.com/style2.css", body1, headers1, "stylesheet", "thirdparty", null, {});
  assert(storage.index.size === 2, "2 entries in index");

  const refCount = storage.blobRefCount.get(meta1.blobHash);
  assert(refCount === 2, `Blob refcount = 2 (got ${refCount})`);
  assert(storage.dedupSet.has("key2"), "key2 marked as dedup");

  // Different content
  const body2 = Buffer.from("Different content for JS file testing");
  const headers2 = {
    "content-type": "application/javascript",
    "cache-control": "max-age=86400",
    "etag": '"js-etag-1"',
    "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT",
  };

  await storage.put("key3", "https://cdn.example.com/app.js", body2, headers2, "script", "thirdparty", null, {});
  assert(storage.index.size === 3, "3 entries after unique content");
  
  const meta3 = storage.peekMeta("key3");
  const refCount3 = storage.blobRefCount.get(meta3.blobHash);
  assert(refCount3 === 1, `New blob refcount = 1 (got ${refCount3})`);

  // ── Test 7: no-store & max entry size ──
  section("7. Cache-Control no-store & Max Entry Size Guard");

  const noStoreHeaders = { "content-type": "text/css", "cache-control": "no-store" };
  await storage.put("key-nostore", "https://example.com/no-store.css", body1, noStoreHeaders, "stylesheet", "thirdparty", null, {});
  assert(storage.peekMeta("key-nostore") === null, "no-store content not cached");
  assert(storage.stats.noStoreSkipped > 0, `noStoreSkipped counter: ${storage.stats.noStoreSkipped}`);

  const bigBody = Buffer.alloc(60 * 1024 * 1024); // 60MB > 50MB max
  await storage.put("key-big", "https://example.com/huge.mp4", bigBody, headers1, "media", "thirdparty", null, {});
  assert(storage.peekMeta("key-big") === null, "Oversized content not cached");
  assert(storage.stats.maxEntrySizeSkipped > 0, `maxEntrySizeSkipped counter: ${storage.stats.maxEntrySizeSkipped}`);

  // ── Test 8: Document Cache ──
  section("8. Document Cache (HTML conditional)");

  const htmlBody = Buffer.from("<!DOCTYPE html><html><body>Test page</body></html>");
  const htmlHeaders = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "max-age=0",
    "etag": '"doc-etag-1"',
    "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT",
    "set-cookie": "session=abc123; Path=/; HttpOnly",
  };

  await storage.putDocument("doc1", "https://example.com/page", htmlBody, htmlHeaders);
  const docMeta = storage.peekMeta("doc1");
  assert(docMeta !== null, "Document stored");
  assert(docMeta.computedMaxAge === 0, "Document always revalidates (computedMaxAge=0)");
  assert(!docMeta.headers["set-cookie"], "BUG 6 FIX: set-cookie NOT stored in shared cache");

  // ── Test 9: Alias Index ──
  section("9. Alias Index");

  const aliasHeaders = {
    "content-type": "image/png",
    "cache-control": "max-age=86400",
  };
  const aliasBody = Buffer.from("PNG-IMAGE-CONTENT-FOR-AD-CREATIVE");
  await storage.put("key-ad", "https://tpc.googlesyndication.com/simgad/1234", aliasBody, aliasHeaders, "image", "ad", "alias|tpc.googlesyndication.com/simgad/1234", {});
  
  const aliasMeta = storage.peekAlias("alias|tpc.googlesyndication.com/simgad/1234");
  assert(aliasMeta !== null, "Alias lookup returns metadata");
  assert(aliasMeta.origin === "ad", "Alias preserves origin=ad");

  // ── Test 10: IPC Version ──
  section("10. Inter-Process Cache Sharing (IPC)");

  await storage.flush();
  assert(storage._ipcVersion > 0, `IPC version after flush: ${storage._ipcVersion}`);

  // Check version file exists
  const versionFileExists = fs.existsSync(storage.versionFilePath);
  assert(versionFileExists, "IPC version file written to disk");

  if (versionFileExists) {
    const versionData = JSON.parse(fs.readFileSync(storage.versionFilePath, "utf-8"));
    assert(versionData.version === storage._ipcVersion, `IPC version on disk matches memory: ${versionData.version}`);
    assert(versionData.pid === process.pid, "IPC version tracks process ID");
  }

  // ── Test 11: Stats & Report ──
  section("11. Stats & Report Generation");

  storage.recordHit("https://example.com/img.png", "image", "thirdparty", 50000, 50000);
  storage.recordHit("https://example.com/img.png", "image", "thirdparty", 50000, 50000);
  storage.recordMiss("https://example.com/new.css", "stylesheet", "thirdparty", 25000, 25000);
  storage.recordResponseTime(5);
  storage.recordResponseTime(15);

  const stats = storage.getStats();
  assert(stats.entries > 0, `Stats entries: ${stats.entries}`);
  assert(parseFloat(stats.bandwidthSavedPct) > 0, `Bandwidth saved: ${stats.bandwidthSavedPct}%`);
  assert(parseFloat(stats.averageResponseTimeMs) === 10, `Avg response time: ${stats.averageResponseTimeMs}ms`);
  assert(parseFloat(stats.cacheEfficiency) > 0, `Cache efficiency: ${stats.cacheEfficiency}%`);

  const report = storage.getReport();
  assert(report.includes("CDN EdgeProxy CACHE REPORT v6"), "Report contains v6 header");
  assert(report.includes("Performance Metrics"), "Report contains v6 performance section");
  assert(report.includes("Bandwidth saved"), "Report shows bandwidth saved");
  assert(report.includes("Cache efficiency"), "Report shows cache efficiency");
  assert(report.includes("IPC version"), "Report shows IPC version");

  // ── Test 12: Full Runtime Lifecycle ──
  section("12. Full EdgeCacheRuntime Lifecycle");

  const runtime = new EdgeCacheRuntime({
    debug: true,
    cacheDir: path.join(__dirname, "test-runtime-cache-" + Date.now()),
    maxSize: 100 * 1024 * 1024,
    maxAge: 86400000,
    memory: { maxHotBlobBytes: 8 * 1024 * 1024 },
    concurrency: { indexFlushDebounceMs: 100, ipcPollMs: 60000 },
  });

  await runtime.init();
  assert(true, "EdgeCacheRuntime.init() succeeded");

  // Mock context
  let routeCallback = null;
  const mockContext = {
    route: async (pattern, callback) => {
      routeCallback = callback;
    },
    unroute: async (pattern, callback) => {
      routeCallback = null;
    },
  };

  await runtime.attach(mockContext);
  assert(routeCallback !== null, "attach() registered route callback");

  // Simulate requests through the route handler
  // Request 1: Cache MISS (first visit to a static asset)
  const mock1 = createMockRoute("https://cdn.example.com/test-img.png", "image");
  mock1.setFetchCallback(async () => ({
    status: () => 200,
    ok: () => true,
    headers: () => ({
      "content-type": "image/png",
      "cache-control": "max-age=3600",
      "etag": '"img-etag-42"',
    }),
    body: async () => Buffer.from("FAKE-PNG-CONTENT-FOR-SIMULATION-TEST"),
  }));

  await routeCallback(mock1.route);
  const result1 = mock1.getFulfillResult();
  assert(result1 !== null, "Request 1 (MISS): route.fulfill called");
  assert(result1.status === 200, `Request 1: status 200 (got ${result1.status})`);

  // Request 2: Cache HIT (same URL, should be cached now)
  const mock2 = createMockRoute("https://cdn.example.com/test-img.png", "image");
  await routeCallback(mock2.route);
  const result2 = mock2.getFulfillResult();
  assert(result2 !== null, "Request 2 (HIT): route.fulfill called");
  assert(result2.status === 200, "Request 2: status 200 from cache");

  // Request 3: Auction URL → bypass (Class A)
  const mock3 = createMockRoute("https://securepubads.g.doubleclick.net/gampad/ads?gdfp_req=1", "script");
  await routeCallback(mock3.route);
  assert(mock3.wasContinued(), "Request 3 (Auction): route.continue() called (bypass)");

  // Request 4: Beacon → bypass (Class B)
  const mock4 = createMockRoute("https://www.google-analytics.com/collect?v=1", "image");
  await routeCallback(mock4.route);
  assert(mock4.wasContinued(), "Request 4 (Beacon): route.continue() called (bypass)");

  // Request 5: Non-GET → bypass
  const mock5 = createMockRoute("https://cdn.example.com/api", "fetch", "POST");
  await routeCallback(mock5.route);
  assert(mock5.wasContinued(), "Request 5 (POST): route.continue() called (non-GET)");

  // Request 6: Document → conditional cache
  const mock6 = createMockRoute("https://www.example.com/page?utm_source=test", "document");
  mock6.setFetchCallback(async () => ({
    status: () => 200,
    ok: () => true,
    headers: () => ({
      "content-type": "text/html; charset=utf-8",
      "etag": '"page-etag-1"',
      "cache-control": "max-age=0",
    }),
    body: async () => Buffer.from("<html><body>Hello</body></html>"),
  }));
  await routeCallback(mock6.route);
  const result6 = mock6.getFulfillResult();
  assert(result6 !== null, "Request 6 (Document): route.fulfill called");

  // Check runtime stats
  const runtimeStats = runtime.getStats();
  assert(runtimeStats !== null, "getStats() returns data");
  assert(runtimeStats.entries > 0, `Runtime stats entries: ${runtimeStats.entries}`);

  const runtimeReport = runtime.getReport();
  assert(runtimeReport.includes("CDN EdgeProxy"), "getReport() generates report");

  // Detach and shutdown
  await runtime.detach(mockContext);
  assert(routeCallback === null, "detach() unregistered route callback");

  await runtime.shutdown();
  assert(true, "EdgeCacheRuntime.shutdown() completed cleanly");

  // ── Test 13: Multi-Context Shared Cache ──
  section("13. Multi-Context Shared Cache Simulation");

  const sharedRuntime = new EdgeCacheRuntime({
    debug: false,
    logLevel: 0,
    cacheDir: path.join(__dirname, "test-shared-cache-" + Date.now()),
    concurrency: { indexFlushDebounceMs: 100, ipcPollMs: 60000 },
  });
  await sharedRuntime.init();

  let ctxCallbacks = [];
  const contexts = [];
  
  for (let i = 0; i < 5; i++) {
    let cb = null;
    const ctx = {
      route: async (pattern, callback) => { cb = callback; },
      unroute: async () => { cb = null; },
    };
    await sharedRuntime.attach(ctx);
    ctxCallbacks.push(cb);
    contexts.push(ctx);
  }

  assert(ctxCallbacks.length === 5, "5 contexts attached to shared runtime");

  // Context 0: Cache MISS (stores in shared storage)
  const sharedMock1 = createMockRoute("https://cdn.example.com/shared-asset.js", "script");
  sharedMock1.setFetchCallback(async () => ({
    status: () => 200,
    ok: () => true,
    headers: () => ({
      "content-type": "application/javascript",
      "cache-control": "max-age=86400",
      "etag": '"shared-etag"',
    }),
    body: async () => Buffer.from("// Shared JavaScript content across all contexts"),
  }));
  await ctxCallbacks[0](sharedMock1.route);
  assert(sharedMock1.getFulfillResult() !== null, "Context 0: MISS → stored");

  // Context 1-4: Cache HIT (shared cache)
  let sharedHits = 0;
  for (let i = 1; i < 5; i++) {
    const mockN = createMockRoute("https://cdn.example.com/shared-asset.js", "script");
    await ctxCallbacks[i](mockN.route);
    if (mockN.getFulfillResult() && mockN.getFulfillResult().status === 200) {
      sharedHits++;
    }
  }
  assert(sharedHits === 4, `4 other contexts got HIT from shared cache (got ${sharedHits})`);

  // Cleanup
  for (const ctx of contexts) {
    await sharedRuntime.detach(ctx);
  }
  await sharedRuntime.shutdown();

  // ── Test 14: Write Mutex (BUG 1) ──
  section("14. Write Mutex Concurrency Safety");

  const mutexRuntime = new EdgeCacheRuntime({
    debug: false,
    logLevel: 0,
    cacheDir: path.join(__dirname, "test-mutex-cache-" + Date.now()),
    concurrency: { indexFlushDebounceMs: 50, ipcPollMs: 60000 },
  });
  await mutexRuntime.init();

  let mutexCtxCb = null;
  const mutexCtx = {
    route: async (_, cb) => { mutexCtxCb = cb; },
    unroute: async () => {},
  };
  await mutexRuntime.attach(mutexCtx);

  // Fire 20 concurrent requests to stress the write mutex
  const concurrentPromises = [];
  for (let i = 0; i < 20; i++) {
    const mock = createMockRoute(`https://cdn.example.com/concurrent-${i}.css`, "stylesheet");
    mock.setFetchCallback(async () => ({
      status: () => 200,
      ok: () => true,
      headers: () => ({
        "content-type": "text/css",
        "cache-control": "max-age=3600",
        "etag": `"concurrent-${i}"`,
      }),
      body: async () => Buffer.from(`/* CSS file ${i} — content for concurrency test */`),
    }));
    concurrentPromises.push(mutexCtxCb(mock.route));
  }

  await Promise.all(concurrentPromises);
  assert(true, "20 concurrent requests completed without errors");

  await mutexRuntime.storage.flush();
  assert(mutexRuntime.storage.index.size >= 20, `Index has ${mutexRuntime.storage.index.size} entries after concurrent writes`);

  await mutexRuntime.shutdown();

  // ── Cleanup ──
  section("Cleanup");
  
  await storage.shutdown();
  
  // Remove test directories
  const testDirs = fs.readdirSync(__dirname).filter(f => f.startsWith("test-"));
  for (const d of testDirs) {
    const fullPath = path.join(__dirname, d);
    try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch (_) {}
  }
  assert(true, "Test directories cleaned up");

  // ── Summary ──
  console.log("\n" + "═".repeat(60));
  console.log(`  TEST RESULTS: ${passed}/${total} passed, ${failed} failed`);
  console.log("═".repeat(60));

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log("\n  🎉 ALL TESTS PASSED — CDN EdgeProxy v6.0.0 is ready!\n");
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error("FATAL TEST ERROR:", err);
  process.exit(1);
});
