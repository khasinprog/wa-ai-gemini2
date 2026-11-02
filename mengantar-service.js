/**
 * mengantar-service.js
 * Integrasi resmi Mengantar API (app.mengantar.com) untuk order, pickup, tracking resi, dan label PDF.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const MENGANTAR_BASE = 'https://app.mengantar.com';
const MENGANTAR_API_KEY = (process.env.MENGANTAR_API_KEY || '').trim() || 'API-A44O3OQUZLDNWZNJ';
const MENGANTAR_ORIGIN_ID = process.env.MENGANTAR_ORIGIN_MONGO_ID || process.env.MENGANTAR_ORIGIN_ID || '5fc6491cf8f44b34aa4ce87b';

// Origin Toko (Khafa Store)
const SENDER_INFO = {
  name: 'Khafa Store',
  pic: 'Khasin Khafabi',
  phone: '081233350792',
  address: 'Jl. Garuda No.1784, RT.2/RW.17, Serua, Kec. Ciputat, Kota Tangerang Selatan, Banten 15414',
  originCode: 'TGR10000',
  addressId: '6a9f98c093b84c454903a71c',
};

/**
 * 1. Ambil semua pesanan dari akun Mengantar via Public API
 */
async function fetchMengantarOrders() {
  try {
    const url = `${MENGANTAR_BASE}/api/public/${MENGANTAR_API_KEY}/order`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.data || [];
  } catch (e) {
    console.warn('[Mengantar] fetchMengantarOrders error:', e.message);
    return [];
  }
}

/**
 * Normalisasi nomor HP untuk pencocokan (ambil 8-10 digit terakhir)
 */
function cleanPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length > 8 ? digits.slice(-9) : digits;
}

/**
 * 2. Sinkronkan daftar order lokal bot dengan data dari Mengantar
 */
async function syncOrdersWithMengantar(localOrders) {
  const mengantarOrders = await fetchMengantarOrders();
  if (!mengantarOrders.length) {
    return { syncedCount: 0, mengantarTotal: 0 };
  }

  let syncedCount = 0;

  for (const o of localOrders) {
    const oPhone = cleanPhone(o.hp);

    // Cari kecocokan di Mengantar
    const matched = mengantarOrders.find(m => {
      // Cocok ID Mengantar
      if (o.mengantar_order_id && String(m._id) === String(o.mengantar_order_id)) return true;
      // Cocok Nomor Resi
      if (o.no_resi && m.cnote_no && String(m.cnote_no).trim() === String(o.no_resi).trim()) return true;
      // Cocok Nomor HP customer
      if (oPhone && cleanPhone(m.RECEIVER_PHONE) === oPhone) return true;
      return false;
    });

    if (matched) {
      let changed = false;

      // Update No Resi
      if (matched.cnote_no && o.no_resi !== matched.cnote_no) {
        o.no_resi = matched.cnote_no;
        changed = true;
      }

      // Update Ekspedisi
      if (matched.courier && o.courier !== matched.courier) {
        o.courier = matched.courier;
        changed = true;
      }

      // Update Mengantar ID & PDF Label URL
      if (matched._id) {
        if (o.mengantar_order_id !== matched._id) {
          o.mengantar_order_id = matched._id;
          changed = true;
        }
        const pdfUrl = `${MENGANTAR_BASE}/print?ids=${matched._id}`;
        if (o.pdf_label_url !== pdfUrl) {
          o.pdf_label_url = pdfUrl;
          changed = true;
        }
      }

      // Update Posisi Tracking ("Sampai Mana")
      let trackText = '';
      let trackDate = '';
      if (matched.lastHistory) {
        const h = matched.lastHistory;
        trackText = h.desc || h.code || '';
        if (h.counter_name) trackText += ` (${h.counter_name})`;
        trackDate = h.date || '';
      } else if (matched.status) {
        trackText = `Status Mengantar: ${matched.status}`;
      }

      if (trackText && o.tracking_status !== trackText) {
        o.tracking_status = trackText;
        o.tracking_date = trackDate;
        changed = true;
      }

      // Update Pickup Status
      const newPickupStatus = matched.cnote_no ? 'picked_up' : (matched.pickupDate ? 'requested' : 'draft');
      if (o.pickup_status !== newPickupStatus) {
        o.pickup_status = newPickupStatus;
        changed = true;
      }

      // Update Status Order Bot jika di Mengantar sudah selesai / retur / batal
      const mStatus = (matched.status || '').toUpperCase();
      if (mStatus === 'DELIVERED' && o.status !== 'terkirim') {
        o.status = 'terkirim';
        changed = true;
      } else if (mStatus === 'RTS' && o.status !== 'retur') {
        o.status = 'retur';
        changed = true;
      } else if (mStatus === 'CANCELLED' && o.status !== 'batal') {
        o.status = 'batal';
        changed = true;
      } else if ((mStatus === 'ON_PROCESS' || matched.cnote_no) && (o.status === 'order' || o.status === 'baru')) {
        o.status = 'diproses';
        changed = true;
      }

      if (changed) syncedCount++;
    }
  }

  return { syncedCount, mengantarTotal: mengantarOrders.length };
}

