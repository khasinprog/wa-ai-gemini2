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
  'JT': 'J&T',
  'iDexpress': 'ID Express',
  'iDlite': 'ID Express Lite',
  'JNE': 'JNE',
  'SiCepat': 'SiCepat',
  'SAP': 'SAP',
  'SAPLite': 'SAP Lite',
  'anteraja': 'Anteraja',
  'lion': 'Lion',
  'Ninja': 'Ninja',
  'pos': 'POS',
};

function formatOngkirForCustomer(result, destName) {
  if (!result || !result.price) {
    return `Maaf Kak, tarif ke ${destName || 'lokasi tersebut'} belum bisa dicek otomatis saat ini. Hubungi admin ya untuk info ongkir 🙏`;
  }

  const courierName = COURIER_DISPLAY_NAMES[result.courier] || result.courier;
  const harga = `Rp ${Number(result.price).toLocaleString('id-ID')}`;
  const etd = result.etd ? ` (${result.etd})` : '';
  const discount = result.discount > 0
    ? ` *(sudah diskon Rp ${Number(result.discount).toLocaleString('id-ID')})*` : '';

  let msg = `Ongkir ke ${destName || 'lokasi kamu'} 📦\n`;
  msg += `• ${courierName}: ${harga}${etd}${discount}`;

  // Tampilkan kurir lain (max 2 tambahan) sebagai alternatif
  if (result.allCouriers?.length > 1) {
    const others = result.allCouriers
      .filter(c => c.courier !== result.courier)
      .slice(0, 2);
    if (others.length) {
      msg += '\nAlternatif:';
      others.forEach(c => {
        const cName = COURIER_DISPLAY_NAMES[c.courier] || c.courier;
        msg += `\n• ${cName}: Rp ${Number(c.price).toLocaleString('id-ID')}`;
      });
    }
  }

  return msg;
}

// ── 5. Flow utama: dari tag content "kecamatan,kabupaten" ─────────
async function processCekOngkirTag(tagContent, itemValue) {
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
    formatted: formatOngkirForCustomer(result, destLoc.name),
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
