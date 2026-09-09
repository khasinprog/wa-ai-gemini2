/**
 * address-ai.js — AI-powered address extraction & COD check
 * Extracted from server.js (lines 4279-4416).
 *
 * Dependencies:
 *   ./state-store  — orders, settings, io, save, persistOrderToDB, PATHS.ORDER_FILE
 *   ./gemini-service — getAvailableKey()
 */

'use strict';

const store             = require('./state-store');
const { getAvailableKey } = require('./gemini-service');

// ── Komerce API config ──
// Priority: settings.json (dashboard) > env var > warning
function getKomerceKey() {
  const key = (store.settings.komerceApiKey || process.env.KOMERCE_API_KEY || '').trim();
  if (!key) console.warn('⚠️  [Komerce] API Key belum diisi — cek settings atau env KOMERCE_API_KEY');
  return key;
}
function getOriginId() {
  return (store.settings.originId || process.env.KOMERCE_ORIGIN_ID || '73528').trim();
}

// ── Provinsi yang dicover ID Express COD (berdasarkan jangkauan resmi ID Express) ──
// Sumber: https://idexpress.com/coverage
const IDE_COD_PROVINCES = [
  'ACEH', 'SUMATERA UTARA', 'SUMATERA BARAT', 'RIAU', 'KEPULAUAN RIAU',
  'JAMBI', 'BENGKULU', 'SUMATERA SELATAN', 'KEPULAUAN BANGKA BELITUNG', 'LAMPUNG',
  'BANTEN', 'DKI JAKARTA', 'JAWA BARAT', 'JAWA TENGAH', 'DI YOGYAKARTA', 'JAWA TIMUR',
  'BALI', 'NUSA TENGGARA BARAT',
  'KALIMANTAN BARAT', 'KALIMANTAN TENGAH', 'KALIMANTAN SELATAN', 'KALIMANTAN TIMUR', 'KALIMANTAN UTARA',
  'SULAWESI SELATAN', 'SULAWESI TENGGARA', 'SULAWESI TENGAH', 'SULAWESI UTARA', 'SULAWESI BARAT', 'GORONTALO',
];

function isIDECODCovered(provinceName) {
  if (!provinceName) return false;
  const p = provinceName.toUpperCase().trim();
  return IDE_COD_PROVINCES.some(prov => p.includes(prov) || prov.includes(p));
}

