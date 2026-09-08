/**
 * webhook-handler.js — Extracted webhook route handlers
 *
 * Registers:
 *   GET  /webhook          — Meta Cloud API verification handshake
 *   POST /webhook          — Meta Cloud API incoming events handler
 *   POST /webhook/wa-incoming — MacroDroid bridge incoming handler
 */

'use strict';

const crypto = require('crypto');
const config = require('./config');
const store  = require('./state-store');
const db     = require('./db');
const { sendWhatsAppText, markAsReadWithTyping, downloadAndSaveCustomerMedia, downloadAndSaveCustomerAudio, waConfigured } = require('./whatsapp-api');
const { processBufferedMessages, processCustomerMessage, isOpHour, isWhitelisted } = require('./message-processor');
const { handleAdminEscalationAnswer } = require('./admin-escalation');
const { buildHistory } = require('./chat-helpers');
const { aiReply, buildSystemPrompt } = require('./gemini-service');
const { validateFieldOrder, extractOrder } = require('./message-postprocess');

// ── Env vars ──────────────────────────────────────────────────────
const WEBHOOK_VERIFY_TOKEN  = process.env.WEBHOOK_VERIFY_TOKEN || '';
const META_APP_SECRET       = process.env.META_APP_SECRET || '';
const MACRODROID_BRIDGE_TOKEN = process.env.MACRODROID_BRIDGE_TOKEN || '';

// ── MacroDroid debounce buffer ────────────────────────────────────
const macrodroidBuffers = new Map();

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

// Normalisasi nomor Indonesia: ubah prefix 0xxx jadi 62xxx biar bisa dicocokkan
// dengan format JID WhatsApp (62xxx@s.whatsapp.net)
const { normalizeIdNumber } = require('./config');

// Normalisasi sender dari MacroDroid (bisa berupa nomor digit atau nama kontak)
function normalizeMacrodroidSender(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length >= 8) return normalizeIdNumber(digits);
  return (raw || '').trim();
}

