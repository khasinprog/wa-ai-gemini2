# PLAN: Step-Based Order System

> **Status:** DRAFT - Menunggu review & approval
> **Date:** 2026-09-02
> **Author:** Claude Sonnet 4.6

---

## Ringkasan

Sistem menjawab berbasis **step + flags** yang terstruktur:
- AI selalu cek flags → tahu posisi di step mana → jawab sesuai step
- Product lock persist sampai customer pindah produk
- Step 1-4: AI otomatis. Step 5: eskalasi ke Telegram (manual)
- Alamat dipecah detail: nama, dusun, desa, kecamatan, kota, RT/RW, patokan

---

## DAFTAR ISI

1. [OrderState Baru (Before/After)](#1-orderstate)
2. [Step System](#2-step-system)
3. [Product Lock](#3-product-lock)
4. [Step 1: Tanya Produk](#4-step-1)
5. [Step 2: Follow-up Questions](#5-step-2)
6. [Step 3: Kumpulkan Data](#6-step-3)
7. [Step 4: Konfirmasi Order](#7-step-4)
8. [Step 5: Eskalasi ke Telegram](#8-step-5)
9. [System Prompt Updates](#9-system-prompt)
10. [Timeline](#10-timeline)

---

## 1. OrderState

### BEFORE (Sekarang)

```javascript
// Simpel — hanya track produk + warna
const orderStates = new Map();
// from → {
//   product: "Baby Walking Assistant",
//   stage: "color_selected",     // 6 stages: idle, product_inquired, color_selected, name_given, address_given, phone_given, confirmed
//   color: "Biru Muda",
//   name: null,                  // ← TIDAK di-auto-detect
//   address: null,               // ← TIDAK di-auto-detect
//   phone: null,
//   lastUpdate: Date.now()
// }
```

**Masalah:**
- Tidak ada step tracking (1-5)
- Alamat = 1 field, tidak dipecah
- Tidak ada product lock persistence
- Tidak ada verifikasi nama

---

### AFTER (Rencana)

```javascript
const orderStates = new Map();
// from → {
//   // ── STEP ──
//   step: 1,                     // 1=tanya produk, 2=follow-up, 3=kumpul data, 4=konfirmasi, 5=eskalasi
//
//   // ── PRODUCT LOCK ──
//   product: "Baby Walking Assistant",  // locked sampai customer tanya produk lain
//
//   // ── DATA ORDER ──
//   color: "Biru Muda",
//   namaLengkap: null,           // nama lengkap penerima (WAJIB ≥ 2 kata atau konfirmasi)
//   namaVerified: false,         // sudah diverifikasi? (single-word = belum verified)
//   dusun: null,                 // dusun/rukeman/kampung
//   desa: null,                  // desa/kelurahan
//   kecamatan: null,             // kecamatan
//   kota: null,                  // kota/kabupaten
//   rtRw: null,                  // RT/RW
//   patokan: null,               // patokan rumah (dekat masjid, dll)
//   alamatLengkap: null,         // gabungan dari semua field di atas (untuk rekap)
//   noHp: null,                  // nomor HP (bisa = SAMA_DENGAN_WA)
//
//   // ── STATUS ──
//   orderConfirmed: false,       // customer sudah jawab "ya/benar/oke"
//   lastUpdate: Date.now()
// }
```

### Perubahan

| Field | Before | After |
|-------|--------|-------|
| Tracking | `stage` (6 nilai) | `step` (5 nilai) |
| Nama | `name` (1 field) | `namaLengkap` + `namaVerified` |
| Alamat | `address` (1 field) | `dusun`, `desa`, `kecamatan`, `kota`, `rtRw`, `patokan`, `alamatLengkap` |
| HP | `phone` | `noHp` |
| Product lock | Reset saat restart | Persist sampai customer pindah |
| Step 5 | Tidak ada | Eskalasi ke Telegram |

---

## 2. Step System

### Flow

```
Step 1: Customer tanya produk
  → AI jawab lengkap dari KB
  → Flag: step=1, product=X

Step 2: Customer tanya detail (bukan tanya produk)
  → AI jawab SINGKAT, tidak ulang KB
  → Flag: step=2

Step 3: Customer mau order → kumpulkan data
  → AI tanya satu per satu: nama → alamat → patokan → HP
  → Flag: step=3, isi field yang ditanyakan
  → Cek flag: field mana yang belum terisi → tanya itu

Step 4: Konfirmasi order
  → AI rekap semua data
  → Customer jawab "ya/benar/oke"
  → Flag: step=4, orderConfirmed=true
  → Simpan order

Step 5: Di luar step 1-4 (eskalasi)
  → AI forward ke Telegram admin
  → Admin jawab manual
  → Jawaban dikirim ke customer via WA
```

---

## 3. Product Lock

### BEFORE

```javascript
// productFocus di-reset saat server restart
// Detect product di setiap pesan
const detectedProduct = detectProductFocus(combinedBody);
if (detectedProduct) {
  productFocus.set(from, detectedProduct);
}
```

**Masalah:**
- Tidak persist
- Bisa berubah tanpa sengaja

---

### AFTER

```javascript
function updateOrderState(from, message) {
  let state = orderStates.get(from);
  const detectedProduct = detectProductFocus(message);

  // Product lock: hanya berubah kalau customer tanya produk LAIN
  if (detectedProduct && (!state || state.product !== detectedProduct)) {
    state = createOrderState(detectedProduct);
    orderStates.set(from, state);
  }

  // Jika customer tanya produk yang SAMA, jangan reset state
  if (detectedProduct && state && state.product === detectedProduct) {
    return state; // sudah locked, jangan reset
  }

  // Step determination berdasarkan flags
  if (!state) return null;

  // Auto-detect step berdasarkan isi pesan
  const lowerMsg = message.toLowerCase();

  // Step 5 trigger: pertanyaan yang tidak masuk step 1-4
  if (state.step >= 3 && isEscalationNeeded(message, state)) {
    state.step = 5;
  }

  state.lastUpdate = Date.now();
  orderStates.set(from, state);
  return state;
}

function isEscalationNeeded(message, state) {
  const lower = message.toLowerCase();
  // Pertanyaan yang perlu eskalasi:
  // - Estimasi hari sampai
  // - Stok riil
  // - Kebijakan retur
  // - Pertanyaan di luar produk
  const escalationKeywords = ['estimasi', 'berapa hari', 'stok', 'retur', 'garansi', 'komplain',
    'batal', 'gak jadi', 'kirim', 'hari sampai', 'kurir'];
  return escalationKeywords.some(k => lower.includes(k));
}
```

---

## 4. Step 1: Tanya Produk

### BEFORE

```javascript
// AI jawab dari KB, ada rules di system prompt tapi tidak terstruktur
// Tidak ada flags untuk track step
```

### AFTER

```javascript
// Step 1: AI jawab LENGKAP dari KB
// System prompt tambah rules:
const STEP1_RULES = `
STEP 1 — JAWAB PRODUK:
- Customer bertanya tentang produk (nama, harga, manfaat, varian, stok)
- Jawab LENGKAP dari informasi produk di atas
- Sebutkan: harga, varian, manfaat utama (1-2 poin), CTA
- Tandai: step=1, product=[nama produk]
- JANGAN tanya data order di step ini
`;
```

### Contoh

```
Customer: "Kak ada pasta dempul? Harga brpa?"
AI: "Ada Kak! Pasta Dempul Instan Tembok harganya Rp25.000.
Produk ini untuk memperbaiki dinding retak/lubang, cara pakainya gampang tinggal oles.
Mau pesan atau ada yang mau ditanyakan lagi Kak?"
→ step=1, product="Pasta Dempul"
```

---

## 5. Step 2: Follow-up Questions

### BEFORE

```javascript
// Tidak ada rules khusus untuk follow-up
// AI kadang ulang penjelasan dari KB
```

### AFTER

```javascript
const STEP2_RULES = `
STEP 2 — FOLLOW-UP:
- Customer bertanya DETAIL tentang produk yang SUDAH dibahas di Step 1
- Jawab SINGKAT langsung ke inti, JANGAN ulang penjelasan dari Step 1
- Contoh: "ukurannya berapa?" → "250 gram per unit Kak"
- JANGAN sebut manfaat lagi jika sudah dijelaskan di Step 1
- JANGAN sebut harga lagi jika sudah disebut di Step 1
- Tandai: step=2
`;
```

### Contoh

```
Customer: "Itu ukurannya berapa?"
AI: "250 gram per unit Kak. Kalau 2 pack dapet 500 gram."
→ step=2 (TIDAK ulang penjelasan produk)
```

---

## 6. Step 3: Kumpulkan Data

### BEFORE

```javascript
// Detect nama/alamat otomatis (sering salah)
// Address = 1 field
// Tidak ada verifikasi nama
```

### AFTER

```javascript
const STEP3_RULES = `
STEP 3 — KUMPULKAN DATA:
- Customer sudah menunjukkan minat order (bilang "mau order", "pesan", pilih warna)
- Tanya data SATU PER SATU dalam urutan:
  1. Nama lengkap penerima
  2. Alamat: dusun/kampung, desa/kelurahan, kecamatan, kota/kabupaten
  3. Patokan rumah
  4. RT/RW
  5. Konfirmasi nomor HP (pakai nomor WA ini?)

- VERIFIKASI NAMA: Kalau customer kasih 1 kata saja (misal "Khasin"),
  WAJIB tanya: "Ini sudah nama lengkap Kak? Mohon nama lengkap ya."
  JANGAN langsung catat sebagai nama lengkap.

- CEK FLAG: Sebelum tanya, cek field mana yang BELUM terisi.
  JANGAN tanya field yang sudah ada.

- Setiap data diterima, ISI FLAG:
  flagnamaLengkap = "Khasin Khafabi"
  flagdesa = "Tamantirto"
  flagkecamatan = "Kasihan"
  dst.

- Tandai: step=3
`;
```

### Contoh Flow Step 3

```
AI: "Siap Kak, warna Pink Muda sudah dicatat. Boleh minta nama lengkap penerimanya?"
Customer: "Khasin"
AI: "Ini sudah nama lengkap Kak? Mohon nama lengkap ya 😊"
Customer: "Khasin Khafabi"
AI: "Siap Kak Khasin Khafabi. Sekarang alamat lengkapnya ya — dusun/kampung, desa, kecamatan, dan kota?"
Customer: "Rukeman, Tamantirto, Kasihan, Bantul"
AI: "Siap. Patokan rumahnya apa Kak? Biar kurir gampang cari."
Customer: "Deket masjid"
AI: "Siap. RT/RW nya berapa Kak?"
Customer: "RT 03/05"
AI: "Boleh pakai nomor WhatsApp ini juga untuk dihubungi kurir ya Kak?"
Customer: "Iya"
→ step=3, semua flag terisi
```

---

## 7. Step 4: Konfirmasi Order

### BEFORE

```javascript
// AI rekap, tapi kadang tidak lengkap
// Tidak ada flag orderConfirmed
```

### AFTER

```javascript
const STEP4_RULES = `
STEP 4 — KONFIRMASI:
- SEMUA data sudah lengkap (cek flag: nama, desa, kecamatan, kota, patokan, RT/RW, HP)
- Rekap pesanan: produk, warna, harga, nama, alamat lengkap+patokan, HP
- Tanya: "Apakah data sudah benar semua Kak?"
- JANGAN tanya data tambahan di step ini
- Setelah customer konfirmasi "ya/benar/oke":
  - Sisipkan [ORDER_DATA]...[/ORDER_DATA]
  - Flag: step=4, orderConfirmed=true
- Tandai: step=4
`;
```

### Contoh

```
AI: "Baik Kak, saya rekap ya:
Produk: Baby Walking Assistant (warna Pink Muda)
Harga: Rp95.000 (termasuk ongkir)
Nama: Khasin Khafabi
Alamat: Rukeman, Tamantirto, Kasihan, Bantul
Patokan: Deket masjid
RT/RW: RT 03/05
HP: pakai nomor WA ini

Apakah data sudah benar semua Kak?"
Customer: "Ya"
→ [ORDER_DATA]{"nama":"Khasin Khafabi","produk":"Baby Walking Assistant",...}[/ORDER_DATA]
```

---

## 8. Step 5: Eskalasi ke Telegram

### BEFORE

```javascript
// Escalation via [ESCALATE] tag
// AI masih kasih jawaban parsial dulu
// Otomatis kirim ke Telegram
```

### AFTER

```javascript
const STEP5_RULES = `
STEP 5 — ESKALASI KE ADMIN:
- Pertanyaan yang TIDAK bisa dijawab dari KB (estimasi, stok, kebijakan, dll)
- JANGAN jawab sendiri, JANGAN mengarang
- Forward pertanyaan ke Telegram admin:
  "Ada pertanyaan dari [nama] ([nomor]):
  Produk: [produk]
  Pertanyaan: [pertanyaan customer]"
- Balas ke customer: "Sebentar ya Kak, saya tanyakan ke admin dulu."
- Tunggu jawaban dari admin via Telegram
- Admin jawab → kirim ke customer via WA
- Tandai: step=5 (kembali ke step sebelumnya setelah admin jawab)
`;
```

### Contoh

```
Customer: "Berapa lama sampai ke Jogja?"
AI: "Sebentar ya Kak, saya tanyakan ke admin dulu."
→ Forward ke Telegram: "Ada pertanyaan dari Khasin (628xxx): Berapa lama sampai ke Jogja?"
→ Admin jawab via Telegram: "Estimasi 2-3 hari"
→ App kirim ke WA: "Estimasi pengiriman ke Jogja 2-3 hari Kak. Ada lagi yang bisa dibantu?"
→ step kembali ke step sebelumnya (3 atau 4)
```

---

## 9. System Prompt Updates

### BEFORE

```javascript
// System prompt panjang (~200 baris)
// Tidak ada step-by-step instructions
// Tidak ada flags reference
```

### AFTER

```javascript
function buildSystemPrompt(name, relevantKB, isFirstMessage, from) {
  const parts = [];

  parts.push(`Kamu adalah ${settings.persona}`);
  parts.push(`Panggil customer "Kak".`);
  parts.push('');

  // KB produk
  if (relevantKB?.trim()) {
    parts.push('=== INFORMASI PRODUK & BISNIS ===');
    parts.push(relevantKB.trim());
    parts.push('');
  }

  // Order state + flags
  const orderState = from ? orderStates.get(from) : null;
  if (orderState && orderState.step) {
    parts.push('=== STATUS SAAT INI ===');
    parts.push(`Step: ${orderState.step}`);
    parts.push(`Produk: ${orderState.product || '-'}`);
    if (orderState.color) parts.push(`Warna: ${orderState.color}`);
    if (orderState.namaLengkap) parts.push(`Nama: ${orderState.namaLengkap} (verified: ${orderState.namaVerified})`);
    if (orderState.desa) parts.push(`Desa: ${orderState.desa}`);
    if (orderState.kecamatan) parts.push(`Kecamatan: ${orderState.kecamatan}`);
    if (orderState.kota) parts.push(`Kota: ${orderState.kota}`);
    if (orderState.rtRw) parts.push(`RT/RW: ${orderState.rtRw}`);
    if (orderState.patokan) parts.push(`Patokan: ${orderState.patokan}`);
    if (orderState.noHp) parts.push(`HP: ${orderState.noHp}`);

    // Apa yang perlu ditanyakan
    const missing = getMissingFields(orderState);
    if (missing.length) {
      parts.push(`→ Belum ada: ${missing.join(', ')}`);
      parts.push(`Tanyakan field yang masih kurang, satu per satu.`);
    }
    parts.push('');
  }

  // STEP RULES — hanya kirim rules untuk step saat ini
  if (!orderState || orderState.step === 1) {
    parts.push(STEP1_RULES);
  } else if (orderState.step === 2) {
    parts.push(STEP2_RULES);
  } else if (orderState.step === 3) {
    parts.push(STEP3_RULES);
  } else if (orderState.step === 4) {
    parts.push(STEP4_RULES);
  } else if (orderState.step === 5) {
    parts.push(STEP5_RULES);
  }

  // Rules umum (CTA, nego, dll)
  parts.push('');
  parts.push('=== ATURAN UMUM ===');
  parts.push('- Akhiri dengan 1 pertanyaan CTA');
  parts.push('- Max 3-4 kalimat per balasan');
  parts.push('- Pisahkan paragraf dengan enter');

  return parts.join('\n');
}

function getMissingFields(state) {
  const missing = [];
  if (!state.namaLengkap || !state.namaVerified) missing.push('nama lengkap');
  if (!state.desa) missing.push('desa/kampung');
  if (!state.kecamatan) missing.push('kecamatan');
  if (!state.kota) missing.push('kota/kabupaten');
  if (!state.patokan) missing.push('patokan rumah');
  if (!state.rtRw) missing.push('RT/RW');
  if (!state.noHp) missing.push('nomor HP');
  return missing;
}
```

---

## 10. Timeline

### Phase 1: OrderState + Step Tracking ✅
- [x] Update `orderState` object (tambah step, address breakdown, namaVerified)
- [x] Update `updateOrderState()` — step determination
- [x] Update `getMissingFields()` — cek field kosong
- [x] Update `buildSystemPrompt()` — inject flags + step rules
- [x] Persist ke `orderStates.json`
- [x] Load saat server start + auto-cleanup >14 hari

### Phase 2: Step Rules ✅
- [x] Implement STEP1-5 rules
- [x] Build system prompt: hanya kirim rules untuk step saat ini
- [x] [STEP=X] tag detection → auto-update orderState.step

### Phase 3: Address Breakdown ✅
- [x] `extractCustomerFields()` — deteksi nama, alamat, RT/RW, patokan
- [x] `detectOrderData()` — gunakan step numbers
- [x] Address breakdown: dusun, desa, kecamatan, kota, rtRw, patokan

### Phase 4: Deploy & Test ✅
- [x] Deploy ke server (`/var/www/wa-ai-gemini2/`)
- [x] Raw payload logging ke Gemini API

### Phase 5: Fix dari Test Feedback 🔄
- [ ] **FIX: Auto-detect step transition** — Step 1→2 otomatis saat customer tanya detail
- [ ] **FIX: extractCustomerFields() parsing alamat** — 3 items: desa/kecamatan/kota (bukan dusun/desa/kecamatan)
- [ ] **FIX: isEscalationNeeded() keyword list** — "kirim" terlalu umum, perlu filter
- [ ] **FIX: Double reply handling** — buffer gabung 2 pesan → AI jangan jawab 2x
- [ ] **REVIEW: Step 3 activation** — kapan step naik dari 1 ke 3? (perlu auto-detect "mau order")

---

## 11. Hasil Test & Fix yang Diperlukan

> **Test Date:** 2 September 2026, 08:43-08:53
> **Customer:** Khafastore (6281233350792)
> **Produk:** Pasta Dempul Instan Tembok
> **Status:** ⚠️ Test ini dijalankan dengan code LAMA (deploy ke directory salah). Issue yang ditemukan menjadi dasar fix Phase 5.

### Issue #1: Step Tidak Naik Otomatis (Critical)

**Apa yang terjadi:**
Customer tanya "Ini 1 botol brpa gram" → AI masih di Step 1 → jawab LENGKAP (ulang harga + total gram).

**Yang seharusnya:**
Step naik ke 2 → AI jawab SINGKAT: "250 gram per tube Kak"

**Root Cause:**
Tidak ada auto-detect untuk transisi Step 1→2. `orderState.step` selalu = 1 karena tidak ada logic yang mendeteksi kapan customer sudah selesai tanya produk dan mulai follow-up.

**Fix yang diperlukan:**
```javascript
// Di updateOrderState() atau extractCustomerFields():
// Step 1→2: Jika step=1 dan customer tanya detail (bukan tanya produk baru)
// dan ada history (sudah ada minimal 1 balasan AI sebelumnya)
if (state.step === 1 && history?.length >= 2) {
  state.step = 2;
}
```

**Alternatif:** Jangan auto-detect step transition. Biarkan AI yang menentukan berdasarkan system prompt + history. Tapi ini kurang reliable karena AI sering "lupa" untuk update step.

---

### Issue #2: extractCustomerFields() Parsing Alamat Salah (Medium)

**Apa yang terjadi:**
Customer: "Tamantirto, kasihan, bantul" (3 items)

```javascript
// Logic sekarang (3 items):
parts[0] = "Tamantirto" → dusun  // ← salah
parts[1] = "Kasihan"    → desa   // ← salah
parts[2] = "Bantul"     → kecamatan // ← salah
```

**Yang seharusnya:**
```javascript
// 3 items = desa, kecamatan, kota (tanpa dusun)
parts[0] = "Tamantirto" → desa
parts[1] = "Kasihan"    → kecamatan
parts[2] = "Bantul"     → kota
```

**Fix yang diperlukan:**
Update `extractCustomerFields()`:
```javascript
if (parts.length === 3) {
  if (!state.desa) state.desa = parts[0];
  if (!state.kecamatan) state.kecamatan = parts[1];
  if (!state.kota) state.kota = parts[2];
}
if (parts.length === 4) {
  if (!state.dusun) state.dusun = parts[0];
  if (!state.desa) state.desa = parts[1];
  if (!state.kecamatan) state.kecamatan = parts[2];
  if (!state.kota) state.kota = parts[3];
}
```

---

### Issue #3: isEscalationNeeded() Keyword Terlalu Umum (Medium)

**Apa yang terjadi:**
Customer: "Ini dikirim kapn" → keyword "kirim" match → Step 5 eskalasi.

**Yang seharusnya:**
"Kirim" memang harus trigger eskalasi, tapi ada false positive jika customer bilang "kirim aja" (artinya: proses order, bukan tanya estimasi).

**Fix yang diperlukan:**
```javascript
function isEscalationNeeded(message, state) {
  const lower = message.toLowerCase();
  // Hanya trigger jika ada konteks pertanyaan, bukan konfirmasi order
  const isConfirmOrder = /\b(iya|oke|benar|setuju|proses|lanjut|bayar)\b/.test(lower);
  if (isConfirmOrder) return false;

  const escalationKeywords = ['estimasi', 'berapa hari', 'stok', 'retur', 'garansi',
    'komplain', 'batal', 'gak jadi', 'kirim kapan', 'hari sampai', 'kurir sampai'];
  return escalationKeywords.some(k => lower.includes(k));
}
```

---

### Issue #4: Double Reply dari Buffer (Low — sudah di-fix sebelumnya)

**Apa yang terjadi:**
Customer kirim 2 pesan cepat: "ada pasta dempul?" + "cek hrga" → digabung buffer → AI jawab 2x (1 untuk tanya produk, 1 untuk tanya harga).

**Status:** Sudah di-fix dengan buffer+check sebelumnya. Tapi perlu dipastikan AI tidak split jawaban jadi 2 untuk 1 combined message.

---

### Issue #5: Step 3 Activation Logic (Needs Review)

**Pertanyaan:**
Kapan step naik dari 1/2 ke 3? Saat customer bilang:
- "iya" (confirm order)
- "mau order"
- "pesan"
- Pilih warna

**Yang terjadi di test:**
Customer bilang "iya ka" dan "iya" 2x → AI masih tanya "mau diproses?" → tidak naik ke Step 3.

**Fix yang diperlukan:**
Tambah auto-detect di `updateOrderState()`:
```javascript
const orderIntents = /\b(iya|mau|order|pesan|beli|proses|ambil|cadangan|ambil satu)\b/;
if (state.step <= 2 && orderIntents.test(lowerMsg)) {
  state.step = 3;
}
```

---

### Issue #6: [ORDER_DATA] Tidak Dikirim (Critical)

**Apa yang terjadi:**
Customer konfirmasi "Iya" setelah rekap → AI tidak kirim [ORDER_DATA] tag → order tidak tersimpan.

**Root Cause:**
Karena test jalan dengan code LAMA (belum ada STEP4_RULES), AI tidak tahu kapan harus kirim [ORDER_DATA].

**Status:** Sudah di-fix dengan STEP4_RULES yang baru. Perlu di-test ulang.

---

## 12. Raw Payload Logging

> Setiap request ke Gemini API, server sekarang log raw JSON payload.
> Untuk melihat: `pm2 logs wa-bot --lines 500 | grep -A 50 "RAW PAYLOAD"`

**Format raw payload:**
```json
{
  "endpoint": "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
  "systemInstruction": {
    "parts": [
      { "text": "[system prompt lengkap — semua rules, KB, flags, step]" }
    ]
  },
  "contents": [
    { "role": "user",   "parts": [{ "text": "pesan customer 1" }] },
    { "role": "model",  "parts": [{ "text": "balasan AI 1" }] },
    { "role": "user",   "parts": [{ "text": "pesan customer 2" }] },
    { "role": "model",  "parts": [{ "text": "balasan AI 2" }] },
    { "role": "user",   "parts": [{ "text": "pesan customer saat ini" }] }
  ],
  "generationConfig": { "temperature": 0.7 }
}
```

**Yang perlu diperhatikan di raw payload:**
1. `systemInstruction` — apakah step rules sudah benar? Apakah STATUS SAAT INI lengkap?
2. `contents` — apakah history lengkap? Apakah ada role asymmetry (user tanpa model)?
3. `contents[last]` — apakah current message benar? Apakah ada data yang terlewat?

---

## Komentar & Review

### Dari User:
> *(Tambahkan komentar atau pertanyaan di sini)*

### Dari Claude:
> Test pertama mengungkap 6 issue. 3 di antaranya critical (step tidak naik, parsing alamat salah, ORDER_DATA tidak terkirim). Fix Phase 5 sudah direncanakan — perlu diimplementasi dan test ulang.

---

## File yang Akan Diubah

| File | Komponen | Estimasi |
|------|----------|---------|
| `server.js` | OrderState object | ~80 baris |
| `server.js` | Step rules (STEP1-5) | ~60 baris |
| `server.js` | buildSystemPrompt | ~50 baris |
| `server.js` | updateOrderState | ~40 baris |
| `server.js` | detectOrderData (address) | ~30 baris |

**Total estimasi:** ~260 baris

---

## Komentar & Review

### Dari User:
> *(Tambahkan komentar atau pertanyaan di sini)*

### Dari Claude:
> *(Catatan teknis atau alternatif di sini)*

---

## Approval

- [ ] User approve planning
- [ ] Mulai implementasi Phase 1
- [ ] Testing selesai
- [ ] Deploy ke server
