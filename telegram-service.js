/**
 * telegram-service.js  — P2-D
 * Layanan Telegram Bot untuk eskalasi pertanyaan customer WA ke admin.
 *
 * Flow:
 *   AI tidak tahu jawaban
 *     → notifyAdminViaTelegram(questions[])   # kirim daftar pertanyaan ke Telegram admin
 *     → Admin reply di Telegram (bisa swipe reply atau ketik biasa)
 *     → onReplyHandler dipanggil dengan { adminText }
 *     → server.js memanggil handleAdminEscalationAnswer(adminText)
 *
 * Module ini ditulis dalam CommonJS agar kompatibel dengan server.js.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { Bot } = require('grammy');
const fs   = require('fs');
const path = require('path');

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
const SESSIONS_FILE = path.join(__dirname, 'data', 'telegram_sessions.json');

// ── Session store sederhana (persisten ke JSON) ───────────────────
const sessionMap = new Map(); // telegramMsgId → { escalationIds, timestamp }

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) sessionMap.set(Number(k), v);
      console.log(`[Telegram] 📂 Memuat ${sessionMap.size} sesi eskalasi`);
    }
  } catch(e) { console.warn('[Telegram] Gagal load sesi:', e.message); }
}

function saveSessions() {
  try {
    const obj = {};
    for (const [k, v] of sessionMap.entries()) obj[k] = v;
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch(e) { console.warn('[Telegram] Gagal simpan sesi:', e.message); }
}

function cleanOldSessions(maxAgeMs = 48 * 60 * 60 * 1000) {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of sessionMap.entries()) {
    if (now - v.timestamp > maxAgeMs) { sessionMap.delete(k); changed = true; }
  }
  if (changed) saveSessions();
}

// ── Telegram Bot ─────────────────────────────────────────────────
let bot = null;
let isRunning = false;
let replyHandlers = []; // callback: async (adminText) => {}

function isConfigured() {
  return !!(BOT_TOKEN && ADMIN_CHAT_ID);
}

function init() {
  if (!BOT_TOKEN) {
    console.warn('[Telegram] ⚠️ TELEGRAM_BOT_TOKEN belum diisi di .env — eskalasi Telegram nonaktif');
    return false;
  }
  if (!ADMIN_CHAT_ID) {
    console.warn('[Telegram] ⚠️ TELEGRAM_ADMIN_CHAT_ID belum diisi di .env');
    return false;
  }
  try {
    bot = new Bot(BOT_TOKEN);
    setupHandlers();
    loadSessions();
    return true;
  } catch(e) {
    console.error('[Telegram] ❌ Gagal init bot:', e.message);
    return false;
  }
}

function setupHandlers() {
  // /start — info Chat ID
  bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.reply(
      `👋 <b>Bot WA Escalation aktif!</b>\n\n` +
      `🆔 <b>Chat ID kamu:</b> <code>${chatId}</code>\n\n` +
      `ℹ️ Setiap ada pertanyaan customer yang AI tidak tahu, ` +
      `notifikasi akan masuk ke sini.\n\n` +
      `👉 <b>Reply</b> pesan notifikasi untuk kirim jawaban ke customer WA.`,
      { parse_mode: 'HTML' }
    );
    console.log(`[Telegram] /start dari Chat ID: ${chatId}`);
  });

  // /id — cek chat ID
  bot.command('id', async (ctx) => {
    await ctx.reply(`🆔 Chat ID kamu: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
  });

  // Handler pesan teks masuk dari admin
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    const replyTo = ctx.message.reply_to_message;
    const fromChatId = String(ctx.chat.id);

    if (fromChatId !== String(ADMIN_CHAT_ID)) {
      await ctx.reply('⛔ Akun ini tidak terdaftar sebagai admin.');
      return;
    }

    console.log(`[Telegram] 📩 Pesan admin: "${text.slice(0, 80)}"`);

    // ── F2-C: Cek apakah reply ke pesan bukti transfer ──────────────
    if (replyTo?.message_id) {
      const session = sessionMap.get(replyTo.message_id);
      if (session?.type === 'transfer') {
        const textLower = text.trim().toLowerCase();
        const approved = /^(ok|oke|approve|approved|valid|confirm|konfirmasi|yes|iya|acc)$/i.test(textLower);
        const rejected = /^(reject|rejected|tolak|invalid|tidak|batal|cancel)$/i.test(textLower);

        if (approved || rejected) {
          for (const handler of transferApprovedHandlers) {
            try {
              await handler({
                customerPhone: session.customerPhone,
                customerName:  session.customerName,
                orderId:       session.orderId,
                approved:      approved,
                adminNote:     text,
              });
            } catch(e) {
              console.error('[Telegram] ❌ Error transfer approval handler:', e.message);
            }
          }

          await ctx.reply(
            approved
              ? `✅ <b>Transfer disetujui!</b>\nKonfirmasi sudah dikirim ke customer WA. 🎉`
              : `❌ <b>Transfer ditolak.</b>\nCustomer WA akan diminta transfer ulang.`,
            { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
          );
          return;
        }
      }
    }
    // ────────────────────────────────────────────────────────────────

    // Escalation reply biasa → teruskan ke replyHandlers
    for (const handler of replyHandlers) {
      try {
        await handler(text);
      } catch(e) {
        console.error('[Telegram] ❌ Error handler:', e.message);
      }
    }

    await ctx.reply(
      `✅ <b>Jawaban diterima!</b>\nSedang diproses dan diteruskan ke customer WA... 🚀`,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
    );
  });

  bot.catch((err) => {
    console.error('[Telegram] ❌ Bot error:', err.message);
  });
}

// ── Mulai polling ─────────────────────────────────────────────────
async function startPolling() {
  if (!bot && !init()) return false;
  if (isRunning) return true;
  try {
    bot.start({
      onStart: (info) => {
        isRunning = true;
        console.log(`[Telegram] ✅ Bot aktif: @${info.username}`);
      },
    });
    // Bersihkan sesi lama setiap 6 jam
    setInterval(() => cleanOldSessions(), 6 * 60 * 60 * 1000);
    return true;
  } catch(e) {
    console.error('[Telegram] ❌ Gagal start polling:', e.message);
    return false;
  }
}

// ── Kirim notifikasi eskalasi ke admin Telegram ───────────────────
// questions = array of { id, productTag, question, senderName }
async function notifyAdminEscalations(questions) {
  if (!bot && !init()) return { success: false, error: 'Bot tidak aktif' };
  if (!questions?.length) return { success: false, error: 'Tidak ada pertanyaan' };

  const timeStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const lines = questions.map(q =>
    `${q.id}. [<b>${q.productTag}</b>] dari <i>${q.senderName || 'Customer'}</i>:\n` +
    `   └ <code>${q.question}</code>`
  );

  const text =
    `🔔 <b>ESKALASI PERTANYAAN CUSTOMER WA</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏰ ${timeStr} WIB | ${questions.length} pertanyaan\n\n` +
    lines.join('\n\n') + '\n\n' +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👉 <b>Reply pesan ini</b> dengan jawaban berurutan sesuai nomor.\n` +
    `Contoh:\n<code>1. jawaban untuk pertanyaan 1\n2. jawaban untuk pertanyaan 2</code>`;

  try {
    const sent = await bot.api.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'HTML' });
    // Simpan mapping msgId → escalation IDs
    const session = {
      escalationIds: questions.map(q => q.id),
      timestamp: Date.now(),
    };
    sessionMap.set(sent.message_id, session);
    saveSessions();
    console.log(`[Telegram] 📤 Notifikasi terkirim (Msg ID: ${sent.message_id})`);
    return { success: true, messageId: sent.message_id };
  } catch(e) {
    console.error('[Telegram] ❌ Gagal kirim notifikasi:', e.message);
    return { success: false, error: e.message };
  }
}

// ── Daftarkan callback saat admin balas di Telegram ───────────────
// callback: async (adminText) => {}
function onReply(callback) {
  if (typeof callback === 'function') replyHandlers.push(callback);
}

// ── F2-B: Kirim bukti transfer (gambar) ke admin Telegram ─────────
// imagePath: path file lokal, order: { id, nama, produk, alamat, hp }
// Return: { success, messageId }
let transferApprovedHandlers = []; // callback: async ({ customerPhone, orderId, adminNote }) => {}

async function sendTransferProof({ imagePath, customerPhone, customerName, order }) {
  if (!bot && !init()) return { success: false, error: 'Bot tidak aktif' };

  const timeStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const caption =
    `💳 <b>BUKTI TRANSFER DITERIMA</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Nama:</b> ${customerName || order?.nama || '-'}\n` +
    `📱 <b>WA:</b> <code>${customerPhone}</code>\n` +
    `📦 <b>Produk:</b> ${order?.produk || '-'}\n` +
    `📍 <b>Alamat:</b> ${(order?.alamat || '-').slice(0, 100)}\n` +
    `⏰ <b>Waktu:</b> ${timeStr} WIB\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Reply <b>"ok"</b> atau <b>"approve"</b> untuk konfirmasi ke customer\n` +
    `❌ Reply <b>"reject"</b> untuk minta customer transfer ulang`;

  try {
    const { InputFile } = require('grammy');
    const sent = await bot.api.sendPhoto(ADMIN_CHAT_ID, new InputFile(imagePath), {
      caption,
      parse_mode: 'HTML',
    });

    // Simpan session: msgId → { type: 'transfer', customerPhone, orderId }
    sessionMap.set(sent.message_id, {
      type:          'transfer',
      customerPhone,
      customerName:  customerName || order?.nama,
      orderId:       order?.id || null,
      timestamp:     Date.now(),
    });
    saveSessions();

    console.log(`[Telegram] 💳 Bukti transfer terkirim ke admin (Msg ID: ${sent.message_id})`);
    return { success: true, messageId: sent.message_id };
  } catch(e) {
    console.error('[Telegram] ❌ Gagal kirim bukti transfer:', e.message);
    return { success: false, error: e.message };
  }
}

// ── F2-C: Daftarkan callback saat admin approve/reject transfer ────
function onTransferApproved(callback) {
  if (typeof callback === 'function') transferApprovedHandlers.push(callback);
}

// ── F5-B2: Kirim alert klaim garansi + foto ke admin Telegram ─────
// imagePath: path file lokal foto klaim (opsional)
// claim: { description, customerPhone, customerName, order }
async function sendClaimAlert({ imagePath, customerPhone, customerName, description, order }) {
  if (!bot && !init()) return { success: false, error: 'Bot tidak aktif' };

  const timeStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const caption =
    `⚠️ <b>KLAIM GARANSI MASUK</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Nama:</b> ${customerName || order?.nama || '-'}\n` +
    `📱 <b>WA:</b> <code>${customerPhone}</code>\n` +
    `📦 <b>Produk:</b> ${order?.produk || '-'}\n` +
    `📍 <b>Alamat:</b> ${(order?.alamat || '-').slice(0, 100)}\n` +
    `🔍 <b>Masalah:</b> ${description || 'tidak dijelaskan'}\n` +
    `⏰ <b>Waktu:</b> ${timeStr} WIB\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Harap verifikasi dan hubungi customer jika diperlukan.`;

  try {
    const { InputFile } = require('grammy');
    let sent;
    if (imagePath && require('fs').existsSync(imagePath)) {
      sent = await bot.api.sendPhoto(ADMIN_CHAT_ID, new InputFile(imagePath), {
        caption,
        parse_mode: 'HTML',
      });
    } else {
      // Kirim teks saja jika tidak ada foto
      sent = await bot.api.sendMessage(ADMIN_CHAT_ID, caption, { parse_mode: 'HTML' });
    }
    console.log(`[Telegram] ⚠️ Klaim garansi terkirim ke admin (Msg ID: ${sent.message_id})`);
    return { success: true, messageId: sent.message_id };
  } catch(e) {
    console.error('[Telegram] ❌ Gagal kirim klaim garansi:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = {
  isConfigured,
  startPolling,
  notifyAdminEscalations,
  sendTransferProof,
  sendClaimAlert,
  onTransferApproved,
  onReply,
};
