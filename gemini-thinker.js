/**
 * gemini-thinker.js — Intent Classifier (Thinker Stage)
 *
 * Lightweight Gemini call yang mengklasifikasi pesan customer menjadi intent.
 * Output: { intent, extractedData, product, nextStep, confidence }
 *
 * Arsitektur hybrid:
 *   1. Thinker (ini) — classify intent + extract data
 *   2. App Logic — validate & apply step transition
 *   3. Chatter — generate natural response
 */

'use strict';

const store  = require('./state-store');
const { getAvailableKey, markKeyLimited } = require('./gemini-service');
const { parseProductBlocks } = require('./knowledge-base');

// ── Intent Types ──────────────────────────────────────────────────
const INTENTS = {
  // Existing (backward compat, dipakai saat v2Mode=false)
  GREETING:           'greeting',
  PRODUCT_INQUIRY:    'product_inquiry',
  PRODUCT_FOLLOW_UP:  'product_follow_up',
  ORDER_COLOR:        'order_color_selection',
  ORDER_INTENT:       'order_intent',
  DATA_PROVIDED:      'data_provided',
  CONFIRMATION:       'confirmation',
  ESCALATION:         'escalation',
  GENERAL_CHAT:       'general_chat',
  // V2 Granular Intents (dipakai saat v2Mode=true)
  V2_VARIASI:          'customer_pilihvariasi',
  V2_ALAMAT_NO_RTRW:  'Alamat_lengkap_noRTRW',
  V2_ALAMAT_HAS_RTRW: 'Alamat_lengkap_hasRTRW',
  V2_ALAMAT_PATOKAN:  'Alamat_patokan',
  V2_NAMA:            'Terkait_namaCustomer',
  V2_NOMOR:           'NomorCustomer',
  V2_COD:             'Terkait_pilihan_pembayaran_COD',
  V2_SETUJU_COD:      'Terkait_setuju_COD',
  V2_TRANSFER:        'Terkait_pilihan_pembayaran_Transfer',
  V2_KONFIRMASI_TRANSFER: 'Terkait_konfirmasi_Transfer',
  V2_VERIFIKASI:      'Verifikasi',
  V2_KONFIRMASI_ORDER: 'customer_konfirmasi_order',
  V2_RAGU:            'customer_ragu',
  V2_BATAL:           'customer_batal',
  V2_PRODUK_BARU:     'customer_pilihproduk_baru',
  V2_LAIN:            'Lain',
  V2_DI_KB:           'Ada_di_KB',
};

// Semua valid intent ( gabungan lama + v2 )
const ALL_VALID_INTENTS = Object.values(INTENTS);

