"use strict";

/**
 * CacheModule v6.2.0 — Comprehensive Test Suite
 *
 * Self-contained: no external test framework required.
 * Run: node test/test_v620.js
 *
 * Coverage:
 *   GROUP 1:  classifyOrigin — existing + v6.1.0 (14 tests)
 *   GROUP 2:  classifyOrigin — NEW v6.2.0 extended domains (8 tests)
 *   GROUP 3:  classifyOrigin — NEW structural patterns (14 tests)
 *   GROUP 4:  classify — beacon/fetch/xhr fix (4 tests)
 *   GROUP 5:  classify — VAST/SIMID/OMID (5 tests)
 *   GROUP 6:  classify — Privacy Sandbox (5 tests)
 *   GROUP 7:  classify — CTV/OTT (4 tests)
 *   GROUP 8:  canonicalKey — universal stripping v6.1.0 (6 tests)
 *   GROUP 9:  canonicalKey — NEW v6.2.0 params (6 tests)
 *   GROUP 10: aliasKey — 3-tier v6.1.0 (4 tests)
 *   GROUP 11: aliasKey — NEW v6.2.0 expanded domains (5 tests)
 *   GROUP 12: aliasKey — path timestamp detection (2 tests)
 *   GROUP 13: _looksLikeCacheBuster — enhanced (8 tests)
 *   GROUP 14: _hasPathTimestamp — NEW v6.2.0 (4 tests)
 *   GROUP 15: Runtime learning v6.1.0 (3 tests)
 *   GROUP 16: Enhanced learnAdDomain v6.2.0 (3 tests)
 *   GROUP 17: computeFreshness — immutable v6.2.0 (3 tests)
 *   GROUP 18: varyKey enhanced v6.2.0 (4 tests)
 *
 * Total: 102 test cases
 */

// ─── Imports ──────────────────────────────────────────────────────────────────
const { URLNormalizer }    = require("../lib/URLNormalizer");
const { TrafficClassifier } = require("../lib/TrafficClassifier");
const { computeFreshness } = require("../lib/StorageEngine");

// ─── Test harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let currentGroup = "";

function group(name) {
  currentGroup = name;
  console.log(`\n── ${name} ──`);
}

