/**
 * whatsapp-api.js — WhatsApp Cloud API helpers
 * Send, download, upload, mark-as-read via Graph API Meta.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const db   = require('./db');
const store = require('./state-store');

const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}`;
const waConfigured = !!(WHATSAPP_TOKEN && PHONE_NUMBER_ID);

if (!waConfigured) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m WHATSAPP_TOKEN / PHONE_NUMBER_ID belum diisi di .env');
}

async function graphFetch(pathSuffix, options = {}) {
  const url = `${GRAPH_BASE}${pathSuffix}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      ...(options.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch(e) {}
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.graphError = data?.error;
    throw err;
  }
  return data;
}

async function sendWhatsAppText(to, text, quotedWamid) {
  if (to === store.TEST_PHONE) {
    console.log(`[TEST] 📨 Dicegat (tidak dikirim ke WABA): "${text?.slice(0, 80)}"`);
    return { intercepted: true, text };
  }
  if (!waConfigured) { console.error('❌ WhatsApp Cloud API belum dikonfigurasi'); return null; }
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text, preview_url: false },
  };
  if (quotedWamid) body.context = { message_id: quotedWamid };
  return graphFetch('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function uploadWhatsAppMedia(filePath, mimetype) {
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: mimetype });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', blob, path.basename(filePath));
  form.append('type', mimetype);
  const data = await graphFetch('/media', { method: 'POST', body: form });
  return data?.id || null;
}

async function uploadWhatsAppMediaBuffer(buffer, mimetype, filename) {
  const blob = new Blob([buffer], { type: mimetype });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', blob, filename);
  form.append('type', mimetype);
  const data = await graphFetch('/media', { method: 'POST', body: form });
  return data?.id || null;
}

async function sendWhatsAppImageByPath(to, filePath, mimetype) {
  const mediaId = await uploadWhatsAppMedia(filePath, mimetype);
  if (!mediaId) throw new Error('Upload media ke WhatsApp gagal');
  const body = { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId } };
  return graphFetch('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function sendWhatsAppMediaById(to, mediaId, mediaType, caption) {
  const key = mediaType === 'video' ? 'video' : 'image';
  const mediaObj = { id: mediaId };
  if (caption) mediaObj.caption = caption;
  const body = { messaging_product: 'whatsapp', to, type: key, [key]: mediaObj };
  return graphFetch('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function markAsReadWithTyping(wamid, withTyping = true) {
  if (!waConfigured || !wamid) return;
  const body = { messaging_product: 'whatsapp', status: 'read', message_id: wamid };
  if (withTyping) body.typing_indicator = { type: 'text' };
  try { await graphFetch('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch(e) { /* non-fatal */ }
}

async function downloadAndSaveCustomerMedia(mediaId, wamid, mimetype) {
  if (!waConfigured) return null;
  try {
    const infoRes = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    if (!infoRes.ok) throw new Error(`Graph API error ${infoRes.status}`);
    const { url } = await infoRes.json();
    if (!url) throw new Error('URL media tidak ditemukan');

    const imgRes = await fetch(url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!imgRes.ok) throw new Error(`Download gagal: HTTP ${imgRes.status}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    const ext = (mimetype || '').includes('png') ? 'png' :
                (mimetype || '').includes('gif') ? 'gif' : 'jpg';
    const safeName = (wamid || Date.now().toString()).replace(/[^a-z0-9_-]/gi, '_');
    const filename = `customer_${safeName}.${ext}`;
    const savePath = path.join(store.PATHS.IMAGES_DIR, filename);
    fs.writeFileSync(savePath, buffer);

    const mediaUrlPath = `/images/${filename}`;
    try {
      await db.pool.query('UPDATE messages SET media_url = $1 WHERE waba_message_id = $2', [mediaUrlPath, wamid]);
      console.log(`🖼️ Gambar customer disimpan: ${filename}`);
      const inMemMsg = store.messages.find(m => m.wamid === wamid || m.waba_message_id === wamid);
      if (inMemMsg) {
        inMemMsg.mediaUrl = mediaUrlPath;
        inMemMsg.media_url = mediaUrlPath;
        inMemMsg.messageType = 'image';
        inMemMsg.message_type = 'image';
        store.save(store.PATHS.MSG_FILE, store.messages);
      }
      store.io?.emit('message_media_updated', { wamid, mediaUrl: mediaUrlPath });
    } catch(dbErr) { console.warn('[P2-A] Gagal update media_url di DB:', dbErr.message); }
    return mediaUrlPath;
  } catch (e) {
    console.warn(`⚠️ [P2-A] Gagal download gambar customer:`, e.message);
    return null;
  }
}

async function downloadAndSaveCustomerAudio(mediaId, wamid, mimetype) {
  if (!waConfigured) return null;
  try {
    const infoRes = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    if (!infoRes.ok) throw new Error(`Graph API error ${infoRes.status}`);
    const { url } = await infoRes.json();
    if (!url) throw new Error('URL audio tidak ditemukan');

    const audioRes = await fetch(url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!audioRes.ok) throw new Error(`Download gagal: HTTP ${audioRes.status}`);
    const buffer = Buffer.from(await audioRes.arrayBuffer());

    const ext = (mimetype || '').includes('mp4') ? 'mp4' : 'ogg';
    const safeName = (wamid || Date.now().toString()).replace(/[^a-z0-9_-]/gi, '_');
    const filename = `customer_${safeName}.${ext}`;
    const savePath = path.join(store.PATHS.AUDIO_DIR, filename);
    fs.writeFileSync(savePath, buffer);

    const mediaUrlPath = `/audio/${filename}`;
    try {
      await db.pool.query('UPDATE messages SET media_url = $1, message_type = $2 WHERE waba_message_id = $3', [mediaUrlPath, 'audio', wamid]);
      console.log(`🎙️ Audio customer disimpan: ${filename}`);
      const inMemMsg = store.messages.find(m => m.wamid === wamid || m.waba_message_id === wamid);
      if (inMemMsg) {
        inMemMsg.mediaUrl = mediaUrlPath;
        inMemMsg.media_url = mediaUrlPath;
        inMemMsg.messageType = 'audio';
        inMemMsg.message_type = 'audio';
        inMemMsg.mediaMimeType = mimetype || 'audio/ogg';
        inMemMsg.media_mime_type = mimetype || 'audio/ogg';
        store.save(store.PATHS.MSG_FILE, store.messages);
      }
      store.io?.emit('message_media_updated', { wamid, mediaUrl: mediaUrlPath, messageType: 'audio' });
    } catch(dbErr) { console.warn('[P2-A2] Gagal update audio di DB:', dbErr.message); }
    return mediaUrlPath;
  } catch (e) {
    console.warn(`⚠️ [P2-A2] Gagal download audio customer:`, e.message);
    return null;
  }
}

module.exports = {
  graphFetch, waConfigured, WHATSAPP_TOKEN, GRAPH_API_VERSION,
  sendWhatsAppText, uploadWhatsAppMedia, uploadWhatsAppMediaBuffer,
  sendWhatsAppImageByPath, sendWhatsAppMediaById,
  markAsReadWithTyping, downloadAndSaveCustomerMedia, downloadAndSaveCustomerAudio,
};