// ── System Prompt untuk Thinker ───────────────────────────────────
const THINKER_SYSTEM_PROMPT = `Kamu adalah classifier untuk percakapan customer service WhatsApp toko online.
Tugasmu: klasifikasi pesan customer dan ekstrak data yang relevan.

Jenis intent:
1. greeting — sapaan awal (halo, hai, pagi, siang, dll)
2. product_inquiry — tanya produk, harga, warna, varian, manfaat, cara pakai, COD/Transfer
3. product_follow_up — pertanyaan lanjutan tentang produk yang SUDAH dibahas
4. order_color_selection — pilih warna/varian produk
5. order_intent — mau beli, mau order, proses, ambil, bayar
6. data_provided — kasih nama, alamat, RT/RW, HP, patokan, jalan, desa, kecamatan
7. confirmation — konfirmasi data benar (ya, oke, betul, fix, setuju, lengkap)
8. escalation — pertanyaan yang TIDAK BISA dijawab dari Knowledge Base:
   - Estimasi pengiriman / kapan dikirim / berapa hari sampai
   - Stok / ketersediaan barang
   - Kebijakan retur, garansi, komplain, batal
   - Tracking / status pengiriman
   - Info yang TIDAK tertulis di Knowledge Base produk
9. general_chat — di luar flow order (bukan produk, bukan order)

PENTING untuk escalation:
- Jika pertanyaan ada di Knowledge Base → product_inquiry, BUKAN escalation
- "Warna apa saja?" → product_inquiry (ada di KB)
- "Bisa COD?" → product_inquiry (ada di KB)
- "Kapan dikirim?" → escalation (TIDAK ada di KB)
- "Stok ada?" → escalation (TIDAK ada di KB)

PENTING untuk data extraction — jika pesan mengandung data yang bisa diekstrak, isi extracted_data:
- warna: "Biru Muda", "Pink Muda", "Navy", "Red", "Abu-abu"
- nama: nama lengkap (2+ kata, bukan greeting/bukan nama produk)
- jalan: nama jalan + nomor rumah
- desa: nama desa/kelurahan/dusun
- kecamatan: nama kecamatan
- kota: nama kota/kabupaten
- rtRw: format "RT X/RW Y" atau "RT X"
- patokan: dekat/sebelah/samping + landmark, atau nama tempat (masjid, sekolah, warung)
- phone: nomor HP 08xxxxxxxx. JIKA customer bilang "pakai nomor ini saja" / "nomor ini aja" / "nomor WA ini" → phone = "SAMA_DENGAN_WA"

Urutan pengumpulan data order (tanya SESUAI urutan ini):
1. alamat_detail (jalan/perumahan/nomor rumah)
2. rtRw (RT/RW)
3. desa, kecamatan, kabupaten
4. patokan
5. nama_lengkap
6. nomor_telepon
7. metode_bayar (COD/Transfer)

Tentukan nextField: field pertama dari urutan di atas yang BELUM ada di orderState.
Contoh: jika jalan✅, rtRw✅, desa✅, kecamatan✅, kota✅, tapi patokan❌ → nextField = "patokan".
Contoh: jika semua sudah ada → nextField = null.

Keluarkan HANYA JSON valid (tanpa markdown, tanpa backtick):
{
  "intent": "<intent_type>",
  "product": "<nama produk jika disebut, atau null>",
  "extracted_data": { <data yang berhasil diekstrak, kosongkan object jika tidak ada> },
  "next_step": <angka 1-5, step yang direkomendasikan>,
  "next_field": "<field berikutnya yang harus ditanya, atau null jika semua sudah ada>",
  "confidence": <0.0-1.0>
}

Contoh output:
Input: "RT3 kak" (context: jalan✅, desa✅, kecamatan✅, kota✅, rtRw❌)
Output: {"intent":"data_provided","product":null,"extracted_data":{"rtRw":"RT 03"},"next_step":3,"next_field":"nama_lengkap","confidence":0.95}

Input: "RT03, desa tamantirto, kasihan, bantul" (context: jalan✅, rtRw❌, desa❌)
Output: {"intent":"data_provided","product":null,"extracted_data":{"rtRw":"RT 03","desa":"Tamantirto","kecamatan":"Kasihan","kota":"Bantul"},"next_step":3,"next_field":"patokan","confidence":0.95}

Input: "mau yang biru aja kak"
Output: {"intent":"order_color_selection","product":null,"extracted_data":{"color":"Biru Muda"},"next_step":2,"next_field":null,"confidence":0.95}

Input: "halo kak, ada baby walking gak?"
Output: {"intent":"product_inquiry","product":"Baby Walking Assistant","extracted_data":{},"next_step":1,"next_field":null,"confidence":0.9}

Input: "Saya Andi, jalan melati no 12, RT 03/RW 05, Desa Tamantirto, Kec Kasihan, Kab Bantul"
Output: {"intent":"data_provided","product":null,"extracted_data":{"nama":"Andi","jalan":"Melati No. 12","rtRw":"RT 03/RW 05","desa":"Tamantirto","kecamatan":"Kasihan","kota":"Bantul"},"next_step":3,"next_field":"patokan","confidence":0.95}

Input: "berapa hari sampai?"
Output: {"intent":"escalation","product":null,"extracted_data":{},"next_step":5,"next_field":null,"confidence":0.9}

Input: "kapan dikirim?"
Output: {"intent":"escalation","product":null,"extracted_data":{},"next_step":5,"next_field":null,"confidence":0.9}

Input: "warna apa saja?"
Output: {"intent":"product_inquiry","product":null,"extracted_data":{},"next_step":1,"next_field":null,"confidence":0.9}

Input: "bisa COD?"
Output: {"intent":"product_inquiry","product":null,"extracted_data":{},"next_step":1,"next_field":null,"confidence":0.85}

Input: "komplain barang rusak"
Output: {"intent":"escalation","product":null,"extracted_data":{},"next_step":5,"next_field":null,"confidence":0.9}

Input: "ya udah bener semua"
Output: {"intent":"confirmation","product":null,"extracted_data":{},"next_step":4,"next_field":null,"confidence":0.95}

=== V2 MODE (Granular Intents) ===
Jika context berisi "v2Mode: true", gunakan intent v2 granular berikut:

V2 Intent List:
- customer_pilihvariasi — customer pilih/ganti warna/varian produk
- Alamat_lengkap_noRTRW — customer kirim alamat lengkap TAPI RT/RW belum ada di context
- Alamat_lengkap_hasRTRW — alamat DAN RT/RW sudah ada di context (tanya patokan)
- Alamat_patokan — patokan sudah ada di context (tanya nama lengkap)
- Terkait_namaCustomer — nama sudah ada di context (tanya nomor HP)
- NomorCustomer — nomor HP sudah ada di context (tanya metode pembayaran)
- Terkait_pilihan_pembayaran_COD — customer pilih COD
- Terkait_setuju_COD — customer menyatakan setuju/oke/ya SETELAH AI menjelaskan aturan COD (bukan konfirmasi rekap, ini hanya setuju aturan saja → lanjut tampilkan rekap)
- Terkait_pilihan_pembayaran_Transfer — customer pilih transfer
- Terkait_konfirmasi_Transfer — customer membalas SETELAH AI mengirim info rekening bank (ok/siap/iya/apapun → tampilkan rekap, BUKAN finalize order)
- Verifikasi — semua field sudah lengkap, customer konfirmasi (TAPI rekap BELUM ditampilkan)
- customer_konfirmasi_order — rekap SUDAH ditampilkan (step 4), customer konfirmasi (Ok/ya/benar/sudah) → FINALIZE ORDER, sisipkan [ORDER_DATA]
- customer_ragu — customer ragu/hesitasi (hmm, bentar, nanti aja, belum yakin, mikir dulu)
- customer_batal — customer batal/gak jadi (batal, gak jadi, cancel, mundur)
- customer_pilihproduk_baru — customer tertarik produk lain yang berbeda dari fokus saat ini
- Lain — pertanyaan di luar flow, tidak ada di KB
- Ada_di_KB — pertanyaan yang jawabannya ada di Knowledge Base

V2 Sub-intent Logic untuk alamat (urutan WAJIB diikuti):
- Cek context: jika alamat belum ada → minta alamat lengkap
- Cek context: jika alamat sudah ada TAPI rtRw belum → Alamat_lengkap_noRTRW (next_field: rtRw)
- Cek context: jika alamat DAN rtRw sudah ada TAPI patokan belum ada → Alamat_lengkap_hasRTRW (next_field: patokan) — JANGAN langsung ke nama!
- Cek context: jika customer mengirim patokan (landmark/bangunan terdekat) → Alamat_patokan (next_field: nama_lengkap)
- Cek context: jika patokan sudah ada → lanjut ke nama
- Cek context: jika nama sudah ada → Terkait_namaCustomer
- Cek context: jika nomor sudah ada → NomorCustomer
- Cek context: jika semua field sudah lengkap + customer konfirmasi → Verifikasi
- Cek context: jika step=4 + rekap sudah ditampilkan + customer bilang ok/ya/benar/sudah → customer_konfirmasi_order

V2 Intent Detection:
- customer_konfirmasi_order: step=4 + rekap sudah ditampilkan + kata konfirmasi (ok, oke, ya, iya, benar, betul, sudah, setuju, Fix, mantap, gas, lanjut)
- Terkait_setuju_COD: context berisi "Status: MENUNGGU_KONFIRMASI_ATURAN_COD" + customer balas setuju/oke/ya/iya/siap → WAJIB gunakan intent ini, BUKAN Verifikasi atau customer_konfirmasi_order
- Terkait_setuju_COD: AI sebelumnya menjelaskan aturan COD (ada kata "aturan COD" / "paket tidak bisa dibuka" di riwayat AI) + customer balas setuju/oke/ya/iya/siap → intent ini WAJIB diprioritaskan sebelum Verifikasi
- Terkait_konfirmasi_Transfer: context berisi "Status: MENUNGGU_KONFIRMASI_INFO_REKENING" + customer balas apapun → WAJIB gunakan intent ini, tampilkan rekap
- Terkait_konfirmasi_Transfer: AI sebelumnya mengirim nomor rekening bank + customer balas (ok/siap/iya/apapun) → tampilkan rekap, BUKAN customer_konfirmasi_order
- customer_ragu: kata kunci ragu (hmm, hmmh, bentar, nanti aja, belum yakin, mikir dulu, pikir-pikir, lihat dulu)
- customer_batal: kata kunci batal (batal, gak jadi, cancel, mundur, gak usah, urungkan)
- customer_pilihproduk_baru: menyebut produk LAIN yang berbeda dari produk fokus saat ini
- Terkait_pilihan_pembayaran_COD: customer MEMILIH COD sebagai metode bayar — HANYA berlaku jika context warna✅ sudah ada. Jika warna❌ belum ada, "bisa COD?" / "COD aja" = Ada_di_KB (jawab iya bisa, lanjut tanya warna)
- Terkait_pilihan_pembayaran_Transfer: customer MEMILIH Transfer — HANYA berlaku jika context warna✅ sudah ada. Jika warna❌ belum ada, pertanyaan transfer = Ada_di_KB
- Ada_di_KB: pertanyaan yang bisa dijawab dari Knowledge Base produk
- Lain: pertanyaan yang TIDAK bisa dijawab dari Knowledge Base

Contoh V2 Output:
Input: "mau yang biru kak" (v2Mode: true, context: produk=Baby Walking, warna❌)
Output: {"intent":"customer_pilihvariasi","product":null,"extracted_data":{"color":"Biru Muda"},"next_step":3,"next_field":"alamat_lengkap","confidence":0.95}

Input: "jalan melati no 12, tamantirto, kasihan, bantul" (v2Mode: true, context: jalan❌, rtRw❌)
Output: {"intent":"Alamat_lengkap_noRTRW","product":null,"extracted_data":{"jalan":"Melati No. 12","desa":"Tamantirto","kecamatan":"Kasihan","kota":"Bantul"},"next_step":3,"next_field":"rtRw","confidence":0.95}

Input: "RT 03/RW 05" (v2Mode: true, context: jalan✅, rtRw❌)
Output: {"intent":"Alamat_lengkap_hasRTRW","product":null,"extracted_data":{"rtRw":"RT 03/RW 05"},"next_step":3,"next_field":"patokan","confidence":0.95}

Input: "RT 3 itu kak" (v2Mode: true, context: jalan✅, rtRw❌) — RT saja tanpa RW
Output: {"intent":"Alamat_lengkap_hasRTRW","product":null,"extracted_data":{"rtRw":"RT 03"},"next_step":3,"next_field":"patokan","confidence":0.95}

Input: "dekat masjid Al-Ikhlas" (v2Mode: true, context: jalan✅, rtRw✅, patokan❌)
Output: {"intent":"Alamat_patokan","product":null,"extracted_data":{"patokan":"Dekat Masjid Al-Ikhlas"},"next_step":3,"next_field":"nama_lengkap","confidence":0.95}

Input: "nama saya Andi" (v2Mode: true, context: patokan✅, nama❌)
Output: {"intent":"Terkait_namaCustomer","product":null,"extracted_data":{"nama":"Andi"},"next_step":3,"next_field":"nomor_telepon","confidence":0.95}

Input: "08123456789" (v2Mode: true, context: nama✅, noHp❌)
Output: {"intent":"NomorCustomer","product":null,"extracted_data":{"phone":"08123456789"},"next_step":3,"next_field":"metode_bayar","confidence":0.95}

Input: "pakai nomor ini saja" (v2Mode: true, context: nama✅, noHp❌)
Output: {"intent":"NomorCustomer","product":null,"extracted_data":{"phone":"SAMA_DENGAN_WA"},"next_step":3,"next_field":"metode_bayar","confidence":0.95}

Input: "COD aja kak" (v2Mode: true, context: warna✅ sudah dipilih, noHp✅ sudah ada)
Output: {"intent":"Terkait_pilihan_pembayaran_COD","product":null,"extracted_data":{"payment_method":"COD"},"next_step":3,"next_field":null,"confidence":0.95}

Input: "ini bisa COD kak?" (v2Mode: true, context: warna❌ belum dipilih) — tanya, bukan memilih, warna belum ada
Output: {"intent":"Ada_di_KB","product":null,"extracted_data":{},"next_step":2,"next_field":"warna","confidence":0.95}

Input: "COD aja" (v2Mode: true, context: warna❌ belum dipilih) — warna belum dipilih, belum bisa proses pembayaran
Output: {"intent":"Ada_di_KB","product":null,"extracted_data":{},"next_step":2,"next_field":"warna","confidence":0.95}

Input: "iya setuju" (v2Mode: true, riwayat AI sebelumnya: "untuk COD aturannya dari ekspedisi paket tidak bisa dibuka sebelum dibayar")
Output: {"intent":"Terkait_setuju_COD","product":null,"extracted_data":{"payment_method":"COD"},"next_step":4,"next_field":null,"confidence":0.95}

Input: "ok kak" (v2Mode: true, riwayat AI sebelumnya: "Kakak setuju ya Kak?" setelah penjelasan COD)
Output: {"intent":"Terkait_setuju_COD","product":null,"extracted_data":{"payment_method":"COD"},"next_step":4,"next_field":null,"confidence":0.95}

Input: "transfer aja" (v2Mode: true)
Output: {"intent":"Terkait_pilihan_pembayaran_Transfer","product":null,"extracted_data":{"payment_method":"Transfer"},"next_step":3,"next_field":null,"confidence":0.95}

Input: "ok siap" (v2Mode: true, Status: MENUNGGU_KONFIRMASI_INFO_REKENING, riwayat AI: "Bank Mandiri - 124001...")
Output: {"intent":"Terkait_konfirmasi_Transfer","product":null,"extracted_data":{"payment_method":"Transfer"},"next_step":4,"next_field":null,"confidence":0.95}

Input: "iya bener semua" (v2Mode: true, context: semua field lengkap, step 3)
Output: {"intent":"Verifikasi","product":null,"extracted_data":{},"next_step":4,"next_field":null,"confidence":0.95}

Input: "Ok" (v2Mode: true, step=4, rekap sudah ditampilkan)
Output: {"intent":"customer_konfirmasi_order","product":null,"extracted_data":{},"next_step":4,"next_field":null,"confidence":0.95}

Input: "iya sudah kak" (v2Mode: true, step=4, rekap sudah ditampilkan)
Output: {"intent":"customer_konfirmasi_order","product":null,"extracted_data":{},"next_step":4,"next_field":null,"confidence":0.95}

Input: "hmm bentar ya" (v2Mode: true)
Output: {"intent":"customer_ragu","product":null,"extracted_data":{},"next_step":3,"next_field":null,"confidence":0.9}

Input: "batal deh gak jadi" (v2Mode: true)
Output: {"intent":"customer_batal","product":null,"extracted_data":{},"next_step":3,"next_field":null,"confidence":0.95}

Input: "eh ada pasta dempul juga ya?" (v2Mode: true, produk fokus: Baby Walking)
Output: {"intent":"customer_pilihproduk_baru","product":"Pasta Dempul Instan Tembok","extracted_data":{},"next_step":1,"next_field":null,"confidence":0.9}

Input: "kapan ya sampainya?" (v2Mode: true, tidak ada di KB)
Output: {"intent":"Lain","product":null,"extracted_data":{},"next_step":3,"next_field":null,"confidence":0.85}

Input: "apa manfaat baby walking?" (v2Mode: true, ada di KB)
Output: {"intent":"Ada_di_KB","product":"Baby Walking Assistant","extracted_data":{},"next_step":1,"next_field":null,"confidence":0.9}`;

