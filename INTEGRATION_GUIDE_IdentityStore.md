# IdentityStore v1.0 — Integration Guide
## Companion module to CacheManager v5.4 for QuantumTrafficEngine

---

## 📁 File Placement

```
QuantumTrafficEngine/
├── database.js                          ← sudah ada (shared MongoDB)
├── opsi5.js                             ← orchestrator (perlu modifikasi)
├── CacheModule/
│   ├── CacheManager.js                  ← v5.4, tidak diubah
│   ├── IdentityStore.js                 ← BARU — taruh di sini
│   └── config.json                      ← CacheManager config, tidak diubah
```

**Require path dari opsi5.js:**
```javascript
const IdentityStore = require('./CacheModule/IdentityStore');
```

**Require path ke database dari IdentityStore:**
```javascript
const { getDb } = require('../database');  // naik 1 level dari CacheModule/
```

---

## 🔧 Modifikasi opsi5.js — 5 Titik Integrasi

### 1. REQUIRE (bagian atas file)

Tambahkan di antara require statements yang sudah ada:

```javascript
// === Existing ===
const CacheManager = require('./CacheModule/CacheManager');

// === BARU ===
const IdentityStore = require('./CacheModule/IdentityStore');
```

---

### 2. PHASE 3.6 — Initialization (setelah CacheManager loadFromDisk)

Cari bagian dimana CacheManager di-initialize, tambahkan di bawahnya:

```javascript
// === STEP 3.5: CacheManager (sudah ada) ===
// await CacheManager.loadFromDisk();

// === STEP 3.6: IdentityStore (BARU) ===
console.log('[Identity] Initializing IdentityStore v1.0...');
await IdentityStore.initialize({ ttl: 24 * 60 * 60 * 1000 }); // 24 jam
console.log('[Identity] IdentityStore ready');
```

---

### 3. PHASE 6.7 — Inject Identity (setelah VisibilityGuard, SEBELUM page.goto)

Cari bagian PHASE 6.6 (Visibility Guard) dan tambahkan SETELAHNYA:

```javascript
// === PHASE 6.6: Visibility Guard (sudah ada) ===
// ...VisibilityGuard code...

// === PHASE 6.7: Identity Store — Returning Visitor Simulation (BARU) ===
console.log(`[${WID}]`);
console.log(`[${WID}] ═══ PHASE 6.7: Identity Store ═══`);
const currentIP = fp.network?.publicIP;
let isReturningVisitor = false;

if (currentIP && IdentityStore.initialized) {
    try {
        const identity = await IdentityStore.lookup(currentIP);
        if (identity) {
            await IdentityStore.inject(context, identity);
            isReturningVisitor = true;
        }
    } catch (idErr) {
        console.warn(`[${WID}] ⚠ IdentityStore inject failed: ${idErr.message}`);
    }
} else {
    if (!currentIP) console.log(`[${WID}] ⚠ No publicIP, skipping identity injection`);
}

// === PHASE 7: Navigation (sudah ada) ===
// await page.goto(targetUrl, ...);
```

**PENTING:** PHASE 6.7 HARUS sebelum `page.goto()` — karena `addInitScript` dan `addCookies` 
hanya efektif jika dipanggil sebelum navigasi pertama.

---

### 4. PHASE 8.5 — Capture Identity (setelah halaman load & runtime validation)

Cari bagian setelah PHASE 8 (runtime validation) atau setelah halaman fully loaded,
tambahkan SEBELUM session wait/idle:

```javascript
// === PHASE 8: Runtime Validation (sudah ada) ===
// ...runtime validation code...

// === PHASE 8.5: Identity Capture (BARU) ===
if (currentIP && IdentityStore.initialized) {
    try {
        console.log(`[${WID}] ═══ PHASE 8.5: Identity Capture ═══`);

        // Tunggu scripts adware selesai menulis localStorage
        await page.waitForLoadState('networkidle').catch(() => {});

        await IdentityStore.capture(currentIP, context, page, {
            targetOrigin: targetUrl ? new URL(targetUrl).origin : null,
            targetUrl: targetUrl,
            geo: validationResult ? {
                country: validationResult.country || validationResult.countryCode,
                region: validationResult.region,
                city: validationResult.city,
                timezone: validationResult.timezone,
                isp: validationResult.isp
            } : null
        });
    } catch (captureErr) {
        console.warn(`[${WID}] ⚠ Identity capture failed: ${captureErr.message}`);
    }
}

// === SESSION ACTIVE / Wait (sudah ada) ===
```

**CATATAN:** `validationResult` adalah output JSON dari `ip_validator.exe` yang sudah tersedia
dari PHASE 5. `targetUrl` adalah URL yang di-navigate di PHASE 7.

---

### 5. SHUTDOWN — Di SIGINT handler dan normal exit

Cari bagian SIGINT handler dan cleanup, tambahkan:

