# Laporan Review: V2 — Hybrid Draft Mode

**Tanggal:** 2026-09-06  
**Scope:** AI behavior V2 (auto-send step 1-3 + draft mode step 4+ & ongkir)

---

## Ringkasan Perubahan

| Komponen | Status |
|----------|--------|
| STEP3_RULES (nama → alamat gabung) | ✅ OK |
| STEP4_RULES (rekap + `[DRAFT_REKAP]`) | ✅ OK |
| ATURAN ONGKIR V2 (ongkir → draft) | ✅ OK |
| DRAFT_RULES (rules baru) | ✅ OK |
| Draft detection — Cloud API path | ✅ OK |
| Draft detection — Retry path | ✅ OK |
| Draft detection — MacroDroid path | ✅ OK |
| Tag stripping sebelum save draft | ✅ OK |

---

## Detail Temuan

### 1. STEP3_RULES — 2-Step Collection ✅
- Flow: **Langkah 1** (nama) → **Langkah 2** (alamat gabung dalam 1 pesan)
- RT/RW, patokan, HP tetap diwajibkan (tidak dikurangi)
- **Tidak ada issue.**

### 2. STEP4_RULES — Rekap + Draft ✅
- Format rekap: bullet point (•) dengan 7 field wajib
- `[DRAFT_REKAP]` tag di akhir → hold message untuk admin review
- Admin bisa edit draft lalu kirim manual via dashboard
- **Tidak ada issue.**

### 3. ATURAN ONGKIR V2 ✅
Flow split jadi 3 jalur:
| Customer bertanya | AI response | Draft? |
|---|---|---|
| "ongkirnya berapa" (eksplisit) | "[DRAFT_ONGKIR]" tag → hold | ✅ Ya |
| "sudah termasuk ongkir?" | Jawab langsung dari KB | ❌ Tidak |
| Belum tanya ongkir (normal flow) | "Nanti admin cek setelah alamat lengkap" | ❌ Tidak |

- **ATURAN CEK_ONGKIR OTOMATIS tetap berlaku** di samping DRAFT_ONGKIR
- AI tidak akan pernah mengeluarkan `[CEK_ONGKIR]` dan `[DRAFT_ONGKIR]` bersamaan (CEK_ONGKIR hanya muncul saat kecamatan/kota sudah diketahui dan AI merangkum alamat; DRAFT_ONGKIR muncul saat customer eksplisit tanya ongkir)
- **Tidak ada issue.**

### 4. DRAFT_RULES ✅
- Aturan draft mencakup: rekap, ongkir, "kapan dikirim", pertanyaan di luar flow
- Semua pakai tag `[DRAFT_ONGKIR]` kecuali rekap pakai `[DRAFT_REKAP]`
- Instruksi: "Jika ragu, gunakan `[DRAFT_ONGKIR]`" — fallback yang baik
- **Tidak ada issue.**

### 5. Draft Tag Detection — 3 Path ✅
Semua path punya logika yang konsisten:

```
_hasDraftTag = cleanReply.includes('[DRAFT_ONGKIR]') || cleanReply.includes('[DRAFT_REKAP]');
if (step >= 4 || _hasDraftTag) {
  cleanReply = cleanReply.replace(/\[DRAFT_REKAP\]/gi, '').replace(/\[DRAFT_ONGKIR\]/gi, '').trim();
  // save as draft + push notif
}
```

| Path | Lokasi | Status |
|------|--------|--------|
| Cloud API | ~line 3034 | ✅ |
| Retry | ~line 2603 | ✅ |
| MacroDroid | ~line 3600 | ✅ |

### 6. Tag Stripping ✅
Tag `[DRAFT_REKAP]` dan `[DRAFT_ONGKIR]` di-strip dari `cleanReply` sebelum disimpan ke `aiReplyDraft`. Customer tidak akan melihat tag di WhatsApp.

---

## Observasi Penting (Non-Bug)

### B1 Hold Check Menyimpan Raw Reply
Di Cloud API path (~line 2998), saat B1 Hold Check terjadi (ada pesan susulan selama reply delay):
```js
entry.replied = true;
entry.aiReply = reply;  // raw reply dengan tag [DRAFT_ONGKIR] masih ada
```
**Dampak:** Reply dengan tag disimpan mentah di `aiReply`, tapi saat retry path memprosesnya, tag akan di-strip dan draft mode akan aktif. Tidak ada duplikat draft karena hold check terjadi *sebelum* draft detection. **Tidak ada issue fungsional.**

### WhatsApp API Response 200 vs Draft
Saat draft mode aktif, server merespons WhatsApp API dengan status 200 (success), tapi pesan TIDAK dikirim ke customer — hanya disimpan sebagai draft. Dari sisi WhatsApp, tidak ada masalah. Admin harus mengirim manual via dashboard.

---

## Kesimpulan

Semua perubahan V2 berjalan dengan benar. Tidak ada bug atau issue fungsional. Siap untuk deploy.
