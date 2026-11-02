/**
 * ongkir-helper.js  — P2-C
 * Fungsi internal server-side untuk cek ongkir via Mengantar API.
 *
 * Format response Mengantar (verified via API exploration):
 *   /address/search → { data: [{ _id, DESTINATION_CODE, SUBDISTRICT_NAME, DISTRICT_NAME, ... }] }
 *   /order/estimate → { data: { price, estimatedSpecialPrice, estimatedDate, JNE_zone, ... } }
 *   Catatan: estimate private HANYA return 1 kurir (JNE/flagship kurir toko)
 *            dengan harga final setelah diskon di estimatedSpecialPrice.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const MENGANTAR_BASE        = 'https://app.mengantar.com';
const MENGANTAR_ITEM_WEIGHT = parseFloat(process.env.MENGANTAR_ITEM_WEIGHT || '1');

// Origin ID toko (Serua, Ciputat, Tangerang Selatan)
// Disimpan di .env sebagai MENGANTAR_ORIGIN_ID (format: MongoDB _id dari /address/search)
const MENGANTAR_ORIGIN_MONGO_ID = process.env.MENGANTAR_ORIGIN_MONGO_ID || '5fc6491cf8f44b34aa4ce87b';

// ── 1. Parse lokasi tujuan dari isi tag [CEK_ONGKIR:...] ──────────
function parseShippingDestination(text) {
  if (!text) return null;

  // Bersihkan prefiks administratif seperti Desa, Kelurahan, Kec, Kab, Kota dsb
  const stripped = text
    .replace(/\b(desa|kelurahan|kel|ds|kecamatan|kec|kabupaten|kab|kota)\b\.?/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped) return null;
  return { query: stripped, raw: text.trim() };
}

// ── 2. Cari _id MongoDB lokasi dari keyword ───────────────────────
// Return: { mongoId, code, name, city, province }
async function searchLocationId(keyword) {
  try {
    const apiKey = (process.env.MENGANTAR_API_KEY || '').trim() || 'API-A44O3OQUZLDNWZNJ';
    const url = `${MENGANTAR_BASE}/api/public/${apiKey}/address/search?keyword=${encodeURIComponent(keyword)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const results = data?.data || [];
    if (!results.length) return null;

    // Pilih hasil terbaik: prioritaskan SUBDISTRICT_NAME (desa) atau DISTRICT_NAME (kecamatan)
    const kwLower = keyword.toLowerCase();
    const kwWords = kwLower.split(/[\s,]+/).filter(Boolean);
    const best =
      results.find(r => kwWords.some(w => (r.SUBDISTRICT_NAME || '').toLowerCase() === w)) ||
      results.find(r => kwWords.some(w => (r.DISTRICT_NAME || '').toLowerCase() === w)) ||
      results.find(r => (r.SUBDISTRICT_NAME || '').toLowerCase().includes(kwWords[0])) ||
      results.find(r => (r.DISTRICT_NAME || '').toLowerCase().includes(kwWords[0])) ||
      results[0];

    const fullName = [best.SUBDISTRICT_NAME, best.DISTRICT_NAME, best.CITY_NAME].filter(Boolean).join(', ');

    return {
      mongoId: best._id,
      code:    best.DESTINATION_CODE,
      name:    fullName,
      city:    best.CITY_NAME,
      province: best.PROVINCE_NAME,
    };
  } catch (e) {
    console.warn('[Ongkir] searchLocationId error:', e.message);
    return null;
  }
}

// ── 3. Estimate multi-kurir via Mengantar public API ─────────────
// Endpoint: /api/order/allEstimatePublic (tanpa API key, multi-kurir)
// Return: { courier, price, specialPrice, etd, codFee, allCouriers } atau null
// defaultCourier: 'JT' = J&T
async function estimateOngkir({ originMongoId, destMongoId, weight, itemValue, defaultCourier = 'JT' }) {
  try {
    const params = new URLSearchParams({
      origin_id:      originMongoId,
      destination_id: destMongoId,
      weight:         String(weight || MENGANTAR_ITEM_WEIGHT),
      item_value:     String(itemValue || 100000),
    });
    const url = `${MENGANTAR_BASE}/api/order/allEstimatePublic?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.success || !data.data) return null;
    const allCouriers = data.data;

    // Build daftar kurir yang tersedia (non-cargo, non-unsupported)
    const available = Object.entries(allCouriers)
      .filter(([name, info]) => !info.unsupported && !name.toLowerCase().includes('cargo'))
      .map(([name, info]) => ({
        courier: name,
        price: info.estimatedSpecialPrice || info.estimatedPrice || info.price || 0,
        originalPrice: info.estimatedPrice || info.price || 0,
        discount: info.discount || 0,
        etd: info.estimatedDate || info.estimate_delivery || null,
        codFee: info.codFee || 0,
      }));

    if (!available.length) return null;

    // Pilih kurir default (J&T)
    const primary = available.find(c => c.courier === defaultCourier) || available[0];

    return {
      ...primary,
      allCouriers: available,
    };
  } catch (e) {
    console.warn('[Ongkir] estimateOngkir error:', e.message);
    return null;
  }
}

// ── 4. Format hasil ongkir menjadi teks siap kirim ke customer ────
// Tampilkan J&T sebagai kurir utama + info kurir lain jika ada

// Mapping nama kurir API → nama tampil customer
const COURIER_DISPLAY_NAMES = {
  'spx': 'SPX',
  'SPX': 'SPX',
  'SAP': 'SAP',
  'SAPLite': 'SAP Lite',
  'SiCepat': 'SiCepat',
  'JNE': 'JNE',
  'JT': 'J&T',
  'anteraja': 'Anteraja',
  'lion': 'Lion',
  'Ninja': 'Ninja',
  'pos': 'POS',
  'iDexpress': 'ID Express',
  'iDlite': 'ID Express Lite',
};

// Urutan prioritas tampilan ekspedisi:
// 1. SPX (Shopee Express)
// 2. SAP / SAP Lite (ambil yang termurah jika keduanya tersedia)
// 3. Ekspedisi termurah di luar SPX dan SAP
function selectPriorityCouriers(allCouriers) {
  if (!allCouriers || !allCouriers.length) return [];

  const selected = [];
  const used = new Set();

  // 1. Prioritas 1: SPX
  const spx = allCouriers.find(c => /^spx$/i.test(c.courier));
  if (spx) {
    selected.push(spx);
    used.add(spx.courier.toLowerCase());
  }

  // 2. Prioritas 2: SAP / SAP Lite (ambil termurah jika keduanya ada)
  const sapCandidates = allCouriers
    .filter(c => /^sap/i.test(c.courier) && !used.has(c.courier.toLowerCase()))
    .sort((a, b) => a.price - b.price);
  if (sapCandidates.length > 0) {
    selected.push(sapCandidates[0]);
    used.add(sapCandidates[0].courier.toLowerCase());
  }

  // 3. Prioritas 3: Ekspedisi termurah di luar SPX dan SAP
  const others = allCouriers
    .filter(c => !/^spx/i.test(c.courier) && !/^sap/i.test(c.courier) && !used.has(c.courier.toLowerCase()))
    .sort((a, b) => a.price - b.price);

  if (others.length > 0) {
    selected.push(others[0]);
    used.add(others[0].courier.toLowerCase());
  }

  // Fallback: Jika SPX atau SAP tidak tersedia di tujuan ini
  if (selected.length === 0) {
    const sorted = [...allCouriers].sort((a, b) => a.price - b.price);
    return sorted.slice(0, 3);
  }

  return selected;
}

function formatOngkirForCustomer(result, destName) {
  if (!result || (!result.price && (!result.allCouriers || !result.allCouriers.length))) {
    return `Maaf Kak, tarif ke ${destName || 'lokasi tersebut'} belum bisa dicek otomatis saat ini. Hubungi admin ya untuk info ongkir 🙏`;
  }

  const couriersToShow = selectPriorityCouriers(result.allCouriers || [result]);

  let msg = `Ongkir ke ${destName || 'lokasi kamu'} 📦`;
  for (const c of couriersToShow) {
    const cName = COURIER_DISPLAY_NAMES[c.courier] || c.courier.toUpperCase();
    const harga = Number(c.price).toLocaleString('id-ID');
    const codFee = (c.codFee && c.codFee > 0) ? c.codFee : 4000;
    const codFeeStr = Number(codFee).toLocaleString('id-ID');
    const etd = c.etd ? ` (${c.etd})` : '';
    msg += `\n• Sebesar Rp ${harga} (${cName}), biaya COD Rp ${codFeeStr}${etd}`;
  }

  return msg;
}

// ── 5. Flow utama: dari tag content "desa, kecamatan, kabupaten" ───
async function processCekOngkirTag(tagContent, itemValue) {
  const dest = parseShippingDestination(tagContent);
  if (!dest || !dest.query) {
    console.warn('[Ongkir] Tidak bisa parse tujuan dari:', tagContent);
    return null;
  }

  const keyword = dest.query;
  console.log(`[Ongkir] Search lokasi tujuan: "${keyword}"`);

  const destLoc = await searchLocationId(keyword);
  if (!destLoc?.mongoId) {
    console.warn('[Ongkir] Lokasi tidak ditemukan:', keyword);
    return null;
  }

  console.log(`[Ongkir] Estimasi: ${MENGANTAR_ORIGIN_MONGO_ID} → ${destLoc.mongoId} (${destLoc.name})`);
  const result = await estimateOngkir({
    originMongoId: MENGANTAR_ORIGIN_MONGO_ID,
    destMongoId:   destLoc.mongoId,
    weight:        MENGANTAR_ITEM_WEIGHT,
    itemValue:     itemValue || 100000,
  });

  return {
    formatted: formatOngkirForCustomer(result, destLoc.name),
    destName:  destLoc.name,
    result,
  };
}

// ── 6. Helper: Ganti semua tag [CEK_ONGKIR:...] dalam teks balasan AI ──
async function resolveOngkirTags(replyText, itemValue = 100000) {
  if (!replyText || typeof replyText !== 'string' || !replyText.includes('[CEK_ONGKIR:')) {
    return replyText;
  }

  const regex = /\[CEK_ONGKIR:([^\]]+)\]/gi;
  const matches = [...replyText.matchAll(regex)];
  if (!matches.length) return replyText;

  let resolved = replyText;
  for (const m of matches) {
    const fullTag = m[0];
    const loc = m[1].trim();
    try {
      const res = await processCekOngkirTag(loc, itemValue);
      if (res?.formatted) {
        resolved = resolved.replace(fullTag, res.formatted);
      } else {
        resolved = resolved.replace(fullTag, `(Untuk estimasi ongkir ke ${loc} sedang kami konfirmasi ke admin ya Kak)`);
      }
    } catch (e) {
      console.warn('[resolveOngkirTags] Error:', e.message);
      resolved = resolved.replace(fullTag, '');
    }
  }
  return resolved;
}

module.exports = {
  parseShippingDestination,
  searchLocationId,
  estimateOngkir,
  formatOngkirForCustomer,
  processCekOngkirTag,
  resolveOngkirTags,
};