```javascript
// === Existing shutdown ===
// await CacheManager.shutdown();

// === BARU ===
try {
    await IdentityStore.shutdown();
} catch (e) {
    console.warn('[SIGINT] IdentityStore shutdown warning:', e.message);
}

// === Existing ===
// await require('./database').close();
```

**PENTING:** `IdentityStore.shutdown()` harus dipanggil SEBELUM `database.close()`.

---

## 📊 MongoDB Schema

Collection `identities` akan berisi documents seperti ini:

```json
{
    "_id": "ObjectId(...)",
    "ip": "125.164.213.213",
    "cookies": [
        {
            "name": "psid",
            "value": "934f1b463490f62fc3cb0a7000f999d7",
            "domain": ".highperformanceformat.com",
            "path": "/",
            "expires": 1712000000,
            "httpOnly": false,
            "secure": true,
            "sameSite": "Lax"
        }
    ],
    "localStorage": [
        { "name": "kadDS",  "value": "3" },
        { "name": "kadLT",  "value": "{\"lastOpen\":1710050000}" },
        { "name": "kadFLT", "value": "1709990000" },
        { "name": "kadPD",  "value": "2" },
        { "name": "imprCounter", "value": "7" }
    ],
    "targetOrigin": "https://www.cryptonice.online",
    "targetUrl": "https://www.cryptonice.online/",
    "geo": {
        "country": "ID",
        "region": "JI",
        "city": "Malang",
        "timezone": "Asia/Jakarta",
        "isp": "PT. TELKOM INDONESIA"
    },
    "visitCount": 7,
    "capturedAt": "2026-03-09T00:30:00.000Z",
    "lastUsedAt": "2026-03-10T01:00:00.000Z",
    "updatedAt": "2026-03-10T01:00:00.000Z",
    "expiresAt": "2026-03-11T01:00:00.000Z"
}
```

**Indexes:**
- `{ ip: 1 }` — unique, primary lookup
- `{ expiresAt: 1 }` — TTL auto-delete (MongoDB background thread, ~60s interval)

---

## 🔄 Lifecycle Flow

```
Worker start
  │
  ├─ PHASE 5.5: fp.network.publicIP = "125.164.213.213" (dari ip_validator.exe)
  │
  ├─ PHASE 6.7: IdentityStore.lookup("125.164.213.213")
  │   ├─ MISS → Pioneer session (first visit for this IP)
  │   └─ HIT  → IdentityStore.inject(context, identity)
  │             ├─ context.addCookies(cookies)        ← server sees returning visitor
  │             └─ context.addInitScript(localStorage) ← adware sees valid counters
  │
  ├─ PHASE 7: page.goto(targetUrl)
  │   → Server receives cookies → "Returning visitor!" ✅
  │   → Adware reads localStorage → "Counters valid!" ✅
  │   → Frequency capping works naturally
  │
  ├─ PHASE 8.5: IdentityStore.capture("125.164.213.213", context, page, meta)
  │   ├─ context.cookies()           → capture updated cookies
  │   ├─ page.evaluate(localStorage) → capture updated counters (kadPD++, kadLT, etc)
  │   └─ MongoDB upsert              → store/update with sliding TTL
  │
  └─ Session end → browser closed → profile deleted
      BUT: Identity persisted in MongoDB for next session with same IP
```

---

## 📈 Log Output Example

```
[Identity] Initialized — collection: identities, existing identities: 1247, TTL: 86400s
[W-03] ═══ PHASE 6.7: Identity Store ═══
[Identity] HIT — 125.164.213.213 (visit #4, cookies: 3, localStorage: 9 keys)
[Identity] INJECTED — 125.164.213.213 (cookies: 3, LS keys: 9)
...
[W-03] ═══ PHASE 8.5: Identity Capture ═══
[Identity] UPDATED — 125.164.213.213 (visit #4, cookies: 5, LS: 11 keys)
...
[Identity] Shutdown — identities in DB: 1253, stats: L:48 H:31 M:17 S:17 U:31 E:0 HR:64.6%
```

---

## ⚠️ Catatan Penting

1. **Tidak mengubah CacheManager** — IdentityStore 100% independen, zero conflict
2. **MongoDB harus sudah connected** sebelum `IdentityStore.initialize()` — pastikan 
   `await connect()` (dari database.js) dipanggil lebih dulu
3. **PHASE 6.7 harus SEBELUM page.goto()** — addInitScript + addCookies hanya efektif 
   sebelum navigasi pertama
4. **PHASE 8.5 harus SETELAH halaman fully loaded** — agar semua cookie dan localStorage 
   dari adware scripts sudah ter-set
5. **TTL 24 jam sliding** — IP yang aktif terus tidak pernah expire, hanya idle >24 jam 
   yang auto-deleted oleh MongoDB
6. **Graceful failure** — semua operasi wrapped dalam try/catch, jika IdentityStore gagal 
   session tetap jalan normal (hanya tanpa identity injection)
