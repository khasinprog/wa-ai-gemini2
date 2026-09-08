/**
 * message-processor.js — Chat processing pipeline
 * Process customer messages, build history, manage AI reply flow.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const config = require('./config');
const store  = require('./state-store');
const db     = require('./db');
const { buildHistory, buildConversationSummary, getReplyDelayMs } = require('./chat-helpers');
const { classifyIntent } = require('./gemini-thinker');
const { getRelevantKnowledge } = require('./knowledge-base');
const { updateOrderState, createOrderState } = require('./order-state');
const { aiReply, buildSystemPrompt } = require('./gemini-service');
const { cleanFieldQuestions, validateFieldOrder, extractOrder, extractEscalations, buildOrderSummary } = require('./message-postprocess');
const { markAsReadWithTyping, sendWhatsAppText, sendWhatsAppImageByPath, downloadAndSaveCustomerMedia, downloadAndSaveCustomerAudio } = require('./whatsapp-api');
const scheduler = require('./followup-scheduler');

// ── Product image dedup (in-memory) ──
function hasSentProductImage(from, productName) {
  return store.sentProductImages.get(from)?.has(productName) || false;
}
function markProductImageSent(from, productName) {
  if (!store.sentProductImages.has(from)) store.sentProductImages.set(from, new Set());
  store.sentProductImages.get(from).add(productName);
}

// ── Process a single customer message ──
async function processCustomerMessage(from, senderName, combinedBody, lastWamid, imagePath, customerMediaId, customerMediaMime, customerAudioId, customerAudioMime) {
  // PREEMPTION: cancel previous AI process for this user
  if (store.activeProcessing.has(from)) {
    const currentTask = store.activeProcessing.get(from);
    if (currentTask.controller) currentTask.controller.abort();
    if (currentTask.timeoutId) clearTimeout(currentTask.timeoutId);
    if (currentTask.resolveDelay) currentTask.resolveDelay();
    store.activeProcessing.delete(from);
    console.log(`⚡ Menghentikan proses AI sebelumnya untuk ${senderName} karena ada pesan baru.`);
  }

  scheduler.cancel(from, 'transfer');

  const entry = {
    id: Date.now(), from, senderName, body: combinedBody, wamid: lastWamid,
    waba_message_id: lastWamid,
    message_type: imagePath ? 'image' : 'text',
    timestamp: new Date().toISOString(),
    replied: false, aiReply: null,
  };

  entry.orderStep = store.orderStates.get(from)?.step || null;
  store.messages.unshift(entry);
  if (store.messages.length > config.MESSAGE_LIMIT) store.messages = store.messages.slice(0, config.MESSAGE_LIMIT);
  store.save(store.PATHS.MSG_FILE, store.messages);
  store.persistMessageToDB(entry);
  const _st = store.orderStates.get(from);
  console.log(`📨 [${from.slice(-4)}] step=${_st?.step ?? '-'} | "${combinedBody.slice(0, 45)}${combinedBody.length > 45 ? '…' : ''}" → AI`);
  store.io?.emit('new_message', entry);

  if (customerMediaId && customerMediaMime) {
    downloadAndSaveCustomerMedia(customerMediaId, lastWamid, customerMediaMime)
      .catch(e => console.warn('[P2-A] deferred download error:', e.message));
  }
  if (customerAudioId && customerAudioMime) {
    downloadAndSaveCustomerAudio(customerAudioId, lastWamid, customerAudioMime)
      .catch(e => console.warn('[P2-A2] deferred download error:', e.message));
  }

  const prevTask = store.userLocks.get(from) || Promise.resolve();

  const nextTask = prevTask.then(async () => {
    if (store.settings.autoReply && isOpHour() && isWhitelisted(from)) {
      const controller = new AbortController();
      const taskState = { controller, timeoutId: null };
      store.activeProcessing.set(from, taskState);

      try { await markAsReadWithTyping(lastWamid, true); } catch(e) {}

      const history = buildHistory(from, entry.id);

      // Audio path
      let audioPathForAI = null;
      if (customerAudioId) {
        const audioExt = (customerAudioMime || '').includes('mp4') ? 'mp4' : 'ogg';
        const audioSafeName = (lastWamid || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const audioFilename = `customer_${audioSafeName}.${audioExt}`;
        const audioFullPath = path.join(store.PATHS.AUDIO_DIR, audioFilename);
        if (fs.existsSync(audioFullPath)) {
          audioPathForAI = audioFullPath;
        } else {
          try {
            const audioUrl = await downloadAndSaveCustomerAudio(customerAudioId, lastWamid, customerAudioMime);
            if (audioUrl) audioPathForAI = path.join(store.PATHS.AUDIO_DIR, path.basename(audioUrl));
          } catch(e) { console.warn('[P2-B2] Gagal download audio:', e.message); }
        }
      }

      // ── THINKER: Classify intent (hybrid mode) ──
      let thinkerResult = null;
      try {
        thinkerResult = await classifyIntent(combinedBody, {
          from,
          orderState: store.orderStates.get(from),
          history: history.slice(-3),
        });
        if (thinkerResult) {
          console.log(`🧠 [Thinker] intent=${thinkerResult.intent}, product=${thinkerResult.product || '-'}, confidence=${thinkerResult.confidence}`);
        }
      } catch(thinkerErr) {
        console.warn('[Thinker] Gagal classify, fallback ke regex:', thinkerErr.message);
      }

      // Update order state — uses Thinker output if available, else fallback regex
      let orderState;
      if (thinkerResult && thinkerResult.extractedData) {
        orderState = updateOrderStateFromThinker(from, combinedBody, thinkerResult);
      } else {
        orderState = updateOrderState(from, combinedBody);
      }
      if (orderState) {
        console.log(`📋 [OrderState] ${senderName}: step=${orderState.step}, product=${orderState.product}, color=${orderState.color || '-'}, nama=${orderState.namaLengkap || '-'} desa=${orderState.desa || '-'}`);
      }

      let reply = await aiReply(combinedBody, senderName, history, controller.signal, from, imagePath, audioPathForAI, thinkerResult);

      // CEK_ONGKIR tag
      let ongkirFormatted = null;
      if (reply) {
        const ongkirMatch = reply.match(/\[CEK_ONGKIR:([^\]]+)\]/i);
        if (ongkirMatch) {
          reply = reply.replace(/\[CEK_ONGKIR:[^\]]+\]/gi, '').trim();
          try {
            const ongkirHelper = require('./ongkir-helper');
            const ongkirResult = await ongkirHelper.processCekOngkirTag(ongkirMatch[1].trim(), 100000);
            if (ongkirResult?.formatted) ongkirFormatted = ongkirResult.formatted;
          } catch (ongkirErr) { console.warn('[P2-C] Error cek ongkir:', ongkirErr.message); }
        }
      }

      // Validate field order
      if (reply) {
        const currentState = store.orderStates.get(from);
        if (currentState && currentState.step >= 3) {
          reply = validateFieldOrder(reply, currentState);
        }
      }

      if (reply) {
        // B1: Hold check
        const hasNewerMessage = store.messages.some(m =>
          m.from === from && m.id > entry.id && !m.replied
        );
        if (store.pendingBuffers.has(from) || hasNewerMessage) {
          console.log(`⏸️ Reply untuk ${senderName} ditahan — ada pesan susulan.`);
          store.activeProcessing.delete(from);
          entry.replied = true;
          entry.aiReply = reply;
          entry.heldReply = true;
          store.save(store.PATHS.MSG_FILE, store.messages);
          store.persistMessageToDB(entry);
          return;
        }

        reply = extractOrder(reply, from);
        const escResult = extractEscalations(reply, from, senderName);
        reply = escResult.cleanReply;
        if (!reply.trim()) {
          store.activeProcessing.delete(from);
          entry.replied = true;
          entry.aiReply = null;
          entry.cancelledEntry = true;
          entry.awaitingAdmin = true;
          store.save(store.PATHS.MSG_FILE, store.messages);
          store.persistMessageToDB(entry);
          store.io?.emit('message_updated', entry);
          return;
        }

        let cleanReply = reply;
        if (ongkirFormatted) cleanReply = cleanReply + '\n\n' + ongkirFormatted;

        // BUKTI_TRANSFER
        if (cleanReply.includes('[BUKTI_TRANSFER]')) {
          cleanReply = cleanReply.replace(/\[BUKTI_TRANSFER\]/gi, '').trim();
          scheduler.cancel(from, 'transfer');
          const tg = require('./telegram-service');
          if (tg.isConfigured() && imagePath) {
            const lastOrder = store.orders.find(o => o.jid === from || o.wa_id === from);
            tg.sendTransferProof({ imagePath, customerPhone: from.replace('@s.whatsapp.net', '').replace('@c.us', ''), customerName: senderName, order: lastOrder }).catch(e => console.error('[F2] Gagal forward bukti transfer:', e.message));
          }
        }

        // DELAY_SUMMARY
        if (cleanReply.includes('[DELAY_SUMMARY]')) {
          cleanReply = cleanReply.replace(/\[DELAY_SUMMARY\]/gi, '').trim();
          scheduler.schedule(from, 'summary', 15 * 60 * 1000, async () => {
            const summary = buildOrderSummary(from);
            if (summary) await sendWhatsAppText(from, summary).catch(e => console.error('[F4] Gagal kirim summary:', e.message));
          });
        }

        // KLAIM_GARANSI
        const klaimMatch = cleanReply.match(/\[KLAIM_GARANSI:([^\]]*)\]/i);
        if (klaimMatch) {
          cleanReply = cleanReply.replace(/\[KLAIM_GARANSI:[^\]]*\]/gi, '').trim();
          store.activeClaims.set(from, { description: klaimMatch[1].trim() || 'tidak dijelaskan', timestamp: Date.now() });
          db.saveActiveClaim(from, klaimMatch[1].trim() || 'tidak dijelaskan');
        }

        // Active claim image forward
        const tg = require('./telegram-service');
        if (imagePath && store.activeClaims.has(from) && !klaimMatch) {
          const claim = store.activeClaims.get(from);
          const lastOrder = store.orders.find(o => o.jid === from || o.wa_id === from);
          if (tg.isConfigured()) {
            tg.sendClaimAlert({ imagePath, customerPhone: from.replace('@s.whatsapp.net', '').replace('@c.us', ''), customerName: senderName, description: claim.description, order: lastOrder }).catch(e => console.error('[F5] Gagal forward klaim:', e.message));
          }
          store.activeClaims.delete(from);
          db.deleteActiveClaim(from);
        }

        // KIRIM_GAMBAR
        const imgMatches = [...cleanReply.matchAll(/\[KIRIM_GAMBAR:(.*?)\]/gi)];
        let productsToImage = [];
        for (const match of imgMatches) {
          productsToImage.push(match[1].trim());
          cleanReply = cleanReply.replace(match[0], '').trim();
        }

        // Fallback: auto-detect product images
        if (productsToImage.length === 0 && store.settings.productImages) {
          const lowerReply = cleanReply.toLowerCase();
          for (const productName of Object.keys(store.settings.productImages)) {
            if (!hasSentProductImage(from, productName) && lowerReply.includes(productName.toLowerCase())) {
              productsToImage.push(productName);
            }
          }
        }

        // Reply delay
        const delayMs = from === store.TEST_PHONE ? 0 : getReplyDelayMs(cleanReply);
        await new Promise(resolve => {
          taskState.resolveDelay = resolve;
          taskState.timeoutId = setTimeout(() => { taskState.resolveDelay = null; resolve(); }, delayMs);
        });

        if (controller.signal.aborted) {
          entry.replied = true;
          entry.aiReply = reply;
          entry.heldReply = true;
          store.save(store.PATHS.MSG_FILE, store.messages);
          store.persistMessageToDB(entry);
          return;
        }

        // B1 Hold Check #2
        const hasNewerMessageAfterDelay = store.messages.some(m =>
          m.from === from && m.id > entry.id && !m.replied
        );
        if (store.pendingBuffers.has(from) || hasNewerMessageAfterDelay) {
          entry.replied = true;
          entry.aiReply = reply;
          entry.heldReply = true;
          store.save(store.PATHS.MSG_FILE, store.messages);
          store.persistMessageToDB(entry);
          return;
        }

        store.activeProcessing.delete(from);

        // Step tag
        const stepTagMatch = cleanReply.match(/\[STEP=(\d)\]/i);
        if (stepTagMatch) {
          const newStep = parseInt(stepTagMatch[1]);
          const st = store.orderStates.get(from);
          if (st && [1,2,3,4,5].includes(newStep) && st.step !== newStep) {
            st.step = newStep;
            st.lastUpdate = Date.now();
          }
          cleanReply = cleanReply.replace(/\[STEP=\d\]/gi, '').trim();
          entry.aiReply = cleanReply;
        }

        // DRAFT MODE
        const _currentStep = store.orderStates.get(from)?.step || 1;
        const _hasDraftTag = cleanReply.includes('[DRAFT_ONGKIR]') || cleanReply.includes('[DRAFT_REKAP]');
        if (_currentStep >= 4 || _hasDraftTag) {
          cleanReply = cleanReply.replace(/\[DRAFT_REKAP\]/gi, '').replace(/\[DRAFT_ONGKIR\]/gi, '').trim();
          entry.aiReplyDraft = cleanReply;
          entry.draftStatus = 'pending';
          entry.replied = true;
          entry.aiReply = null;
          store.save(store.PATHS.MSG_FILE, store.messages);
          store.persistMessageToDB(entry);
          store.io?.emit('message_updated', entry);
          console.log(`📝 [DRAFT] ${senderName}: ${cleanReply.slice(0, 80)}...`);
          return;
        }

        // SPLIT bubbles
        try {
          const bubbles = cleanReply.split(/\[SPLIT\]/i).map(b => b.trim().replace(/\[SPLIT\]/gi, '')).filter(Boolean);
          for (let bi = 0; bi < bubbles.length; bi++) {
            if (bi > 0) await new Promise(r => setTimeout(r, config.BUBBLE_DELAY_MS));
            await sendWhatsAppText(from, bubbles[bi], bi === 0 ? lastWamid : undefined);
          }
        } catch (sendErr) {
          console.error(`❌ Gagal kirim reply ke ${senderName}:`, sendErr.message);
          store.save(store.PATHS.MSG_FILE, store.messages);
          store.persistMessageToDB(entry);
          return;
        }

        // Send product images
        for (const productToImage of productsToImage) {
          if (hasSentProductImage(from, productToImage)) continue;
          if (store.settings.productImages && store.settings.productImages[productToImage]) {
            let anySent = false;
            for (const filename of store.settings.productImages[productToImage]) {
              if (filename) {
                const imgPath = path.join(store.PATHS.IMAGES_DIR, filename);
                if (fs.existsSync(imgPath)) {
                  try {
                    const ext = filename.split('.').pop().toLowerCase();
                    const mimetype = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
                    await sendWhatsAppImageByPath(from, imgPath, mimetype);
                    anySent = true;
                  } catch(e) { console.error('Gagal kirim gambar:', e.message); }
                }
              }
            }
            if (anySent) markProductImageSent(from, productToImage);
          }
        }

        entry.replied = true;
        entry.aiReply = cleanReply.replace(/\[SPLIT\]/gi, ' ').replace(/\s+/g, ' ').trim();
        store.save(store.PATHS.MSG_FILE, store.messages);
        store.persistMessageToDB(entry);
        store.io?.emit('message_updated', entry);
        console.log(`🤖 AI (delay ${Math.round(delayMs/1000)}s): ${cleanReply}`);

        setTimeout(retryFailedMessages, 5000);

        // Transfer follow-up timer
        const PAYMENT = { accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER || '' };
        if (PAYMENT.accountNumber && cleanReply.includes(PAYMENT.accountNumber) && !scheduler.isActive(from, 'transfer')) {
          scheduler.schedule(from, 'transfer', 3 * 60 * 60 * 1000, async () => {
            await sendWhatsAppText(from, `Halo Kak 😊 Kami ingin memastikan, apakah pembayaran transfer sudah berhasil dilakukan?\n\nKalau kakak butuh info rekening lagi atau ada kendala, kami siap membantu ya 🙏`).catch(e => console.error('[F3] Gagal kirim follow-up:', e.message));
          });
        }

      } else {
        store.activeProcessing.delete(from);
        if (controller.signal.aborted) {
          entry.replied = true;
          entry.aiReply = null;
          entry.cancelledEntry = true;
          store.save(store.PATHS.MSG_FILE, store.messages);
          store.persistMessageToDB(entry);
        }
      }
    }
  }).catch(e => {
    store.activeProcessing.delete(from);
    console.error('Error in user queue:', e);
  }).finally(() => {
    if (store.userLocks.get(from) === nextTask) store.userLocks.delete(from);
  });

  store.userLocks.set(from, nextTask);
}

// Update order state from Thinker output (hybrid mode)
function updateOrderStateFromThinker(from, message, thinkerResult) {
  const { intent, extractedData, product } = thinkerResult;
  let state = store.orderStates.get(from);

  // Product focus
  if (product && (!state || state.product !== product)) {
    state = createOrderState(product);
    store.orderStates.set(from, state);
  }
  if (!state) return null;

  // Apply extracted data from Thinker
  if (extractedData) {
    if (extractedData.color && !state.color) state.color = extractedData.color;
    if (extractedData.phone && !state.noHp) state.noHp = extractedData.phone;
    if (extractedData.nama && !state.namaLengkap) { state.namaLengkap = extractedData.nama; state.namaVerified = true; }
    if (extractedData.jalan && !state.jalan) state.jalan = extractedData.jalan;
    if (extractedData.desa && !state.desa) state.desa = extractedData.desa;
    if (extractedData.kecamatan && !state.kecamatan) state.kecamatan = extractedData.kecamatan;
    if (extractedData.kota && !state.kota) state.kota = extractedData.kota;
    if (extractedData.rtRw && !state.rtRw) state.rtRw = extractedData.rtRw;
    if (extractedData.patokan && !state.patokan) state.patokan = extractedData.patokan;
  }

  // Step transition from Thinker recommendation
  if (thinkerResult.nextStep && [1,2,3,4,5].includes(thinkerResult.nextStep)) {
    if (thinkerResult.nextStep !== state.step) {
      console.log(`📊 [Step] ${from.slice(-4)}: ${state.step}→${thinkerResult.nextStep} (Thinker recommendation)`);
      state.step = thinkerResult.nextStep;
    }
  }

  state.lastUpdate = Date.now();
  store.orderStates.set(from, state);
  return state;
}

// ── Process buffered messages ──
async function processBufferedMessages(from) {
  const buf = store.pendingBuffers.get(from);
  if (!buf || buf.texts.length === 0) return;

  const controller = new AbortController();
  store.activeProcessing.set(from, { controller, timeoutId: null });

  try {
    while (buf.texts.length > 0) {
      const texts = buf.texts.splice(0);
      const combinedBody = texts.join('\n');
      const currentWamid = buf.lastWamid;
      const currentSenderName = buf.senderName;

      console.log(`🔄 [Buffer] Proses ${texts.length} pesan: "${combinedBody.slice(0, 60)}"`);

      let imagePathForAI = null;
      if (buf.mediaId) {
        try {
          const ext = (buf.mediaMime || '').includes('png') ? 'png' : 'jpg';
          const safeName = (buf.mediaWamid || Date.now().toString()).replace(/[^a-z0-9_-]/gi, '_');
          const filename = `customer_${safeName}.${ext}`;
          const savePath = path.join(store.PATHS.IMAGES_DIR, filename);
          if (fs.existsSync(savePath)) {
            imagePathForAI = savePath;
          } else {
            const mediaUrlPath = await downloadAndSaveCustomerMedia(buf.mediaId, buf.mediaWamid, buf.mediaMime);
            if (mediaUrlPath) imagePathForAI = path.join(store.PATHS.IMAGES_DIR, path.basename(mediaUrlPath));
          }
        } catch(imgErr) { console.warn('[Buffer] Gagal siapkan gambar:', imgErr.message); }
      }

      let audioPathForAI = null;
      if (buf.audioId) {
        try {
          const audioExt = (buf.audioMime || '').includes('mp4') ? 'mp4' : 'ogg';
          const audioSafeName = (buf.audioWamid || currentWamid || '').replace(/[^a-zA-Z0-9_-]/g, '_');
          const audioFilename = `customer_${audioSafeName}.${audioExt}`;
          const audioFullPath = path.join(store.PATHS.AUDIO_DIR, audioFilename);
          if (fs.existsSync(audioFullPath)) {
            audioPathForAI = audioFullPath;
          } else {
            const audioUrl = await downloadAndSaveCustomerAudio(buf.audioId, buf.audioWamid || currentWamid, buf.audioMime);
            if (audioUrl) audioPathForAI = path.join(store.PATHS.AUDIO_DIR, path.basename(audioUrl));
          }
        } catch(audErr) { console.warn('[Buffer] Gagal siapkan audio:', audErr.message); }
      }

      await processCustomerMessage(from, currentSenderName, combinedBody, currentWamid, imagePathForAI, buf.mediaId, buf.mediaMime, buf.audioId, buf.audioMime);

      if (buf.texts.length > 0) {
        console.log(`⚡ [Buffer] Ada ${buf.texts.length} susulan → gabung & proses ulang`);
        continue;
      }
      break;
    }
  } finally {
    store.activeProcessing.delete(from);
    store.pendingBuffers.delete(from);
  }
}

// ── Retry failed messages ──
async function retryFailedMessages() {
  if (!store.settings.autoReply) return;
  const MAX_RETRY_COUNT = config.MAX_RETRY_COUNT;
  const nowTime = Date.now();
  const failedEntries = store.messages.filter(m => !m.replied && (nowTime - new Date(m.timestamp).getTime() < config.RETRY_WINDOW_MS) && (m.retryCount || 0) < MAX_RETRY_COUNT);
  if (!failedEntries.length) return;

  console.log(`♻️ Mencoba membalas ulang ${failedEntries.length} pesan yang tertunda...`);

  for (const entry of failedEntries) {
    const prevTask = store.userLocks.get(entry.from) || Promise.resolve();
    const nextTask = prevTask.then(async () => {
      if (entry.replied) return;
      if (!isOpHour() || !isWhitelisted(entry.from)) return;

      const history = buildHistory(entry.from, entry.id);
      entry.retryCount = (entry.retryCount || 0) + 1;

      let reply = await aiReply(entry.body, entry.senderName, history, null, entry.from);

      if (reply) {
        const retryState = store.orderStates.get(entry.from);
        if (retryState && retryState.step >= 3) reply = validateFieldOrder(reply, retryState);
      }

      if (reply) {
        reply = extractOrder(reply, entry.from);
        const escResult = extractEscalations(reply, entry.from, entry.senderName);
        reply = escResult.cleanReply;
        if (!reply.trim()) {
          entry.replied = true;
          entry.aiReply = null;
          entry.awaitingAdmin = true;
          store.save(store.PATHS.MSG_FILE, store.messages);
          store.persistMessageToDB(entry);
          return;
        }

        try { await markAsReadWithTyping(entry.wamid, true); } catch(e) {}
        await new Promise(r => setTimeout(r, 2000));

        let cleanReply = reply;
        const imgMatches = [...reply.matchAll(/\[KIRIM_GAMBAR:(.*?)\]/gi)];
        const productsToImage = [];
        for (const match of imgMatches) { productsToImage.push(match[1].trim()); cleanReply = cleanReply.replace(match[0], '').trim(); }

        const _retryStep = store.orderStates.get(entry.from)?.step || 1;
        const _hasRetryDraftTag = cleanReply.includes('[DRAFT_ONGKIR]') || cleanReply.includes('[DRAFT_REKAP]');
        if (_retryStep >= 4 || _hasRetryDraftTag) {
          cleanReply = cleanReply.replace(/\[DRAFT_REKAP\]/gi, '').replace(/\[DRAFT_ONGKIR\]/gi, '').trim();
          entry.aiReplyDraft = cleanReply;
          entry.draftStatus = 'pending';
          entry.replied = true;
          entry.aiReply = null;
          store.save(store.PATHS.MSG_FILE, store.messages);
          store.persistMessageToDB(entry);
          store.io?.emit('message_updated', entry);
          return;
        }

        await sendWhatsAppText(entry.from, cleanReply, entry.wamid);

        for (const productToImage of productsToImage) {
          if (hasSentProductImage(entry.from, productToImage)) continue;
          if (store.settings.productImages && store.settings.productImages[productToImage]) {
            for (const filename of store.settings.productImages[productToImage]) {
              if (filename) {
                const imgPath = path.join(store.PATHS.IMAGES_DIR, filename);
                if (fs.existsSync(imgPath)) {
                  try {
                    const ext = filename.split('.').pop().toLowerCase();
                    const mimetype = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
                    await sendWhatsAppImageByPath(entry.from, imgPath, mimetype);
                  } catch(e) {}
                }
              }
            }
            markProductImageSent(entry.from, productToImage);
          }
        }

        entry.replied = true;
        entry.aiReply = cleanReply;
        store.save(store.PATHS.MSG_FILE, store.messages);
        store.persistMessageToDB(entry);
        store.io?.emit('message_updated', entry);
      } else if (entry.retryCount >= MAX_RETRY_COUNT) {
        entry.replied = true;
        entry.aiReply = null;
        entry.cancelledEntry = true;
        store.save(store.PATHS.MSG_FILE, store.messages);
        store.persistMessageToDB(entry);
      } else {
        store.save(store.PATHS.MSG_FILE, store.messages);
        store.persistMessageToDB(entry);
      }
    }).catch(e => console.error('Retry error:', e.message))
    .finally(() => { if (store.userLocks.get(entry.from) === nextTask) store.userLocks.delete(entry.from); });

    store.userLocks.set(entry.from, nextTask);
  }
}

// ── Helpers ──
function isOpHour() {
  if (!store.settings.opHours?.enabled) return true;
  const now = new Date();
  const [sh, sm] = store.settings.opHours.start.split(':').map(Number);
  const [eh, em] = store.settings.opHours.end.split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
}

function isWhitelisted(num) {
  if (!store.settings.whitelist?.length) return true;
  return store.settings.whitelist.some(w => num.includes(w.replace(/\D/g, '')));
}

module.exports = {
  processCustomerMessage, processBufferedMessages, retryFailedMessages,
  isOpHour, isWhitelisted, hasSentProductImage, markProductImageSent,
};
