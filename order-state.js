/**
 * order-state.js — Order flow management
 * Track customer order progress through steps, detect products,
 * extract order data from messages.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const config = require('./config');
const store  = require('./state-store');
const { parseProductBlocks } = require('./knowledge-base');

const ORDER_STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
const POST_ORDER_TTL_MS = 3 * 24 * 60 * 60 * 1000;   // 3 days after confirmed

// ── Persist order state to file ──
let _persistTimer = null;
function _doPersistOrderState() {
  const obj = {};
  for (const [phone, state] of store.orderStates) obj[phone] = state;
  try { fs.writeFileSync(store.PATHS.ORDER_STATE_FILE, JSON.stringify(obj, null, 2)); }
  catch (e) { console.error('[OrderState] Gagal persist:', e.message); }
}
function persistOrderState(urgent = false) {
  if (urgent) { _doPersistOrderState(); return; }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(_doPersistOrderState, 2000);
}

// ── Load from file on startup ──
function loadOrderStates() {
  try {
    const data = JSON.parse(fs.readFileSync(store.PATHS.ORDER_STATE_FILE, 'utf-8'));
    const now = Date.now();
    let loaded = 0, cleaned = 0;
    for (const [phone, state] of Object.entries(data)) {
      if (!state.lastUpdate || (now - state.lastUpdate) > ORDER_STATE_TTL_MS) { cleaned++; continue; }
      store.orderStates.set(phone, state);
      loaded++;
    }
    console.log(`📦 [OrderState] Loaded ${loaded} state, cleaned ${cleaned} expired`);
    if (cleaned > 0) persistOrderState();
  } catch { console.log('📦 [OrderState] File tidak ada, mulai fresh'); }
}

// ── Cleanup interval ──
function startCleanupInterval() {
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [from, state] of store.orderStates) {
      if (!state.orderConfirmed && now - state.lastUpdate > 30 * 60 * 1000) {
        store.orderStates.delete(from);
        changed = true;
        continue;
      }
      if (state.orderConfirmed && now - state.lastUpdate > POST_ORDER_TTL_MS) {
        store.orderStates.set(from, createOrderState(state.product));
        changed = true;
      }
    }
    if (changed) persistOrderState(true);
  }, 5 * 60 * 1000);
}

function createOrderState(product) {
  return {
    step: 1, product, color: null, namaLengkap: null, namaVerified: false,
    jalan: null, dusun: null, desa: null, kecamatan: null, kota: null,
    rtRw: null, patokan: null, patokanSkipped: false, alamatLengkap: null,
    noHp: null, orderConfirmed: false, lastUpdate: Date.now(),
  };
}

function detectProductFocus(message) {
  const blocks = parseProductBlocks(store.settings.knowledgeBase);
  if (!blocks.length) return null;
  const lowerMsg = message.toLowerCase();
  for (const b of blocks) {
    if (!b.name) continue;
    const words = b.name.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    if (words.some(w => lowerMsg.includes(w))) return b.name;
  }
  return null;
}

function detectOrderData(message, currentStep) {
  const lower = message.toLowerCase().trim();
  const data = {};
  if ([1, 2].includes(currentStep)) {
    const colorMap = {
      'biru muda': 'Biru Muda', 'biru': 'Biru Muda',
      'pink muda': 'Pink Muda', 'pink': 'Pink Muda',
      'abu': 'Abu-abu', 'abu-abu': 'Abu-abu',
      'navy': 'Navy', 'red': 'Red', 'merah': 'Red',
    };
    for (const [key, val] of Object.entries(colorMap)) {
      if (lower === key || (lower.includes(key) && !lower.includes('bukan'))) { data.color = val; break; }
    }
  }
  if (currentStep === 3) {
    const phoneMatch = message.match(/\b(08\d{8,12})\b/);
    if (phoneMatch) data.phone = phoneMatch[1];
  }
  return data;
}

function looksLikeAddress(text) {
  return /jalan|jl\.|jl\s|gg\.|gang|rt\s|rw\s|\brt\b|\brw\b|desa|kelurahan|kel\.|kecamatan|kec\.|kota|kabupaten|kab\.|dusun|rukeman|kampung|perum|perumahan|blok|no\.|nomor|kompleks|komplek/i.test(text);
}

function looksLikeQuestion(text) {
  return /\?|harga|berapa|stok|warna|ukuran|manfaat|cara|kirim|tok/i.test(text);
}

function extractCustomerFields(state, message) {
  const lower = message.toLowerCase().trim();
  const words = message.trim().split(/\s+/);

  const skipWords = /^(ya|y|oke|ok|baik|siap|betul|benar|sama|boleh|mantap|gas|proses|lanjut|fix|setuju|iya|noted|ok\s*ku|iya\s*ka|oke\s*ka|baik\s*ka|siap\s*ka|oke\s*kak|siap\s*kak|ya\s*ka|ya\s*kak|noted\s*ka|betul\s*ka|benar\s*ka|proses\s*ka|lanjut\s*ka|fix\s*ka|mantap\s*ka|gas\s*ka|setuju\s*ka|boleh\s*ka|sama\s*ka)$/;
  if (skipWords.test(lower)) return;

  // RT/RW "gak ada"
  if (!state.rtRw && /\b(gak|nggak|ga|tidak)\s*(ada)?\b/i.test(lower) && /\b(rt|rw|rukun)\b/i.test(lower)) {
    state.rtRw = '-';
  }

  // Patokan optional
  if (!state.patokan && !state.patokanSkipped && /\b(gak ada|ga ada|tidak ada|gak punya|ga punya|gapunya)\b/i.test(lower) && /\b(patokan|panduan|penanda|acuan|landmark)\b/i.test(lower)) {
    state.patokanSkipped = true;
  }

  // noHp SAMA_DENGAN_WA
  if (!state.noHp && /\b(sama|boleh|pakai|pake|aja|nomor\s*ini|wa\s*ini|whatsapp\s*ini|nomor\s*wa)\b/i.test(lower) && !/\b08\d{8}/.test(message)) {
    state.noHp = 'SAMA_DENGAN_WA';
  }

  // NAMA: >= 2 kata, bukan greeting/product/address
  const hasComma = message.includes(',');
  const isGreeting = /^(halo|hai|hello|hey|permisi|selamat|assalam|pagi|siang|sore|malam)/i.test(lower);
  const isProductInquiry = /\b(tanya|nanya|cek|harga|produk|stok|ready|berapa|ada|mau)\b/i.test(lower);
  const KB_KEYWORDS = ['baby walking', 'pasta dempul', 'selang', 'mini sealer'];
  const COLOR_KEYWORDS = ['navy', 'red', 'biru muda', 'pink muda', 'biru', 'pink', 'merah', 'abu-abu', 'abu'];
  const isPatokan = /\b(dekat|sebelah|samping|belakang|depan|masjid|mushola|warung|sekolah|tokо)\b/i.test(lower);
  const isProductName = !!detectProductFocus(message) || KB_KEYWORDS.some(kw => lower.includes(kw))
    || COLOR_KEYWORDS.some(kw => lower === kw || (lower.includes(kw) && lower.split(/\s+/).length <= 5)) || isPatokan;
  const isNotName = isGreeting || isProductInquiry || isProductName;

  if (!state.namaLengkap || !state.namaVerified) {
    if (words.length >= 2 && !hasComma && !looksLikeAddress(lower) && !looksLikeQuestion(lower) && !isNotName) {
      state.namaLengkap = message.trim();
      state.namaVerified = true;
    } else if (words.length === 1 && !hasComma && !looksLikeAddress(lower) && !looksLikeQuestion(lower) && !isNotName) {
      const addressStarted = state.jalan || state.rtRw || state.desa;
      if (!state.namaLengkap && !addressStarted) {
        state.namaLengkap = message.trim();
        state.namaVerified = false;
      }
    }
  }

  // RT/RW
  if (!state.rtRw) {
    const rtRwBoth = message.match(/rt\s*(\d{1,3})\s*[\/\s]\s*(?:rw\s*)?(\d{1,3})/i);
    if (rtRwBoth) { state.rtRw = `RT ${rtRwBoth[1]}/RW ${rtRwBoth[2]}`; }
    else {
      const rtOnly = message.match(/\brt\s*(\d{1,3})\b/i);
      if (rtOnly) state.rtRw = `RT ${rtOnly[1]}`;
    }
  }

  // JALAN
  if (!state.jalan) {
    const jalanMatch = message.match(/(?:jalan|jl\.?|jl|perum(?:ahan)?|komplek)\s+(.+)/i);
    if (jalanMatch) { state.jalan = jalanMatch[1].replace(/[,\n].*$/, '').trim(); }
    else {
      const noMatch = message.match(/(?:nomor|no\.?)\s*[:\s]*(\d+[a-zA-Z]?)/i);
      if (noMatch && words.length <= 5) state.jalan = `No. ${noMatch[1]}`;
    }
  }

  // DESA / DUSUN
  if (!state.desa) {
    const dusunMatch = message.match(/\b(dusun|desa|kelurahan|kel\.|kampung)\s+([\w\s]+?)$/i);
    if (dusunMatch && words.length <= 4) state.desa = dusunMatch[2].trim();
  }
  // KECAMATAN
  if (!state.kecamatan) {
    const kecMatch = message.match(/\b(kecamatan|kec\.?)\s+([\w\s]+?)$/i);
    if (kecMatch && words.length <= 4) state.kecamatan = kecMatch[2].trim();
  }
  // KOTA
  if (!state.kota) {
    const kotaMatch = message.match(/\b(kabupaten|kota|kab\.?)\s+([\w\s]+?)$/i);
    if (kotaMatch && words.length <= 4) state.kota = kotaMatch[2].trim();
  }
  // Single-word kecamatan/kota
  const addressStarted = state.jalan || state.rtRw || state.desa;
  if (!state.kecamatan && addressStarted && words.length === 1 && !isNotName) {
    state.kecamatan = message.trim();
  } else if (!state.kota && state.kecamatan && words.length === 1 && !isNotName) {
    state.kota = message.trim();
  }
  // Comma-separated address parts
  if (!state.desa || !state.kecamatan || !state.kota) {
    let addrRaw = message.replace(/rt\s*\d+\s*\/\s*(?:rw\s*)?\d+/gi, '').trim();
    if (state.jalan) {
      const firstCommaIdx = addrRaw.indexOf(',');
      if (firstCommaIdx !== -1) addrRaw = addrRaw.substring(firstCommaIdx + 1).trim();
    }
    const parts = addrRaw.split(/[,\n]+/).map(p => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      if (!state.desa && !state.kecamatan) { state.desa = parts[0]; state.kecamatan = parts[1]; }
      else if (state.desa && state.kecamatan && !state.kota) { state.kecamatan = parts[0]; state.kota = parts[1]; }
      else if (!state.desa) { state.desa = parts[0]; if (!state.kecamatan) state.kecamatan = parts[1]; }
      else if (!state.kecamatan) { state.kecamatan = parts[0]; if (!state.kota) state.kota = parts[1]; }
    } else if (parts.length === 3) {
      if (!state.desa) state.desa = parts[0];
      if (!state.kecamatan) state.kecamatan = parts[1];
      if (!state.kota) state.kota = parts[2];
    } else if (parts.length >= 4) {
      if (!state.dusun && !/^\d/.test(parts[0])) state.dusun = parts[0];
      if (!state.desa) state.desa = parts[1];
      if (!state.kecamatan) state.kecamatan = parts[2];
      if (!state.kota) state.kota = parts[3];
    }
  }

  // PATOKAN
  if (!state.patokan && !state.patokanSkipped) {
    const lowerClean = lower.replace(/rt\s*\d+\s*\/?\s*rw\s*\d+/gi, '').trim();
    if (lowerClean.length > 3 && !/^\d{8,13}$/.test(lowerClean.replace(/\s/g, '')) && !looksLikeAddress(lowerClean) && words.length >= 2) {
      const patokanKeywords = ['dekat', 'deket', 'sebelah', 'samping', 'belakang', 'depan', 'sudut', 'ujung', 'masjid', 'sekolah', 'warung', 'jalan'];
      if (patokanKeywords.some(k => lowerClean.includes(k))) state.patokan = message.trim();
    }
  }
}

function getMissingFields(state) {
  const missing = [];
  if (!state.jalan)               missing.push('nama jalan dan nomor jalan');
  if (!state.desa)                missing.push('dusun/desa');
  if (!state.rtRw)                missing.push('RT/RW');
  if (!state.kecamatan)           missing.push('kecamatan');
  if (!state.kota)                missing.push('kabupaten');
  if (!state.patokan && !state.patokanSkipped) missing.push('patokan');
  if (!state.namaLengkap || !state.namaVerified) missing.push('nama lengkap');
  if (!state.noHp)                missing.push('nomor HP');
  return missing;
}

function getNextOrderField(state) {
  if (!state.color) return 'warna';
  if (!state.namaLengkap || !state.namaVerified) return 'nama lengkap penerima';
  if (!state.desa) return 'alamat (dusun, desa, kecamatan, kota)';
  if (!state.patokan) return 'patokan rumah';
  if (!state.rtRw) return 'RT/RW';
  if (!state.noHp) return 'nomor HP';
  return null;
}

function updateOrderState(from, message) {
  let state = store.orderStates.get(from);
  const detectedProduct = detectProductFocus(message);
  const lower = message.toLowerCase().trim();

  if (detectedProduct && (!state || state.product !== detectedProduct)) {
    state = createOrderState(detectedProduct);
    store.orderStates.set(from, state);
    persistOrderState();
  }

  if (!state) return null;

  const data = detectOrderData(message, state.step);
  if (data.color && !state.color) state.color = data.color;
  else if (data.phone && !state.noHp) state.noHp = data.phone;

  extractCustomerFields(state, message);

  const priorReplies = store.messages.filter(m => m.from === from && m.aiReply && !m.cancelledEntry).length;
  const prevStep = state.step;

  // Step 1→2
  if (state.step === 1 && priorReplies >= 1 && !detectedProduct) state.step = 2;

  // Step 2→3: order intent
  const orderIntent = /\b(mau\s+(order|pesan|beli|ambil)|saya\s+(order|pesan|beli)|lanjut\s+order|proses\s+aja|oke\s*(bayar|proses|lanjut)|setuju\s+order)\b|\border\b|\bpesan\b|\bbeli\b|\bambil\b|\bproses\b|\bsatu\s+(ya|dong|kak|please)\b|\b\w+\s+aja\b|\b\w+\s+dong\b|\b(tak|aku|aq)\s+ambil\b/i;
  if (state.step === 2 && orderIntent.test(lower)) state.step = 3;

  // Step 3→4: confirmation
  const confirmPattern = /\b(ya|y|iya|oke|ok|betul|benar|siap|fix|setuju|sudah|lengkap|mantap|gas|proses|lanjut|boleh)\b/i;
  const isShortConfirm = lower.split(/\s+/).length <= 5;
  if (state.step === 3 && confirmPattern.test(lower) && isShortConfirm) {
    if (getMissingFields(state).length === 0) state.step = 4;
  }

  // Step 3→5: escalation
  if ([3, 4].includes(state.step)) {
    const escKeywords = ['estimasi', 'berapa hari', 'stok', 'retur', 'garansi', 'komplain', 'batal', 'gak jadi', 'kirim kapan', 'kirim kapn', 'hari sampai', 'kurir sampai', 'kapan sampai'];
    const isEscalation = escKeywords.some(k => lower.includes(k));
    const isConfirm = confirmPattern.test(lower);
    if (isEscalation && !isConfirm) state.step = 5;
  }

  if (state.step !== prevStep) {
    console.log(`📊 [Step] ${from.slice(-4)}: ${prevStep}→${state.step} (${message.slice(0, 40)})`);
  }

  state.lastUpdate = Date.now();
  store.orderStates.set(from, state);
  persistOrderState();
  return state;
}

module.exports = {
  createOrderState, detectProductFocus, detectOrderData,
  updateOrderState, extractCustomerFields, getMissingFields,
  getNextOrderField, looksLikeAddress, looksLikeQuestion,
  loadOrderStates, persistOrderState, startCleanupInterval,
};
