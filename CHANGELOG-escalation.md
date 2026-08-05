# Perubahan — Escalation Flow + Aturan Cara Jawab/CTA

Diterapkan di atas `wa-ai-v2-final` (yang kamu upload), semua di `server.js`. Tidak ada perubahan struktur DB/dashboard.

## 1. Anti-mengarang: tag `[ESCALATE:...]`
- `buildSystemPrompt()` sekarang instruksikan Gemini: kalau jawabannya TIDAK eksplisit ada di KB, JANGAN mengarang — sisipkan `[ESCALATE:Nama Produk]pertanyaan[/ESCALATE]` (atau `[ESCALATE:UMUM]...[/ESCALATE]` untuk hal non-produk).
- Beda dengan kasus "produk memang gak dijual toko ini" (itu tetap dijawab jujur langsung, gak perlu escalate — supaya WA kamu gak di-spam tiap ada yang nanya hal random di luar bisnis).
- Fungsi baru `extractEscalations()` menangkap tag ini, hapus dari balasan ke customer, dan catat sebagai entri pending (`data/escalations.json`, persist walau server restart).

## 2. Customer ditahan diam sampai kamu jawab
- Kalau SELURUH balasan Gemini cuma berisi tag escalate (gak ada info lain), sistem **tidak kirim apa pun** ke customer — sesuai keputusan kita. Kalau sebagian bisa dijawab, bagian itu tetap dikirim seperti biasa.

## 3. Notifikasi ke WA kamu (nomor superadmin yang sama)
- Setiap ada pertanyaan baru, kamu dikirimi pesan bernomor: `1. [Selang Kran Fleksibel 360°] ...`
- Nomor ini konsisten dipakai lagi saat kamu balas, jadi walau kamu jawab 3 pertanyaan sekaligus dalam 1 pesan, tetap bisa dipetakan dengan benar.

## 4. Kamu jawab borongan → otomatis terpecah & masuk KB permanen
- Saat kamu (dari nomor admin) kirim balasan yang BUKAN command `on`/`off`, dan ada pertanyaan pending → sistem panggil Gemini sekali lagi (`handleAdminEscalationAnswer`) khusus untuk memetakan balasanmu ke ID pertanyaan yang sesuai.
- Tiap jawaban otomatis disisipkan permanen ke `settings.knowledgeBase`: masuk ke blok produk yang sesuai (`appendFaqToKB`), atau ke blok baru `=== INFO UMUM TOKO ===` kalau bukan soal produk tertentu / tag tidak dikenali.
- Setelah tersimpan, jawaban langsung dikirim ke customer yang nunggu (nomor asalnya disimpan di entri pending, jadi tidak perlu customer masih online/kirim ulang apa pun).

## 5. Aturan cara jawab & CTA baru di system prompt
- Persona generik ("admin"/"kami"), gaya profesional, emoji jarang.
- Nego harga: boleh potongan maks Rp10.000, keputusan sendiri.
- Reseller/grosir: tolak sopan, harga tetap sama.
- Customer marah/sarkas: tetap sopan & normal.
- Customer batal: terima langsung, jangan dibujuk lagi.
- **CTA wajib**: setiap balasan (termasuk balasan trigger iklan) harus diakhiri 1 pertanyaan pengarah closing, maksimal 1 pertanyaan (gak numpuk kalau balasan udah otomatis mengandung pertanyaan).
- Order: setelah data (Nama/Alamat/No HP) lengkap, WAJIB rekap ulang + minta konfirmasi "ya/benar" dulu sebelum `[ORDER_DATA]` disisipkan (final). Order multi-produk didukung, total dihitung gabungan.

## ⚠️ Catatan penting — channel MacroDroid
Notifikasi ke admin (`notifyAdminEscalations`) dan jawaban balik ke customer di flow eskalasi ini dikirim lewat **WhatsApp Cloud API** (`sendWhatsAppText`), karena itu channel yang bisa "push" pesan kapan saja. Kalau kamu lagi aktif jalan di channel **MacroDroid/Android bridge** (bukan Cloud API), pengiriman proaktif ini KEMUNGKINAN tidak akan sampai, karena bridge itu sifatnya request-response (nunggu HP Android polling), bukan push. Kalau kamu memang berencana pindah total ke custom Android app, ini perlu didesain ulang sedikit (misal app Android polling endpoint baru `/api/pending-notifications` secara berkala). Kabari aku kalau kamu mau aku desain bagian itu juga.

## Yang belum disentuh (di luar scope diskusi ini)
- Tampilan dashboard (`public/index.html`) belum ditambah panel khusus buat lihat daftar pending escalations — saat ini cuma bisa dipantau lewat WA notifikasi & file `data/escalations.json`. Bisa ditambah kalau kamu mau.
