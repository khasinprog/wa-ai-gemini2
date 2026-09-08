/**
 * message-postprocess.js — Post-process AI reply
 * Extract tags ([ORDER_DATA], [ESCALATE], etc), validate field order,
 * clean up reply before sending to customer.
 */

'use strict';

const config = require('./config');
const store  = require('./state-store');
const db     = require('./db');

// ── FIELD ORDER VALIDATION ────────────────────────────────────────
// Cegah AI menanyakan field yang sudah terisi
const FIELD_ORDER = [
  { key: 'jalan',      pattern: /(?:jalan|jl\.?|no\.?\s*\d|alamat|rumah|gang|gg\.?|komplek|perumahan)\b/i, get: s => s.jalan },
  { key: 'desa',       pattern: /(?:dusun|desa|kelurahan|kel\.|kampung)\b/i, get: s => s.desa },
  { key: 'rtRw',       pattern: /(?:rt|rw|rt\s*\/?\s*rw)\b/i, get: s => s.rtRw },
  { key: 'kecamatan',  pattern: /(?:kecamatan|kec\.?)\b/i, get: s => s.kecamatan },
  { key: 'kota',       pattern: /(?:kabupaten|kota|kab\.?)\b/i, get: s => s.kota },
  { key: 'patokan',    pattern: /(?:patokan|dekat|sebelah|samping)\b/i, get: s => s.patokan },
  { key: 'namaLengkap', pattern: /(?:nama\s+lengkap|nama\s+yang\s+lengkap|siapa\s+nama|nama\s+anda)\b/i, get: s => s.namaLengkap && s.namaVerified },
  { key: 'noHp',       pattern: /(?:nomor\s*(?:hp|wa|whatsapp)|no\.?\s*(?:hp|wa)|nomor\s+hp)\b/i, get: s => s.noHp },
];

const FIELD_LABELS = {
  jalan: 'nama jalan dan nomor rumah',
  desa: 'dusun atau desa',
  rtRw: 'RT dan RW',
  kecamatan: 'kecamatan',
  kota: 'kabupaten atau kota',
  patokan: 'patokan atau landmark terdekat',
  namaLengkap: 'nama lengkap',
  noHp: 'nomor HP yang aktif',
};

const REDIRECT_TEMPLATES = [
  'Baik Kak, untuk {label}-nya apa ya?',
  'Kalau {label}-nya gimana, Kak?',
  'Boleh diinfokan {label}-nya, Kak?',
  'Untuk {label}-nya apa ya, Kak?',
];

// Bersihkan pertanyaan field yang sudah terjawab dari history AI
function cleanFieldQuestions(aiReply, orderState) {
  if (!orderState || orderState.step < 3 || !aiReply) return aiReply;
  const fieldPatterns = [
    { pattern: /(?:rt|rw|rt\s*\/?\s*rw)\b/i, collected: () => orderState.rtRw },
    { pattern: /(?:dusun|desa|kelurahan|kel\.|kampung)\b/i, collected: () => orderState.desa },
    { pattern: /(?:kecamatan|kec\.?)\b/i, collected: () => orderState.kecamatan },
    { pattern: /(?:kabupaten|kota|kab\.?)\b/i, collected: () => orderState.kota },
    { pattern: /(?:patokan|dekat|sebelah|samping)\b/i, collected: () => orderState.patokan },
    { pattern: /(?:nama\s+lengkap|nama\s+yang\s+lengkap|siapa\s+nama)\b/i, collected: () => orderState.namaLengkap && orderState.namaVerified },
    { pattern: /(?:nomor\s*(?:hp|wa|whatsapp)|no\.?\s*(?:hp|wa))\b/i, collected: () => orderState.noHp },
  ];
  for (const { pattern, collected } of fieldPatterns) {
    if (pattern.test(aiReply) && collected()) return '[data sudah dicatat]';
  }
  return aiReply;
}

