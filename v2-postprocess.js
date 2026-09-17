/**
 * v2-postprocess.js — V2 Response Style Postprocess
 *
 * Menangani FIXED template responses untuk intent-intent v2.
 * Antara Chatter output dan existing postprocess.
 *
 * Flow: Chatter(Gemini) -> [v2-postprocess] -> existing postprocess(tags, etc)
 */

'use strict';

// ── Payment config ──────────────────────────────────────────────────
const PAYMENT = {
  bankName:      process.env.PAYMENT_BANK_NAME      || 'Mandiri',
  accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER || '1240011135580',
  accountName:   process.env.PAYMENT_ACCOUNT_NAME   || 'Khasin Khafabi',
};

// ── V2 Fixed Templates ──────────────────────────────────────────────
// type: 'fixed' = template = jawaban lengkap (Gemini output diabaikan)
//       'hybrid' = template punya {s1} placeholder, kalimat pertama Gemini di-splice
//       'prefix' = template ditambah di depan Gemini output
//       'none' = tidak ada override, existing behavior

const V2_TEMPLATES = {

  // ── Pilih variasi ────────────────────────────────────────────────
  customer_pilihvariasi: {
    type: 'fixed',
    template: `Oke Kak, {variasi} dicatat ya!\n\nBoleh dibantu alamat lengkapnya Kak, meliputi nama jalan/perumahan, nomor rumah, RT/RW, dusun (jika ada), desa/kelurahan, kecamatan, dan kabupaten/kota?`,
  },

  // ── Alamat — RT/RW belum ada ─────────────────────────────────────
  Alamat_lengkap_noRTRW: {
    type: 'fixed',
    template: `Boleh minta RT/RW nya Kak? Kalau memang tidak ada tidak apa-apa ya.`,
  },

  // ── Alamat — RT/RW sudah ada, tanya patokan ──────────────────────
  Alamat_lengkap_hasRTRW: {
    type: 'fixed',
    template: `Siap Kak, sudah dicatat ya.\n\nBoleh dibantu patokan rumahnya Kak? Misalnya dekat sekolah, toko, atau masjid/tempat ibadah gitu ya Kak, biar kurir gampang nyarinya.`,
  },

  // ── Patokan sudah ada, tanya nama ────────────────────────────────
  Alamat_patokan: {
    type: 'fixed',
    template: `Nama penerima produk atas nama siapa ya Kak? Nama lengkap ya Kak.`,
  },

  // ── Nama sudah ada, tanya nomor HP ───────────────────────────────
  Terkait_namaCustomer: {
    type: 'fixed',
    template: `Untuk nomor telepon yang bisa dihubungi kurir, boleh pakai nomor WA ini Kak? Atau ada nomor lain ya Kak?`,
  },

  NomorCustomer: {
    type: 'fixed',
    template: `Untuk pembayarannya Kak, mau pilih COD atau Transfer? Kalau transfer ada diskon 10% dari harga normal ya Kak 😊`,
  },

  // ── Pilih COD ────────────────────────────────────────────────────
  Terkait_pilihan_pembayaran_COD: {
    type: 'fixed',
    template: `Baik Kak, untuk COD aturannya dari ekspedisi paket tidak bisa dibuka sebelum dibayar ya Kak.\n\nTapi tenang, kalau produk tidak sesuai Kakak bisa ajukan pengiriman ulang atau pengembalian dana kok.\n\nKakak setuju ya Kak?`,
  },

  // ── Customer setuju aturan COD → tampilkan rekap pesanan ─────────
  Terkait_setuju_COD: {
    type: 'fixed',
    template: `Baik Kak, berikut ringkasan pesanan Kakak ya.\n\n🛍️ Produk: {produk} - {variasi}\n📍 Alamat: {alamat_lengkap}\n🏘️ RT/RW: {rt_rw}\n🏠 Patokan: {patokan}\n👤 Nama Penerima: {nama}\n📱 Nomor Telepon: {nomor}\n💳 Pembayaran: COD\n\nMohon dicek kembali ya Kak, kalau sudah sesuai kami proses ya Kak.`,
  },

  // ── Pilih Transfer ───────────────────────────────────────────────
  Terkait_pilihan_pembayaran_Transfer: {
    type: 'fixed',
    template: `Baik Kak, untuk transfer bisa ke rekening berikut ya Kak.\n\nBank {bank_name} - {account_number} a/n {account_name}\n\nNanti kami kirimkan ringkasan pesanan dulu ya Kak, setelah Kakak konfirmasi baru transfer.`,
  },

  // ── Customer balas setelah terima info rekening → tampilkan rekap ─
  Terkait_konfirmasi_Transfer: {
    type: 'fixed',
    template: `Baik Kak, berikut ringkasan pesanan Kakak ya.\n\n🛍️ Produk: {produk} - {variasi}\n📍 Alamat: {alamat_lengkap}\n🏘️ RT/RW: {rt_rw}\n🏠 Patokan: {patokan}\n👤 Nama Penerima: {nama}\n📱 Nomor Telepon: {nomor}\n💳 Pembayaran: Transfer\n\nMohon dicek kembali ya Kak, kalau sudah sesuai kami kirimkan ringkasan untuk proses transfer ya Kak.`,
  },

  // ── Verifikasi / Rekap ───────────────────────────────────────────
  Verifikasi: {
    type: 'fixed',
    template: `Baik Kak, berikut ringkasan pesanan Kakak ya.\n\n🛍️ Produk: {produk} - {variasi}\n📍 Alamat: {alamat_lengkap}\n🏘️ RT/RW: {rt_rw}\n🏠 Patokan: {patokan}\n👤 Nama Penerima: {nama}\n📱 Nomor Telepon: {nomor}\n💳 Pembayaran: {pembayaran}\n\nMohon dicek kembali ya Kak, kalau sudah sesuai kami proses ya Kak.`,
  },

  // ── Customer konfirmasi order (step 4, rekap sudah ditampilkan) ──
  customer_konfirmasi_order: {
    type: 'fixed',
    template: `Siap Kak, pesanan Kakak sedang kami proses ya. Mohon ditunggu info selanjutnya.`,
  },

  // ── Customer ragu ────────────────────────────────────────────────
  customer_ragu: {
    type: 'fixed',
    template: `Tidak apa-apa Kak, kalau ada yang ingin ditanyakan atau dipertimbangkan boleh tanya dulu ya.`,
  },

  // ── Customer batal ───────────────────────────────────────────────
  customer_batal: {
    type: 'fixed',
    template: `Tidak apa-apa Kak, terima kasih sudah mampir ya. Kalau sewaktu-waktu tertarik boleh hubungi kami lagi Kak.`,
  },

  // ── Customer pilih produk baru ───────────────────────────────────
  customer_pilihproduk_baru: {
    type: 'hybrid',
    template: `{s1}`,
  },

  // ── Lain (draft ke admin) ────────────────────────────────────────
  Lain: {
    type: 'prefix',
    template: `[DRAFT - PERLU APPROVE ADMIN] {s1}`,
  },

  // ── Ada di KB ────────────────────────────────────────────────────
  Ada_di_KB: {
    type: 'none', // tidak ada override, existing behavior
  },
};

