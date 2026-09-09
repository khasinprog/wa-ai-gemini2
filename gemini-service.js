/**
 * gemini-service.js — Gemini API logic extracted from server.js
 * Handles key management, API calls, retry logic, and request logging.
 */

'use strict';

const store  = require('./state-store');
const config = require('./config');
const path   = require('path');
const fs     = require('fs');

const { getRelevantKnowledge } = require('./knowledge-base');
const { cleanFieldQuestions } = require('./message-postprocess');
const { getMissingFields } = require('./order-state');

// ── File paths ─────────────────────────────────────────────────────
const RAW_CAP_FILE = store.PATHS.RAW_CAP_FILE;

// ═══════════════════════════════════════════════════════════════════
// INTERNAL STATE
// ═══════════════════════════════════════════════════════════════════
let activeKeyIndex   = 0;
let apiKeyStates     = [];
let lastUsedKeyIndex = 0;

// ═══════════════════════════════════════════════════════════════════
// PROMPT RULES (step rules + draft rules)
// ═══════════════════════════════════════════════════════════════════

const STEP1_RULES = `
STEP 1 — JAWAB PRODUK (MAKSIMAL 3 KALIMAT):
- Customer bertanya tentang produk (nama, harga, manfaat, varian, stok)
- MAKSIMAL 3 kalimat. Susun: (1) harga + ongkir, (2) sebutkan SEMUA varian/warna yang tersedia dari KB, (3) CTA tanya pilihan
- Jika produk punya varian/warna: WAJIB sebut semua pilihan supaya customer bisa pilih. Contoh: "Pilih yang mana, Kak?"
- Contoh: "Harganya Rp95.000 sudah termasuk ongkir Kak. Pilihan warna: Navy, Red, Pink Muda, Biru Muda. Mau pilih yang mana?"
- JANGAN tanya data order di step ini
- JANGAN lebih dari 3 kalimat
`;

const STEP2_RULES = `
STEP 2 — FOLLOW-UP:
- Customer bertanya DETAIL tentang produk yang SUDAH dibahas di Step 1
- Jawab SINGKAT langsung ke inti, JANGAN ulang penjelasan dari Step 1
- Contoh: "ukurannya berapa?" → "250 gram per unit Kak"
- JANGAN sebut manfaat lagi jika sudah dijelaskan di Step 1
- JANGAN sebut harga lagi jika sudah disebut di Step 1
`;

const STEP3_RULES = `
STEP 3 — KUMPULKAN DATA (V2):
- Customer sudah pilih varian DAN sudah konfirmasi metode pembayaran
- Tanya dalam 2 langkah saja (JIKA BELUM ADA):

**Langkah 1 — Nama Lengkap:**
- "Nama lengkap penerimaannya siapa, Kak?"
- Kalau 1 kata → verifikasi: "Ini sudah nama lengkap Kak?"
- Catat di field namaLengkap

**Langkah 2 — Alamat Lengkap (SATU pesan, semua sekaligus):**
- WAJIB tanya dalam 1 balasan, minta SEMUA sekaligus:
  "Untuk alamat lengkapnya Kak, bisa sebutkan: nama jalan/perumahan, nomor rumah, RT/RW, dusun, desa, kecamatan, kabupaten, dan patokan rumah (dekat masjid/warung/sekolah) ya Kak?"
- CEK FLAG: sebelum tanya, cek field mana yang SUDAH ada. JANGAN tanya ulang yang sudah terisi. Kalau nama sudah ada → langsung tanya alamat.
- Customer boleh jawab sebagian atau semua dalam 1 pesan. Jika ada yang kurang, baru tanya bagian yang kurang saja.

- **STEP 3 TIDAK BOLEH SELESAI tanpa RT/RW, patokan, dan nomor HP.**
- Kalau customer tidak kasih nomor HP: "Boleh pakai nomor WhatsApp ini juga Kak?"
- Kalau patokan berupa masjid: WAJIB minta NAMA masjidnya

- Tanda akhir: tampilkan tag [STEP=3] di baris terakhir balasanmu.
`;

const STEP4_RULES = `
STEP 4 — KONFIRMASI & DRAFT (V2):
- SEMUA data sudah lengkap (cek flag: nama, desa, kecamatan, kota, patokan, RT/RW, HP)
- Tugas: rekap pesanan dalam format BULLET POINT (•) dan SISIPKAN tag [DRAFT_REKAP] di akhir balasan.

Format rekap WAJIB:
  • Produk: [nama produk]
  • Varian: [warna/kategori]
  • Harga: Rp [harga] ([status ongkir])
  • Nama: [nama lengkap penerima]
  • Alamat: [nama jalan, nomor rumah, RT/RW, desa, kecamatan, kota]
  • Patokan: [patokan/landmark]
  • Nomor HP: [nomor HP ASLI customer — JANGAN tulis "08xxxxxxxx" atau "nomor yang ini"]
  • Pembayaran: [COD atau Transfer]

- Jika noHp = "SAMA_DENGAN_WA", gunakan nomor WhatsApp customer yang terlihat di STATUS SAAT INI.
- Setelah rekap, tutup dengan: "Apakah data di atas sudah benar semua Kak?"
- JANGAN tanya data tambahan di step ini.
- Tanda akhir: tampilkan tag [STEP=4] di baris terakhir balasanmu.
`;

