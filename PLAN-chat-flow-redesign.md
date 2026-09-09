# Plan: Chat Flow Redesign — Thinker as Decision Maker

> Tujuan: Meningkatkan kualitas response AI dengan menjadikan Thinker sebagai central decision maker.

---

## Arsitektur Baru

```
Customer kirim pesan
    ↓
[1] Thinker (Gemini call #1)
    - Classify intent
    - Extract data
    - Decide action (jawab langsung / draft / escalate)
    - Recommend nextStep
    ↓
[2] Update Order State
    - Apply extracted data ke orderState
    - Apply Thinker intent → step transition
    ↓
[3] Chatter (Gemini call #2)
    - Generate response dengan context Thinker
    - Output natural language + tags jika perlu
    ↓
[4] Post-Process
    - Parse tags ([ESCALATE], [ORDER_DATA], [DRAFT], dll)
    - Send response ke customer
```

---

## Flow Lengkap: Dari Tanya Produk Sampai Alamat

### Step 1 — Customer Tanya Produk

```
Customer: "Halo ada baby walking gak?"
```

**Thinker:**
```json
{
  "intent": "product_inquiry",
  "product": "Baby Walking Assistant",
  "extractedData": {},
  "nextStep": 1
}
```

**Chatter Context:**
```
=== THINKER RESULT ===
Intent: product_inquiry
Produk: Baby Walking Assistant
Customer baru pertama kali tanya produk ini.

=== STATUS SAAT INI ===
Step: 1 (Jawab Produk)
Belum ada data order.
```

**Chatter Response:**
```
Baby Walking Assistant harganya Rp95.000 sudah termasuk ongkir Kak.
Pilihan warna: Navy, Red, Pink Muda, Biru Muda.
Mau pilih yang mana?
```

**Order State:** `step: 1, product: "Baby Walking Assistant"`

---

### Step 2 — Customer Pilih Warna

```
Customer: "Aku pilih navy"
```

**Thinker:**
```json
{
  "intent": "order_color_selection",
  "product": null,
  "extractedData": { "color": "Navy" },
  "nextStep": 2
}
```

**Chatter Context:**
```
=== THINKER RESULT ===
Intent: order_color_selection
Data baru: color = "Navy"
→ WAJIB acknowledge: "Pilihan warna Navy sudah dicatat."

=== STATUS SAAT INI ===
Step: 2 (Follow-up)
Warna: Navy (baru diterima)
```

**Chatter Response:**
```
Siap Kak, warna Navy sudah dicatat. 
Untuk melanjutkan, boleh dibantu alamat lengkapnya? 
(Nama jalan, nomor rumah, RT/RW, desa, kecamatan, kota, dan patokan)
```

**Order State:** `step: 2, color: "Navy"`

---

### Step 3 — Customer Kirim Alamat

```
Customer: "Perumahan dalem tamantirto c3"
```

**Thinker:**
```json
{
  "intent": "data_provided",
  "product": null,
  "extractedData": { "jalan": "dalem tamantirto C3" },
  "nextStep": 3
}
```

**Chatter Context:**
```
=== THINKER RESULT ===
Intent: data_provided
Data baru: jalan = "dalem tamantirto C3"
→ WAJIB acknowledge sebelum tanya field lain.

=== STATUS SAAT INI ===
Step: 3 (Kumpul Data)
Jalan: dalem tamantirto C3 (BARU DITERIMA)
→ Belum ada: dusun/desa, RT/RW, kecamatan, kabupaten, patokan, nama lengkap, nomor HP
→ TUGAS: tanya field berikutnya (desa/kota) dalam 1 pesan
```

**Chatter Response:**
```
Perumahan Dalem Tamantirto C3 sudah dicatat ya Kak. 
Untuk desa, kecamatan, dan kota-nya mana Kak?
```

**Order State:** `step: 3, jalan: "dalem tamantirto C3"`

---

### Step 3 — Customer Kasih Data Lengkap

```
Customer: "RT 03 rukeman, tamantirto, kasihan, bantul"
```

**Thinker:**
```json
{
  "intent": "data_provided",
  "product": null,
  "extractedData": { "rtRw": "RT 03", "patokan": "Rukeman", "desa": "Tamantirto", "kecamatan": "Kasihan", "kota": "Bantul" },
  "nextStep": 3
}
```

