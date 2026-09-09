# 🛠️ Improvement Plan — wa-ai-gemini2

> Dibuat: 2026-09-09 | Berdasarkan: Code Review post-refactor modularisasi

---

## Daftar Isu & Dampak

| # | Prioritas | Isu | Dampak Jika TIDAK Diperbaiki | Dampak JIKA Diperbaiki |
|---|-----------|-----|------------------------------|------------------------|
| 1 | 🔴 Urgent | Modularisasi tidak aktif (server.js 4812 baris) | Maintenance 2x lipat, bug silently muncul di versi berbeda | Server.js turun ke ~300 baris, single source of truth |
| 2 | 🔴 Urgent | API key Komerce hardcoded | Key bocor jika repo public | Key aman, bisa rotate tanpa deploy ulang |
| 3 | 🔴 Urgent | Import error `normalizeIdNumber` di webhook-handler | Runtime crash saat MacroDroid dipakai | MacroDroid path berjalan tanpa error |
| 4 | 🟡 High | Plaintext password comparison | Password leak dari memory dump / .env | Password ter-hash, aman meski DB leak |
| 5 | 🟡 High | CORS wildcard `*` | CSRF / situs jahat bisa akses API | Hanya domain trusted yang bisa akses |
| 6 | 🟡 High | API key Gemini di URL | Key ter-log di proxy/access logs | Key tidak bocor ke logs |
| 7 | 🟢 Medium | Product names hardcoded | Harus edit code saat tambah produk | Produk baru langsung jalan dari KB |
| 8 | 🟢 Medium | Blocking file I/O | Event loop block saat banyak concurrent | Response time stabil di load tinggi |
| 9 | 🟢 Low | Zero test suite | Regressions tak terdeteksi setiap deploy | Regressions ketahuan sebelum deploy |

---

## Step-by-Step Improvement

### #1 — Aktifkan Modularisasi

**Status saat ini:**
- 13 file modular sudah dibuat tapi TIDAK di-import oleh server.js
- server.js masih 4812 baris dengan semua fungsi inline
- Dua versi kode berjalan paralel (server.js vs module)

**Dampak Jika TIDAK Diperbaiki:**
- 🐛 Bug fix harus dilakukan di 2 tempat — jika lupa satu, behavior beda
- 🔧 Refactor selanjutnya makin sulit (tidak tahu versi mana yang benar)
- 📦 Bundle size doubled — semua code diduplikasi di memory
- 🧠 Cognitive load tinggi — developer harus baca 4812 baris bukan 300

**Dampak Jika Diperbaiki:**
- ✅ server.js jadi ~300 baris (setup + wire modules)
- ✅ Single source of truth — perubahan di 1 tempat
- ✅ Mudah test per-module secara terpisah
- ✅ Load time lebih cepat (kurang code di main thread)

**Step-by-step:**

```
Step 1.1: Verifikasi semua module export correctly
  - Buka setiap file module
  - Pastikan fungsi yang di-export SAMA dengan yang ada di server.js
  - Buat checklist mapping: server.js function → module file

Step 1.2: Import modules ke server.js
  - Tambah import di server.js untuk:
    const store = require('./state-store');
    const { updateOrderState, createOrderState, ... } = require('./order-state');
    const { processCustomerMessage, processBufferedMessages, retryFailedMessages } = require('./message-processor');
    const { registerWebhookRoutes } = require('./webhook-handler');
    const { registerApiRoutes } = require('./api-routes');
    const { buildHistory, getReplyDelayMs } = require('./chat-helpers');
    const { sendWhatsAppText, ... } = require('./whatsapp-api');
    const { aiReply, getApiKeys, ... } = require('./gemini-service');
    const { classifyIntent } = require('./gemini-thinker');
    const { cleanFieldQuestions, validateFieldOrder, extractOrder, ... } = require('./message-postprocess');
    const { notifyAdminEscalations, handleAdminEscalationAnswer } = require('./admin-escalation');

Step 1.3: Ganti semua inline functions dengan import
  - Hapus semua duplicate function definitions di server.js
  - Ganti pemanggilan: updateOrderState() → panggil dari module
  - Ulangi untuk setiap fungsi duplikat

Step 1.4: Hapus dead code dari server.js
  - Hapus definisi fungsi yang sudah di-import
  - Hapus constants yang sudah di centralize di config.js / state-store.js
  - server.js harusnya hanya berisi:
    - Express setup
    - Middleware
    - Route registration (panggil registerWebhookRoutes, registerApiRoutes)
    - Server start

Step 1.5: Test manual
  - Jalankan server, cek semua log normal
  - Test kirim pesan WhatsApp → AI reply
  - Test webhook Meta → message processing
  - Test dashboard login
  - Test order flow (step 1-5)
```