const DRAFT_RULES = `
=== ATURAN DRAFT (KAPAN JAWABAN TIDAK LANGSUNG DIKIRIM) ===
Kamu WAJIB menulis jawaban tapi TIDAK LANGSUNG mengirim ke customer (draft) dalam situasi berikut:

1. REKAP PESANAN (Step 4): Gunakan tag [DRAFT_REKAP] di akhir balasan. Admin akan review dan edit jika perlu.
2. PERTANYAAN ONGKIR: Ketika customer tanya ongkir dan kamu tidak yakin/punya data lengkap, gunakan tag [DRAFT_ONGKIR] di akhir balasan.
3. "KAPAN DIKIRIM" / ESTIMASI WAKTU: Jika customer tanya "kapan dikirim", "brp hari sampai", atau estimasi waktu -> draft + tag [DRAFT_ONGKIR].
4. PERTANYAAN DI LUAR FLOW: Pertanyaan yang tidak ada di KB dan tidak bisa kamu jawab sendiri -> draft + tag [DRAFT_ONGKIR].

CARA MENULIS DRAFT:
- Tetap tulis jawaban yang SUDAH KAMU KETAHUI (jangan tulis kosong)
- Di akhir jawaban, tambahkan salah satu tag: [DRAFT_REKAP] atau [DRAFT_ONGKIR]
- Jika ragu antara dua tag, gunakan [DRAFT_ONGKIR]
`;

const STEP5_RULES = `
STEP 5 — ESKALASI KE ADMIN:
- Jika ada pertanyaan yang jawabannya TIDAK ada di KB: JANGAN jawab sendiri, JANGAN mengarang.
- Info yang WAJIB di-escalate:
  * Estimasi pengiriman / kapan dikirim / berapa hari sampai
  * Stok / ketersediaan barang
  * Kebijakan retur, garansi, klaim yang tidak disebutkan di KB
  * Tracking / status pengiriman
  * Info apapun yang TIDAK tertulis eksplisit di INFORMASI PRODUK & BISNIS
- CARA MERESPONS: Balas customer dengan singkat dulu, lalu SISIPKAN tag [ESCALATE]
- TIDAK BOLEH: membuat tanggal, waktu, estimasi hari, atau angka yang tidak ada di KB
- JANGAN tanya data tambahan di step ini
`;

// ═══════════════════════════════════════════════════════════════════
// 1. getApiKeys
// ═══════════════════════════════════════════════════════════════════
function getApiKeys() {
  const keys = [];
  let i = 1;
  while (true) {
    const val = process.env[`GEMINI_API_KEY_${i}`];
    if (val === undefined) break;
    keys.push(val.trim());
    i++;
  }
  if (keys.length === 0 && process.env.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY.trim());
  }
  return keys;
}

// ═══════════════════════════════════════════════════════════════════
// 2. getValidKeys
// ═══════════════════════════════════════════════════════════════════
function getValidKeys() {
  return getApiKeys()
    .map((k, i) => ({ key: k, slot: i }))
    .filter(x => x.key && x.key.length >= 10);
}

// ═══════════════════════════════════════════════════════════════════
// 3. getAvailableKey — round-robin with rate-limit state
// ═══════════════════════════════════════════════════════════════════
function getAvailableKey() {
  const validKeys = getValidKeys();
  const n = validKeys.length;
  if (n === 0) return null;
  ensureKeyStates(n);

  const now = Date.now();
  for (let tried = 0; tried < n; tried++) {
    const pos = (lastUsedKeyIndex + tried) % n;
    const state = apiKeyStates[pos];

    if (state.status !== 'ON' && state.retry_at !== null && now >= state.retry_at) {
      state.status = 'ON';
      state.retry_at = null;
    }

    if (state.status === 'ON') {
      return { key: validKeys[pos].key, slot: validKeys[pos].slot, pos };
    }
  }
  return null; // all keys exhausted
}