// Validasi: jika AI tanya field yang sudah terisi, redirect ke field berikutnya
function validateFieldOrder(aiReply, orderState) {
  if (!orderState || orderState.step < 3 || !aiReply) return aiReply;

  let asksAlreadyCollected = false;
  let matchedField = null;
  for (const { pattern, get, key } of FIELD_ORDER) {
    if (pattern.test(aiReply) && get(orderState)) {
      asksAlreadyCollected = true;
      matchedField = key;
      break;
    }
  }
  if (!asksAlreadyCollected) {
    console.log(`🔍 [VALIDATE] OK — reply tidak tanya field terisi: "${aiReply.slice(0, 60)}"`);
    return aiReply;
  }

  const missingField = FIELD_ORDER.find(f => !f.get(orderState));
  if (!missingField) return aiReply;

  const label = FIELD_LABELS[missingField.key] || missingField.key;
  const tpl = REDIRECT_TEMPLATES[Math.floor(Math.random() * REDIRECT_TEMPLATES.length)];
  const redirect = tpl.replace('{label}', label);

  console.log(`🔧 [FieldOrder] AI tanya field sudah terisi → redirect ke "${missingField.key}": ${redirect}`);
  return redirect;
}

// ── EXTRACT ORDER ─────────────────────────────────────────────────
function extractOrder(replyText, fromJid) {
  let cleanReply = replyText;
  const match = replyText.match(/\[ORDER_DATA\]([\s\S]*?)\[\/ORDER_DATA\]/);
  if (match) {
    try {
      const data = JSON.parse(match[1].trim());
      let hpValue = data.hp || '';
      if (/SAMA_DENGAN_WA/i.test(hpValue)) {
        hpValue = (fromJid || '').split('@')[0];
      }
      const order = {
        id: Date.now().toString() + Math.floor(Math.random() * 1000),
        jid: fromJid,
        nama: data.nama || '',
        hp: hpValue,
        produk: data.produk || '',
        alamat: data.alamat || '',
        payment_method: (data.pembayaran || '').toUpperCase().includes('TRANSFER') ? 'Transfer'
                      : (data.pembayaran || '').toUpperCase().includes('COD') ? 'COD' : null,
        status: 'order',
        timestamp: new Date().toISOString()
      };

      const missingFields = [];
      if (!order.nama?.trim() || order.nama.trim().length < 3) missingFields.push('nama');
      if (!order.produk?.trim()) missingFields.push('produk');
      if (!order.alamat?.trim() || order.alamat.trim().length < 10) missingFields.push('alamat');
      if (missingFields.length > 0) {
        console.warn(`⚠️ ORDER_DATA ditolak — field belum lengkap: ${missingFields.join(', ')} | dari: ${fromJid}`);
        cleanReply = replyText.replace(/\[ORDER_DATA\][\s\S]*?\[\/ORDER_DATA\]/g, '').trim();
        return cleanReply;
      }

      const isDuplicate = store.orders.some(o =>
        o.jid === fromJid &&
        o.produk === order.produk &&
        (Date.now() - new Date(o.timestamp).getTime() < config.ORDER_DEDUP_WINDOW_MS)
      );

      if (!isDuplicate) {
        store.orders.unshift(order);
        store.save(store.PATHS.ORDER_FILE, store.orders);
        store.persistOrderToDB(order);
        store.io?.emit('new_order', order);
        console.log('🛒 Order baru tertangkap:', order.nama);

        const _st = store.orderStates.get(fromJid);
        if (_st) {
          _st.step = 4;
          _st.orderConfirmed = true;
          _st.lastUpdate = Date.now();
          store.orderStates.set(fromJid, _st);
          // persistOrderState will be called by order-state module
          console.log(`📊 [Step] ${fromJid.slice(-4)}: →4 (ORDER_DATA diterima)`);
        }
        // Background process AI Address — will be called from server.js
        if (typeof store._processOrderAddressAI === 'function') {
          store._processOrderAddressAI(order.id);
        }
      } else {
        console.log('⚠️ Mengabaikan order duplikat dari:', order.nama);
      }
    } catch(e) {
      console.error('Gagal parse ORDER_DATA JSON:', e.message);
    }
    cleanReply = replyText.replace(/\[ORDER_DATA\][\s\S]*?\[\/ORDER_DATA\]/g, '').trim();
  }
  return cleanReply;
}

