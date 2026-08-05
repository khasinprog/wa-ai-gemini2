# Perubahan v2 — Ringkasan

## Bug Fixes

### 1. PWA teks tidak muncul (BUG UTAMA)
- **Root cause**: `socket.on('message_updated')` tidak ada di frontend — AI reply masuk tapi UI tidak update
- **Fix**: Tambah handler `message_updated` di frontend yang update allMessages dan re-render chat

### 2. Inconsistency field `msg.from` vs `msg.wa_id`
- **Root cause**: Setelah migrasi DB, field bisa jadi `wa_id` bukan `from`
- **Fix**: `processContacts()` sekarang normalize keduanya — `msg.from = msg.from || msg.wa_id`

### 3. Service Worker cache stale (PWA tidak update)
- **Root cause**: Cache name `wa-ai-v1` tidak pernah di-bust saat ada update
- **Fix**: Cache name diganti ke `wa-ai-v2`, old cache otomatis dihapus saat aktivasi

### 4. CSS `unread-badge` tidak ada definisi
- **Root cause**: `unread-badge` dipakai di HTML tapi CSS-nya tidak pernah ditulis
- **Fix**: Tambah CSS lengkap dengan warna hijau WA (#25D366)

---

## Fitur Baru

### 5. Tampilan gambar di chat bubble
- Pesan dengan `mediaUrl` (tipe image) tampil sebagai gambar inline
- Klik gambar → buka di tab baru
- CSS class: `.bubble-img`

### 6. Link preview dari iklan FB
- Pesan dengan `linkUrl` tampil dengan card preview (thumbnail + judul + domain)
- Thumbnail dari Open Graph di-fetch server, disimpan di field `link_thumbnail` DB
- CSS class: `.link-preview`, `.lp-thumb`, `.lp-title`, `.lp-domain`

### 7. Notifikasi hijau chat baru (WA-style)
- Toast notification muncul di pojok kanan atas saat ada pesan masuk dari kontak yang tidak aktif
- Warna hijau (#25D366) sesuai WhatsApp
- Klik toast → langsung buka chat kontak tersebut
- Auto-hide setelah 5 detik
- Contact list item flash hijau animasi saat ada pesan baru

---

## File yang Diubah
| File | Perubahan |
|---|---|
| `public/index.html` | renderChat, processContacts, socket handlers, CSS, toast |
| `public/sw.js` | Cache name v2, exclude /uploads/ dari cache |
| `db.js` | **BARU** — PostgreSQL schema + helper functions |
| `package.json` | Tambah dependensi: `pg`, `multer`, `open-graph-scraper` |

## Cara Setup Database
1. Install PostgreSQL di VPS
2. Buat database: `createdb chatapp_db`
3. Tambah di `.env`:
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/chatapp_db
   ```
4. Jalankan server — schema otomatis dibuat saat startup

## Catatan
- `server.js` belum dikonversi penuh ke PostgreSQL — masih pakai JSON file
- Untuk konversi penuh, integrasikan fungsi dari `db.js` ke `server.js` (lihat handover doc)
- Priority konversi: messages → contacts → orders → settings