/**
 * 3. Proses Request Pickup atau Simpan Draft Mengantar
 */
async function processOrderPickup(order, isTestingDraft = false) {
  const courier = order.courier || 'SPX';
  const metode = order.metode_pengiriman || order.payment_method || 'COD';

  if (isTestingDraft) {
    // Mode Draft / Testing: Buat resi simulasi dan preview label PDF
    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    const draftResi = `DFT-${courier.toUpperCase()}-${randomSuffix}`;
    const now = new Date();
    const dateStr = now.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

    order.courier = courier;
    order.metode_pengiriman = metode;
    order.no_resi = draftResi;
    order.pickup_status = 'draft';
    order.tracking_status = '📝 Draft Pesanan (Siap diverifikasi di Mengantar)';
    order.tracking_date = dateStr;
    order.pdf_label_url = `/api/orders/${order.id}/preview-label`;
    if (order.status === 'order' || order.status === 'baru') {
      order.status = 'diproses';
    }

    return {
      ok: true,
      isDraft: true,
      order,
      message: `Berhasil disimpan sebagai Draft (${courier}). Resi simulasi: ${draftResi}. Kurir belum dipanggil.`
    };
  }

  // Mode Live: Coba daftarkan ke Mengantar
  try {
    const url = `${MENGANTAR_BASE}/api/public/${MENGANTAR_API_KEY}/order`;
    const payload = {
      courier: courier.toLowerCase() === 'spx' ? 'spx' : (courier.toLowerCase() === 'sap' ? 'Sap' : courier),
      RECEIVER_NAME: order.nama,
      RECEIVER_PHONE: order.hp,
      RECEIVER_ADDR1: order.ai_alamat || order.alamat,
      GOODS_DESC: order.produk,
      GOODS_AMOUNT: 99000,
      COD_AMOUNT: metode.toUpperCase().includes('COD') ? 99000 : 0,
      TYPE: 'PICKUP',
      WEIGHT: 1,
      SHIPPER_NAME: SENDER_INFO.name,
      SHIPPER_PHONE: SENDER_INFO.phone,
      ORIGIN_CODE: SENDER_INFO.originCode,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok && data.success) {
      const created = data.data || {};
      order.mengantar_order_id = created._id || null;
      order.no_resi = created.cnote_no || order.no_resi || `MGT-${Date.now().toString().slice(-6)}`;
      order.pickup_status = 'requested';
      order.tracking_status = '🚚 Menunggu Kurir Pickup';
      order.tracking_date = new Date().toLocaleString('id-ID');
      order.pdf_label_url = created._id ? `${MENGANTAR_BASE}/print?ids=${created._id}` : `/api/orders/${order.id}/preview-label`;
      order.status = 'diproses';

      return {
        ok: true,
        order,
        message: `Pickup berhasil didaftarkan ke Mengantar (${courier})! No Resi: ${order.no_resi}`
      };
    } else {
      // Jika Mengantar mengembalikan error atau konfigurasi kurir belum lengkap
      console.warn('[Mengantar] Live API response:', data);

      // Simpan sebagai draft aman dan beri link verifikasi
      const randomSuffix = Math.floor(100000 + Math.random() * 900000);
      order.courier = courier;
      order.no_resi = order.no_resi || `MGT-${courier}-${randomSuffix}`;
      order.pickup_status = 'draft';
      order.tracking_status = '📝 Siap Pickup (Cek verifikasi di app.mengantar.com)';
      order.tracking_date = new Date().toLocaleString('id-ID');
      order.pdf_label_url = `/api/orders/${order.id}/preview-label`;
      order.status = 'diproses';

      return {
        ok: true,
        isDraft: true,
        order,
        message: `Order disimpan sebagai Draft Siap Kirim (${courier}). Silakan kroscek di app.mengantar.com.`
      };
    }
  } catch (e) {
    console.error('[Mengantar] processOrderPickup error:', e.message);
    // Fallback ke draft aman
    order.pickup_status = 'draft';
    order.no_resi = order.no_resi || `DFT-${courier}-${Date.now().toString().slice(-6)}`;
    order.pdf_label_url = `/api/orders/${order.id}/preview-label`;
    return {
      ok: true,
      isDraft: true,
      order,
      message: `Order disimpan sebagai Draft lokal. Error koneksi Mengantar: ${e.message}`
    };
  }
}

/**
 * 4. Generate HTML Label Pengiriman Standar Thermal (100mm x 100mm)
 */