function test(name, actual, expected) {
  // Deep equality via JSON for objects, strict equality for primitives
  const actualStr   = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  const ok = actualStr === expectedStr;

  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      Expected: ${expectedStr}`);
    console.log(`      Got:      ${actualStr}`);
  }
}

// ─── Shared instances ─────────────────────────────────────────────────────────
const normalizer = new URLNormalizer();
const classifier = new TrafficClassifier();

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1: classifyOrigin — existing + v6.1.0 tests MUST still pass
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 1: classifyOrigin — existing + v6.1.0 domains");

test(
  "Google Adsense → ad",
  classifier.classifyOrigin("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"),
  "ad"
);
test(
  "DoubleClick → ad",
  classifier.classifyOrigin("https://ad.doubleclick.net/ddm/trackclk/N1234"),
  "ad"
);
test(
  "Criteo → ad",
  classifier.classifyOrigin("https://static.criteo.net/js/ld/publishertag.prebid.js"),
  "ad"
);
test(
  "Adform → ad",
  classifier.classifyOrigin("https://track.adform.net/serving/scripts/trackpoint/"),
  "ad"
);
test(
  "Jivox → ad",
  classifier.classifyOrigin("https://cdn.jivox.com/player/jivox-ad.js"),
  "ad"
);
test(
  "RTBHouse → ad",
  classifier.classifyOrigin("https://creatives.rtbhouse.com/banners/abc.html"),
  "ad"
);
test(
  "DoubleVerify → ad",
  classifier.classifyOrigin("https://cdn.doubleverify.com/dvtp_src.js"),
  "ad"
);
test(
  "IAS (iasds01) → ad",
  classifier.classifyOrigin("https://pixel.iasds01.com/analytics.js"),
  "ad"
);
test(
  "FreeWheel → ad",
  classifier.classifyOrigin("https://8562.v.fwmrm.net/ad/g/1"),
  "ad"
);
test(
  "Flashtalking → ad",
  classifier.classifyOrigin("https://servedby.flashtalking.com/imp/1/12345"),
  "ad"
);
test(
  "Innovid → ad",
  classifier.classifyOrigin("https://video.innovid.com/preroll/abc"),
  "ad"
);
test(
  "Normal API → thirdparty",
  classifier.classifyOrigin("https://api.example.com/v1/data"),
  "thirdparty"
);
test(
  "Normal website → thirdparty",
  classifier.classifyOrigin("https://www.example.com/page"),
  "thirdparty"
);
test(
  "CDN no ad pattern → thirdparty",
  classifier.classifyOrigin("https://cdn.mywebsite.com/assets/logo.png"),
  "thirdparty"
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2: classifyOrigin — NEW v6.2.0 extended domains
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 2: classifyOrigin — NEW v6.2.0 extended domains");

test(
  "33across → ad",
  classifier.classifyOrigin("https://ssc.33across.com/ps/?id=abc"),
  "ad"
);
test(
  "TripleLift → ad",
  classifier.classifyOrigin("https://ads.triplelift.com/header/auction?s=12345"),
  "ad"
);
test(
  "GumGum → ad",
  classifier.classifyOrigin("https://g2.gumgum.com/ads/js"),
  "ad"
);
test(
  "Nativo → ad",
  classifier.classifyOrigin("https://x.nativo.com/native/ad"),
  "ad"
);
test(
  "Connatix → ad",
  classifier.classifyOrigin("https://cds.connatix.com/p/vid/player.js"),
  "ad"
);
test(
  "SpringServe → ad",
  classifier.classifyOrigin("https://vid.springserve.com/vast/12345"),
  "ad"
);
test(
  "Magnite → ad",
  classifier.classifyOrigin("https://prebid-server.magnite.com/openrtb2/auction"),
  "ad"
);
test(
  "Prebid → ad",
  classifier.classifyOrigin("https://prebid.adnxs.com/pbs/v1/openrtb2/auction"),
  "ad"
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3: classifyOrigin — NEW structural patterns
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 3: classifyOrigin — structural hostname patterns");

test(
  "ads.* → ad",
  classifier.classifyOrigin("https://ads.publisher.com/banner"),
  "ad"
);
test(
  "ad.* → ad",
  classifier.classifyOrigin("https://ad.example.com/creative"),
  "ad"
);
test(
  "adserver.* → ad",
  classifier.classifyOrigin("https://adserver.mynetwork.com/impression"),
  "ad"
);
test(
  "serve.* → ad",
  classifier.classifyOrigin("https://serve.myads.com/banner"),
  "ad"
);
test(
  "creative.* → ad",
  classifier.classifyOrigin("https://creative.adnetwork.com/banner.html"),
  "ad"
);
test(
  "banner.* → ad",
  classifier.classifyOrigin("https://banner.myads.com/300x250"),
  "ad"
);
test(
  "vast.* → ad",
  classifier.classifyOrigin("https://vast.adserver.com/v1/tag"),
  "ad"
);
test(
  "tracking.* → ad (NEW v6.2.0)",
  classifier.classifyOrigin("https://tracking.publisher.com/event"),
  "ad"
);
test(
  "track.* → ad (NEW v6.2.0)",
  classifier.classifyOrigin("https://track.example.com/click"),
  "ad"
);
test(
  "pixel.* → ad (NEW v6.2.0)",
  classifier.classifyOrigin("https://pixel.adpartner.com/sync"),
  "ad"
);
test(
  "beacon.* → ad (NEW v6.2.0)",
  classifier.classifyOrigin("https://beacon.publisher.com/viewability"),
  "ad"
);
test(
  "delivery.* → ad (NEW v6.2.0)",
  classifier.classifyOrigin("https://delivery.adnetwork.com/serve"),
  "ad"
);
test(
  "tag.* → ad (NEW v6.2.0)",
  classifier.classifyOrigin("https://tag.adprovider.com/container"),
  "ad"
);
test(
  "tags.* → ad (NEW v6.2.0)",
  classifier.classifyOrigin("https://tags.adprovider.com/container"),
  "ad"
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4: classify — beacon/fetch/xhr fix (v6.1.0)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 4: classify — beacon/fetch/xhr resourceType fix");

test(
  "Fetch impression → class B",
  classifier.classify("https://tracking.example.com/impression?id=123", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "XHR pixel → class B",
  classifier.classify("https://pixel.example.com/pixel?id=123", "xhr"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "Image pixel → class B",
  classifier.classify("https://tracking.example.com/pixel?id=123", "image"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "Normal fetch (no beacon keyword) → class C",
  classifier.classify("https://api.example.com/data?page=1", "fetch"),
  { class: "C", origin: "thirdparty", action: "cache" }
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5: classify — VAST/SIMID/OMID (NEW v6.2.0)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 5: classify — VAST/SIMID/OMID/VPAID (NEW v6.2.0 B1)");

test(
  "URL with /simid/ → class B",
  classifier.classify("https://ad.example.com/simid/container", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "URL with /omid/ → class B",
  classifier.classify("https://ad.example.com/omid/verify", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "URL with /omidverification/ → class B",
  classifier.classify("https://ad.example.com/omidverification/session", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "URL with /vpaid/ → class B",
  classifier.classify("https://ad.example.com/vpaid/legacy", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "URL with /interactive/creative → class B",
  classifier.classify("https://ad.example.com/interactive/creative/v1", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6: classify — Privacy Sandbox (NEW v6.2.0)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 6: classify — Privacy Sandbox APIs (NEW v6.2.0 B2)");

test(
  "URL with /topics/ → class A",
  classifier.classify("https://example.com/topics/v1", "fetch"),
  { class: "A", origin: "thirdparty", action: "bypass" }
);
test(
  "URL with /protected-audience/ → class A",
  classifier.classify("https://example.com/protected-audience/bid", "fetch"),
  { class: "A", origin: "thirdparty", action: "bypass" }
);
test(
  "URL with /fledge/ → class A",
  classifier.classify("https://example.com/fledge/join", "fetch"),
  { class: "A", origin: "thirdparty", action: "bypass" }
);
test(
  "URL with /interest-group/ → class A",
  classifier.classify("https://example.com/interest-group/update", "fetch"),
  { class: "A", origin: "thirdparty", action: "bypass" }
);
test(
  "URL with /attribution-reporting/ → class A",
  classifier.classify("https://example.com/attribution-reporting/v1", "fetch"),
  { class: "A", origin: "thirdparty", action: "bypass" }
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7: classify — CTV/OTT (NEW v6.2.0)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 7: classify — CTV/OTT SSAI/DAI/CSAI (NEW v6.2.0 B4)");

test(
  "URL with /ssai/ → class B",
  classifier.classify("https://ad.example.com/ssai/manifest", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "URL with /dai/ → class B",
  classifier.classify("https://ad.example.com/dai/stream", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "URL with /csai/ → class B",
  classifier.classify("https://ad.example.com/csai/ad", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);
test(
  "URL with /ad-pod/ → class B",
  classifier.classify("https://ad.example.com/ad-pod/segment", "fetch"),
  { class: "B", origin: "ad", action: "bypass" }
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8: canonicalKey — universal stripping (v6.1.0 tests MUST pass)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 8: canonicalKey — universal stripping (v6.1.0)");

test(
  "Strip cb+ord, keep size",
  normalizer.canonicalKey("https://ad.example.com/ad?cb=12345&ord=67890&size=300x250"),
  "ad.example.com/ad?size=300x250"
);
test(
  "Strip consent params (gdpr_consent), keep size",
  normalizer.canonicalKey("https://ad.example.com/ad?gdpr_consent=XXXXX&size=300x250"),
  "ad.example.com/ad?size=300x250"
);
test(
  "Strip click-redirect params (click), keep size",
  normalizer.canonicalKey("https://ad.example.com/ad?click=http%3A%2F%2Fexample.com&size=300x250"),
  "ad.example.com/ad?size=300x250"
);
test(
  "Strip heuristic timestamp value, keep size",
  normalizer.canonicalKey("https://ad.example.com/ad?t=1678234567890&size=300x250"),
  "ad.example.com/ad?size=300x250"
);
test(
  "Path-only domain: tpc.googlesyndication.com → strips query",
  normalizer.canonicalKey("https://tpc.googlesyndication.com/simgad/12345?cb=1"),
  "tpc.googlesyndication.com/simgad/12345"
);
test(
  "Normal API: no stripping of functional params",
  normalizer.canonicalKey("https://api.example.com/data?page=1&limit=10"),
  "api.example.com/data?limit=10&page=1"
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 9: canonicalKey — NEW v6.2.0 params (C1)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 9: canonicalKey — NEW v6.2.0 params (C1)");

test(
  "Strip nonce param",
  normalizer.canonicalKey("https://ad.example.com/ad?nonce=abc123xyz789&size=300x250"),
  "ad.example.com/ad?size=300x250"
);
test(
  "Strip sig param",
  normalizer.canonicalKey("https://ad.example.com/ad?sig=abcdef123456&size=300x250"),
  "ad.example.com/ad?size=300x250"
);
test(
  "Strip token param",
  normalizer.canonicalKey("https://ad.example.com/ad?token=mytoken&size=300x250"),
  "ad.example.com/ad?size=300x250"
);
test(
  "Strip tcf param (consent C1)",
  normalizer.canonicalKey("https://ad.example.com/ad?tcf=abc&size=300x250"),
  "ad.example.com/ad?size=300x250"
);
test(
  "Strip dest param (click-redirect C1)",
  normalizer.canonicalKey("https://ad.example.com/ad?dest=http%3A%2F%2Flanding.com&size=300x250"),
  "ad.example.com/ad?size=300x250"
);
test(
  "Strip landingpage param (click-redirect C1)",
  normalizer.canonicalKey("https://ad.example.com/ad?landingpage=http%3A%2F%2Flanding.com&size=300x250"),
  "ad.example.com/ad?size=300x250"
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 10: aliasKey — 3-tier (v6.1.0 tests MUST pass)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 10: aliasKey — 3-tier (v6.1.0)");

test(
  "Tier 1: Google Adsense (known ad alias domain) → path-only alias",
  normalizer.aliasKey("https://tpc.googlesyndication.com/simgad/12345?cb=1&ord=2"),
  "alias|tpc.googlesyndication.com/simgad/12345"
);
test(
  "Tier 2: Static file (.js) → strip version params",
  normalizer.aliasKey("https://cdn.example.com/script.js?v=1.2.3"),
  "alias|cdn.example.com/script.js"
);
test(
  "Tier 3: Extensionless URL with cache-buster param → alias",
  normalizer.aliasKey("https://ad.example.com/creative?cb=12345&size=300x250"),
  "alias|ad.example.com/creative?size=300x250"
);
test(
  "No alias: normal API without cache-buster",
  normalizer.aliasKey("https://api.example.com/data?page=1&limit=10"),
  null
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 11: aliasKey — NEW v6.2.0 expanded domains (C4)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 11: aliasKey — NEW v6.2.0 expanded ad alias domains (C4)");

test(
  "cdn.criteo.com → Tier 1 alias (path-only)",
  normalizer.aliasKey("https://cdn.criteo.com/creative/abc123.jpg"),
  "alias|cdn.criteo.com/creative/abc123.jpg"
);
test(
  "cdn.flashtalking.com → Tier 1 alias (path-only)",
  normalizer.aliasKey("https://cdn.flashtalking.com/creative/banner.html"),
  "alias|cdn.flashtalking.com/creative/banner.html"
);
test(
  "cdn.jivox.com → Tier 1 alias (path-only)",
  normalizer.aliasKey("https://cdn.jivox.com/creative/ad.html"),
  "alias|cdn.jivox.com/creative/ad.html"
);
test(
  "cdn.ampproject.org → pathOnlyDomains in canonicalKey (C3)",
  normalizer.canonicalKey("https://cdn.ampproject.org/v0.js?v=1&cb=123"),
  "cdn.ampproject.org/v0.js"
);
test(
  "ib.adnxs.com → pathOnlyDomains in canonicalKey (C3)",
  normalizer.canonicalKey("https://ib.adnxs.com/getuid?cb=12345"),
  "ib.adnxs.com/getuid"
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 12: aliasKey — path timestamp detection (NEW v6.2.0 C2)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 12: aliasKey — path timestamp detection (NEW v6.2.0 C2)");

test(
  "URL with /creative/abc/1678234567890/300x250.jpg → alias strips timestamp segment",
  normalizer.aliasKey("https://cdn.network.com/creative/abc/1678234567890/300x250.jpg"),
  "alias|cdn.network.com/creative/abc/300x250.jpg"
);
test(
  "URL with /img/short123/file.jpg → no timestamp strip (segment too short)",
  normalizer.aliasKey("https://cdn.network.com/img/short123/file.jpg"),
  null
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 13: _looksLikeCacheBuster — enhanced (v6.1.0 + v6.2.0 C5)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 13: _looksLikeCacheBuster — enhanced detection");

test(
  "Unix timestamp 13 digits → true",
  normalizer._looksLikeCacheBuster("1678234567890"),
  true
);
test(
  "Unix timestamp 10 digits → true",
  normalizer._looksLikeCacheBuster("1678234567"),
  true
);
test(
  "UUID format → true",
  normalizer._looksLikeCacheBuster("550e8400-e29b-41d4-a716-446655440000"),
  true
);
test(
  "Long hex string (20 hex chars) → true",
  normalizer._looksLikeCacheBuster("abcdef1234567890abcd"),
  true
);
test(
  "Short number (3 digits) → false",
  normalizer._looksLikeCacheBuster("300"),
  false
);
test(
  "Normal string → false",
  normalizer._looksLikeCacheBuster("hello"),
  false
);
test(
  "Base64-like string 20+ chars → true (NEW v6.2.0 C5)",
  normalizer._looksLikeCacheBuster("ABCDEFGHIJKLMNOPQRSTUVwxyz=="),
  true
);
test(
  "Short base64-like under 20 chars → false (length guard)",
  normalizer._looksLikeCacheBuster("ABCDEFabcdef=="),
  false
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 14: _hasPathTimestamp (NEW v6.2.0 C2)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 14: _hasPathTimestamp — path-segment cache-buster detection");

test(
  "Path with 13-digit segment → found: true, segment removed",
  normalizer._hasPathTimestamp("/creative/abc/1678234567890/300x250.jpg"),
  { found: true, cleanPath: "/creative/abc/300x250.jpg" }
);
test(
  "Path with 10-digit segment → found: true, segment removed",
  normalizer._hasPathTimestamp("/creative/abc/1678234567/banner.jpg"),
  { found: true, cleanPath: "/creative/abc/banner.jpg" }
);
test(
  "Path with short number (3 digits) → found: false",
  normalizer._hasPathTimestamp("/img/300/banner.jpg"),
  { found: false, cleanPath: "/img/300/banner.jpg" }
);
test(
  "Path with no numbers → found: false",
  normalizer._hasPathTimestamp("/img/creative/banner.jpg"),
  { found: false, cleanPath: "/img/creative/banner.jpg" }
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 15: Runtime learning (v6.1.0 tests MUST pass)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 15: Runtime learning — learnAdDomain v6.1.0");

{
  const tc1 = new TrafficClassifier();
  tc1.learnAdDomain("unknown-ad-network.com", { "x-creative-id": "abc123" });
  test(
    "learnAdDomain from x-creative-id header → classifyOrigin returns ad",
    tc1.classifyOrigin("https://unknown-ad-network.com/ad"),
    "ad"
  );
}

{
  const tc2 = new TrafficClassifier();
  tc2.learnAdDomain("cors-ad-origin.com", { "access-control-allow-origin": "https://doubleclick.net" });
  test(
    "learnAdDomain from CORS pointing to known ad domain → classifyOrigin returns ad",
    tc2.classifyOrigin("https://cors-ad-origin.com/resource"),
    "ad"
  );
}

{
  const tc3 = new TrafficClassifier();
  tc3.learnAdDomain("normal-site.com", { "content-type": "application/json" });
  test(
    "learnAdDomain from non-ad headers → does NOT learn, classifyOrigin returns thirdparty",
    tc3.classifyOrigin("https://normal-site.com/resource"),
    "thirdparty"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 16: Enhanced learnAdDomain (NEW v6.2.0 B5)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 16: Enhanced learnAdDomain — NEW v6.2.0 B5 headers");

{
  const tc4 = new TrafficClassifier();
  tc4.learnAdDomain("newad-xadtype.com", { "x-ad-type": "banner" });
  test(
    "learnAdDomain from x-ad-type → classifyOrigin returns ad",
    tc4.classifyOrigin("https://newad-xadtype.com/ad"),
    "ad"
  );
}

{
  const tc5 = new TrafficClassifier();
  tc5.learnAdDomain("vast-server-xvast.com", { "x-vast-url": "https://ad.vast.xml" });
  test(
    "learnAdDomain from x-vast-url → classifyOrigin returns ad",
    tc5.classifyOrigin("https://vast-server-xvast.com/vast"),
    "ad"
  );
}

{
  const tc6 = new TrafficClassifier();
  tc6.learnAdDomain("creative-size-server.com", { "x-creative-size": "300x250" });
  test(
    "learnAdDomain from x-creative-size → classifyOrigin returns ad",
    tc6.classifyOrigin("https://creative-size-server.com/ad"),
    "ad"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 17: computeFreshness — immutable (NEW v6.2.0 A6)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 17: computeFreshness — immutable support (NEW v6.2.0 A6)");

test(
  "cache-control: public, immutable → 365 days in ms",
  computeFreshness({ "cache-control": "public, immutable" }, 86400000),
  365 * 24 * 60 * 60 * 1000
);
test(
  "cache-control: max-age=3600 → 3600000 ms",
  computeFreshness({ "cache-control": "max-age=3600" }, 86400000),
  3600000
);
test(
  "No cache-control header → returns defaultMaxAge",
  computeFreshness({}, 86400000),
  86400000
);

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 18: varyKey enhanced (NEW v6.2.0 C6)
// ─────────────────────────────────────────────────────────────────────────────
group("GROUP 18: varyKey — enhanced Accept-Language support (NEW v6.2.0 C6)");

{
  const baseKey = "example.com/ad";
  const acceptVal = "text/html,application/xhtml+xml";
  const langVal = "en-US,en;q=0.9";

  // Pre-computed MD5 hashes (first 8 chars):
  //   md5("text/html,application/xhtml+xml") = e0c21c6f...
  //   md5("en-US,en;q=0.9")                 = c73895d2...

  test(
    "Vary: Accept → appends |accept=<hash>",
    normalizer.varyKey(baseKey, { accept: acceptVal }, "Accept"),
    `${baseKey}|accept=e0c21c6f`
  );
  test(
    "Vary: Accept-Language → appends |lang=<hash>",
    normalizer.varyKey(baseKey, { "accept-language": langVal }, "Accept-Language"),
    `${baseKey}|lang=c73895d2`
  );
  test(
    "Vary: Accept, Accept-Language → appends both (accept first, then lang)",
    normalizer.varyKey(baseKey, { accept: acceptVal, "accept-language": langVal }, "Accept, Accept-Language"),
    `${baseKey}|accept=e0c21c6f|lang=c73895d2`
  );
  test(
    "No Vary header → returns canonicalKey unchanged",
    normalizer.varyKey(baseKey, { accept: acceptVal }, null),
    baseKey
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log("\n" + "═".repeat(60));
console.log(`CacheModule v6.2.0 Test Results`);
console.log("═".repeat(60));
console.log(`  Total:  ${total}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log("═".repeat(60));

if (failed > 0) {
  console.log(`\n  ✗ ${failed} test(s) FAILED — see details above.\n`);
  process.exit(1);
} else {
  console.log(`\n  ✓ All ${passed} tests PASSED.\n`);
  process.exit(0);
}
