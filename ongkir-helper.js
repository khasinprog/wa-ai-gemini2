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
const MENGANTAR_API_KEY     = process.env.MENGANTAR_API_KEY    || '';
const MENGANTAR_ITEM_WEIGHT = parseFloat(process.env.MENGANTAR_ITEM_WEIGHT || '1');

// Origin ID toko (Serua, Ciputat, Tangerang Selatan)
// Disimpan di .env sebagai MENGANTAR_ORIGIN_ID (format: MongoDB _id dari /address/search)
const MENGANTAR_ORIGIN_MONGO_ID = process.env.MENGANTAR_ORIGIN_MONGO_ID || '5fc6491cf8f44b34aa4ce87b';

// ── 1. Parse lokasi tujuan dari isi tag [CEK_ONGKIR:...] ──────────
function parseShippingDestination(text) {
  if (!text) return null;
  const clean = text.trim();

  // Pola 1: "X,Y" dari tag langsung
  const commaMatch = clean.match(/^([^,]+),\s*(.+)$/);
  if (commaMatch) {
    return { kecamatan: commaMatch[1].trim(), kabupaten: commaMatch[2].trim() };
  }

  // Pola 2: "kecamatan X kabupaten Y"
  const verboseMatch = clean.match(
    /kec(?:amatan)?\s+([a-zA-Z\s]+?)\s+(?:kab(?:upaten)?|kota)\s+([a-zA-Z\s]+?)(?:[,.\n]|$)/i
  );
  if (verboseMatch) {
    return { kecamatan: verboseMatch[1].trim(), kabupaten: verboseMatch[2].trim() };
  }

  return null;
}

// ── 2. Cari _id MongoDB lokasi dari keyword ───────────────────────
// Return: { mongoId, code, name, city, province }
async function searchLocationId(keyword) {
  try {
    const url = `${MENGANTAR_BASE}/api/public/dummykey/address/search?keyword=${encodeURIComponent(keyword)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const results = data?.data || [];
    if (!results.length) return null;

    // Pilih hasil terbaik: prioritaskan DISTRICT_NAME cocok kata pertama keyword
    const kw0 = keyword.toLowerCase().split(' ')[0];
    const best =
      results.find(r => (r.DISTRICT_NAME || '').toLowerCase().includes(kw0)) ||
      results.find(r => (r.SUBDISTRICT_NAME || '').toLowerCase().includes(kw0)) ||
      results[0];

    return {
      mongoId: best._id,
      code:    best.DESTINATION_CODE,
      name:    `${best.DISTRICT_NAME}, ${best.CITY_NAME}`,
      city:    best.CITY_NAME,
      province: best.PROVINCE_NAME,
    };
  } catch (e) {
    console.warn('[Ongkir] searchLocationId error:', e.message);
    return null;
  }
}

// ── 3. Estimate ongkir via Mengantar private API ──────────────────
// Return: { price, specialPrice, etd } atau null
async function estimateOngkir({ originMongoId, destMongoId, weight, itemValue }) {
  if (!MENGANTAR_API_KEY) {
    console.warn('[Ongkir] MENGANTAR_API_KEY belum diisi di .env');
    return null;
  }
  try {
    const params = new URLSearchParams({
      origin_id:      originMongoId,
      destination_id: destMongoId,
      weight:         String(weight || MENGANTAR_ITEM_WEIGHT),
      item_value:     String(itemValue || 100000),
    });
    const url = `${MENGANTAR_BASE}/api/public/${encodeURIComponent(MENGANTAR_API_KEY)}/order/estimate?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.success || !data.data) return null;
    const d = data.data;

    return {
      price:        d.estimatedSpecialPrice || d.estimatedPrice || d.price || 0,
      originalPrice: d.estimatedPrice || d.price || 0,
      discount:     d.discount || 0,
      etd:          d.estimatedDate || null,
      codFee:       d.codFee || 0,
    };
  } catch (e) {
    console.warn('[Ongkir] estimateOngkir error:', e.message);
    return null;
  }
}

// ── 4. Format hasil ongkir menjadi teks siap kirim ke customer ────
// courierPriority: array nama kurir urutan prioritas (dari ENV atau settings)
function formatOngkirForCustomer(result, destName, courierPriority) {
  if (!result || !result.price) {
    return `Maaf Kak, tarif ke ${destName || 'lokasi tersebut'} belum bisa dicek otomatis saat ini. Hubungi admin ya untuk info ongkir 🙏`;
  }

  // Jika ada services array (multi-kurir), sort berdasarkan prioritas
  if (result.services && result.services.length > 1 && courierPriority?.length) {
    result.services.sort((a, b) => {
      const ai = courierPriority.findIndex(p => a.courier?.toLowerCase().includes(p.toLowerCase()));
      const bi = courierPriority.findIndex(p => b.courier?.toLowerCase().includes(p.toLowerCase()));
      const ra = ai === -1 ? 999 : ai;
      const rb = bi === -1 ? 999 : bi;
      return ra - rb || a.price - b.price;
    });
  }

  const harga = `Rp ${Number(result.price).toLocaleString('id-ID')}`;
  const etd = result.etd ? ` (${result.etd})` : '';
  const discount = result.discount > 0
    ? ` *(sudah diskon Rp ${Number(result.discount).toLocaleString('id-ID')})*` : '';

  return `Ongkir ke ${destName || 'lokasi kamu'} 📦\n• Tarif: ${harga}${etd}${discount}`;
}

// ── 5. Flow utama: dari tag content "kecamatan,kabupaten" ─────────
async function processCekOngkirTag(tagContent, itemValue, courierPriority) {
  const dest = parseShippingDestination(tagContent);
  if (!dest) {
    console.warn('[Ongkir] Tidak bisa parse tujuan dari:', tagContent);
    return null;
  }

  const keyword = `${dest.kecamatan} ${dest.kabupaten}`.trim();
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
    formatted: formatOngkirForCustomer(result, destLoc.name, courierPriority),
    destName:  destLoc.name,
    result,
  };
}

module.exports = {
  parseShippingDestination,
  searchLocationId,
  estimateOngkir,
  formatOngkirForCustomer,
  processCekOngkirTag,
};
