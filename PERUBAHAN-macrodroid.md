# Perubahan: Dukungan Channel Ganda (Cloud API + MacroDroid)

Server sekarang bisa pilih salah satu dari 2 channel untuk kirim balasan WA, diatur lewat
setting `channel` (default: `cloudapi`). Bisa diganti langsung dari dashboard (card
**"📡 Channel Pengiriman"** di panel kiri, halaman AI WA Assistant).

## 1. Channel `cloudapi` (default, tidak berubah)
Sama seperti sebelumnya — webhook `/webhook`, kirim balasan lewat Graph API Meta.

## 2. Channel `macrodroid` (baru)
Endpoint baru: **`POST /webhook/wa-incoming`**

**Wajib disiapkan dulu sebelum dipakai:**
1. Isi `MACRODROID_BRIDGE_TOKEN` di `.env` dengan string acak bebas (sudah ditambahkan
   placeholder kosong di `.env` kamu — isi dulu sebelum deploy).
2. Di dashboard, ganti dropdown Channel Pengiriman ke **"🤖 MacroDroid (HP Android)"**
   (endpoint akan menolak request dengan status 409 selama channel belum di-set ke `macrodroid`,
   supaya tidak kepakai tanpa sengaja).
3. Di HTTP Request action Macro 1 (MacroDroid), set:
   - URL: `https://<domain-server-kamu>/webhook/wa-incoming`
   - Method: POST
   - Header: `X-Bridge-Token: <isi sama dengan MACRODROID_BRIDGE_TOKEN>`
   - Body (JSON): `{ "sender": "<nomor/nama dari notifikasi>", "message": "<isi pesan>", "senderName": "<opsional>" }`
   - Simpan field `reply` dari response ke variable `%ai_reply%` (dan `images` kalau mau
     dikembangkan lebih lanjut untuk kirim gambar via automation).

**Perilaku endpoint:**
- Menjalankan pipeline AI yang **sama persis** dengan channel Cloud API: persona, knowledge
  base per-produk, extract data order, tag `[KIRIM_GAMBAR:...]`, command `on`/`off` dari nomor
  superadmin, whitelist nomor, jam operasional, dan riwayat percakapan per kontak.
- Buffer/debounce pesan susulan tetap jalan (durasi ikut setting **"Tunggu Pesan Susulan"** yang
  sama dengan channel Cloud API). Kalau ada pesan baru masuk dari nomor yang sama sebelum
  debounce selesai, request yang lama langsung dibalas `{ "reply": null, "buffered": true }`
  (MacroDroid tidak perlu kirim apa-apa untuk respons ini) — hanya request TERAKHIR yang dapat
  balasan final berisi teks AI.
- Response sukses: `{ "reply": "<teks balasan AI>", "images": ["/images/xxx.jpg", ...] }`
- Response saat auto-reply nonaktif / di luar jam operasional / nomor tidak di-whitelist:
  `{ "reply": null, "skipped": true }`

**Keterbatasan yang perlu diketahui:**
- Kirim pesan manual dari dashboard (`/api/send`) belum didukung untuk channel MacroDroid,
  karena server tidak bisa "mendorong" pesan ke HP secara langsung (HP hanya aktif saat
  menerima notifikasi WA masuk). Balas manual langsung saja dari WhatsApp di HP kalau perlu.
- Pengiriman gambar produk lewat MacroDroid butuh langkah/macro tambahan di HP (server hanya
  menyediakan URL gambar di field `images`, belum otomatis attach & kirim seperti channel
  Cloud API).

## File yang berubah
- `server.js` — endpoint `/webhook/wa-incoming`, setting `channel`, penyesuaian `/api/status`
  & `/api/send`.
- `public/index.html` — card "Channel Pengiriman" di dashboard.
- `.env.example` dan `.env` — tambah `MACRODROID_BRIDGE_TOKEN`.