// Cek apakah JID pengirim adalah nomor superadmin (untuk command on/off)
function isAdminNumber(fromJid) {
  if (!store.settings.adminNumber) return false;
  const adminNorm = normalizeIdNumber(store.settings.adminNumber);
  const fromNorm = (fromJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return adminNorm && fromNorm === adminNorm;
}

// Verifikasi X-Hub-Signature-256 dari Meta supaya payload webhook dipastikan asli
function isValidMetaSignature(req) {
  if (!META_APP_SECRET) return true; // belum diisi, skip (bisa jalan pas testing)
  const signatureHeader = req.get('X-Hub-Signature-256');
  if (!signatureHeader || !req.rawBody) return false;
  const expectedHash = crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  const expected = `sha256=${expectedHash}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Validasi struktur payload webhook Meta WhatsApp
function validateWebhookPayload(body) {
  if (!body || typeof body !== 'object') return false;
  if (!Array.isArray(body.entry)) return false;

  for (const entry of body.entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (!Array.isArray(entry.changes)) return false;

    for (const change of entry.changes) {
      if (!change || typeof change !== 'object') return false;
      if (!change.value || typeof change.value !== 'object') return false;
    }
  }
  return true;
}

// Dedup wamid — cek apakah pesan ini sudah pernah diproses
function isWamidProcessed(id) {
  if (!id) return false;
  if (store.processedWamidsSet.has(id)) return true;
  return false;
}

// Tandai wamid sudah diproses (in-memory + persist ke DB)
function markWamidProcessed(id) {
  if (!id) return;
  store.processedWamidsSet.add(id);
  store.processedWamids.push(id);
  if (store.processedWamids.length > config.DEDUP_CACHE_SIZE) {
    const old = store.processedWamids.shift();
    store.processedWamidsSet.delete(old);
  }
  db.saveProcessedWamid(id);
}

// ═══════════════════════════════════════════════════════════════════
// EXTRACT MESSAGE BODY by type
// ═══════════════════════════════════════════════════════════════════

function extractMessageBody(msg, from, wamid, contactName) {
  const pendingBuffers = store.pendingBuffers;

  if (msg.type === 'text') {
    return msg.text?.body || '';
  }

  if (msg.type === 'image') {
    const body = msg.image?.caption || '';
    if (msg.image?.id && wamid) {
      const mediaId = msg.image.id;
      const mimetype = msg.image?.mime_type || 'image/jpeg';
      // Fire-and-forget download gambar customer ke disk
      downloadAndSaveCustomerMedia(mediaId, wamid, mimetype)
        .catch(e => console.warn('[P2-A] download error:', e.message));
      // Simpan info gambar di buffer agar Gemini bisa membaca
      if (!pendingBuffers.has(from)) {
        pendingBuffers.set(from, { texts: [], lastWamid: wamid, senderName: contactName || from });
      }
      const imgBuf = pendingBuffers.get(from);
      imgBuf.mediaId = mediaId;
      imgBuf.mediaMime = mimetype;
      imgBuf.mediaWamid = wamid;
      if (!body.trim()) return '[gambar]';
    }
    return body;
  }

  if (msg.type === 'video') return msg.video?.caption || '';

  if (msg.type === 'button') return msg.button?.text || '';

  if (msg.type === 'interactive') {
    return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
  }

  if (msg.type === 'sticker') {
    console.log(`[P1-D] Stiker dari ${from}, dilewati`);
    return null; // null = skip (jangan diproses)
  }

  if (msg.type === 'reaction') {
    console.log(`[P1-D] Reaction dari ${from}, dilewati`);
    return null;
  }

  if (msg.type === 'audio' || msg.type === 'voice') {
    const body = '[Customer mengirim pesan suara. Dengarkan audio yang disertakan dan balas berdasarkan isi suaranya. Jika tidak bisa memahami, minta dengan sopan untuk mengetik ulang.]';
    if (msg.audio?.id && wamid) {
      const audioMimetype = msg.audio?.mime_type || 'audio/ogg';
      downloadAndSaveCustomerAudio(msg.audio.id, wamid, audioMimetype)
        .catch(e => console.warn('[P2-A2] audio download error:', e.message));
      if (!pendingBuffers.has(from)) {
        pendingBuffers.set(from, { texts: [], lastWamid: wamid, senderName: contactName || from });
      }
      const audioBuf = pendingBuffers.get(from);
      audioBuf.audioId = msg.audio.id;
      audioBuf.audioMime = audioMimetype;
      audioBuf.audioWamid = wamid;
    }
    return body;
  }

  if (msg.type === 'document') {
    return '[customer mengirim dokumen/file — mohon balas dengan sopan bahwa kamu hanya bisa menerima pesan teks atau foto produk, dan minta customer ketik ulang pertanyaannya]';
  }

  if (msg.type === 'location') {
    const lat = msg.location?.latitude;
    const lng = msg.location?.longitude;
    const locName = msg.location?.name || '';
    if (lat && lng) {
      return `[customer mengirim lokasi GPS: koordinat ${lat}, ${lng}${locName ? `, nama lokasi: ${locName}` : ''}. Gunakan info ini sebagai konfirmasi alamat pengiriman jika relevan, dan minta customer lengkapi dengan RT/RW, kelurahan, kecamatan, kota/kabupaten jika belum ada]`;
    }
    return '';
  }

  return '';
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Register all webhook routes on the Express app.
 *
 * @param {import('express').Application} app
 */
function registerWebhookRoutes(app) {

  // ─────────────────────────────────────────────────────────────────
  // 1. GET /webhook — Meta Cloud API verification handshake
  // ─────────────────────────────────────────────────────────────────
  app.get('/webhook', (req, res) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      console.log('Webhook diverifikasi oleh Meta');
      return res.status(200).send(challenge);
    }
    console.log('Verifikasi webhook gagal — token tidak cocok');
    return res.sendStatus(403);
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. POST /webhook — Meta Cloud API incoming events handler
  // ─────────────────────────────────────────────────────────────────
  app.post('/webhook', (req, res) => {
    // Balas 200 DULUAN secepatnya, biar Meta tidak anggap gagal & kirim ulang
    res.sendStatus(200);

    if (!isValidMetaSignature(req)) {
      console.log('Signature webhook tidak valid, payload dicurigai palsu — diabaikan');
      return;
    }

    if (!validateWebhookPayload(req.body)) {
      console.log('Payload webhook tidak valid (struktur tidak sesuai) — diabaikan');
      return;
    }

    try {
      const entryList = req.body.entry || [];
      for (const entry of entryList) {
        for (const change of (entry.changes || [])) {
          const value = change.value;
          if (!value) continue;

          const contactName = value.contacts?.[0]?.profile?.name;
          const msgs = value.messages;
          if (!msgs || !msgs.length) continue;

          for (const msg of msgs) {
            try {
              const from = msg.from;
              const wamid = msg.id;
              if (isWamidProcessed(wamid)) {
                console.log('Wamid sudah pernah diproses, skip:', wamid);
                continue;
              }
              markWamidProcessed(wamid);

              // Tandai dibaca (fire-and-forget)
              markAsReadWithTyping(wamid, false);

              // Extract body berdasarkan tipe pesan
              let body = extractMessageBody(msg, from, wamid, contactName);

              // null = skip (sticker, reaction, dll)
              if (body === null) continue;

              if (!body.trim()) {
                console.log(`Pesan tipe "${msg.type}" tanpa teks/caption, dilewati`);
                continue;
              }

              const senderName = contactName || from;
              console.log(`${senderName}: ${body}`);

              // ── Command superadmin: on/off ──
              if (isAdminNumber(from)) {
                const cmd = body.trim().toLowerCase();
                if (cmd === 'on' || cmd === 'off') {
                  store.settings.autoReply = (cmd === 'on');
                  store.save(store.PATHS.SET_FILE, store.settings);
                  store.io?.emit('settings_updated', store.settings);

                  const confirmText = store.settings.autoReply
                    ? 'Bot diaktifkan. Auto-reply AI menyala kembali.'
                    : 'Bot dimatikan. Auto-reply AI nonaktif, semua chat masuk perlu dibalas manual.';

                  sendWhatsAppText(from, confirmText).catch(e => console.error(e.message));
                  console.log(`Admin command: ${cmd.toUpperCase()} -> autoReply=${store.settings.autoReply}`);
                  continue;
                }
                // Bukan command on/off — jika ada pertanyaan pending, anggap ini
                // balasan borongan admin untuk eskalasi
                if (store.pendingEscalations.length > 0) {
                  handleAdminEscalationAnswer(body).catch(
                    e => console.error('Gagal proses balasan eskalasi admin:', e.message)
                  );
                  continue;
                }
              }

              // ── Stop chat per nomor ──
              if (store.settings.stoppedChats?.includes(from)) {
                console.log(`Chat ${senderName} (${from.slice(-4)}) di-stop — AI tidak memproses.`);
                continue;
              }

              // ── Buffer & debounce ──
              const pendingBuffers = store.pendingBuffers;
              const existing = pendingBuffers.get(from);
              if (existing) {
                existing.texts.push(body);
                existing.lastWamid = wamid;
                if (msg.type === 'image' && msg.image?.id) {
                  existing.mediaId = msg.image.id;
                  existing.mediaMime = msg.image?.mime_type || 'image/jpeg';
                  existing.mediaWamid = wamid;
                }
                if (msg.type === 'audio' && msg.audio?.id) {
                  existing.audioId = msg.audio.id;
                  existing.audioMime = msg.audio?.mime_type || 'audio/ogg';
                }
                console.log(`[Buffer] ${senderName}: "${body}" (pending: ${existing.texts.length})`);
              } else {
                pendingBuffers.set(from, { texts: [body], lastWamid: wamid, senderName });
                console.log(`[Buffer] ${senderName}: "${body}" (pending: 1)`);
              }

              // Mulai proses jika belum ada yang proses
              if (!store.activeProcessing.has(from)) {
                processBufferedMessages(from).catch(
                  e => console.error('Buffer error:', e.message)
                );
              }

            } catch (e) {
              console.error('Msg error:', e.message);
            }
          }
        }
      }
    } catch (e) {
      console.error('Webhook parse error:', e.message);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. POST /webhook/wa-incoming — MacroDroid bridge incoming handler
  // ─────────────────────────────────────────────────────────────────
  app.post('/webhook/wa-incoming', async (req, res) => {
    try {
      if (MACRODROID_BRIDGE_TOKEN && req.headers['x-bridge-token'] !== MACRODROID_BRIDGE_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized: X-Bridge-Token tidak cocok' });
      }
      if (store.settings.channel !== 'macrodroid') {
        return res.status(409).json({
          error: 'Channel MacroDroid tidak sedang aktif. Aktifkan dulu di dashboard (Channel Pengiriman).',
        });
      }

      const { sender, message, senderName } = req.body || {};
      if (!sender || !message) return res.status(400).json({ error: 'Isi sender dan message' });

      const from = normalizeMacrodroidSender(sender);
      const name = (senderName || sender || '').toString();
      console.log(`[MacroDroid] ${name}: ${message}`);

      if (!store.settings.autoReply || !isOpHour() || !isWhitelisted(from)) {
        return res.json({ reply: null, skipped: true });
      }

      // Command superadmin: on/off
      if (isAdminNumber(from)) {
        const cmd = String(message).trim().toLowerCase();
        if (cmd === 'on' || cmd === 'off') {
          store.settings.autoReply = (cmd === 'on');
          store.save(store.PATHS.SET_FILE, store.settings);
          store.io?.emit('settings_updated', store.settings);
          const confirmText = store.settings.autoReply
            ? 'Bot diaktifkan. Auto-reply AI menyala kembali.'
            : 'Bot dimatikan. Auto-reply AI nonaktif, semua chat masuk perlu dibalas manual.';
          console.log(`Admin command (MacroDroid): ${cmd.toUpperCase()} -> autoReply=${store.settings.autoReply}`);
          return res.json({ reply: confirmText });
        }
      }

      // Buffer/debounce: tumpuk pesan berurutan dari sender yang sama
      const existing = macrodroidBuffers.get(from);
      if (existing) {
        clearTimeout(existing.timer);
        existing.texts.push(String(message));
        // Selesaikan request LAMA yang tertumpuk
        if (existing.pendingRes) {
          try { existing.pendingRes.json({ reply: null, buffered: true }); } catch (e) {}
        }
      }
      const buffer = existing || { texts: [String(message)] };
      buffer.senderName = name;
      buffer.pendingRes = res;
      const debounceMs = Math.max(1, Number(store.settings.debounceSeconds) || 6) * 1000;
      buffer.timer = setTimeout(() => flushMacrodroidBuffer(from), debounceMs);
      macrodroidBuffers.set(from, buffer);
    } catch (e) {
      console.error('MacroDroid webhook error:', e.message);
      try { res.status(500).json({ error: e.message }); } catch (e2) {}
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// FLUSH MACRODROID BUFFER (debounced message processing)
// ═══════════════════════════════════════════════════════════════════

async function flushMacrodroidBuffer(from) {
  const buffer = macrodroidBuffers.get(from);
  if (!buffer) return;
  macrodroidBuffers.delete(from);

  const combinedBody = buffer.texts.join('\n');
  const finalRes = buffer.pendingRes;
  const senderName = buffer.senderName || from;

  // Create & persist message entry
  const entry = {
    id: Date.now(), from, senderName, body: combinedBody, wamid: null,
    timestamp: new Date().toISOString(), replied: false, aiReply: null, channel: 'macrodroid',
  };
  store.messages.unshift(entry);
  if (store.messages.length > config.MESSAGE_LIMIT) {
    store.messages = store.messages.slice(0, config.MESSAGE_LIMIT);
  }
  store.save(store.PATHS.MSG_FILE, store.messages);
  store.persistMessageToDB(entry);

  // IMP-4A: orderStep untuk dashboard badge (MacroDroid channel)
  entry.orderStep = store.orderStates.get(from)?.step || null;
  store.io?.emit('new_message', entry);

  // Antre per-pengirim (sama dengan Cloud API supaya tidak ada dua
  // balasan AI yang berjalan bersamaan untuk kontak yang sama)
  const prevTask = store.userLocks.get(from) || Promise.resolve();
  const nextTask = prevTask.then(async () => {
    if (entry.replied) return;

    const history = buildHistory(from, entry.id);

    let reply = await aiReply(combinedBody, senderName, history, null, from);

    // RC-5: Validasi field order di MacroDroid path
    if (reply) {
      const macroState = store.orderStates.get(from);
      if (macroState && macroState.step >= 3) {
        reply = validateFieldOrder(reply, macroState);
      }
    }

    if (!reply) {
      store.save(store.PATHS.MSG_FILE, store.messages);
      store.persistMessageToDB(entry);
      console.log('[MacroDroid] AI tidak membalas (cek error/quota di atas)');
      try { finalRes.json({ reply: null, error: 'AI tidak membalas, cek quota/log server' }); } catch (e) {}
      return;
    }

    // extractOrder — tarik data order dari tag [ORDER_DATA]
    reply = extractOrder(reply, from);

    let cleanReply = reply;

    // Kumpulkan gambar produk yang diminta via [KIRIM_GAMBAR:X] tag
    const imgMatches = [...reply.matchAll(/\[KIRIM_GAMBAR:(.*?)\]/gi)];
    const productsToImage = [];
    for (const match of imgMatches) {
      productsToImage.push(match[1].trim());
      cleanReply = cleanReply.replace(match[0], '').trim();
    }

    // Dedupe product images — skip yang sudah pernah dikirim di percakapan ini
    const imageUrls = [];
    for (const p of productsToImage) {
      if (store.sentProductImages.get(from)?.has(p)) continue;
      const files = store.settings.productImages?.[p];
      let anySent = false;
      if (files) for (const f of files) if (f) { imageUrls.push(`/images/${f}`); anySent = true; }
      if (anySent) {
        if (!store.sentProductImages.has(from)) store.sentProductImages.set(from, new Set());
        store.sentProductImages.get(from).add(p);
      }
    }

    // [SPLIT] tag → newline (MacroDroid tidak bisa kirim multi-bubble terpisah)
    let finalCleanReply = cleanReply.replace(/\[SPLIT\]/gi, '\n').replace(/\n{3,}/g, '\n\n').trim();

    // DRAFT MODE: Step >= 4 ATAU ada [DRAFT_ONGKIR] tag → simpan draft
    const _macroStep = store.orderStates.get(from)?.step || 1;
    const _hasMacroDraftTag = finalCleanReply.includes('[DRAFT_ONGKIR]') || finalCleanReply.includes('[DRAFT_REKAP]');
    if (_macroStep >= 4 || _hasMacroDraftTag) {
      finalCleanReply = finalCleanReply.replace(/\[DRAFT_REKAP\]/gi, '').replace(/\[DRAFT_ONGKIR\]/gi, '').trim();
      entry.aiReplyDraft = finalCleanReply;
      entry.draftStatus = 'pending';
      entry.replied = true;
      entry.aiReply = null;
      store.save(store.PATHS.MSG_FILE, store.messages);
      store.persistMessageToDB(entry);
      store.io?.emit('message_updated', entry);
      console.log(`[DRAFT MacroDroid] ${senderName}: ${finalCleanReply.slice(0, 80)}...`);
      try { finalRes.json({ reply: null, draft: true }); } catch (e) {}
      return;
    }

    // Final reply
    entry.replied = true;
    entry.aiReply = finalCleanReply;
    store.save(store.PATHS.MSG_FILE, store.messages);
    store.persistMessageToDB(entry);
    store.io?.emit('message_updated', entry);
    console.log(`AI (MacroDroid) -> ${senderName}: ${finalCleanReply}`);

    try { finalRes.json({ reply: finalCleanReply, images: imageUrls }); } catch (e) {}
  }).catch(e => {
    console.error('MacroDroid flush error:', e.message);
    try { finalRes.json({ reply: null, error: e.message }); } catch (e2) {}
  }).finally(() => {
    // Bersihkan lock kalau tidak ada task pending baru dari nomor ini
    if (store.userLocks.get(from) === nextTask) store.userLocks.delete(from);
  });
  store.userLocks.set(from, nextTask);
}

module.exports = { registerWebhookRoutes };
