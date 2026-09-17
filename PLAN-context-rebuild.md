# PLAN: Rebuild Context Management System

> **Status:** DRAFT - Menunggu review & approval
> **Date:** 2026-09-01
> **Author:** Claude Sonnet 4.6

---

## Ringkasan Masalah

Customer test percakapan order Baby Walking Assistant. Setelah beberapa turn, AI kehilangan konteks dan mereset ke "Halo Kak, ada yang bisa saya bantu?" padahal sedang dalam proses order.

**Contoh issue:**
```
Customer: Biru muda aja
Customer: Khasin
AI: Halo Kak, ada yang bisa saya bantu?  ← KONTEKS HILANG!
```

---

## DAFTAR ISI

1. [Testing Log (Feature Baru)](#0-testing-log)
2. [History Building](#1-history-building)
3. [System Prompt](#2-system-prompt)
4. [Debounce + Context Merging](#3-debounce--context-merging)
5. [Product Focus → OrderState](#4-product-focus--orderstate)
6. [Order Data Extraction](#5-order-data-extraction)
7. [Timeline & Prioritas](#7-timeline--prioritas)

---

## 0. Testing Log (Feature Baru)

### Tujuan

Setiap kali `callGeminiDirect()` dipanggil, log **semua data** yang dikirim ke Gemini supaya penyebab error/context loss ketahuan.

### Yang Di-log

```
═══════════════════════════════════════════════════════════
📤 GEMINI REQUEST [12:34:56] User: Khafastore (628xxx)
═══════════════════════════════════════════════════════════

--- SYSTEM PROMPT (234 tokens) ---
Kamu adalah admin Khafastore yang ramah.
PRODUK: Baby Walking Assistant Rp 95.000...
STATUS: Menunggu data nama, warna sudah dipilih (Biru Muda)

--- HISTORY (4 entries, 8 messages) ---
[1] User: "Baby walking ada?"
    AI: "Ready Kak, Rp 95.000..."
[2] User: "Aku mau order"
    AI: "Siap Kak, pilih warna dulu..."
[3] User: "Biru"
    AI: "Biru muda dicatat..."
[4] User: "Biru muda aja"
    AI: "Baik, warna Biru Muda sudah dicatat..."

--- CURRENT MESSAGE ---
"Khasin"

--- TOTAL TOKENS ---
System: 234 | History: 512 | Current: 8

═══════════════════════════════════════════════════════════
📥 GEMINI RESPONSE [12:34:58] (1.2s)
═══════════════════════════════════════════════════════════
"Siap Kak Khasin, alamat lengkapnya dimana?"
Output tokens: 24
═══════════════════════════════════════════════════════════
```

### Implementasi

Tambah fungsi `logGeminiRequest()` di `server.js`:

```javascript
function logGeminiRequest(direction, data) {
  if (!settings.debugMode) return; // hanya log jika debug mode aktif

  if (direction === 'request') {
    const { user, phone, systemPrompt, history, message, tokenEstimate } = data;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📤 GEMINI REQUEST [${new Date().toLocaleTimeString('id-ID')}] User: ${user} (${phone})`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`\n--- SYSTEM PROMPT (${tokenEstimate.system} tokens) ---`);
    console.log(systemPrompt);
    console.log(`\n--- HISTORY (${history.length} entries) ---`);
    history.forEach((h, i) => {
      console.log(`[${i+1}] User: "${h.user?.slice(0, 80)}"`);
      console.log(`    AI: "${h.ai?.slice(0, 80)}"`);
    });
    console.log(`\n--- CURRENT MESSAGE ---`);
    console.log(`"${message}"`);
    console.log(`\n--- TOKEN ESTIMATE ---`);
    console.log(`System: ${tokenEstimate.system} | History: ${tokenEstimate.history} | Current: ${tokenEstimate.current}`);
  }

  if (direction === 'response') {
    const { ok, text, error, duration, outputTokens } = data;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📥 GEMINI RESPONSE [${new Date().toLocaleTimeString('id-ID')}] (${duration}ms)`);
    console.log(`${'═'.repeat(60)}`);
    if (ok) {
      console.log(`"${text?.slice(0, 200)}"`);
      console.log(`Output tokens: ${outputTokens}`);
    } else {
      console.log(`❌ ERROR: ${error}`);
    }
    console.log(`${'═'.repeat(60)}\n`);
  }
}
```

### Setting: Debug Mode

Tambah toggle di `.env`:
```
AI_DEBUG_LOG=true
```

Atau tambah di settings dashboard.

### Komentar
> *(Tambahkan komentar di sini)*

---

## 1. History Building

### File: `server.js`

---

### BEFORE (Sekarang)

```javascript
// Di processCustomerMessage() — 2 lokasi:

// Lokasi 1 (line ~1545):
const history = messages
  .filter(m => m.from === from && m.id !== entry.id && !m.cancelledEntry && m.aiReply)
  .sort((a, b) => a.id - b.id)
  .slice(-8);  // ← HANYA 8 ENTRIES

// Lokasi 2 (line ~1709):
const history = messages
  .filter(m => m.from === from && m.id !== entry.id && !m.cancelledEntry && m.aiReply)
  .sort((a, b) => a.id - b.id)
  .slice(-8);
```

**Masalah:**
- `.slice(-8)` = max 8 entries = ~4 turn percakapan
- Konteks awal (produk, harga) hilang setelah 4 turn baru
- Jika percakapan 6 turn, turn 1-2 sudah out of context

---

### AFTER (Rencana)

```javascript
// Fungsi baru — taruh di dekat productFocus Map (~line 195):

function buildHistory(from, currentEntryId, maxEntries = 20) {
  const relevantMessages = messages
    .filter(m => m.from === from && m.id !== currentEntryId && !m.cancelledEntry && m.aiReply)
    .sort((a, b) => a.id - b.id);

  // Jika <= maxEntries, kirim semua
  if (relevantMessages.length <= maxEntries) {
    return relevantMessages;
  }

  // Jika lebih, compress entries lama jadi summary
  const recent = relevantMessages.slice(-maxEntries);
  const old = relevantMessages.slice(0, -maxEntries);

  // Buat summary dari entries lama
  const summary = buildConversationSummary(old);

  return [{ _summary: true, summary }, ...recent];
}

function buildConversationSummary(oldEntries) {
  const products = new Set();
  let discussed = [];
  for (const entry of oldEntries) {
    const userText = entry.body?.toLowerCase() || '';
    if (userText.includes('baby walking')) products.add('Baby Walking Assistant');
    if (userText.includes('pasta dempul')) products.add('Pasta Dempul');
    if (userText.includes('harga') || userText.includes('berapa')) discussed.push('harga');
    if (userText.includes('warna') || userText.includes('biru') || userText.includes('pink')) discussed.push('warna');
    if (userText.includes('order') || userText.includes('mau')) discussed.push('order');
    if (userText.includes('alamat') || userText.includes('jalan') || userText.includes('jl')) discussed.push('alamat');
    if (userText.includes('ongkir') || userText.includes('kirim')) discussed.push('ongkir');
  }
  const parts = [];
  if (products.size) parts.push(`Produk dibahas: ${[...products].join(', ')}`);
  if (discussed.length) parts.push(`Topik: ${[...new Set(discussed)].join(', ')}`);
  return parts.join('. ') || 'Percakapan sebelumnya.';
}
```

**Di callGeminiDirect() — ganti cara build contents:**

```javascript
// BEFORE:
if (history?.length) {
  for (const h of history.slice(-8)) {  // ← slice duplikat, hapus
    contents.push({ role: 'user', parts: [{ text: h.user }] });
    if (h.ai) contents.push({ role: 'model', parts: [{ text: h.ai }] });
  }
}

// AFTER:
if (history?.length) {
  for (const h of history) {
    // Jika entry adalah summary, inject sebagai system instruction tambahan
    if (h._summary) {
      // Summary akan di-append ke system prompt, bukan sebagai message
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: h.user }] });
    if (h.ai) contents.push({ role: 'model', parts: [{ text: h.ai }] });
  }
}
```

**Di buildSystemPrompt() — tambah summary:**

```javascript
// AFTER (tambah di akhir buildSystemPrompt):
if (history?.length && history[0]?._summary) {
  parts.push('');
  parts.push('=== RINGKASAN PERCAKAPAN SEBELUMNYA ===');
  parts.push(history[0].summary);
  parts.push('');
}
```

---

### Perubahan

| Aspek | Before | After |
|-------|--------|-------|
| Max history | 8 entries | 20 entries |
| Long conversation | Konteks hilang | Summary + recent 20 |
| Token usage | ~500 tokens | ~1500 tokens (worth it) |

### Komentar
> *(Tambahkan komentar di sini)*

---

## 2. System Prompt

### File: `server.js` → `buildSystemPrompt()`

---

### BEFORE (Sekarang ~120 baris)

```javascript
// Ringkasan — terlalu banyak rules:
parts.push('=== ATURAN MENJAWAB ===');
parts.push('- FOKUS pada produk yang sedang ditanyakan customer SAAT INI.');
parts.push('- Jangan campur informasi produk lain dari riwayat chat sebelumnya.');
parts.push('- Balas secara natural, singkat, dan langsung ke inti.');
parts.push('- Gunakan bahasa percakapan WhatsApp yang santai dan ramah.');
parts.push('- JANGAN gunakan tanda petik (") dalam balasan.');
parts.push('- Jika menerima pesan suara, FOKUS pada pesan teks');
parts.push('- Kamu mengaku sebagai "admin", bukan AI atau bot.');
parts.push('- Emoji dipakai JARANG saja. Maksimal 1-2 per balasan.');
parts.push('- Pisahkan paragraf dengan baris baru (enter)...');
// ... + aturan nego, CTA, panjang balasan, data pemesanan = ~120 baris total
```

**Masalah:**
- Terlalu banyak rules → AI bingung mana prioritas
- Banyak rules "JANGAN" → AI fokus ke yang tidak boleh, bukan yang harus
- Rules nego/marah/cancel jarang terjadi tapi selalu dikirim → token terbuang
- AI kadang salah pilih rules

---

### AFTER (Rencana ~40 baris)

```javascript
function buildSystemPrompt(from) {
  const parts = [];

  // === BAGIAN 1: Identitas (static) ===
  parts.push(`Kamu adalah admin ${settings.storeName || 'Toko'} yang ramah dan helpful.`);
  parts.push(`Panggil customer "Kak".`);
  parts.push('');

  // === BAGIAN 2: Produk (dynamic dari knowledge base) ===
  if (settings.knowledgeBase) {
    parts.push('PRODUK YANG TERSEDIA:');
    parts.push(settings.knowledgeBase);
    parts.push('');
  }

  // === BAGIAN 3: Aturan utama (hanya 5 rules) ===
  parts.push('ATURAN:');
  parts.push('1. Fokus ke produk yang sedang dibahas SAAT INI, jangan campur produk lain.');
  parts.push('2. Jawaban max 3-4 kalimat. Pisahkan paragraf dengan enter.');
  parts.push('3. Akhiri dengan 1 pertanyaan CTA (misal: "Mau order Kak?", "Warna apa Kak?").');
  parts.push('4. Jika ditanya harga, sebutkan harga. Jika ditanya manfaat, sebutkan manfaat.');
  parts.push('5. Jika customer kasih data (nama, alamat, HP, warna), langsung catat dan konfirmasi.');
  parts.push('');

  // === BAGIAN 4: Status order (dynamic) ===
  const orderState = orderStates?.get(from);
  if (orderState && orderState.stage !== 'idle') {
    parts.push('=== STATUS ORDER SAAT INI ===');
    parts.push(`Produk: ${orderState.product || '-'}`);
    parts.push(`Stage: ${orderState.stage}`);
    if (orderState.color) parts.push(`Warna: ${orderState.color}`);
    if (orderState.name) parts.push(`Nama: ${orderState.name}`);
    if (orderState.address) parts.push(`Alamat: ${orderState.address}`);
    if (orderState.phone) parts.push(`HP: ${orderState.phone}`);

    // Apa yang perlu ditanyakan selanjutnya
    const nextField = getNextOrderField(orderState);
    if (nextField) {
      parts.push(`→ Menunggu: ${nextField}`);
      parts.push(`Jika customer memberikan ${nextField}, langsung catat dan lanjut.`);
    }
    parts.push('');
  }

  // === BAGIAN 5: Rules situasional (hanya jika relevan) ===
  if (orderState?.stage === 'confirmed') {
    parts.push('Order sudah lengkap. Konfirmasi total harga dan ongkir ke customer.');
    parts.push('');
  }

  return parts.join('\n');
}

function getNextOrderField(state) {
  const flow = ['color', 'name', 'address', 'phone'];
  for (const field of flow) {
    if (!state[field]) {
      const labels = { color: 'warna', name: 'nama lengkap', address: 'alamat lengkap', phone: 'no HP' };
      return labels[field];
    }
  }
  return null; // semua sudah lengkap
}
```

---

### Perubahan

| Aspek | Before | After |
|-------|--------|-------|
| Jumlah rules | ~15 rules | 5 rules |
| Panjang prompt | ~120 baris | ~40 baris |
| Token usage | ~800 tokens | ~300 tokens |
| Rules situasional | Selalu dikirim | Hanya jika relevan |
| Status order | Tidak ada | Di-inject otomatis |

### Komentar
> *(Tambahkan komentar di sini)*

---

## 3. Message Buffering (Ganti Debounce)

### File: `server.js` → Webhook handler + `pendingBuffers`

### Konsep

**Cara kerja manusia:**
```
Baca pesan → Proses → Sebelum kirim, cek ada pesan susulan?
  → Kalau ADA: gabung & proses ulang
  → Kalau TIDAK: kirim jawaban
```

**Bukan debounce timeout**, tapi **buffer + cek sebelum kirim**.

---

### BEFORE (Sekarang — Debounce 6 detik)

```javascript
// Webhook handler:
const buf = pendingBuffers.get(from);
buf.messages.push(entry);
if (buf.timeout) clearTimeout(buf.timeout);
buf.timeout = setTimeout(() => {
  processBuffer(from);  // proses setelah 6 detik
}, 6000);

// processBuffer:
async function processBuffer(from) {
  const buf = pendingBuffers.get(from);
  const combinedBody = buf.messages.map(m => m.body).filter(Boolean).join('\n');
  processCustomerMessage(from, combinedBody, ...);
}
```

**Masalah:**
- "baby walking?" (detik 0) → debounce 6 detik
- "cek hrga?" (detik 6) → timeout sudah jalan → proses terpisah
- Hasil: **2 balasan** untuk topik yang sama

---

### AFTER (Rencana — Buffer + Cek Susulan)

```javascript
// ═══════════════════════════════════════════════════════════════
// BARU: Message buffer per user — ganti debounce timeout
// ═══════════════════════════════════════════════════════════════

// Map: from → { pending: [], processing: boolean, lastAiReply: string|null }
const messageBuffers = new Map();

function getBuffer(from) {
  if (!messageBuffers.has(from)) {
    messageBuffers.set(from, { pending: [], processing: false, lastAiReply: null });
  }
  return messageBuffers.get(from);
}

// ═══════════════════════════════════════════════════════════════
// STEP 1: Webhook terima pesan → masuk ke buffer
// ═══════════════════════════════════════════════════════════════

// Di webhook handler (ganti debounce lama):
const buf = getBuffer(from);
buf.pending.push(entry);
console.log(`📥 [Buffer] ${senderName}: "${entry.body}" (pending: ${buf.pending.length})`);

// Jika sedang tidak proses, mulai proses
if (!buf.processing) {
  processBufferedMessages(from);
}

// ═══════════════════════════════════════════════════════════════
// STEP 2: Proses buffer — kirim ke AI, cek susulan sebelum reply
// ═══════════════════════════════════════════════════════════════

async function processBufferedMessages(from) {
  const buf = getBuffer(from);
  if (buf.processing || buf.pending.length === 0) return;

  buf.processing = true;

  try {
    while (buf.pending.length > 0) {
      // Ambil semua pesan yang pending
      const messages = buf.pending.splice(0); // ambil & kosongkan
      const combinedBody = messages.map(m => m.body).filter(Boolean).join('\n');

      console.log(`🔄 [Buffer] Proses ${messages.length} pesan: "${combinedBody.slice(0, 60)}"`);

      // ═══════════════════════════════════════════════════════════
      // STEP 3: Kirim ke AI (async) — sambil nunggu, buffer menerima pesan baru
      // ═══════════════════════════════════════════════════════════

      const aiReply = await getAIReply(from, combinedBody, ...);

      // ═══════════════════════════════════════════════════════════
      // STEP 4: Cek ada susulan? Sebelum kirim ke WhatsApp
      // ═══════════════════════════════════════════════════════════

      if (buf.pending.length > 0) {
        // ADA SUSULAN → jangan kirim dulu, proses gabungan
        console.log(`⚡ [Buffer] Ada ${buf.pending.length} susulan → gabung & proses ulang`);
        continue; // loop lagi → gabung pesan lama + susulan
      }

      // TIDAK ADA SUSULAN → kirim ke WhatsApp
      if (aiReply) {
        await sendWhatsAppMessage(from, aiReply);
        buf.lastAiReply = aiReply;
        console.log(`✅ [Buffer] Reply terkirim: "${aiReply.slice(0, 60)}"`);
      }
    }
  } finally {
    buf.processing = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// STEP 5: Fungsi AI (sama seperti sekarang, tapi dengan logging)
// ═══════════════════════════════════════════════════════════════

async function getAIReply(from, message, senderName, imagePath, audioPath) {
  // Build history
  const history = buildHistory(from, currentEntryId);

  // Update order state
  const orderState = updateOrderState(from, message);

  // Build system prompt (dengan order state)
  const systemPrompt = buildSystemPrompt(from);

  // Log untuk debugging
  logGeminiRequest('request', {
    user: senderName,
    phone: from,
    systemPrompt,
    history,
    message,
    tokenEstimate: { system: estimateTokens(systemPrompt), history: estimateTokens(JSON.stringify(history)), current: estimateTokens(message) }
  });

  // Call Gemini
  const result = await callGeminiDirect(apiKey, message, history, systemPrompt);

  logGeminiRequest('response', { ok: result.ok, text: result.text, error: result.error, duration: result.duration });

  return result.ok ? result.text : null;
}
```

---

### Flow Diagram

```
Customer kirim: "baby walking?"
  │
  ▼
Buffer: pending = ["baby walking?"]
  │
  ▼
Mulai proses → getAIReply("baby walking?")
  │
  │  ... sementara AI proses (2-3 detik) ...
  │
  │  Customer kirim: "cek hrga?"
  │  Buffer: pending = ["cek hrga?"]
  │
  ▼
AI selesai → aiReply = "Baby Walking ready, Rp 95.000..."
  │
  ▼
CEK: buf.pending.length > 0? → YA (ada "cek hrga?")
  │
  ▼
JANGAN KIRIM DULU → gabung: "baby walking?\ncek hrga?"
  │
  ▼
Proses ulang → getAIReply("baby walking?\ncek hrga?")
  │
  ▼
AI selesai → aiReply = "Baby Walking ready, Rp 95.000. Mau order Kak?"
  │
  ▼
CEK: buf.pending.length > 0? → TIDAK
  │
  ▼
KIRIM ke WhatsApp → 1 jawaban gabungan ✅
```

---

### Skenario Lain

**Skenario A: Pesan susulan di order flow**
```
"Biru muda aja" → AI proses → sebelum kirim cek → ada "Khasin"
→ gabung: "Biru muda aja\nKhasin" → AI proses
→ "Baik Kak Khasin, warna Biru Muda sudah dicatat. Alamatnya?"
→ kirim 1 jawaban ✅
```

**Skenario B: Tidak ada susulan**
```
"baby walking?" → AI proses → sebelum kirim cek → tidak ada susulan
→ kirim langsung ✅
```

**Skenario C: Pesan datang setelah reply terkirim**
```
"baby walking?" → AI proses → tidak ada susulan → kirim reply
... 10 detik kemudian ...
"cek hrga?" → buffer kosong → proses baru → kirim reply baru
→ 2 balasan (wajar, karena memang topik baru) ✅
```

---

### Perubahan

| Aspek | Before (Debounce) | After (Buffer + Cek) |
|-------|--------|------|
| Mekanisme | Timeout 6 detik | Cek susulan sebelum kirim |
| "baby walking?" + "cek hrga?" | 2 balasan | 1 balasan gabungan |
| "Biru muda" + "Khasin" | Digabung otomatis | Digabung jika ada saat AI proses |
| Delay respon | 6 detik | Langsung (no delay) |
| Cara kerja | Timeout-based | Event-based (seperti manusia) |

### Komentar
> *(Tambahkan komentar di sini)*

---

## 4. Product Focus → OrderState

### File: `server.js`

---

### BEFORE (Sekarang)

```javascript
// productFocus — hanya simpan nama produk:
const productFocus = new Map(); // from → "Baby Walking Assistant"

// Detect produk:
function detectProductFocus(message) {
  const blocks = parseProductBlocks(settings.knowledgeBase);
  if (!blocks.length) return null;
  const lowerMsg = message.toLowerCase();
  for (const b of blocks) {
    if (!b.name) continue;
    const words = b.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    if (words.some(w => lowerMsg.includes(w))) return b.name;
  }
  return null;
}

// Update di processCustomerMessage:
const detectedProduct = detectProductFocus(combinedBody);
if (detectedProduct) {
  productFocus.set(from, detectedProduct);
}

// Inject ke system prompt:
const focus = from ? productFocus.get(from) : null;
if (focus) {
  parts.push(`=== PRODUK FOKUS SAAT INI: ${focus} ===`);
}
```

**Masalah:**
- Hanya tahu produk apa, tidak tahu **stage** order
- Tidak tahu data apa yang sudah dikumpulkan
- Ketika customer bilang "Khasin", AI tidak tahu itu nama untuk order

---

### AFTER (Rencana)

```javascript
// GANTI productFocus DENGAN orderStates:
const orderStates = new Map();
// from → {
//   product: "Baby Walking Assistant",
//   stage: "color_selected",     // idle, product_inquired, color_selected, name_given, address_given, phone_given, confirmed
//   color: "Biru Muda",
//   name: null,
//   address: null,
//   phone: null,
//   lastUpdate: Date.now()
// }

const ORDER_STAGES = ['idle', 'product_inquired', 'color_selected', 'name_given', 'address_given', 'phone_given', 'confirmed'];

function createOrderState(product) {
  return {
    product,
    stage: 'product_inquired',
    color: null,
    name: null,
    address: null,
    phone: null,
    lastUpdate: Date.now()
  };
}

// Detect produk (sama seperti before):
function detectProductFocus(message) {
  const blocks = parseProductBlocks(settings.knowledgeBase);
  if (!blocks.length) return null;
  const lowerMsg = message.toLowerCase();
  for (const b of blocks) {
    if (!b.name) continue;
    const words = b.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    if (words.some(w => lowerMsg.includes(w))) return b.name;
  }
  return null;
}

// NEW: Detect order data dari pesan customer:
function detectOrderData(message, currentStage) {
  const lower = message.toLowerCase().trim();
  const data = {};

  // Deteksi warna
  const colorMap = {
    'biru muda': 'Biru Muda', 'biru': 'Biru Muda',
    'pink muda': 'Pink Muda', 'pink': 'Pink Muda',
    'abu': 'Abu-abu', 'abu-abu': 'Abu-abu',
    'navy': 'Navy', 'red': 'Red', 'merah': 'Red'
  };
  for (const [key, val] of Object.entries(colorMap)) {
    if (lower === key || lower.includes(key)) {
      data.color = val;
      break;
    }
  }

  // Deteksi nama (jika stage = waiting_name)
  if (currentStage === 'color_selected' || currentStage === 'product_inquired') {
    // Nama: 1-2 kata, bukan pertanyaan, bukan warna, bukan alamat
    const words = message.trim().split(/\s+/);
    if (words.length <= 3 && !lower.includes('?') && !data.color && !lower.includes('jl')) {
      data.name = message.trim();
    }
  }

  // Deteksi alamat
  if (lower.includes('jl') || lower.includes('jalan') || lower.includes('gang') || lower.includes('rt') || lower.includes('rw')) {
    data.address = message.trim();
  }

  // Deteksi HP
  const phoneMatch = message.replace(/\s/g, '').match(/(08\d{8,12})/);
  if (phoneMatch) {
    data.phone = phoneMatch[1];
  }

  return data;
}

// Update order state:
function updateOrderState(from, message) {
  let state = orderStates.get(from);
  const detectedProduct = detectProductFocus(message);

  // Jika ada produk baru terdeteksi, buat/update state
  if (detectedProduct) {
    if (!state || state.product !== detectedProduct) {
      state = createOrderState(detectedProduct);
      orderStates.set(from, state);
    }
  }

  if (!state || state.stage === 'idle') return state;

  // Detect data dari pesan
  const data = detectOrderData(message, state.stage);
  if (data.color && !state.color) { state.color = data.color; state.stage = 'color_selected'; }
  if (data.name && !state.name) { state.name = data.name; state.stage = 'name_given'; }
  if (data.address && !state.address) { state.address = data.address; state.stage = 'address_given'; }
  if (data.phone && !state.phone) { state.phone = data.phone; state.stage = 'phone_given'; }

  // Cek apakah semua data lengkap
  if (state.color && state.name && state.address && state.phone) {
    state.stage = 'confirmed';
  }

  state.lastUpdate = Date.now();
  orderStates.set(from, state);
  return state;
}

// Cleanup order state setelah 30 menit idle:
setInterval(() => {
  const now = Date.now();
  for (const [from, state] of orderStates) {
    if (now - state.lastUpdate > 30 * 60 * 1000) {
      orderStates.delete(from);
    }
  }
}, 5 * 60 * 1000);
```

**Ganti di processCustomerMessage:**

```javascript
// BEFORE:
const detectedProduct = detectProductFocus(combinedBody);
if (detectedProduct) {
  const prevFocus = productFocus.get(from);
  if (prevFocus && prevFocus !== detectedProduct) {
    console.log(`🔄 [ProductFocus] ${senderName}: ${prevFocus} → ${detectedProduct}`);
  }
  productFocus.set(from, detectedProduct);
}

// AFTER:
const orderState = updateOrderState(from, combinedBody);
if (orderState) {
  console.log(`📋 [OrderState] ${senderName}: stage=${orderState.stage}, product=${orderState.product}, color=${orderState.color || '-'}, name=${orderState.name || '-'}`);
}
```

---

### Perubahan

| Aspek | Before | After |
|-------|--------|-------|
| Data yang disimpan | Nama produk saja | Produk + stage + color + name + address + phone |
| AI tahu "Khasin" itu apa | Tidak | Ya (stage = waiting_name) |
| AI tahu warna sudah dipilih | Tidak | Ya (color = "Biru Muda") |
| Auto timeout | Tidak ada | 30 menit idle → reset |

### Komentar
> *(Tambahkan komentar di sini)*

---

## 5. Order Data Extraction

### File: `server.js`

---

### BEFORE (Sekarang)

```javascript
function extractOrder(replyText, fromJid) {
  // Hanya extract dari REPLY AI, bukan dari pesan customer
  // Pattern: [ORDER_DATA]...[/ORDER_DATA] atau regex
}
```

**Masalah:**
- Hanya extract dari reply AI
- Tidak extract dari pesan customer langsung
- Jika customer bilang "Saya Andi, Jl Merdeka No 5", tidak ke-extract

---

### AFTER (Rencana)

```javascript
// Sudah termasuk di Section 4 (OrderState):
// detectOrderData() akan extract dari pesan customer langsung

// Tambahan: Fungsi untuk format order summary
function getOrderSummary(from) {
  const state = orderStates?.get(from);
  if (!state || state.stage === 'idle') return null;

  const parts = [`Produk: ${state.product}`];
  if (state.color) parts.push(`Warna: ${state.color}`);
  if (state.name) parts.push(`Nama: ${state.name}`);
  if (state.address) parts.push(`Alamat: ${state.address}`);
  if (state.phone) parts.push(`HP: ${state.phone}`);
  parts.push(`Status: ${state.stage}`);

  return parts.join(' | ');
}

// Untuk logging:
// Di processCustomerMessage(), setelah updateOrderState:
const orderSummary = getOrderSummary(from);
if (orderSummary) {
  console.log(`📦 [Order] ${senderName}: ${orderSummary}`);
}
```

---

### Perubahan

| Aspek | Before | After |
|-------|--------|-------|
| Sumber extract | Reply AI saja | Pesan customer langsung |
| Data yang di-extract | Nama, alamat, HP | + Warna, stage |
| Update timing | Saat AI reply | Saat pesan customer masuk |

### Komentar
> *(Tambahkan komentar di sini)*

---

## 6. Timeline & Prioritas

### Phase 1: Critical Fix (Hari Ini)
- [ ] Implement testing log (`logGeminiRequest`)
- [ ] Rebuild history building (`buildHistory`)
- [ ] Rebuild system prompt (`buildSystemPrompt`)
- [ ] Fix debounce (smart merge)
- [ ] Test dengan `node test-real-chat.js --verbose`

### Phase 2: OrderState (Hari Ini Juga)
- [ ] Implement `orderStates` Map
- [ ] Implement `updateOrderState()`
- [ ] Implement `detectOrderData()`
- [ ] Inject order state ke system prompt
- [ ] Test order flow lengkap

### Phase 3: Deploy & Monitor
- [ ] Deploy ke server
- [ ] Monitor logs 1-2 jam
- [ ] Cek context retention di production

---

## File yang Akan Diubah

| File | Komponen | Estimasi Perubahan |
|------|----------|-------------------|
| `server.js` | Testing log | ~60 baris |
| `server.js` | History building | ~50 baris |
| `server.js` | System prompt | ~40 baris (rewrite) |
| `server.js` | Debounce handler | ~50 baris |
| `server.js` | OrderState | ~100 baris |
| `test-ai-context.js` | Test cases | ~30 baris |

**Total estimasi:** ~330 baris perubahan

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