**Chatter Context:**
```
=== THINKER RESULT ===
Intent: data_provided
Data baru:
  - RT 03
  - Patokan: Rukeman
  - Desa: Tamantirto
  - Kecamatan: Kasihan
  - Kota: Bantul
→ WAJIB acknowledge semua data baru.

=== STATUS SAAT INI ===
Step: 3 (Kumpul Data)
Jalan: dalem tamantirto C3
RT/RW: RT 03 (BARU)
Desa: Tamantirto (BARU)
Kecamatan: Kasihan (BARU)
Kota: Bantul (BARU)
Patokan: Rukeman (BARU)
→ Belum ada: nama lengkap, nomor HP
→ TUGAS: tanya nama lengkap
```

**Chatter Response:**
```
RT 03, Rukeman, Tamantirto, Kasihan, Bantul sudah dicatat ya Kak.
Untuk nama lengkap penerima-nya siapa Kak?
```

**Order State:** `step: 3, jalan, rtRw, desa, kecamatan, kota, patokan` ✅

---

### Step 3 — Customer Kasih Nama

```
Customer: "Khasin Khafabi"
```

**Thinker:**
```json
{
  "intent": "data_provided",
  "product": null,
  "extractedData": { "nama": "Khasin Khafabi" },
  "nextStep": 3
}
```

**Chatter Response:**
```
Khasin Khafabi sudah dicatat Kak. 
Boleh pakai nomor Kakak yang ini untuk dihubungi kurir, atau nomor lain ya Kak?
```

**Order State:** `step: 3, namaLengkap: "Khasin Khafabi", namaVerified: true`

---

### Step 3 — Customer Kasih Nomor

```
Customer: "Nomor yang ini"
```

**Thinker:**
```json
{
  "intent": "data_provided",
  "product": null,
  "extractedData": { "phone": "SAMA_DENGAN_WA" },
  "nextStep": 3
}
```

**Chatter Response:**
```
Nomor Kakak sudah dicatat ya. 
Untuk pembayarannya, COD atau Transfer Kak? Kalau Transfer ada diskon 10% lho.
```

**Order State:** `step: 3, noHp: "SAMA_DENGAN_WA"` — **SEMUA DATA LENGKAP**

---

### Step 4 — Customer Pilih Pembayaran

```
Customer: "COD saja"
```

**Thinker:**
```json
{
  "intent": "confirmation",
  "product": null,
  "extractedData": {},
  "nextStep": 4
}
```

**Chatter Response:**
```
✅ Rekap Pesanan:
• Produk: Baby Walking Assistant
• Varian: Navy
• Harga: Rp95.000 (sudah termasuk ongkir)
• Nama: Khasin Khafabi
• Alamat: Perumahan Dalem Tamantirto C3, RT 03, Tamantirto, Kasihan, Bantul (Patokan: Rukeman)
• Nomor HP: 085284652361
• Pembayaran: COD

Apakah data di atas sudah benar semua Kak?
```

**PENTING:** Nomor HP yang ditampilkan harus nomor ASLI customer, bukan "08xxxxxxxx" atau "nomor yang ini".
Jika customer pakai "SAMA_DENGAN_WA" → resolve ke nomor WhatsApp customer yang sebenarnya.

**Order State:** `step: 4, payment_method: "COD"`

---

### Step 5 — Customer Konfirmasi

```
Customer: "Iya"
```

**Thinker:**
```json
{
  "intent": "confirmation",
  "product": null,
  "extractedData": {},
  "nextStep": 4
}
```

**Chatter Response (dengan tag ORDER_DATA):**
```
Baik Kak Khasin, pesanan Baby Walking Assistant warna Navy sudah kami proses ya. 
Paket akan segera dikirim. Terima kasih sudah order! 🙏

[ORDER_DATA]{"nama":"Khasin Khafabi","hp":"SAMA_DENGAN_WA","produk":"Baby Walking Assistant Navy","alamat":"Perumahan Dalem Tamantirto C3, RT 03, Tamantirto, Kasihan, Bantul, Patokan: Rukeman","pembayaran":"COD"}[/ORDER_DATA]
```

---

## Case: Pertanyaan di Luar KB (Escalation)

### Customer Tanya: "Kapan dikirim?"

**Thinker:**
```json
{
  "intent": "escalation",
  "product": null,
  "extractedData": {},
  "nextStep": 5
}
```