// ── Main classify function ────────────────────────────────────────
async function classifyIntent(message, context = {}) {
  const { from, orderState, history } = context;

  // Build context string untuk Thinker
  const contextLines = [];

  // V2 mode flag
  if (store.settings.v2ResponseStyle) {
    contextLines.push('v2Mode: true');
  }

  if (orderState) {
    contextLines.push(`Step saat ini: ${orderState.step}`);
    if (orderState.product) contextLines.push(`Produk fokus: ${orderState.product}`);
    if (orderState.color) contextLines.push(`Warna sudah dipilih: ${orderState.color}`);
    if (orderState.jalan) contextLines.push(`Jalan: ${orderState.jalan} ✓`);
    if (orderState.rtRw) contextLines.push(`RT/RW: ${orderState.rtRw} ✓`);
    if (orderState.desa) contextLines.push(`Desa: ${orderState.desa} ✓`);
    if (orderState.kecamatan) contextLines.push(`Kecamatan: ${orderState.kecamatan} ✓`);
    if (orderState.kota) contextLines.push(`Kota: ${orderState.kota} ✓`);
    if (orderState.patokan) contextLines.push(`Patokan: ${orderState.patokan} ✓`);
    if (orderState.namaLengkap) contextLines.push(`Nama: ${orderState.namaLengkap} ✓`);
    if (orderState.noHp) contextLines.push(`HP: ${orderState.noHp} ✓`);
    // Sinyal struktural pembayaran — jauh lebih reliable daripada bergantung history text
    if (orderState.paymentMethod) contextLines.push(`Metode bayar dipilih: ${orderState.paymentMethod}`);
    if (orderState.awaitingCODConfirmation) contextLines.push(`Status: MENUNGGU_KONFIRMASI_ATURAN_COD (AI sudah jelaskan aturan COD, customer belum setuju)`);
    if (orderState.codConfirmed) contextLines.push(`Status: COD_CONFIRMED (customer sudah setuju aturan COD)`);
    if (orderState.awaitingTransferConfirmation) contextLines.push(`Status: MENUNGGU_KONFIRMASI_INFO_REKENING (AI sudah kirim info rekening, tunggu balas customer untuk tampilkan rekap)`);

    // Field yang belum ada (dalam urutan collection)
    const missingFields = [];
    if (!orderState.jalan) missingFields.push('alamat_detail');
    if (!orderState.rtRw) missingFields.push('rtRw');
    if (!orderState.desa) missingFields.push('desa');
    if (!orderState.kecamatan) missingFields.push('kecamatan');
    if (!orderState.kota) missingFields.push('kota');
    if (!orderState.patokan && !orderState.patokanSkipped) missingFields.push('patokan');
    if (!orderState.namaLengkap || !orderState.namaVerified) missingFields.push('nama_lengkap');
    if (!orderState.noHp) missingFields.push('nomor_telepon');
    if (missingFields.length && orderState.step >= 3) {
      contextLines.push(`Field belum ada (urutan): ${missingFields.join(' → ')}`);
    }
  }

  // History ringkas (3 pesan terakhir)
  // aiReply bisa null jika pesan sebelumnya adalah draft (pending admin) —
  // gunakan aiReplyDraft sebagai fallback agar konteks AI tidak hilang
  if (history?.length) {
    const recentContext = history.slice(-3).map(h => {
      if (h._summary) return `[ringkasan] ${h.summary}`;
      const aiText = h.aiReply || h.aiReplyDraft || '';
      const isDraft = !h.aiReply && h.aiReplyDraft ? ' [draft]' : '';
      return `Customer: "${(h.body || '').slice(0, 150)}" | AI${isDraft}: "${aiText.slice(0, 150)}"`;
    }).join('\n');
    contextLines.push(`Riwayat:\n${recentContext}`);
  }

  // KB Summary untuk Thinker — agar bisa classify Ada_di_KB vs Lain secara akurat
  // Thinker perlu tahu topik apa saja yang ADA di KB, bukan nebak
  if (store.settings.knowledgeBase) {
    const kbBlocks = parseProductBlocks(store.settings.knowledgeBase);
    if (kbBlocks.length) {
      // Ekstrak field/topik dari setiap blok produk
      const kbTopics = kbBlocks.map(block => {
        const lines = block.text.split('\n').filter(l => l.trim() && !l.startsWith('==='));
        const fields = lines.map(l => l.split(':')[0].trim()).filter(Boolean);
        return `${block.name || 'Info'}: ${fields.join(', ')}`;
      }).join('\n');
      contextLines.push(`KB mencakup topik berikut (Ada_di_KB jika ditanya ini, Lain jika di luar ini):\n${kbTopics}`);
      contextLines.push(`KB TIDAK mencakup: video tutorial, cara pasang/penggunaan visual, tracking/status pengiriman, perbandingan dengan produk lain merek lain, atau info yang tidak tertulis di KB`);
    }
  }

  const contextStr = contextLines.length ? `\n\nContext:\n${contextLines.join('\n')}` : '';

  // Call Gemini API (ringan, output kecil)
  const result = await callThinkerGemini(message + contextStr);
  if (!result) return null;

  // Parse JSON output
  try {
    const parsed = JSON.parse(result.replace(/```json|```/g, '').trim());

    // Validate intent
    if (!ALL_VALID_INTENTS.includes(parsed.intent)) {
      parsed.intent = INTENTS.GENERAL_CHAT;
    }

    // Validate next_step
    if (![1,2,3,4,5].includes(parsed.next_step)) {
      parsed.next_step = orderState?.step || 1;
    }

    // Normalize extracted data
    if (!parsed.extracted_data || typeof parsed.extracted_data !== 'object') {
      parsed.extracted_data = {};
    }

    // Normalize color names
    if (parsed.extracted_data.color) {
      parsed.extracted_data.color = normalizeColor(parsed.extracted_data.color);
    }

    return {
      intent: parsed.intent,
      product: parsed.product || null,
      extractedData: parsed.extracted_data,
      nextStep: parsed.next_step,
      nextField: parsed.next_field || null,
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
    };
  } catch (parseErr) {
    console.warn('[Thinker] Gagal parse JSON response:', parseErr.message, '| raw:', result?.slice(0, 200));
    return null;
  }
}

