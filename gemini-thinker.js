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

// ── Intent Types ──────────────────────────────────────────────────
const INTENTS = {
  GREETING:           'greeting',
  PRODUCT_INQUIRY:    'product_inquiry',
  PRODUCT_FOLLOW_UP:  'product_follow_up',
  ORDER_COLOR:        'order_color_selection',
  ORDER_INTENT:       'order_intent',
  DATA_PROVIDED:      'data_provided',
  CONFIRMATION:       'confirmation',
  ESCALATION:         'escalation',
  GENERAL_CHAT:       'general_chat',
};

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
- phone: nomor HP 08xxxxxxxx

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
Output: {"intent":"confirmation","product":null,"extracted_data":{},"next_step":4,"next_field":null,"confidence":0.95}`;

// ── Main classify function ────────────────────────────────────────
async function classifyIntent(message, context = {}) {
  const { from, orderState, history } = context;

  // Build context string untuk Thinker
  const contextLines = [];
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
  if (history?.length) {
    const recentContext = history.slice(-3).map(h => {
      if (h._summary) return `[ringkasan] ${h.summary}`;
      return `Customer: "${(h.body || '').slice(0, 80)}" | AI: "${(h.aiReply || '').slice(0, 80)}"`;
    }).join('\n');
    contextLines.push(`Riwayat:\n${recentContext}`);
  }

  const contextStr = contextLines.length ? `\n\nContext:\n${contextLines.join('\n')}` : '';

  // Call Gemini API (ringan, output kecil)
  const result = await callThinkerGemini(message + contextStr);
  if (!result) return null;

  // Parse JSON output
  try {
    const parsed = JSON.parse(result.replace(/```json|```/g, '').trim());

    // Validate intent
    const validIntents = Object.values(INTENTS);
    if (!validIntents.includes(parsed.intent)) {
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