// ── EXTRACT ESCALATIONS ───────────────────────────────────────────
function extractEscalations(replyText, fromJid, senderName) {
  const regex = /\[ESCALATE:(.*?)\]([\s\S]*?)\[\/ESCALATE\]/gi;
  const found = [];
  let cleanReply = replyText.replace(regex, (match, tag, question) => {
    const item = {
      id: store.escalationCounter++,
      from: fromJid,
      senderName,
      productTag: (tag || 'UMUM').trim(),
      question: question.trim(),
      timestamp: new Date().toISOString(),
    };
    store.pendingEscalations.push(item);
    found.push(item);
    return '';
  });
  cleanReply = cleanReply.trim();
  cleanReply = cleanReply.replace(/\[ESCALATE:[^\]]*\][\s\S]*/gi, '').trim();
  if (found.length) {
    store.saveEscalations();
    store.io?.emit('escalations_updated', store.pendingEscalations);
    // Notify admin will be called from server.js
    if (typeof store._notifyAdminEscalations === 'function') {
      store._notifyAdminEscalations().catch(e => console.error('Gagal kirim notifikasi eskalasi:', e.message));
    }
  }
  return { cleanReply, escalations: found };
}

// ── APPEND FAQ TO KB ─────────────────────────────────────────────
function appendFaqToKB(productTag, question, answer) {
  const faqLine = `Q: ${question}\nA: ${answer}\n`;
  const kb = store.settings.knowledgeBase || '';
  const tagNorm = (productTag || '').trim().toLowerCase();

  if (tagNorm && tagNorm !== 'umum') {
    const blocks = kb.split(/^---$/m);
    let found = false;
    const newBlocks = blocks.map(block => {
      const headerMatch = block.match(/===\s*PRODUK:\s*(.+?)\s*===/i);
      if (!found && headerMatch && headerMatch[1].trim().toLowerCase() === tagNorm) {
        found = true;
        return block.replace(/\s*$/, '') + '\n' + faqLine;
      }
      return block;
    });
    if (found) {
      store.settings.knowledgeBase = newBlocks.join('---');
      store.save(store.PATHS.SET_FILE, store.settings);
      store.io?.emit('settings_updated', store.settings);
      return;
    }
  }

  const umumHeaderRegex = /===\s*INFO UMUM TOKO\s*===/i;
  if (umumHeaderRegex.test(kb)) {
    const blocks = kb.split(/^---$/m);
    const newBlocks = blocks.map(block => umumHeaderRegex.test(block) ? block.replace(/\s*$/, '') + '\n' + faqLine : block);
    store.settings.knowledgeBase = newBlocks.join('---');
  } else {
    const sep = kb.trim() ? '\n---\n' : '';
    store.settings.knowledgeBase = kb.trim() + sep + `=== INFO UMUM TOKO ===\n${faqLine}`;
  }
  store.save(store.PATHS.SET_FILE, store.settings);
  store.io?.emit('settings_updated', store.settings);
}

// ── BUILD ORDER SUMMARY ───────────────────────────────────────────
function buildOrderSummary(from) {
  const PAYMENT = {
    bankName:      process.env.PAYMENT_BANK_NAME      || '',
    accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER || '',
    accountName:   process.env.PAYMENT_ACCOUNT_NAME   || '',
  };
  const order = store.orders.find(o => o.jid === from || o.wa_id === from);
  if (!order) return null;

  const pay = order.payment_method || 'belum ditentukan';
  const payInfo = pay === 'Transfer'
    ? `💳 Transfer ke ${PAYMENT.bankName} ${PAYMENT.accountNumber} a.n. ${PAYMENT.accountName}`
    : `📦 COD (bayar saat paket tiba)`;

  return [
    `✅ *Rekap Pesananmu*`, ``,
    `👤 *Nama:* ${order.nama}`,
    `📦 *Produk:* ${order.produk}`,
    `📍 *Alamat:* ${order.alamat}`,
    `📱 *No. HP:* ${order.hp === 'SAMA_DENGAN_WA' ? '(sama dengan WhatsApp)' : order.hp}`,
    `💰 *Metode Bayar:* ${payInfo}`, ``,
    `🛡️ *Garansi Produk:* Jika ada kerusakan atau tidak sesuai, hubungi kami dalam 24 jam setelah paket diterima ya Kak — kami siap bantu 🙏`, ``,
    `📦 Pesanan akan segera kami proses & kirim. Kurir akan menghubungi kakak sebelum datang.`, ``,
    `Terima kasih sudah order di kami Kak! Semoga produknya sesuai harapan ya 😊`,
  ].join('\n');
}

module.exports = {
  FIELD_ORDER, FIELD_LABELS, REDIRECT_TEMPLATES,
  cleanFieldQuestions, validateFieldOrder,
  extractOrder, extractEscalations, appendFaqToKB,
  buildOrderSummary,
};