// ═══════════════════════════════════════════════════════════════════
// 4. markKeyLimited — mark key as limited (RPM or RPD)
// ═══════════════════════════════════════════════════════════════════
function markKeyLimited(pos, quotaId, retryDelaySec) {
  const state = apiKeyStates[pos];
  if (!state) return;

  const validKeys = getValidKeys();
  lastUsedKeyIndex = (pos + 1) % Math.max(validKeys.length, 1);

  if (quotaId && quotaId.includes('PerDay')) {
    state.status = 'OFF_RPD';
    state.retry_at = getNextMidnightPT();
  } else if (quotaId && quotaId.includes('PerMinute')) {
    state.status = 'WAITING_RPM';
    const delaySec = (typeof retryDelaySec === 'number' && !isNaN(retryDelaySec) && retryDelaySec > 0) ? retryDelaySec : 60;
    state.retry_at = Date.now() + delaySec * 1000;
  } else {
    state.status = 'WAITING_RPM';
    const delaySec = (typeof retryDelaySec === 'number' && !isNaN(retryDelaySec) && retryDelaySec > 0) ? retryDelaySec : 60;
    state.retry_at = Date.now() + delaySec * 1000;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5. computeKeyStatuses — status per key for dashboard
// ═══════════════════════════════════════════════════════════════════
function computeKeyStatuses() {
  const rawKeys = getApiKeys();
  const validKeys = getValidKeys();
  ensureKeyStates(validKeys.length);

  let validPos = -1;
  return rawKeys.map((k, i) => {
    const filled = !!(k && k.length >= 10);
    if (!filled) return { slot: i + 1, filled: false, status: 'standby', cooldownUntil: 0 };
    validPos++;
    const state = apiKeyStates[validPos] || { status: 'ON', retry_at: null };
    let status;
    if (state.status !== 'ON') status = 'quota';
    else status = (i === activeKeyIndex) ? 'active' : 'standby';
    return { slot: i + 1, filled: true, status, cooldownUntil: state.retry_at || 0 };
  });
}

// ═══════════════════════════════════════════════════════════════════
// 6. emitKeyStatuses — emit via io
// ═══════════════════════════════════════════════════════════════════
function emitKeyStatuses() {
  store.io?.emit('key_status_update', { keys: computeKeyStatuses(), log: [] });
}

// ═══════════════════════════════════════════════════════════════════
// 7. getNextMidnightPT — next midnight Pacific Time
// ═══════════════════════════════════════════════════════════════════
function getNextMidnightPT() {
  const tz = 'America/Los_Angeles';
  const now = new Date();

  const todayPT = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const [y, m, d] = todayPT.split('-').map(Number);

  const guessUTC = Date.UTC(y, m - 1, d + 1, 0, 0, 0);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(guessUTC)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const ptReadingAsUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
  const offsetMs = guessUTC - ptReadingAsUTC;

  let target = guessUTC + offsetMs;
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000;
  return target;
}

// ═══════════════════════════════════════════════════════════════════
// 8. ensureKeyStates — ensure apiKeyStates array has n entries
// ═══════════════════════════════════════════════════════════════════
function ensureKeyStates(n) {
  while (apiKeyStates.length < n) apiKeyStates.push({ status: 'ON', retry_at: null });
  if (apiKeyStates.length > n) apiKeyStates.length = n;
}

// ═══════════════════════════════════════════════════════════════════
// 9. estimateTokens — rough token estimate
// ═══════════════════════════════════════════════════════════════════
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ═══════════════════════════════════════════════════════════════════
// 10. logGeminiRequest — log request/response + persistent capture
// ═══════════════════════════════════════════════════════════════════
function logGeminiRequest(direction, data) {
  const SEP = '═'.repeat(60);

  if (direction === 'request') {
    const { user, phone, systemPrompt, history, message, tokenEstimate } = data;
    const ts = new Date().toLocaleTimeString('id-ID');

    console.log(`\n${SEP}`);
    console.log(`📤 GEMINI REQUEST [${ts}] User: ${user} (${phone})`);
    console.log(SEP);

    // FULL SYSTEM PROMPT
    console.log(`\n┌─── SYSTEM PROMPT (${tokenEstimate?.system || '?'} tokens) ───`);
    const lines = (systemPrompt || '').split('\n');
    for (const line of lines) {
      if (line.startsWith('==='))  console.log(`│ 🔹 ${line}`);
      else if (line.startsWith('→'))  console.log(`│ ⚠️  ${line}`);
      else if (line.startsWith('STEP')) console.log(`│ 📌 ${line}`);
      else console.log(`│    ${line}`);
    }
    console.log(`└─── END SYSTEM PROMPT ───`);

    // HISTORY
    console.log(`\n┌─── HISTORY (${history?.length || 0} entries) ───`);
    (history || []).forEach((h) => {
      if (h._summary) {
        console.log(`│ 📝 [summary] ${h.summary}`);
      } else {
        const userText = (h.body || '').slice(0, 100);
        const aiText  = (h.aiReply || '').slice(0, 100);
        console.log(`│ 👤 User: "${userText}"`);
        console.log(`│ 🤖 AI:   "${aiText}"`);
      }
    });
    console.log(`└─── END HISTORY ───`);

    // CURRENT MESSAGE
    console.log(`\n┌─── CURRENT MESSAGE ───`);
    console.log(`│ 👤 "${message}"`);
    console.log(`└─── END MESSAGE ───`);

    // TOKEN ESTIMATE
    console.log(`\n📊 Tokens → System: ${tokenEstimate?.system || '?'} | History: ${tokenEstimate?.history || '?'} | Current: ${tokenEstimate?.current || '?'}`);
    console.log(SEP);

    // Capture request for test mode
    if (phone === store.TEST_PHONE) {
      store._capturedGeminiRequest = { systemPrompt, history, message, tokenEstimate };
    }
    // Persistent capture — all phones
    store.testRawCaptures.push({
      id: ++store._rawCaptureId,
      phone,
      systemPrompt,
      history,
      message,
      tokenEstimate,
      timestamp: new Date().toISOString(),
    });
    if (store.testRawCaptures.length > 200) store.testRawCaptures.splice(0, store.testRawCaptures.length - 200);
    store.save(RAW_CAP_FILE, store.testRawCaptures);
  }

  if (direction === 'response') {
    const { ok, text, error, duration, outputTokens, phone } = data;
    const ts = new Date().toLocaleTimeString('id-ID');
    console.log(`\n┌─── GEMINI RESPONSE [${ts}] (${duration}ms) ───`);
    if (ok) {
      console.log(`│ 🤖 "${text?.slice(0, 300)}"`);
      if (text?.length > 300) console.log(`│    ... (panjang total: ${text.length} chars)`);
      console.log(`│ 📊 Output tokens: ${outputTokens}`);
    } else {
      console.log(`│ ❌ ERROR: ${error}`);
    }
    console.log(`└─── END RESPONSE ───\n`);

    // Capture response for test mode
    if (phone === store.TEST_PHONE && ok) {
      store._capturedGeminiResponse = { rawText: text, outputTokens, duration };
    }
    // Persistent capture — update last entry with response
    if (ok) {
      const lastCapture = store.testRawCaptures[store.testRawCaptures.length - 1];
      if (lastCapture && lastCapture.phone === phone) {
        lastCapture.rawGemini = text;
        lastCapture.outputTokens = outputTokens;
        lastCapture.duration = duration;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BUILD SYSTEM PROMPT (inline for now)
// ═══════════════════════════════════════════════════════════════════
function buildSystemPrompt(name, relevantKB, isFirstMessage, from, sentImagesForFrom, thinkerData) {
  const settings = store.settings;
  const orderStates = store.orderStates;

  const greetingRule = '- Sapaan ke pelanggan: panggil "Kak" saja tanpa menyebut nama sama sekali (jangan pakai nama dari WhatsApp, baik di pesan pertama maupun balasan berikutnya)';

  const parts = [
    `Kamu adalah ${settings.persona}`,
    greetingRule,
    `Bahasa: ${settings.language}`,
    `Tone: ${settings.tone}`,
    '',
  ];

  // Product focus — declare early so it can be referenced in the KB-missing branch
  const orderState = from ? orderStates.get(from) : null;
  const focus = orderState?.product || null;

  if (relevantKB?.trim()) {
    parts.push('=== INFORMASI PRODUK & BISNIS ===');
    parts.push(relevantKB.trim());
    parts.push('');
  } else if (isFirstMessage && focus) {
    parts.push(`// CATATAN SISTEM: Produk "${focus}" tidak memiliki informasi di Knowledge Base.`);
    parts.push('// Balas dengan sopan bahwa informasi produk ini belum tersedia, dan tawarkan untuk menghubungi admin.');
    parts.push('');
  }

  // Product focus + Step State
  if (focus) {
    parts.push(`=== PRODUK FOKUS: ${focus} ===`);
    parts.push(`Customer sedang membahas "${focus}". Fokus HANYA pada produk ini. Jika customer tanya produk lain, barulah pindah fokus.`);
    parts.push('');
  }

  // Step State + flags
  if (orderState && orderState.step) {
    parts.push('=== STATUS SAAT INI ===');
    parts.push(`Step: ${orderState.step}`);
    if (orderState.color) parts.push(`Warna: ${orderState.color}`);
    if (orderState.jalan) parts.push(`Jalan: ${orderState.jalan}`);
    if (orderState.namaLengkap) parts.push(`Nama: ${orderState.namaLengkap} (verified: ${orderState.namaVerified})`);
    if (orderState.desa) parts.push(`Desa: ${orderState.desa}`);
    if (orderState.kecamatan) parts.push(`Kecamatan: ${orderState.kecamatan}`);
    if (orderState.kota) parts.push(`Kota: ${orderState.kota}`);
    if (orderState.rtRw) parts.push(`RT/RW: ${orderState.rtRw}`);
    if (orderState.patokan) parts.push(`Patokan: ${orderState.patokan}`);
    if (orderState.noHp) parts.push(`HP: ${orderState.noHp}`);

    const missing = getMissingFields(orderState);
    if (missing.length && orderState.step >= 3) {
      parts.push(`→ Belum ada: ${missing.join(', ')}`);
      parts.push(`TUGAS WAJIB: tanya HANYA field pertama "${missing[0]}" dalam balasan ini. JANGAN tanya lebih dari 1 field.`);
    }

    // Thinker extracted data — acknowledge before asking next field
    if (thinkerData?.extractedData && Object.keys(thinkerData.extractedData).length > 0) {
      const fields = Object.entries(thinkerData.extractedData)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: "${v}"`);
      if (fields.length) {
        parts.push('');
        parts.push('=== DATA BARU DARI CUSTOMER (pesan ini) ===');
        parts.push(fields.join('\n'));
        parts.push('→ WAJIB: acknowledge data di atas SEBELUM tanya field berikutnya. Contoh: "Perumahan dalem tamantirto C3 sudah dicatat ya Kak."');
      }
    }

    // Resolve phone number: SAMA_DENGAN_WA → actual WhatsApp number
    if (orderState?.noHp === 'SAMA_DENGAN_WA' && from) {
      const resolvedPhone = from.replace('@s.whatsapp.net', '').replace('@c.us', '');
      parts.push('');
      parts.push(`Nomor HP customer: ${resolvedPhone} (SAMA_DENGAN_WA)`);
    }
    parts.push('');
  }

  if (settings.followUp?.trim()) {
    parts.push('=== PROSEDUR MENJAWAB (WAJIB DIIKUTI, BUKAN SEKADAR REFERENSI) ===');
    parts.push(settings.followUp.trim());
    parts.push('');
  }

  // Step rules
  if (!orderState || orderState.step === 1) parts.push(STEP1_RULES);
  else if (orderState.step === 2) parts.push(STEP2_RULES);
  else if (orderState.step === 3) parts.push(STEP3_RULES);
  else if (orderState.step === 4) parts.push(STEP4_RULES);
  else if (orderState.step === 5) parts.push(STEP5_RULES);
  parts.push(DRAFT_RULES);

  parts.push('=== ATURAN MENJAWAB ===');
  parts.push('- FOKUS pada produk yang sedang ditanyakan customer SAAT INI. Jangan campur informasi produk lain dari riwayat chat sebelumnya.');
  parts.push('- Balas secara natural seperti manusia, bukan robot');
  parts.push('- Gunakan bahasa percakapan sehari-hari yang hangat, gaya tetap profesional (bukan lebay/berlebihan)');
  parts.push('- JANGAN tanya ulang field yang sudah tercatat di STATUS SAAT INI.');
  parts.push('- JANGAN gunakan tanda petik di awal atau akhir pesan');
  parts.push('- Jika menerima pesan suara (audio), DENGARKAN isi audionya dan balas berdasarkan konten suara pelanggan.');
  parts.push('- Kamu mengaku sebagai "admin"/"kami" toko — JANGAN pakai nama persona apapun, dan JANGAN sebut bahwa kamu AI kecuali ditanya langsung');
  parts.push('- Emoji dipakai JARANG saja (boleh sesekali, jangan tiap kalimat)');
  parts.push('- Pisahkan paragraf dengan baris baru (enter) agar mudah dibaca.');
  parts.push('');
  parts.push('=== ATURAN NEGO HARGA & SITUASI SULIT ===');
  parts.push('- Kalau pelanggan minta nego/diskon harga: boleh kasih potongan MAKSIMAL Rp10.000 dari harga normal, putuskan sendiri tanpa perlu tanya admin. Kalau minta lebih dari itu, tetap tolak sopan dan pertahankan harga setelah potongan Rp10.000 tersebut');
  parts.push('- Kalau pelanggan minta harga reseller/grosir/mau dijual lagi: TOLAK dengan sopan, harga tetap sama berapa pun jumlah/tujuan pembeliannya');
  parts.push('- Kalau pelanggan marah, kecewa, sarkas, atau menuduh: tetap balas dengan SOPAN dan NORMAL seperti biasa, jangan defensif berlebihan');
  parts.push('- Kalau pelanggan bilang batal/gak jadi/mundur/kemahalan: TERIMA langsung dengan ucapan terima kasih yang sopan dan TUTUP percakapan dengan baik. DILARANG KERAS menawarkan apapun sebagai "penggantinya"');
  parts.push('');
  parts.push('=== ATURAN CTA / ARAHKAN KE CLOSING (PENTING) ===');
  parts.push('- SETIAP balasan WAJIB diakhiri dengan 1 pertanyaan yang mengarahkan percakapan lebih dekat ke closing');
  parts.push('- Pilih SENDIRI pertanyaan yang paling relevan sesuai konteks saat itu');
  parts.push('- MAKSIMAL 1 pertanyaan per balasan.');
  parts.push('- Kalau pelanggan sudah menunjukkan minat jelas tapi belum kasih data pemesanan, boleh proaktif ajak closing');
  parts.push('');
  parts.push('=== PANJANG & GAYA BALASAN (PENTING) ===');
  parts.push('- Ikuti PROSEDUR MENJAWAB di atas sebagai aturan wajib, tapi jangan diulang kata-per-kata sebagai skrip');
  parts.push(isFirstMessage
    ? '- Ini kemungkinan pesan PERTAMA pelanggan: boleh jelaskan 1-2 keunggulan utama produk secara singkat, maksimal 3-4 kalimat total'
    : '- Ini BUKAN pesan pertama (sudah ada riwayat chat): JANGAN ulangi penjelasan keunggulan produk yang sudah dijelaskan sebelumnya.');
  parts.push('- JANGAN sebut nama produk berulang kali. Kalau produk sudah disebut sebelumnya, cukup referensikan dengan "produknya", "pesanan", atau langsung ke inti');
  parts.push('- Kalau pelanggan hanya minta harga ("cek harga", "berapa", dll), jawab harga + 1 kalimat penutup/CTA saja.');
  parts.push('');
  parts.push('=== BATAS KALIMAT PER STEP (PENTING) ===');
  parts.push('- Step 1 (produk): MAKSIMAL 3 kalimat — harga + varian/warna + CTA');
  parts.push('- Step 2 (follow-up): 1 kalimat — langsung jawab pertanyaan + CTA');
  parts.push('- Step 3 (kumpul data): 1 kalimat — tanya SATU field spesifik.');
  parts.push('- Step 4 (konfirmasi): MAKSIMAL 2 kalimat — konfirmasi pesanan + penutup');
  parts.push('- Step 5 (eskalasi): Sapa customer singkat + sisipkan tag [ESCALATE]');
  parts.push('- Di luar aturan di atas, SINGKAT dan langsung ke inti.');
  parts.push('');
  parts.push('=== ATURAN DATA PEMESANAN (IKUTI STEP3 RULES, PENTING) ===');
  parts.push('- Untuk pengumpulan data alamat dan data customer, IKUTI urutan di STEP3 RULES di atas (satu field per balasan).');
  parts.push('- Untuk No HP: JANGAN langsung minta diketik. Tanya dulu: "Boleh pakai nomor WhatsApp ini juga untuk dihubungi kurir ya, Kak?"');
  parts.push('- HATI-HATI KATA AMBIGU: Kata "No", "no", "nomer", "nomor" dalam chat bahasa Indonesia SERING berarti "Nomor", BUKAN berarti "tidak/batal".');
  parts.push('- Tetap patuhi ATURAN CTA (maksimal 1 pertanyaan per balasan)');
  parts.push('- Begitu SEMUA data sudah lengkap terkumpul: JANGAN langsung sisipkan [ORDER_DATA]. Balas dulu dengan MEREKAP pesanan dan minta konfirmasi eksplisit');
  parts.push('- Order baru dianggap FINAL setelah pelanggan membalas mengonfirmasi. BARU pada balasan konfirmasi tersebut kamu sisipkan [ORDER_DATA]');
  parts.push('- Kalau pesanan berisi LEBIH DARI 1 produk, jumlahkan semua ke dalam total harga saat merekap');
  parts.push('Format blok data:');
  parts.push('[ORDER_DATA]{"nama": "Nama Lengkap", "hp": "No HP, atau SAMA_DENGAN_WA", "produk": "Nama Produk", "alamat": "Alamat lengkap", "pembayaran": "COD atau Transfer"}[/ORDER_DATA]');
  parts.push('PENTING: Jangan menyertakan blok ini jika pelanggan hanya tanya-tanya, belum pasti memesan.');
  parts.push('- WAJIB VERIFIKASI SEBELUM REKAP: cek data SUDAH pernah disebutkan EKSPLISIT oleh customer');
  parts.push('- DILARANG KERAS menyisipkan [ORDER_DATA] jika nama penerima atau alamat detail BELUM pernah dikirimkan oleh customer.');
  parts.push('');
  parts.push('=== KALIMAT PENUTUP KHUSUS UNTUK PRODUK COD (PENTING) ===');
  parts.push('- Cek INFORMASI PRODUK & BISNIS: kalau produk bisa COD, pada balasan konfirmasi order final WAJIB tambahkan kalimat tentang menitipkan uang ke keluarga jika sering di luar rumah');
  parts.push('- Kalimat ini HANYA untuk produk yang statusnya bisa COD.');
  parts.push('');
  parts.push('=== ATURAN ESKALASI KE ADMIN (SANGAT PENTING — JANGAN MENGARANG) ===');
  parts.push('- Kalau ada pertanyaan yang jawabannya TIDAK tertulis eksplisit di KB — JANGAN PERNAH mengarang atau menebak jawaban');
  parts.push('- Sisipkan tag [ESCALATE:Nama Produk]pertanyaan singkat untuk admin[/ESCALATE]');
  parts.push('- Kalau SELURUH balasan hanya berisi tag [ESCALATE], JANGAN tambahkan basa-basi');
  parts.push('- Kalau sebagian BISA dijawab dan sebagian TIDAK, jawab dulu yang bisa, lalu tambahkan tag [ESCALATE]');
  parts.push('');
  parts.push('=== ANTI-HALLUCINATION: INFO YANG BOLEH vs TIDAK BOLEH (SANGAT PENTING) ===');
  parts.push('- INFO YANG BOLEH: nama produk, harga, varian/warna, manfaat/kegunaan, cara pakai');
  parts.push('- INFO YANG TIDAK BOLEH: tanggal/hari pengiriman, estimasi waktu sampai, status stok, nama kurir, lokasi toko, kebijakan yang tidak disebutkan');
  parts.push('- Gunakan tag [ESCALATE] untuk pertanyaan di luar KB');
  parts.push('');
  parts.push('=== ATURAN SPLIT BUBBLE (PENTING) ===');
  parts.push('- Ketika customer menyebut nama produk untuk PERTAMA KALI, WAJIB pisahkan balasan menjadi 2 bagian menggunakan tag [SPLIT]');
  parts.push('    Bagian 1: konfirmasi nama produk (1 kalimat)');
  parts.push('    Bagian 2: isi jawaban lengkap (harga, varian, detail, CTA)');
  parts.push('- JANGAN gunakan [SPLIT] kalau produk sudah pernah dikonfirmasi di history');
  parts.push('- JANGAN gunakan [SPLIT] untuk balasan non-produk');
  parts.push('- JANGAN gunakan [SPLIT] lebih dari 1 kali dalam 1 percakapan untuk produk yang sama.');
  parts.push('');

  // Image rules
  const productsWithImages = Object.keys(settings.productImages || {}).filter(k => settings.productImages[k] && settings.productImages[k].some(img => img));
  if (productsWithImages.length > 0) {
    const alreadyImaged = productsWithImages.filter(p => sentImagesForFrom?.has(p));
    const notYetImaged = productsWithImages.filter(p => !sentImagesForFrom?.has(p));
    parts.push('=== ATURAN GAMBAR (PENTING) ===');
    parts.push(`Produk berikut memiliki gambar yang siap dikirim: ${productsWithImages.join(', ')}.`);
    parts.push('- Begitu kamu SUDAH menjelaskan produk, WAJIB tambahkan: [KIRIM_GAMBAR:Nama Produk]');
    parts.push('- Gambar HANYA dikirim SEKALI per produk dalam 1 percakapan.');
    if (alreadyImaged.length) parts.push(`- Produk yang GAMBARNYA SUDAH dikirim: ${alreadyImaged.join(', ')}.`);
    if (notYetImaged.length) parts.push(`- Produk yang gambarnya BELUM dikirim: ${notYetImaged.join(', ')}.`);
    parts.push('');
  }

  parts.push('=== MENANGANI PESAN DENGAN BEBERAPA MAKSUD SEKALIGUS (PENTING) ===');
  parts.push('- Satu pesan pelanggan bisa berisi BEBERAPA maksud/intent sekaligus');
  parts.push('- Baca SELURUH isi pesan pelanggan sebelum menjawab');
  parts.push('- Kalau pelanggan menyebut nama produk DAN sekaligus minta harga, anggap produk sudah terkonfirmasi dan langsung jawab harga/info-nya');

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 11. callGeminiDirect — full Gemini API call with multimodal support
// ═══════════════════════════════════════════════════════════════════
async function callGeminiDirect(key, keySlot, message, name, history, signal, from, imagePath, audioPath, thinkerData) {
  const startTime = Date.now();
  const settings = store.settings;
  const orderStates = store.orderStates;
  const model = settings.modelName || config.DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // Build contents from history
  const contents = [];
  if (history?.length) {
    for (const h of history) {
      // Skip summary entries — they are appended to system prompt, not contents
      if (h._summary) continue;
      contents.push({ role: 'user', parts: [{ text: h.body }] });
      // B4: Skip cancelled/held replies so internal strings don't leak to Gemini context
      if (h.aiReply && !h.cancelledEntry && !h.heldReply) {
        const cleanedReply = cleanFieldQuestions(h.aiReply, orderStates.get(from));
        contents.push({ role: 'model', parts: [{ text: cleanedReply }] });
      }
    }
  }

  // P2-B: Include image as multimodal inline_data
  const userParts = [];
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const imgBuffer = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).toLowerCase().replace('.', '');
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      const mime = mimeMap[ext] || 'image/jpeg';
      userParts.push({ inline_data: { mime_type: mime, data: imgBuffer.toString('base64') } });
      console.log(`[P2-B] Gambar disertakan ke Gemini: ${path.basename(imagePath)} (${Math.round(imgBuffer.length / 1024)}KB)`);
    } catch (e) {
      console.warn('[P2-B] Gagal baca gambar untuk Gemini:', e.message);
    }
  }

  // P2-B2: Include audio as multimodal inline_data
  if (audioPath && fs.existsSync(audioPath)) {
    try {
      const audioBuffer = fs.readFileSync(audioPath);
      const ext = path.extname(audioPath).toLowerCase().replace('.', '');
      const audioMime = ext === 'mp4' ? 'audio/mp4' : 'audio/ogg';
      userParts.push({ inline_data: { mime_type: audioMime, data: audioBuffer.toString('base64') } });
      console.log(`[P2-B2] Audio disertakan ke Gemini: ${path.basename(audioPath)} (${Math.round(audioBuffer.length / 1024)}KB)`);
    } catch (e) {
      console.warn('[P2-B2] Gagal baca audio untuk Gemini:', e.message);
    }
  }

  userParts.push({ text: message || '[customer mengirim pesan suara]' });
  contents.push({ role: 'user', parts: userParts });

  // Get relevant KB and build system prompt
  const relevantKB = getRelevantKnowledge(message, history);
  const isFirstMessage = !history?.length;
  const sentImagesForFrom = store.sentProductImages.get(from) || null;
  let systemPromptText = buildSystemPrompt(name, relevantKB, isFirstMessage, from, sentImagesForFrom, thinkerData);

  // Append summary from old conversations to system prompt
  const summaryEntry = history?.find(h => h._summary);
  if (summaryEntry) {
    systemPromptText += '\n\n=== RINGKASAN PERCAKAPAN SEBELUMNYA ===\n' + summaryEntry.summary;
  }

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPromptText }] },
    generationConfig: { temperature: settings.temperature ?? config.DEFAULT_TEMPERATURE },
  };

  // Log the request
  logGeminiRequest('request', {
    user: name,
    phone: from,
    systemPrompt: systemPromptText,
    history: history || [],
    message,
    tokenEstimate: {
      system: estimateTokens(systemPromptText),
      history: estimateTokens(JSON.stringify(history || [])),
      current: estimateTokens(message),
    },
  });

  // Raw payload log
  const rawLog = {
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    systemInstruction: { parts: [{ text: systemPromptText }] },
    contents: contents.map(c => ({
      role: c.role,
      parts: c.parts.map(p => p.text ? { text: p.text } : { inline_data: { mime_type: p.inline_data?.mime_type, data: '[base64...]' } })
    })),
    generationConfig: body.generationConfig,
  };
  console.log(`\nRAW PAYLOAD KE GEMINI:`);
  console.log(JSON.stringify(rawLog, null, 2));
  console.log(`END RAW PAYLOAD\n`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: e.message };
  }

  // Handle error responses
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    let errData = null;
    try {
      errData = await res.json();
      msg = errData?.error?.message || msg;
    } catch (e) {}

    // 429 — Rate limit: parse quotaId and retryDelay
    if (res.status === 429) {
      let quotaId = null;
      let retryDelaySec = null;
      try {
        const details = errData?.error?.details || [];
        for (const d of details) {
          if (!quotaId && Array.isArray(d.violations)) {
            for (const v of d.violations) {
              if (v?.quotaId) { quotaId = v.quotaId; break; }
            }
          }
          if (retryDelaySec === null && typeof d?.['@type'] === 'string' && d['@type'].includes('RetryInfo') && d.retryDelay) {
            const rd = d.retryDelay;
            if (typeof rd === 'string') {
              const m = rd.match(/^(\d+(?:\.\d+)?)s?$/);
              if (m) retryDelaySec = parseFloat(m[1]);
            } else if (typeof rd === 'number') {
              retryDelaySec = rd;
            }
          }
        }
      } catch (e) {}
      return { ok: false, status429: true, quotaId, retryDelaySec, error: msg };
    }

    // 503 — Transient overload
    if (res.status === 503) {
      return { ok: false, status503: true, error: msg };
    }

    return { ok: false, error: msg };
  }

  // Parse successful response
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text.trim()) return { ok: false, error: 'Respons kosong dari Gemini' };

  const usage = data.usageMetadata;
  const duration = Date.now() - startTime;
  if (usage) {
    console.log(`[Token] Key ${keySlot + 1} | Prompt: ${usage.promptTokenCount} | Output: ${usage.candidatesTokenCount}`);
  }

  const cleanText = text.trim().replace(/^["'`]+|["'`]+$/g, '').trim();

  // Log the response
  logGeminiRequest('response', {
    ok: true,
    text: cleanText,
    duration,
    outputTokens: usage?.candidatesTokenCount || 0,
    phone: from,
  });

  return { ok: true, text: cleanText };
}

// ═══════════════════════════════════════════════════════════════════
// 12. callGeminiRaw — simple Gemini call for internal tasks
// ═══════════════════════════════════════════════════════════════════
async function callGeminiRaw(systemPrompt, userText) {
  const picked = getAvailableKey();
  if (!picked) return null;
  const model = store.settings.modelName || config.DEFAULT_MODEL;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': picked.key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.1 },
      }),
    });
    if (res.status === 429) {
      let errData = null;
      try { errData = await res.json(); } catch (e) {}
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
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    return text.trim() || null;
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// 13. aiReply — retry loop with key rotation
// ═══════════════════════════════════════════════════════════════════
async function aiReply(message, name, history, signal, from, imagePath, audioPath, thinkerData) {
  if (getValidKeys().length === 0) {
    console.error('Tidak ada API key yang valid di .env');
    return null;
  }

  const MAX_503_RETRIES = 3;
  const RETRY_503_DELAY_MS = 2000;
  let retry503Count = 0;
  const tried503Keys = new Set();

  while (true) {
    if (signal?.aborted) return null;

    const picked = getAvailableKey();
    if (!picked) {
      console.warn('Semua API key sedang kena limit -> pesan diqueue untuk retry');
      emitKeyStatuses();
      return null;
    }

    activeKeyIndex = picked.slot;
    emitKeyStatuses();
    console.log(`Mencoba Key ${picked.slot + 1}...`);

    const result = await callGeminiDirect(picked.key, picked.slot, message, name, history, signal, from, imagePath, audioPath, thinkerData);

    if (result.ok) {
      emitKeyStatuses();
      return result.text;
    }
    if (result.aborted) return null;

    // 429 — Rate limit hit: mark key as limited and try next key
    if (result.status429) {
      markKeyLimited(picked.pos, result.quotaId, result.retryDelaySec);
      const st = apiKeyStates[picked.pos];
      console.warn(`Key ${picked.slot + 1} kena limit (${result.quotaId || 'tidak diketahui'}) -> ${st.status}, retry_at=${new Date(st.retry_at).toISOString()}`);
      emitKeyStatuses();
      continue;
    }

    // 503 — Transient overload: try another key with short delay
    if (result.status503) {
      retry503Count++;
      tried503Keys.add(picked.pos);

      const totalKeys = getValidKeys().length;
      if (retry503Count >= MAX_503_RETRIES || tried503Keys.size >= totalKeys) {
        console.warn(`${retry503Count}x 503 "high demand" setelah coba ${tried503Keys.size} key -> pesan diqueue untuk retry`);
        emitKeyStatuses();
        return null;
      }

      lastUsedKeyIndex = (picked.pos + 1) % Math.max(totalKeys, 1);
      console.warn(`Key ${picked.slot + 1} 503 "high demand" -> skip, coba key lain (${retry503Count}/${MAX_503_RETRIES})`);
      emitKeyStatuses();
      await new Promise(r => setTimeout(r, RETRY_503_DELAY_MS));
      continue;
    }

    // Other errors: try another key
    retry503Count++;
    tried503Keys.add(picked.pos);
    const totalKeys = getValidKeys().length;

    if (retry503Count >= MAX_503_RETRIES || tried503Keys.size >= totalKeys) {
      console.error(`${retry503Count}x error setelah coba ${tried503Keys.size} key: ${result.error?.slice(0, 150)} -> pesan diqueue untuk retry`);
      emitKeyStatuses();
      return null;
    }

    lastUsedKeyIndex = (picked.pos + 1) % Math.max(totalKeys, 1);
    console.warn(`Key ${picked.slot + 1} error (${result.error?.slice(0, 80)}) -> skip, coba key lain (${retry503Count}/${MAX_503_RETRIES})`);
    emitKeyStatuses();
    await new Promise(r => setTimeout(r, RETRY_503_DELAY_MS));
    continue;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MODULE EXPORTS
// ═══════════════════════════════════════════════════════════════════
module.exports = {
  // Key management
  getApiKeys,
  getValidKeys,
  getAvailableKey,
  markKeyLimited,
  computeKeyStatuses,
  emitKeyStatuses,
  ensureKeyStates,
  getNextMidnightPT,

  // API calls
  callGeminiDirect,
  aiReply,
  callGeminiRaw,

  // Utilities
  estimateTokens,
  logGeminiRequest,

  // Internal state accessors (for server.js integration)
  get activeKeyIndex() { return activeKeyIndex; },
  set activeKeyIndex(v) { activeKeyIndex = v; },
  get lastUsedKeyIndex() { return lastUsedKeyIndex; },
  set lastUsedKeyIndex(v) { lastUsedKeyIndex = v; },
  get apiKeyStates() { return apiKeyStates; },
  set apiKeyStates(v) { apiKeyStates = v; },

  // Helpers exposed for other modules
  buildSystemPrompt,
};