---

### #2 — Pindahkan API Key Komerce dari Hardcoded

**Status saat ini:**
```js
// address-ai.js:18
const KOMERCE_API_KEY_DEFAULT = 'Yzx2NjTb1c484631212a74562TQwiwSB';
```

**Dampak Jika TIDAK Diperbaiki:**
- 🔓 Jika repo public atau ada contributor baru, API key langsung terlihat
- 💰 Key bisa dipakai orang lain → quota habis, billing membengkak
- 🔍 Tidak bisa rotate key tanpa edit source code + redeploy

**Dampak Jika Diperbaiki:**
- ✅ Key hanya di .env (sudah di .gitignore)
- ✅ Bisa rotate key kapan saja tanpa ubah code
- ✅ Berbeda environment (dev/staging/prod) bisa pakai key berbeda

**Step-by-step:**

```
Step 2.1: Tambah env var di .env
  KOMERCE_API_KEY=Yzx2NjTb1c484631212a74562TQwiwSB
  KOMERCE_ORIGIN_ID=73528

Step 2.2: Update address-ai.js
  - Ganti hardcoded dengan process.env
  function getKomerceKey() {
    return (store.settings.komerceApiKey || process.env.KOMERCE_API_KEY || '').trim();
  }
  function getOriginId() {
    return (store.settings.originId || process.env.KOMERCE_ORIGIN_ID || '73528').trim();
  }

Step 2.3: Hapus hardcoded default
  - Hapus baris: const KOMERCE_API_KEY_DEFAULT = '...'
  - Hapus baris: const ORIGIN_ID_DEFAULT = '73528'
  - Jika env var kosong dan settings kosong → log warning, jangan pakai default

Step 2.4: Pastikan .env ada di .gitignore
  - Cek .gitignore sudah include .env
```

---

### #3 — Fix Import Error `normalizeIdNumber`

**Status saat ini:**
```js
// webhook-handler.js:11
const { normalizeIdNumber } = require('./config');
```
Tapi `config.js` export objek dengan method `normalizeIdNumber` — bukan named export.
Tergantung cara import, ini bisa crash atau undefined.

**Dampak Jika TIDAK Diperbaiki:**
- 💥 Runtime crash jika MacroDroid channel aktif
- 💥 `normalizeIdNumber()` di webhook-handler akan TypeError
- 🔄 Fallback: admin number check gagal → admin tidak bisa kontrol bot

**Dampak Jika Diperbaiki:**
- ✅ MacroDroid path berjalan tanpa error
- ✅ Admin number normalization konsisten di semua module

**Step-by-step:**

```
Step 3.1: Verifikasi export di config.js
  // config.js seharusnya:
  module.exports = {
    normalizeIdNumber(num) { ... },
    // ... lainnya
  };

Step 3.2: Fix import di webhook-handler.js
  // webhook-handler.js:11 — sudah benar secara sintaks
  // karena config.js export object, destructuring { normalizeIdNumber } akan mengambil method
  // VERIFIKASI: pastikan tidak ada circular dependency

Step 3.3: Test
  - Jalankan server → cek tidak ada error di startup
  - Test send pesan via MacroDroid bridge
  - Test admin command on/off via MacroDroid
```

---

### #4 — Hash Password Admin

**Status saat ini:**
```js
// server.js:190
if (password === process.env.ADMIN_PASSWORD) { ... }
```

**Dampak Jika TIDAK Diperbaiki:**
- 📄 Password tersimpan plaintext di .env dan di memory
- 🔍 Bisa di-read dari process memory dump
- 🔍 Database如果被compromise, password langsung terbaca
- 🔓 Tidak ada protection dari timing attack