// ── Main function: AI address extraction & COD check ──
async function processOrderAddressAI(orderId) {
  const { orders, settings, io, save, persistOrderToDB, PATHS } = store;
  const order = orders.find(o => o.id === orderId);
  if (!order || !order.alamat) return;

  // Skip kalau konfigurasi pengiriman belum diisi (pakai fallback default)
  if (!(settings.komerceApiKey || '').trim()) {
    console.warn('⚠️ [AI Alamat] Komerce API Key belum diisi di settings — menggunakan key default. Isi di dashboard tab "Cek Resi" untuk key kustom.');
  }

  // BUG FIX #1: Gunakan getAvailableKey() agar ikut rotasi round-robin yang benar
  // dan tidak selalu pakai Key 1 saja.
  const picked = getAvailableKey();
  if (!picked) {
    console.warn('⏸️ [AI Alamat] Semua API key sedang kena limit, skip address processing.');
    return;
  }
  const key = picked.key;

  try {
    const model = settings.modelName || 'gemini-3.1-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const systemPrompt = `Kamu adalah asisten ekstraksi alamat pengiriman Indonesia. Dari teks alamat berikut, ekstrak informasi dan kembalikan HANYA JSON murni (tanpa markdown backticks, tanpa komentar) dengan struktur PERSIS ini:\n{"desa": "nama desa atau kelurahan saja (tanpa kata Desa/Kel)", "kecamatan": "nama kecamatan saja (tanpa kata Kec)", "kabupaten": "nama kabupaten atau kota (tanpa kata Kab/Kota)", "provinsi": "nama provinsi", "patokan": "nama jalan, nomor rumah, atau patokan lokasi jika ada — kosongkan jika tidak ada", "kodepos": "kode pos 5 digit jika ada — kosongkan jika tidak diketahui", "alamat_baku": "alamat lengkap rapi format: [patokan jika ada], Desa [desa], Kec [kecamatan], [kabupaten], [provinsi] [kodepos]"}\nJika ada informasi yang tidak tersedia dalam teks, isi dengan string kosong. Jangan mengarang informasi yang tidak ada.`;

    const body = {
      contents: [{ role: 'user', parts: [{ text: order.alamat }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.1 },
    };

    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
    if (!r.ok) return;

    const data = await r.json();
    let text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    // BUG FIX #2: Regex yang lebih robust untuk membersihkan markdown code block
    // Menangani pola: ```json\n...\n``` maupun ```\n...\n```
    text = text.trim().replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const parsed = JSON.parse(text);
    if (!parsed.desa || !parsed.kecamatan) return;
    if (!parsed.kabupaten) parsed.kabupaten = '';
    if (!parsed.patokan) parsed.patokan = '';
    if (!parsed.kodepos) parsed.kodepos = '';

    // Susun ai_alamat terstruktur: patokan + desa + kecamatan + kabupaten + provinsi + kodepos
    const parts_alamat = [
      parsed.patokan || null,
      `Kel/Desa ${parsed.desa}`,
      `Kec ${parsed.kecamatan}`,
      parsed.kabupaten,
      parsed.provinsi,
      parsed.kodepos
    ].filter(Boolean);
    order.ai_alamat = parts_alamat.join(', ') || parsed.alamat_baku || order.alamat;
    io.emit('order_updated', order); // update UI partially

    // Search RajaOngkir destination (gunakan desa + kecamatan untuk akurasi)
    const searchUrl = 'https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=' + encodeURIComponent(parsed.desa + ' ' + parsed.kecamatan) + '&limit=1';
    const destRes = await fetch(searchUrl, { headers: { 'key': getKomerceKey() } });
    const destData = await destRes.json();

    if (destData?.data && destData.data.length > 0) {
      const destObj = destData.data[0];
      const destId = destObj.id;
      const destProvince = destObj.province_name || '';
      const destCity = destObj.city_name || '';

      // Validasi coverage ID Express COD berdasarkan provinsi
      const isCovered = isIDECODCovered(destProvince);

      if (!isCovered) {
        // Provinsi di luar jangkauan COD ID Express sama sekali
        order.ai_cod = `❌ Tidak Tercover COD (${destCity}, ${destProvince})`;
      } else {
        // Check Cost for ID Express (hanya untuk provinsi yang covered)
        const costPayload = new URLSearchParams();
        costPayload.append('origin', getOriginId());
        costPayload.append('destination', destId);
        costPayload.append('weight', '1000');
        costPayload.append('courier', 'ide');
        costPayload.append('price', 'lowest');

        const costRes = await fetch('https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost', {
          method: 'POST',
          headers: { 'key': getKomerceKey(), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: costPayload.toString()
        });

        const costData = await costRes.json();
        const services = costData?.data || [];
        const hasValidService = services.some(d => d.cost > 0);

        if (hasValidService) {
          const cheapest = services.reduce((a, b) => a.cost < b.cost ? a : b);
          order.ai_cod = `✅ COD Bisa — ${destCity} (${cheapest.etd})`;
        } else {
          order.ai_cod = `❌ COD Tidak Bisa — ${destCity}, ${destProvince}`;
        }
      }
    } else {
      order.ai_cod = '⚠️ Area tidak tercover';
    }

    save(PATHS.ORDER_FILE, orders);
    persistOrderToDB(order);
    io.emit('order_updated', order);
  } catch (e) {
    console.error('AI Address Process Error:', e.message);
  }
}

module.exports = { processOrderAddressAI };