function renderThermalLabelHtml(order) {
  const courier = (order.courier || 'SPX').toUpperCase();
  const resi = order.no_resi || `DRAFT-ORD-${order.id.slice(-6)}`;
  const isCOD = (order.metode_pengiriman || order.payment_method || 'COD').toUpperCase().includes('COD');
  const alamat = order.ai_alamat || order.alamat || '-';
  const orderDate = order.created_at ? new Date(order.created_at).toLocaleDateString('id-ID') : new Date().toLocaleDateString('id-ID');

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Label Pengiriman - ${resi}</title>
  <style>
    @page { size: 100mm 100mm; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background: #f1f5f9; display: flex; flex-direction: column; align-items: center; padding: 20px; }
    .no-print-bar { margin-bottom: 16px; display: flex; gap: 10px; }
    .btn-print { background: #2563eb; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 700; cursor: pointer; }
    .btn-close { background: #64748b; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 700; cursor: pointer; }
    
    .label-box {
      width: 100mm;
      min-height: 100mm;
      background: #fff;
      border: 2px solid #000;
      padding: 4mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #000;
      padding-bottom: 3mm;
    }
    .courier-title { font-size: 20px; font-weight: 900; letter-spacing: 1px; }
    .cod-badge {
      font-size: 14px;
      font-weight: 900;
      padding: 3px 8px;
      border: 2px solid #000;
      background: ${isCOD ? '#000' : '#fff'};
      color: ${isCOD ? '#fff' : '#000'};
    }
    .barcode-section {
      text-align: center;
      padding: 3mm 0;
      border-bottom: 1px dashed #000;
    }
    .barcode-lines {
      height: 38px;
      margin: 0 auto;
      letter-spacing: 4px;
      font-family: monospace;
      font-size: 28px;
      font-weight: 900;
      transform: scaleY(1.4);
    }
    .resi-text {
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 1.5px;
      margin-top: 4px;
    }
    .party-section {
      display: flex;
      border-bottom: 1px solid #000;
      padding: 3mm 0;
      gap: 3mm;
    }
    .receiver-box { flex: 1.5; border-right: 1px solid #000; padding-right: 2mm; }
    .sender-box { flex: 1; font-size: 9px; line-height: 1.3; }
    .section-title { font-size: 9px; font-weight: 800; text-transform: uppercase; margin-bottom: 2px; }
    .receiver-name { font-size: 12px; font-weight: 800; color: #000; margin-bottom: 2px; }
    .receiver-phone { font-size: 11px; font-weight: 700; margin-bottom: 3px; }
    .receiver-addr { font-size: 10px; line-height: 1.3; font-weight: 500; }
    
    .product-section {
      padding: 2mm 0;
      font-size: 10px;
      border-bottom: 1px dashed #000;
    }
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 9px;
      padding-top: 2mm;
    }

    @media print {
      body { background: transparent; padding: 0; }
      .no-print-bar { display: none !important; }
      .label-box { border: 1px solid #000; width: 100mm; height: 100mm; page-break-after: always; }
    }
  </style>
</head>
<body>

  <div class="no-print-bar">
    <button class="btn-print" onclick="window.print()">🖨️ Cetak Label (Print Thermal)</button>
    <button class="btn-close" onclick="window.close()">Tutup</button>
  </div>

  <div class="label-box">
    <div>
      <div class="header">
        <div class="courier-title">${courier} EXPRESS</div>
        <div class="cod-badge">${isCOD ? 'COD : Rp 99.000' : 'NON-COD (LUNAS)'}</div>
      </div>

      <div class="barcode-section">
        <div class="barcode-lines">||| | |||| || ||| |||| | ||</div>
        <div class="resi-text">${resi}</div>
      </div>

      <div class="party-section">
        <div class="receiver-box">
          <div class="section-title">PENERIMA:</div>
          <div class="receiver-name">${order.nama || 'Customer'}</div>
          <div class="receiver-phone">📞 ${order.hp || '-'}</div>
          <div class="receiver-addr">${alamat}</div>
        </div>
        <div class="sender-box">
          <div class="section-title">PENGIRIM:</div>
          <div style="font-weight:700;">${SENDER_INFO.name}</div>
          <div>📞 ${SENDER_INFO.phone}</div>
          <div style="margin-top:2px; color:#333;">Tangerang Selatan, Banten</div>
        </div>
      </div>

      <div class="product-section">
        <div style="font-weight:700;">Deskripsi Produk:</div>
        <div>${order.produk || 'Paket Pesanan'} (1 pcs - 1.0 kg)</div>
      </div>
    </div>

    <div class="footer">
      <div>ID: ORD-${order.id.slice(-6)} | Tgl: ${orderDate}</div>
      <div style="font-weight:700;">Mengantar Partner Logistics</div>
    </div>
  </div>

</body>
</html>`;
}

module.exports = {
  fetchMengantarOrders,
  syncOrdersWithMengantar,
  processOrderPickup,
  renderThermalLabelHtml,
  MENGANTAR_BASE,
  SENDER_INFO,
};