**Dampak Jika Diperbaiki:**
- ✅ Password ter-hash dengan bcrypt (salt + cost factor)
- ✅ Timing-safe comparison
- ✅ Database leak tidak langsung expose password
- ✅ Industry standard security

**Step-by-step:**

```
Step 4.1: Install bcryptjs (pure JS, no native deps)
  npm install bcryptjs

Step 4.2: Buat auth helper (auth.js)
  const bcrypt = require('bcryptjs');
  const SALT_ROUNDS = 10;

  async function hashPassword(plain) {
    return bcrypt.hash(plain, SALT_ROUNDS);
  }
  async function comparePassword(plain, hashed) {
    return bcrypt.compare(plain, hashed);
  }

Step 4.3: Update password generation (server.js)
  // Saat auto-generate password:
  const generatedPassword = crypto.randomBytes(6).toString('hex');
  const hashed = await hashPassword(generatedPassword);
  // Simpan HASH ke .env, bukan plaintext
  fs.appendFileSync(envPath, `\nADMIN_PASSWORD_HASH=${hashed}\n`);
  // Tampilkan plaintext ke console saja (satu kali)

Step 4.4: Update login endpoint
  // Ganti:
  // if (password === process.env.ADMIN_PASSWORD)
  // Menjadi:
  const storedHash = process.env.ADMIN_PASSWORD_HASH;
  if (storedHash && await comparePassword(password, storedHash)) {
    // login success
  } else if (!storedHash && password === process.env.ADMIN_PASSWORD) {
    // backward compat: masih ada plaintext lama → login ok + migrate ke hash
    const newHash = await hashPassword(password);
    // update .env dengan hash
  }

Step 4.5: Migrate existing deployment
  - Jalankan script sekali: hash plaintext password → simpan ke .env
  - Hapus ADMIN_PASSWORD plaintext dari .env
```

---

### #5 — Batasi CORS Origin

**Status saat ini:**
```js
// server.js
app.use(cors()); // wildcard *
const io = new Server(server, { cors: { origin: '*' } });
```

**Dampak Jika TIDAK Diperbaiki:**
- 🌐 SITUS MANA SAJA bisa akses API endpoints
- 🔓 Sesi admin bisa di-hijack dari domain lain
- 📡 Socket.io events bisa di-intercept oleh domain jahat
- ⚠️ Bisa dieksploitasi untuk CSRF ke /api/login

**Dampak Jika Diperbaiki:**
- ✅ Hanya dashboard domain yang bisa akses API
- ✅ Admin session aman dari cross-origin attacks
- ✅ Socket.io hanya menerima koneksi dari origin trusted

**Step-by-step:**

```
Step 5.1: Define allowed origins
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',').map(s => s.trim()).filter(Boolean);

Step 5.2: Apply CORS whitelist
  app.use(cors({
    origin: function(origin, callback) {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
        return callback(null, true);
      }
      return callback(new Error('CORS: Origin tidak diizinkan'));
    }
  }));

Step 5.3: Apply ke Socket.io
  const io = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ['GET', 'POST']
    }
  });

Step 5.4: Update .env
  ALLOWED_ORIGINS=https://yourdomain.com,http://localhost:3000
```

---

### #6 — Pindahkan API Key dari URL ke Header

**Status saat ini:**
```js
// gemini-service.js:547
const url = `...${model}:generateContent?key=${encodeURIComponent(key)}`;
```

**Dampak Jika TIDAK Diperbaiki:**
- 📝 API key ter-log di: access logs, CDN logs, monitoring tools, error trackers
- 🔍 Jika key bocor ke logs → bisa dipakai orang lain
- 📊 Google Cloud Audit Log mencatat full URL termasuk key

**Dampak Jika Diperbaiki:**
- ✅ Key tidak terlihat di logs atau URL bars
- ✅ Hanya terkirim sebagai header (tidak di-log default)
- ✅ Comply dengan Google API best practices

**Step-by-step:**