**Chatter Context:**
```
=== THINKER RESULT ===
Intent: escalation
→ Pertanyaan ini TIDAK ADA di Knowledge Base.
→ JAWAB SINGKAT lalu ESCALATE ke admin.
→ JANGAN mengarang informasi.

=== STATUS SAAT INI ===
Step: 3
Product: Baby Walking Assistant
```

**Chatter Response:**
```
Baik Kak, untuk info pengiriman saya tanyakan ke admin dulu ya. Mohon tunggu sebentar. 🙏
[ESCALATE:Baby Walking Assistant]kapan dikirim?[/ESCALATE]
```

---

## Case: Draft Mode

### Customer Tanya: "Ada garansi?"

**Thinker:**
```json
{
  "intent": "escalation",
  "product": null,
  "extractedData": {},
  "nextStep": 5
}
```

**Chatter Response:**
```
Untuk info garansi, saya cek ke admin dulu ya Kak.
[DRAFT_ONGKIR]
```

→ AI simpan sebagai draft, admin review sebelum dikirim.

---

## Perubahan Code yang Diperlukan

### 1. message-processor.js — Guard condition

```js
// SEBELUM:
if (thinkerResult && thinkerResult.extractedData) {
  orderState = updateOrderStateFromThinker(from, combinedBody, thinkerResult);
} else {
  orderState = updateOrderState(from, combinedBody);
}

// SESUDAH:
if (thinkerResult) {
  orderState = updateOrderStateFromThinker(from, combinedBody, thinkerResult);
} else {
  orderState = updateOrderState(from, combinedBody);
}
```

### 2. message-processor.js — updateOrderStateFromThinker

```js
// Tambah handle intent escalation:
if (thinkerResult.intent === 'escalation' && [3, 4].includes(state.step)) {
  state.step = 5;
}
```

### 3. gemini-service.js — buildSystemPrompt

```js
// Tambah THINKER CONTEXT section:
if (thinkerData) {
  parts.push('=== THINKER CONTEXT ===');
  parts.push(`Intent: ${thinkerData.intent}`);
  if (thinkerData.product) parts.push(`Produk: ${thinkerData.product}`);
  if (Object.keys(thinkerData.extractedData || {}).length > 0) {
    parts.push('Data baru dari customer:');
    Object.entries(thinkerData.extractedData).forEach(([k, v]) => {
      if (v) parts.push(`- ${k}: "${v}"`);
    });
    parts.push('→ WAJIB acknowledge data di atas sebelum tanya field lain.');
  }
  if (thinkerData.intent === 'escalation') {
    parts.push('→ Pertanyaan ini TIDAK ADA di Knowledge Base. Jawab singkat lalu ESCALATE.');
    parts.push('→ JANGAN mengarang informasi.');
  }
  parts.push('');
}

// Tambah RESOLVE NOMOR HP untuk summary:
// Jika noHp = "SAMA_DENGAN_WA", resolve ke nomor asli dari WhatsApp
// (nomor customer ada di parameter `from`, format: 628xxx@s.whatsapp.net)
if (orderState?.noHp === 'SAMA_DENGAN_WA' && from) {
  const resolvedPhone = from.replace('@s.whatsapp.net', '').replace('@c.us', '');
  parts.push(`Nomor HP customer: ${resolvedPhone} (SAMA_DENGAN_WA)`);
}
```

**Note:** `from` parameter di `buildSystemPrompt` adalah JID WhatsApp customer (misal: `6285284652361@s.whatsapp.net`). 
Gunakan nomor ini untuk menampilkan nomor asli di summary, bukan "08xxxxxxxx".

### 4. gemini-thinker.js — Perkuat prompt

```js
// Tambah instruksi untuk intent escalation:
// "Ketika classify intent = escalation, pastikan extractedData berisi
//  konteks yang relevan (nama produk, pertanyaan, dll)"
```

---

## Ringkasan Perubahan

| File | Perubahan | Effort |
|------|-----------|--------|
| message-processor.js | Guard condition + intent escalation handling | 15 mnt |
| gemini-service.js | Inject Thinker context ke system prompt | 20 mnt |
| gemini-thinker.js | Perkuat prompt untuk escalation context | 10 mnt |
| order-state.js | Tambah keyword esc yang kurang (ongkir, kurir) | 5 mnt |

**Total estimasi: ~50 menit**