// ── V2 Chatter Hints ────────────────────────────────────────────────
// Instruksi singkat untuk Chatter agar tahu apa yang harus di-generate

const V2_CHATTER_HINTS = {
  customer_pilihvariasi:
    'Tulis 1 kalimat: minta alamat lengkap (nama jalan, nomor rumah, kelurahan, kecamatan, kota).',
  Alamat_lengkap_noRTRW:
    'Tidak perlu menulis apapun. Template sudah disediakan.',
  Alamat_lengkap_hasRTRW:
    'Tulis 1 kalimat: minta patokan rumah (dekat masjid, sekolah, warung, dll).',
  Alamat_patokan:
    'Tidak perlu menulis apapun. Template sudah disediakan.',
  Terkait_namaCustomer:
    'Tidak perlu menulis apapun. Template sudah disediakan.',
  NomorCustomer:
    'Tulis 1 kalimat: tanya metode pembayaran (COD atau Transfer), sebutkan diskon 10% untuk transfer.',
  Terkait_pilihan_pembayaran_COD:
    'Tidak perlu menulis apapun. Template sudah disediakan.',
  Terkait_setuju_COD:
    'Tidak perlu menulis apapun. Template rekap pesanan sudah disediakan. JANGAN tulis apapun.',
  Terkait_pilihan_pembayaran_Transfer:
    'Tidak perlu menulis apapun. Template sudah disediakan.',
  Terkait_konfirmasi_Transfer:
    'Tidak perlu menulis apapun. Template rekap pesanan sudah disediakan. JANGAN tulis apapun.',
  Verifikasi:
    'Tidak perlu menulis apapun. Template sudah disediakan.',
  customer_konfirmasi_order:
    'Tulis 1 kalimat: konfirmasi pesanan sedang diproses. WAJIB sisipkan blok [ORDER_DATA]...[/ORDER_DATA] dengan data lengkap (nama, hp, produk, alamat, pembayaran).',
  customer_ragu:
    'Tidak perlu menulis apapun. Template sudah disediakan.',
  customer_batal:
    'Tidak perlu menulis apapun. Template sudah disediakan.',
  customer_pilihproduk_baru:
    'Jelaskan produk baru dari Knowledge Base. Maks 2 kalimat.',
  Lain:
    'Tulis 1-2 kalimat jawaban natural untuk pertanyaan di luar flow. Jangan mengarang informasi yang tidak ada di KB.',
  Ada_di_KB:
    'Ikuti STEP rules yang berlaku.',
};

// ── Placeholder Mapping ─────────────────────────────────────────────

