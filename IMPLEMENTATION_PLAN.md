# Perbaikan WA AI Assistant — 5 Fitur Baru (Updated)

Berdasarkan analisis kode `server.js` (2474 baris) + klarifikasi user, berikut plan implementasi final.

---

## Ringkasan Perubahan

| # | Fitur | File Terdampak | Kompleksitas |
|---|-------|---------------|-------------|
| 1 | Handle bubble chat (reaction, sticker, audio, dll) | `server.js` | Rendah |
| 2 | Guard + retry tanya nama & alamat detail | `server.js` | Sedang |
| 3 | Split bubble: line 1 kunci konteks produk, line 2 detail | `server.js` | Sedang |
| 4 | Link lokasi dikirim AI otomatis setelah alamat terkumpul | `server.js` + `public/loc.html` | Sedang |
| 5 | Tanya RT, RW dalam pertanyaan alamat pengiriman | `server.js` (system prompt) | Rendah |

---

## Open Questions

> [!IMPORTANT]
> **Fitur 3 — Split Response:**
> AI otomatis memutuskan kapan harus split menggunakan tag `[SPLIT]` saat customer pertama kali menyebut nama produk. Ini menjaga konteks produk tetap ada di history chat.

> [!IMPORTANT]
> **Fitur 4 — Location Tracker:**
> Link dikirim otomatis oleh AI setelah alamat detail terkumpul. Server akan menukar tag `[KIRIM_LINK_LOKASI]` dengan link unik, dan saat customer klik link tersebut, koordinat akan tersimpan untuk digunakan AI dalam percakapan berikutnya.

> [!WARNING]
> **Fitur 2 — Guard field wajib:**
> Guard diterapkan dua lapis: 1) Instruksi ketat di system prompt untuk tanya satu per satu, dan 2) Filter di `extractOrder` untuk membatalkan simpan order jika data (nama/alamat) tidak lengkap.

---

## Proposed Changes

---

### Fitur 1 — Handle Bubble Chat Non-Teks

**Masalah saat ini:**  
Di `server.js` line 1422–1429, tipe pesan yang ditangani hanya: `text`, `image`, `video`, `button`, `interactive`. Tipe lain seperti `reaction`, `sticker`, `audio`, `document`, `location` (kiriman manual) langsung di-skip dengan log "tanpa teks/caption, dilewati" — tidak ada fallback yang bermakna.

#### [MODIFY] [server.js](file:///Users/a1/Project/wa-ai-gemini2/server.js)

Tambahkan handling di blok `body` extraction (line ~1422–1429):

```diff
  if (msg.type === 'text') body = msg.text?.body || '';
  else if (msg.type === 'image') body = msg.image?.caption || '';
  else if (msg.type === 'video') body = msg.video?.caption || '';
  else if (msg.type === 'button') body = msg.button?.text || '';
  else if (msg.type === 'interactive') body = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
+ else if (msg.type === 'sticker') { console.log(`ℹ️ Stiker diterima dari ${from}, dilewati`); continue; }
+ else if (msg.type === 'reaction') { console.log(`ℹ️ Reaction diterima dari ${from}, dilewati`); continue; }
+ else if (msg.type === 'audio') body = '[customer mengirim pesan suara, kamu tidak bisa mendengarnya — balas dengan sopan bahwa kamu hanya bisa menerima pesan teks]';
+ else if (msg.type === 'document') body = '[customer mengirim dokumen/file — balas dengan sopan bahwa kamu hanya bisa menerima pesan teks atau gambar produk]';
+ else if (msg.type === 'location') {
+   // Lokasi manual (bukan dari tracker kita) — tetap bisa diproses
+   const lat = msg.location?.latitude;
+   const lng = msg.location?.longitude;
+   body = lat && lng ? `[customer mengirim lokasi GPS: ${lat}, ${lng}]` : '';
+ }
```

**Catatan:** `reaction` dan `sticker` di-skip diam-diam (tidak balas AI), tapi `audio` dan `document` dibalas dengan pesan fallback yang bermakna supaya customer tidak merasa diabaikan.

---

### Fitur 2 — Guard + Retry Tanya Nama & Alamat Detail

**Masalah saat ini:**  
AI terkadang "skip" tanya nama atau alamat detail karena customer menjawab panjang dan AI salah baca konteks. Tidak ada pengaman di level server.