```
Step 6.1: Update callGeminiDirect (gemini-service.js)
  // Ganti:
  const url = `...generateContent?key=${key}`;
  // Menjadi:
  const url = `...generateContent`;
  res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key
    },
    body: JSON.stringify(body),
    signal
  });

Step 6.2: Update callGeminiRaw (gemini-service.js)
  // Apply perubahan yang sama

Step 6.3: Update callThinkerGemini (gemini-thinker.js)
  // Apply perubahan yang sama

Step 6.4: Update processOrderAddressAI (address-ai.js)
  // Apply perubahan yang sama

Step 6.5: Test semua Gemini API calls
  - Test chat langsung
  - Test thinker classification
  - Test address AI processing
  - Pastikan tidak ada 401/403 error
```

---

### #7 — Buat Product Names Configurable

**Status saat ini:**
```js
// chat-helpers.js:30-33
if (userText.includes('baby walking')) products.add('Baby Walking Assistant');
if (userText.includes('pasta dempul')) products.add('Pasta Dempul');
if (userText.includes('selang')) products.add('Selang Kran Fleksibel 360°');
if (userText.includes('mini sealer')) products.add('Mini Sealer Portable');
```

**Dampak Jika TIDAK Diperbaiki:**
- 🔄 Setiap kali tambah/hapus produk → harus edit code + redeploy
- 🐛 Jika lupa update → summary tidak lengkap
- 📦 Code coupled dengan data produk

**Dampak Jika Diperbaiki:**
- ✅ Tambah produk baru → edit KB saja, zero code change
- ✅ Summary otomatis lengkap dengan semua produk yang ada
- ✅ Code generic, tidak terikat produk tertentu

**Step-by-step:**

```
Step 7.1: Update buildConversationSummary (chat-helpers.js)
  function buildConversationSummary(oldEntries) {
    const { parseProductBlocks } = require('./knowledge-base');
    const blocks = parseProductBlocks(store.settings.knowledgeBase);

    const products = new Set();
    const discussed = [];
    const recentEntries = oldEntries.slice(-5);

    for (const entry of recentEntries) {
      const userText = (entry.body || '').toLowerCase();
      // Dynamic: cocokkan dengan semua produk dari KB
      for (const block of blocks) {
        if (!block.name) continue;
        const words = block.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
        if (words.some(w => userText.includes(w))) {
          products.add(block.name);
        }
      }
      // ... rest of topic detection unchanged
    }
  }

Step 7.2: Tambah fallback untuk produk yang tidak ada di KB header
  - Jika nama produk ada di KB tapi header-nya tidak mengandung kata kunci
  - Tambah alias mapping di settings: { "baby walking": "Baby Walking Assistant" }

Step 7.3: Test
  - Ubah nama produk di KB → pastikan summary berubah otomatis
```

---

### #8 — Convert Blocking I/O ke Async

**Status saat ini:**
```js
// state-store.js:111
const save = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch(e) { ... }
};
// Dipanggil di: saveMessages(), saveSettings(), saveOrders()
// Dipanggil SETIAP pesan masuk
```

**Dampak Jika TIDAK Diperbaiki:**
- ⏱️ Event loop block ~5-50ms setiap write (tergantung ukuran file)
- 📈 Di load tinggi (10+ pesan detik) → response time naik
- 💥 Jika file sangat besar (>10MB) → block bisa 100ms+
- 🔄 Concurrent requests ter-delay

**Dampak Jika Diperbaiki:**
- ✅ Event loop tidak ter-block → response time stabil
- ✅ Throughput naik di load tinggi
- ✅ File ops di-background, tidak mengganggu request handling

**Step-by-step:**

```
Step 8.1: Convert save() di state-store.js
  // Ganti:
  const save = (file, data) => {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
    catch(e) { ... }
  };
  // Menjadi:
  const save = (file, data) => {
    const json = JSON.stringify(data, null, 2);
    fs.writeFile(file, json, (err) => {
      if (err) console.error(`Gagal simpan ${path.basename(file)}:`, err.message);
    });
  };

Step 8.2: Convert load di startup (boleh tetap sync)
  // fs.readFileSync di startup OK — hanya sekali

Step 8.3: Convert persistOrderState
  // fs.writeFileSync → fs.writeFile
  function _doPersistOrderState() {
    const obj = {};
    for (const [phone, state] of store.orderStates) obj[phone] = state;
    const json = JSON.stringify(obj, null, 2);
    fs.writeFile(store.PATHS.ORDER_STATE_FILE, json, (err) => {
      if (err) console.error('[OrderState] Gagal persist:', err.message);
    });
  }

Step 8.4: Tambah write coalescing untuk high-frequency saves
  - Jika 10 pesan masuk dalam 1 detik → hanya tulis sekali
  - Pakai debounce yang sudah ada di persistOrderState

Step 8.5: Test
  - Kirim banyak pesan cepat → pastikan tidak ada data loss
  - Cek semua file JSON ter-save dengan benar
```