function resolvePhone(orderState, from) {
  if (!orderState?.noHp) return '...';
  if (orderState.noHp === 'SAMA_DENGAN_WA') {
    // Resolve nomor WA dari JID (format: 628xxx@s.whatsapp.net)
    if (from) {
      return from.replace('@s.whatsapp.net', '').replace('@c.us', '');
    }
    return '(nomor WA)';
  }
  return orderState.noHp;
}

function resolveAddress(orderState) {
  if (!orderState) return '...';
  const parts = [
    orderState.jalan,
    orderState.rtRw,
    orderState.dusun,
    orderState.desa,
    orderState.kecamatan,
    orderState.kota,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '...';
}

function resolvePayment(thinkerData, orderState) {
  // Cek dari extracted data dulu
  const fromData = thinkerData?.extractedData?.payment_method
    || thinkerData?.extractedData?.pembayaran;
  if (fromData) return fromData;

  // Cek dari order state (kalau sudah ada)
  if (orderState?.paymentMethod) return orderState.paymentMethod;

  return '...';
}

function fillPlaceholders(template, thinkerData, orderState, from) {
  const data = thinkerData?.extractedData || {};

  const replacements = {
    '{variasi}':      data.color || data.warna || orderState?.color || '...',
    '{produk}':       thinkerData?.product || orderState?.product || '...',
    '{nama}':         data.nama || orderState?.namaLengkap || '...',
    '{alamat_lengkap}': resolveAddress(orderState),
    '{rt_rw}':        data.rtRw || orderState?.rtRw || 'Tidak ada',
    '{patokan}':      data.patokan || orderState?.patokan || 'Tidak ada',
    '{nomor}':        resolvePhone(orderState, from),
    '{pembayaran}':   resolvePayment(thinkerData, orderState),
    '{bank_name}':    PAYMENT.bankName,
    '{account_number}': PAYMENT.accountNumber,
    '{account_name}': PAYMENT.accountName,
  };

  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }

  return result;
}

// ── Extract first sentence from Gemini reply ────────────────────────
// Untuk hybrid templates: ambil kalimat pertama sebagai {s1}

function extractFirstSentence(reply) {
  if (!reply) return '';

  // DISABLED: regex terlalu mudah salah split
  // Return seluruh reply — Gemini sudah dikontrol via Chatter prompt
  return reply.trim();
}

// ── Extract [ORDER_DATA] block from Gemini reply ──────────────────
// Penting: FIXED template mengganti seluruh reply, tapi ORDER_DATA harus tetap ada

function extractOrderDataBlock(reply) {
  if (!reply) return '';
  const match = reply.match(/\[ORDER_DATA\]([\s\S]*?)\[\/ORDER_DATA\]/);
  return match ? match[0] : '';
}

// ── Main postprocess function ───────────────────────────────────────

function postprocessV2Reply(reply, thinkerData, orderState, settings, from) {
  // Kill switch: kalau v2 off, skip
  if (!settings?.v2ResponseStyle) {
    return { reply, usedV2: false };
  }

  // Cari template untuk intent ini
  const templateConfig = V2_TEMPLATES[thinkerData?.intent];

  // Kalau tidak ada template atau type = 'none', skip
  if (!templateConfig || templateConfig.type === 'none') {
    return { reply, usedV2: false };
  }

  const { type, template } = templateConfig;

  // ── FIXED: template = jawaban lengkap ──────────────────────────
  if (type === 'fixed') {
    const filled = fillPlaceholders(template, thinkerData, orderState, from);
    // Kalau placeholder kritis masih '...', fallback ke Gemini
    if (filled.includes('...')) {
      console.log(`[V2] Placeholder incomplete for ${thinkerData.intent}, falling back to Gemini`);
      return { reply, usedV2: false };
    }
    // Preserve [ORDER_DATA] block dari Gemini reply (agar order tetap dibuat)
    const orderDataBlock = extractOrderDataBlock(reply);
    return { reply: filled + (orderDataBlock ? '\n\n' + orderDataBlock : ''), usedV2: true };
  }

  // ── HYBRID: splice kalimat pertama Gemini ke {s1} ─────────────
  if (type === 'hybrid') {
    const firstSentence = extractFirstSentence(reply);
    const filled = fillPlaceholders(
      template.replace('{s1}', firstSentence || reply),
      thinkerData,
      orderState,
      from
    );
    // Preserve [ORDER_DATA] block dari Gemini reply
    const orderDataBlock = extractOrderDataBlock(reply);
    return { reply: filled + (orderDataBlock ? '\n\n' + orderDataBlock : ''), usedV2: true };
  }

  // ── PREFIX: tambahkan di depan Gemini output ───────────────────
  if (type === 'prefix') {
    const firstSentence = extractFirstSentence(reply);
    const filled = fillPlaceholders(
      template.replace('{s1}', firstSentence || reply),
      thinkerData,
      orderState,
      from
    );
    return { reply: filled, usedV2: true };
  }

  return { reply, usedV2: false };
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  V2_TEMPLATES,
  V2_CHATTER_HINTS,
  postprocessV2Reply,
  fillPlaceholders,
  extractFirstSentence,
  extractOrderDataBlock,
};