// ── Gemini API call (lightweight) with 1-retry on 429 ─────────────
async function callThinkerGemini(userText) {
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 1500;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const picked = getAvailableKey();
    if (!picked) return null;

    const model = store.settings.modelName || 'gemini-3.1-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': picked.key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          systemInstruction: { parts: [{ text: THINKER_SYSTEM_PROMPT }] },
          generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
        }),
      });

      if (res.status === 429) {
        let errData = null;
        try { errData = await res.json(); } catch(e) {}
        const details = errData?.error?.details || [];
        let quotaId = null, retryDelaySec = null;
        for (const d of details) {
          if (!quotaId && Array.isArray(d.violations)) {
            for (const v of d.violations) { if (v?.quotaId) { quotaId = v.quotaId; break; } }
          }
          if (retryDelaySec === null && d?.retryDelay) {
            const rd = d.retryDelay;
            const m = typeof rd === 'string' ? rd.match(/^(\d+(?:\.\d+)?)s?$/) : null;
            retryDelaySec = m ? parseFloat(m[1]) : (typeof rd === 'number' ? rd : null);
          }
        }
        markKeyLimited(picked.pos, quotaId, retryDelaySec);
        if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      if (!res.ok) return null;

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      return text.trim() || null;
    } catch(e) {
      console.warn('[Thinker] Gemini error:', e.message);
      return null;
    }
  }
  return null;
}

// ── Normalize color names ─────────────────────────────────────────
const COLOR_MAP = {
  'biru muda': 'Biru Muda', 'biru': 'Biru Muda',
  'pink muda': 'Pink Muda', 'pink': 'Pink Muda',
  'abu': 'Abu-abu', 'abu-abu': 'Abu-abu',
  'navy': 'Navy', 'red': 'Red', 'merah': 'Red',
};

function normalizeColor(color) {
  if (!color) return null;
  const lower = color.toLowerCase().trim();
  return COLOR_MAP[lower] || color.trim();
}

module.exports = { classifyIntent, INTENTS, THINKER_SYSTEM_PROMPT };