**Klarifikasi user:** Kalau customer belum kirim nama dan alamat detail → AI harus tanya lagi, tidak boleh lanjut rekap.

**Solusi berlapis (dua layer):**

#### Layer 1 — Prompt AI diperketat

Update `buildSystemPrompt()` pada bagian `=== ATURAN DATA PEMESANAN ===` (line ~622–635):

```diff
+ '- WAJIB VERIFIKASI SEBELUM REKAP: Sebelum kamu mengirim rekap pesanan, CEK satu per satu apakah data berikut SUDAH pernah disebut eksplisit oleh customer di percakapan ini:'
+ '    ✅ Nama lengkap penerima (bukan nama WA — harus customer yang menyebutnya sendiri)'
+ '    ✅ Alamat lengkap dengan RT/RW, kelurahan, kecamatan, kota'
+ '    ✅ Konfirmasi No HP'
+ '  Kalau ada yang BELUM → JANGAN rekap dulu. Tanyakan field yang masih kurang, satu per satu.'
+ '- DILARANG KERAS menyisipkan [ORDER_DATA] jika nama penerima atau alamat detail BELUM pernah dikirimkan customer.'
```

#### Layer 2 — Server-side Guard di `extractOrder()` (line ~789–820)

Validasi wajib sebelum simpan order:

```js
// Guard: tolak ORDER_DATA kalau nama atau alamat kosong/terlalu pendek
const missingFields = [];
if (!order.nama?.trim() || order.nama.trim().length < 3) missingFields.push('nama');
if (!order.produk?.trim()) missingFields.push('produk');
if (!order.alamat?.trim() || order.alamat.trim().length < 10) missingFields.push('alamat detail');

if (missingFields.length > 0) {
  console.warn(`⚠️ ORDER_DATA ditolak — field belum lengkap: ${missingFields.join(', ')}`);
  // Buang tag ORDER_DATA tapi tetap kirim teks balasan AI ke customer
  cleanReply = replyText.replace(/\[ORDER_DATA\][\s\S]*?\[\/ORDER_DATA\]/g, '').trim();
  return cleanReply;
}
```

**Efek:** Kalau AI "nekat" rekap tanpa nama/alamat, order tidak tersimpan. Balasan AI tetap terkirim ke customer, tapi tanpa order masuk ke sistem — sehingga AI akan lanjut tanya lagi di pesan berikutnya.

---

### Fitur 3 — Split Bubble: Line 1 Kunci Konteks Produk, Line 2 Detail

**Masalah saat ini:**  
Semua balasan AI = 1 bubble. Kalau ada bubble AI baru masuk setelah customer tanya BWA, AI bisa "lupa" produknya dan tanya ulang "produk yang mana?".

**Klarifikasi user:**  
> Line 1 = kunci konteks produk (misal "Baby Walking Assistant ya Kak"), Line 2 = detail/harga/varian.  
> Tujuan: supaya kalau ada bubble AI baru, konteks produk sudah terkunci di line 1 dan AI tidak perlu tanya ulang.

**Mekanisme:**
- AI menggunakan tag `[SPLIT]` untuk memisahkan 2 bubble
- **Line 1 (sebelum `[SPLIT]`):** Konfirmasi/kunci produk yang sedang dibahas  
- **Line 2 (setelah `[SPLIT]`):** Isi detail (harga, varian, dll)

Contoh output AI:
```
Baby Walking Assistant ya Kak 😊
[SPLIT]
Harganya Rp 250.000, tersedia warna pink dan biru. Mau pilih warna apa Kak?
```

```
Selang fleksibel ya Kak 👍
[SPLIT]
Harga Rp 85.000, tersedia ukuran 1m dan 2m. Mau ukuran berapa Kak?
```

**Kapan `[SPLIT]` dipakai?**  
Hanya saat customer **pertama kali** menyebut nama produk dan belum ada konfirmasi produk di history. Tidak dipakai untuk balasan biasa (harga ulang, tanya alamat, dll).

#### [MODIFY] [server.js](file:///Users/a1/Project/wa-ai-gemini2/server.js) — System Prompt

Tambah aturan di `buildSystemPrompt()`:

```
=== ATURAN SPLIT BUBBLE (PENTING) ===
- Ketika customer menyebut nama produk untuk pertama kali di percakapan ini, WAJIB pisahkan 
  balasanmu menjadi 2 bagian dengan tag [SPLIT]:
    Bagian 1 (sebelum [SPLIT]): Hanya 1 kalimat pendek yang mengkonfirmasi produk yang ditanyakan.
    Contoh: "Baby Walking Assistant ya Kak 😊" atau "Selang fleksibel ya Kak 👍"
    Bagian 2 (setelah [SPLIT]): Isi jawaban lengkap (harga, varian, detail, CTA).
- Jika produk sudah pernah dikonfirmasi di percakapan ini, JANGAN pakai [SPLIT] lagi.
- JANGAN gunakan [SPLIT] untuk balasan non-produk (tanya nama, alamat, konfirmasi order, dll).
```

#### [MODIFY] [server.js](file:///Users/a1/Project/wa-ai-gemini2/server.js) — Send Logic

Di `processCustomerMessage()`, ganti satu `sendWhatsAppText()` dengan loop multi-bubble:

```js
// Split [SPLIT] jadi beberapa bubble
const bubbles = cleanReply.split('[SPLIT]').map(p => p.trim()).filter(Boolean);
for (let i = 0; i < bubbles.length; i++) {
  if (i > 0) await sleep(1200); // jeda natural antar bubble
  await sendWhatsAppText(from, bubbles[i], i === 0 ? lastWamid : undefined);
}
```

Update juga di `flushMacrodroidBuffer()` untuk channel MacroDroid.

---

### Fitur 4 — Link Lokasi Dikirim AI Otomatis Setelah Alamat Terkumpul

**Klarifikasi user:**  
> Setelah AI selesai menanyakan lokasi (RT/RW, dll sudah dijawab customer), AI secara otomatis mengirim pesan:
> *"Apakah Kakak sekarang di rumah? Kalau di rumah, tolong buka link ini dan berikan akses lokasi supaya rumah mudah ditemukan kurir: [link]"*

**Cara kerja lengkap:**

```
1. Customer jawab alamat lengkap (RT/RW, dll)
2. AI deteksi alamat sudah lengkap → menyisipkan tag khusus [KIRIM_LINK_LOKASI] di balasannya
3. Server deteksi tag tersebut:
   a. Generate session token unik untuk wa_id ini
   b. Kirim teks balasan AI normal ke customer
   c. Kirim bubble ke-2 berisi link: "https://app.trustiomart.com/loc?s=<token>"
4. Customer buka link di browser HP → halaman minta izin GPS
5. Koordinat dikirim ke POST /api/location-capture
6. Server reverse geocode → simpan ke Map customerLocations per wa_id
7. AI berikutnya mendapat info koordinat/alamat GPS di context
```

**Pesan yang dikirim AI (instruksi di system prompt):**
```
Setelah alamat lengkap (termasuk RT/RW) sudah dijawab customer, sisipkan tag berikut 
di akhir balasanmu:
[KIRIM_LINK_LOKASI]
Tag ini akan otomatis diganti sistem dengan link dan pesan:
"Apakah Kakak sekarang di rumah? Kalau di rumah, boleh buka link ini dan izinkan 
akses lokasi ya Kak, supaya rumah Kakak lebih mudah ditemukan kurir 🏠"
```

#### [NEW] [public/loc.html](file:///Users/a1/Project/wa-ai-gemini2/public/loc.html)

Halaman HTML yang:
- Tampilkan pesan "Sedang mendeteksi lokasi Anda..."
- Request `navigator.geolocation.getCurrentPosition()`
- Kirim `{ lat, lng, session }` ke `POST /api/location-capture`
- Tampilkan ✅ "Lokasi berhasil terdeteksi! Terima kasih Kak, kurir kami akan lebih mudah menemukan rumah Kakak."
- Tampilkan ❌ jika akses ditolak, dengan instruksi cara izinkan manual

#### [MODIFY] [server.js](file:///Users/a1/Project/wa-ai-gemini2/server.js)

**Tambah data store:**
```js
const locationSessions = new Map(); // token → { from, createdAt }
const customerLocations = new Map(); // wa_id → { lat, lng, address, timestamp }
```

**Tambah endpoints:**
- `POST /api/location-capture` — terima `{ lat, lng, session }`, reverse geocode via Nominatim, simpan ke `customerLocations`
- `GET /loc` → serve `public/loc.html`