---

### #9 — Tambahkan Test Suite

**Status saat ini:**
- Zero unit tests
- Zero integration tests
- Semua testing manual

**Dampak Jika TIDAK Diperbaiki:**
- 🐛 Regressions tidak terdeteksi sampai production
- 🔧 Refactoring berbahaya (tidak tahu apa yang rusak)
- ⏰ Debugging lebih lama (tidak ada reproducible test)
- 📉 Velocity turun seiring codebase membesar

**Dampak Jika Diperbaiki:**
- ✅ Regressions ketahuan sebelum deploy
- ✅ Refactoring lebih confident (test sebagai safety net)
- ✅ Code documentation via tests
- ✅ Onboarding developer baru lebih cepat

**Step-by-step:**

```
Step 9.1: Setup testing framework
  npm install --save-dev vitest
  // vitest: modern, fast, compatible dengan CommonJS
  // Tambah script di package.json: "test": "vitest run"

Step 9.2: Buat test untuk fungsi murni (tanpa IO/network)
  test/extractCustomerFields.test.js — test regex extraction
  test/detectProductFocus.test.js — test product matching
  test/validateFieldOrder.test.js — test field validation
  test/getRelevantKnowledge.test.js — test KB matching
  test/orderStateTransitions.test.js — test step 1→2→3→4→5

Step 9.3: Buat test untuk postprocess
  test/extractOrder.test.js — test ORDER_DATA parsing
  test/extractEscalations.test.js — test ESCALATE tag parsing
  test/cleanFieldQuestions.test.js — test field cleanup

Step 9.4: Buat test untuk chat helpers
  test/buildHistory.test.js — test history building + summary
  test/getReplyDelayMs.test.js — test delay calculation

Step 9.5: Tambahkan ke CI/CD
  - Jalankan test sebelum setiap deploy
  - Block deploy jika test gagal

Contoh test pertama:
  // test/detectProductFocus.test.js
  const { describe, it, expect } = require('vitest');
  describe('detectProductFocus', () => {
    it('should detect product name from KB', () => {
      const result = detectProductFocus('mau baby walking yang mana?');
      expect(result).toBe('Baby Walking Assistant');
    });
    it('should return null for non-product messages', () => {
      const result = detectProductFocus('terima kasih ya kak');
      expect(result).toBeNull();
    });
  });
```

---

## Timeline Estimasi

| # | Task | Estimasi | Dependensi |
|---|------|----------|------------|
| 1 | Aktifkan modularisasi | 2-3 jam | #3, #6 harus bareng |
| 2 | Pindahkan API key Komerce | 15 menit | - |
| 3 | Fix import normalizeIdNumber | 15 menit | - |
| 4 | Hash password admin | 30 menit | - |
| 5 | Batasi CORS | 15 menit | - |
| 6 | API key ke header | 30 menit | #1 |
| 7 | Product names configurable | 20 menit | - |
| 8 | Async file I/O | 30 menit | #1 |
| 9 | Test suite | 2-3 jam (makan waktu paling lama) | #1 |

**Rekomendasi urutan pengerjaan:**
1. Fix #3 dulu (15 menit, fix crash)
2. Fix #2 (15 menit, fix key leak)
3. Fix #1 + #6 + #8 bareng (modularisasi + header + async = 3 jam)
4. Fix #4 + #5 (security hardening = 45 menit)
5. Fix #7 (20 menit)
6. Fix #9 (test suite = 2-3 jam, bisa bertahap)

**Total estimasi: 6-8 jam**