**Tambah tag handler di `processCustomerMessage()`:**
```js
// Deteksi [KIRIM_LINK_LOKASI] di reply AI
if (cleanReply.includes('[KIRIM_LINK_LOKASI]')) {
  cleanReply = cleanReply.replace('[KIRIM_LINK_LOKASI]', '').trim();
  // Kirim teks reply normal dulu
  await sendWhatsAppText(from, cleanReply, lastWamid);
  // Lalu kirim bubble ke-2 berisi link lokasi
  const token = crypto.randomBytes(16).toString('hex');
  locationSessions.set(token, { from, createdAt: Date.now() });
  const locLink = `https://app.trustiomart.com/loc?s=${token}`;
  const locMsg = `Apakah Kakak sekarang di rumah? Kalau di rumah, boleh buka link ini dan izinkan akses lokasi ya Kak, supaya rumah Kakak lebih mudah ditemukan kurir 🏠\n${locLink}`;
  await sleep(1500);
  await sendWhatsAppText(from, locMsg);
  // skip normal send di bawah karena sudah terkirim
  return;
}
```

**Inject lokasi ke system prompt:**
```js
// Di buildSystemPrompt(), tambah konteks lokasi jika sudah tersedia
const loc = customerLocations.get(from);
if (loc) {
  parts.push(`=== LOKASI GPS CUSTOMER (dari link tracker) ===`);
  parts.push(`Koordinat: ${loc.lat}, ${loc.lng}`);
  if (loc.address) parts.push(`Alamat terdeteksi: ${loc.address}`);
  parts.push('Gunakan info ini sebagai konfirmasi alamat pengiriman jika relevan.');
  parts.push('');
}
```

---

### Fitur 5 — Tanya Detail Lokasi: RT, RW

**Masalah saat ini:**  
System prompt hanya minta "alamat lengkap (kelurahan/kecamatan/kota/kode pos)" + "patokan" — tidak ada instruksi untuk tanya RT/RW.

#### [MODIFY] [server.js](file:///Users/a1/Project/wa-ai-gemini2/server.js) — System Prompt

Update bagian urutan pengumpulan data di `buildSystemPrompt()` (line ~624–627):

```diff
- '  2) Tanya Alamat lengkap (kelurahan/kecamatan/kota/kode pos) — 1 pertanyaan saja'
+ '  2) Tanya Alamat lengkap — minta: nama jalan/gang, nomor rumah, RT/RW, kelurahan/desa, kecamatan, kota/kabupaten, kode pos — 1 pertanyaan saja. Contoh: "Boleh minta alamat lengkapnya Kak? Termasuk nama jalan/gang, nomor rumah, RT/RW, kelurahan, kecamatan, dan kota/kabupatennya ya"'
```

Update juga field `alamat` di `[ORDER_DATA]` format:

```diff
- '"alamat": "Alamat Lengkap termasuk patokan bila ada"'
+ '"alamat": "Alamat Lengkap termasuk RT/RW, kelurahan, kecamatan, kota, dan patokan bila ada"'
```

---

## Urutan Implementasi yang Disarankan

1. **Fitur 5** — paling mudah, hanya ubah string di system prompt ✅  
2. **Fitur 2** — prompt + server guard, tidak ada dependency baru ✅  
3. **Fitur 1** — extend switch/if di webhook handler ✅  
4. **Fitur 3** — split logic, perlu update dua tempat (Cloud API + MacroDroid) ✅  
5. **Fitur 4** — paling kompleks, butuh file baru + 3 endpoint baru ✅  

---

## Verification Plan

### Automated
- `node -e "require('./server.js')"` — pastikan server boot tanpa error

### Manual
- Kirim stiker dari WA → pastikan tidak membalas
- Kirim audio dari WA → pastikan AI balas dengan pesan "hanya bisa terima teks"  
- Test chat order: lewat proses tanpa isi nama → pastikan ORDER_DATA tidak tersimpan
- Test `[SPLIT]` tag → pastikan terkirim 2 bubble terpisah
- Buka `/loc?s=test` di browser → pastikan halaman muncul dan request geolocation
- Test tanya ongkir → pastikan AI minta RT/RW dalam pertanyaan alamat
