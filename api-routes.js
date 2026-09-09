/**
 * api-routes.js — Dashboard API routes
 * Extracted from server.js. Registers all /api/* routes for the dashboard.
 *
 * Usage:
 *   const { registerApiRoutes } = require('./api-routes');
 *   registerApiRoutes(app, io);
 *
 * Auth middleware (Bearer token) is expected to be applied in server.js
 * BEFORE calling registerApiRoutes — this module does not add auth.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const multer = require('multer');

const config  = require('./config');
const store   = require('./state-store');
const db      = require('./db');
const { getApiKeys, computeKeyStatuses, emitKeyStatuses, getAvailableKey, markKeyLimited, callGeminiDirect } = require('./gemini-service');
const { sendWhatsAppText, sendWhatsAppImageByPath, uploadWhatsAppMediaBuffer, waConfigured } = require('./whatsapp-api');
const { processCustomerMessage, retryFailedMessages } = require('./message-processor');
const { processOrderAddressAI } = require('./address-ai');

// ── PWA Push Notification config ────────────────────────────────────
const webpush = require('web-push');
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:admin@trustiomart.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Push subscriptions (loaded from file)
const PUSH_SUB_FILE = path.join(__dirname, 'push-subscriptions.json');
let pushSubscriptions = [];
try { if (fs.existsSync(PUSH_SUB_FILE)) pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_SUB_FILE, 'utf8')); } catch(e) {}
function savePushSubscriptions() {
  try { fs.writeFileSync(PUSH_SUB_FILE, JSON.stringify(pushSubscriptions, null, 2)); } catch(e) {}
}

// ── Multer for media uploads (memory storage, max 64 MB) ────────────
const multerMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

// ── DB persist helper for settings ───────────────────────────────────
async function persistSettingsToDB(s) {
  if (!s) return;
  try { await db.saveSettings(s); } catch(e) { console.error('DB Settings Error:', e.message); }
}

// ── AI Test Session State ────────────────────────────────────────────
let activeTestSession = null;

const AI_TEST_PERSONAS = [
  {
    id: 'persona_1',
    name: 'Khasin',
    label: 'Khasin — buyer produk rumah tangga',
    script: [
      'Halo ka',
      'kamu jual produk apa saja',
      'harga berapa ka?',
      'Udah sama ongkir?',
      'Selang flexible ada ka',
      'Ada fotonya ka',
      'Mau kak — Khasin Khafabi, Jl. Mawar No 5 Kel. Cipete Kec. Ciputat Kota Tangerang Selatan, 082312345678',
      'Ok ka',
    ],
  },
  {
    id: 'persona_2',
    name: 'Azizah',
    label: 'Azizah — calon beli tapi ragu-ragu',
    script: [
      'Halo! Bisa minta info lebih lanjut tentang selang flexibel?',
      'Cek harga ya?',
      'Tertarik sama selang nya sih, tapi ngak semua kran yg pas sama selang nya kali ya?',
      'Oh gitu tapi KK gantilah dulu kran nya, sekarang ini model nya yg kyk lengkung, maunya yg langsung k dinding aja, nantiklh di kbrin ya, cuman mau ngecek harga aja dulu.',
      'Iya sama sama',
    ],
  },
  {
    id: 'persona_3',
    name: 'Rosa',
    label: 'Rosa — buyer baby walking assistant, order sampai konfirmasi',
    script: [
      'Halo! Bisa minta info lebih lanjut tentang baby walking assistant?',
      'Benar ni udah termasuk ongkir cuman lapan buluh sembilan ribu',
      'Warna NaVi boleh kk',
      'Alamat sipang kelurahan desa sipang kecamatan Batang Cenaku, 081363429837',
      'Ok kira2 tg berapa ya kk datang ny biar langsung di siap kan uang ny',
    ],
  },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────
// registerApiRoutes(app, io)
//
// Registers all /api/* dashboard routes on the Express app.
// Assumes auth middleware is already applied for /api/* in server.js.
// ─────────────────────────────────────────────────────────────────────
function registerApiRoutes(app, io) {

  // ═══════════════════════════════════════════════════════════════════
  // SETTINGS & STATUS
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/keystatus', (_, res) => {
    const keys = getApiKeys();
    res.json({
      filled: keys.map(k => !!(k && k.length >= 10)),
      activeIndex: 0,
      statuses: computeKeyStatuses(),
      log: [],
    });
  });

  app.get('/api/status', (_, res) => {
    const channel = store.settings.channel === 'macrodroid' ? 'macrodroid' : 'cloudapi';
    const status  = channel === 'macrodroid' ? 'connected' : (waConfigured ? 'connected' : 'disconnected');
    res.json({ status, channel, version: '3.0' });
  });

  app.get('/api/qr', (_, res) => res.json({ qr: null }));

  app.get('/api/messages', (_, res) => res.json(store.messages.slice(0, 2000)));

  app.get('/api/settings', (_, res) => res.json(store.settings));

  // ═══════════════════════════════════════════════════════════════════
  // PWA PUSH NOTIFICATION
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/push/vapid-key', (_, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

  app.post('/api/push/subscribe', (req, res) => {
    const subscription = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
    pushSubscriptions.push(subscription);
    savePushSubscriptions();
    console.log(`Push subscription ditambahkan (${pushSubscriptions.length} total)`);
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const { endpoint } = req.body;
    pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
    savePushSubscriptions();
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DRAFT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  app.post('/api/draft/send', (req, res) => {
    const { entryId, text } = req.body;
    if (!entryId || !text?.trim()) return res.status(400).json({ error: 'entryId & text required' });
    const entry = store.messages.find(m => m.id === entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.draftStatus !== 'pending') return res.status(400).json({ error: 'Bukan draft aktif' });

    sendWhatsAppText(entry.from, text.trim(), entry.wamid)
      .then(() => {
        entry.aiReplyDraft  = null;
        entry.draftStatus   = 'sent';
        entry.aiReply       = text.trim();
        entry.replied       = true;
        store.save(store.PATHS.MSG_FILE, store.messages);
        store.persistMessageToDB(entry);
        io.emit('message_updated', entry);
        console.log(`[DRAFT SENT] -> ${entry.senderName}: ${text.trim().slice(0, 60)}`);
        res.json({ ok: true });
      })
      .catch(err => {
        console.error('Draft send error:', err.message);
        res.status(500).json({ error: err.message });
      });
  });

  app.post('/api/draft/cancel', (req, res) => {
    const { entryId } = req.body;
    const entry = store.messages.find(m => m.id === entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    entry.draftStatus = 'cancelled';
    entry.aiReplyDraft = null;
    store.save(store.PATHS.MSG_FILE, store.messages);
    store.persistMessageToDB(entry);
    io.emit('message_updated', entry);
    console.log(`[DRAFT CANCEL] ${entry.senderName}`);
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════════════
  // IMAGE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  app.post('/api/upload-image', (req, res) => {
    try {
      const { productName, slot, base64 } = req.body;
      if (!productName || slot == null || !base64) return res.status(400).json({ error: 'Data tidak lengkap' });

      let ext = 'jpg';
      const mimeMatch = base64.match(/^data:image\/(\w+);base64,/);
      if (mimeMatch) ext = mimeMatch[1];

      const base64Data = base64.replace(/^data:image\/\w+;base64,/, '');
      const fileName   = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
      const filePath   = path.join(store.PATHS.IMAGES_DIR, fileName);

      fs.writeFileSync(filePath, base64Data, 'base64');

      if (!store.settings.productImages) store.settings.productImages = {};
      if (!store.settings.productImages[productName]) store.settings.productImages[productName] = [null, null, null];

      // Delete old image if exists
      if (store.settings.productImages[productName][slot]) {
        const oldPath = path.join(store.PATHS.IMAGES_DIR, store.settings.productImages[productName][slot]);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch(e) { console.error('Gagal hapus gambar lama:', e); }
        }
      }

      store.settings.productImages[productName][slot] = fileName;
      store.save(store.PATHS.SET_FILE, store.settings);
      persistSettingsToDB(store.settings);
      io.emit('settings_updated', store.settings);
      res.json({ ok: true, fileName });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/delete-image', (req, res) => {
    try {
      const { productName, slot } = req.body;
      if (!store.settings.productImages || !store.settings.productImages[productName] || !store.settings.productImages[productName][slot]) {
        return res.json({ ok: true });
      }
      const fileName = store.settings.productImages[productName][slot];
      const filePath = path.join(store.PATHS.IMAGES_DIR, fileName);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch(e) { console.error('Gagal hapus file gambar:', e); }
      }
      store.settings.productImages[productName][slot] = null;
      store.save(store.PATHS.SET_FILE, store.settings);
      persistSettingsToDB(store.settings);
      io.emit('settings_updated', store.settings);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // SETTINGS UPDATE
  // ═══════════════════════════════════════════════════════════════════

  app.post('/api/settings', (req, res) => {
    const body = { ...req.body };

    // Validate originId: must be numeric
    if (body.originId !== undefined) {
      const rawOrigin = (body.originId || '').trim();
      if (rawOrigin && !/^\d+$/.test(rawOrigin)) {
        return res.status(400).json({
          error: `Origin ID harus berupa angka, bukan nama kota. Nilai "${rawOrigin}" tidak valid.\n` +
                 `Cari ID kecamatan gudangmu di: https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=NAMA_KECAMATAN&limit=5\n` +
                 `Contoh yang benar: 73528 (Serua, Ciputat, Tangerang Selatan)`,
          field: 'originId',
        });
      }
      body.originId = rawOrigin;
    }

    store.settings = { ...store.settings, ...body };
    store.save(store.PATHS.SET_FILE, store.settings);
    persistSettingsToDB(store.settings);
    io.emit('settings_updated', store.settings);
    res.json({ ok: true });
  });

  app.post('/api/format-kb', async (req, res) => {
    const { knowledgeBase, followUp } = req.body;
    if (!knowledgeBase || !knowledgeBase.trim()) {
      store.settings.knowledgeBase = '';
      store.settings.followUp = followUp || '';
      store.save(store.PATHS.SET_FILE, store.settings);
      persistSettingsToDB(store.settings);
      return res.json({ ok: true, knowledgeBase: '' });
    }

    const allKeys = getApiKeys();
    const key = allKeys.find(k => k && k.length >= 10);
    if (!key) return res.status(400).json({ error: 'Belum ada API key yang diisi' });

    const model = store.settings.modelName || config.DEFAULT_MODEL;
    const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const systemPrompt = `Kamu adalah asisten pembuat database produk. Tugas HANYAMU adalah mengonversi teks mentah yang diberikan user ke dalam format khusus.
Aturan Wajib:
1. Pisahkan setiap produk menggunakan format persis seperti ini:
=== PRODUK: [Nama Produk] ===
[Detail produk: harga, spesifikasi, COD, dsb]
---
2. Jangan buang informasi penting apapun, rapikan tata bahasanya.
3. JANGAN tambahkan kata-kata pembuka/sapaan seperti "Tentu", "Berikut adalah", atau penutup.
4. Output HANYA boleh berisi blok-blok produk dengan format di atas, tidak boleh ada teks lain.`;

    const body = {
      contents: [{ role: 'user', parts: [{ text: knowledgeBase }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.1 },
    };

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const errData = await r.json(); msg = errData?.error?.message || msg; } catch(e) {}
        throw new Error(msg);
      }
      const data = await r.json();
      let formattedText = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

      if (formattedText.trim()) {
        formattedText = formattedText.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
        store.settings.knowledgeBase = formattedText;
        store.settings.followUp = followUp || '';
        store.save(store.PATHS.SET_FILE, store.settings);
        persistSettingsToDB(store.settings);
        io.emit('settings_updated', store.settings);
        res.json({ ok: true, knowledgeBase: formattedText });
      } else {
        res.status(500).json({ error: 'Respons AI kosong' });
      }
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // ORDERS
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/orders', (_, res) => res.json(store.orders));

  app.post('/api/orders/:id/status', (req, res) => {
    const { status } = req.body;
    const order = store.orders.find(o => o.id === req.params.id);
    if (order) {
      order.status = status;
      store.save(store.PATHS.ORDER_FILE, store.orders);
      store.persistOrderToDB(order);
      io.emit('order_updated', order);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Order tidak ditemukan' });
    }
  });

  app.delete('/api/orders/:id', async (req, res) => {
    const id = req.params.id;
    const initLength = store.orders.length;
    store.orders = store.orders.filter(o => o.id !== id);
    if (store.orders.length < initLength) {
      store.save(store.PATHS.ORDER_FILE, store.orders);
      try { await db.deleteOrder(id); } catch(e) { console.error('DB delete order error:', e.message); }
      io.emit('orders', store.orders);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Order tidak ditemukan' });
    }
  });

  app.post('/api/cek-alamat-manual', async (req, res) => {
    const { alamat } = req.body;
    if (!alamat) return res.status(400).json({ error: 'Alamat tidak boleh kosong' });

    const picked = getAvailableKey();
    if (!picked) return res.status(500).json({ error: 'Semua API Key kena limit' });

    try {
      const model = store.settings.modelName || config.DEFAULT_MODEL;
      const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      const systemPrompt = `Kamu adalah asisten ekstraksi alamat pengiriman Indonesia. Dari teks alamat berikut, ekstrak informasi dan kembalikan HANYA JSON murni (tanpa markdown backticks, tanpa komentar) dengan struktur PERSIS ini:
{"desa": "nama desa atau kelurahan saja (tanpa kata Desa/Kel)", "kecamatan": "nama kecamatan saja (tanpa kata Kec)", "kabupaten": "nama kabupaten atau kota (tanpa kata Kab/Kota)", "provinsi": "nama provinsi", "patokan": "nama jalan, nomor rumah, atau patokan lokasi jika ada — kosongkan jika tidak ada", "kodepos": "kode pos 5 digit jika ada — kosongkan jika tidak diketahui", "alamat_baku": "alamat lengkap rapi format: [patokan jika ada], Desa [desa], Kec [kecamatan], [kabupaten], [provinsi] [kodepos]"}
Jika ada informasi yang tidak tersedia dalam teks, isi dengan string kosong. Jangan mengarang informasi yang tidak ada.`;

      const body = {
        contents: [{ role: 'user', parts: [{ text: alamat }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.1 },
      };

      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': picked.key }, body: JSON.stringify(body) });
      if (!r.ok) {
        const errData = await r.json().catch(() => ({}));
        throw new Error(errData?.error?.message || `Gagal menghubungi AI (HTTP ${r.status})`);
      }

      const aiData = await r.json();
      let text = aiData?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      text = text.trim().replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();

      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { throw new Error('Respons AI tidak valid format JSON'); }
      if (!parsed.desa || !parsed.kecamatan) throw new Error('Desa atau Kecamatan gagal diekstrak');
      if (!parsed.kabupaten) parsed.kabupaten = '';
      if (!parsed.patokan)   parsed.patokan   = '';
      if (!parsed.kodepos)   parsed.kodepos   = '';

      let ai_cod   = 'Area tidak tercover';
      let destLabel = null;

      // Search RajaOngkir destination
      const KOMERCE_API_KEY_DEFAULT = 'Yzx2NjTb1c484631212a74562TQwiwSB';
      const ORIGIN_ID_DEFAULT       = '73528';
      const komerceKey  = (store.settings.komerceApiKey || '').trim() || KOMERCE_API_KEY_DEFAULT;
      const originIdVal = (store.settings.originId || '').trim() || ORIGIN_ID_DEFAULT;

      const searchUrl = 'https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=' + encodeURIComponent(parsed.desa + ' ' + parsed.kecamatan) + '&limit=1';
      const destRes   = await fetch(searchUrl, { headers: { key: komerceKey } });
      const destData  = await destRes.json();

      if (destData?.data && destData.data.length > 0) {
        const dest = destData.data[0];
        destLabel  = dest.label || null;
        const destProvince = dest.province_name || '';
        const destCity     = dest.city_name || '';

        const IDE_COD_PROVINCES = [
          'ACEH', 'SUMATERA UTARA', 'SUMATERA BARAT', 'RIAU', 'KEPULAUAN RIAU',
          'JAMBI', 'BENGKULU', 'SUMATERA SELATAN', 'KEPULAUAN BANGKA BELITUNG', 'LAMPUNG',
          'BANTEN', 'DKI JAKARTA', 'JAWA BARAT', 'JAWA TENGAH', 'DI YOGYAKARTA', 'JAWA TIMUR',
          'BALI', 'NUSA TENGGARA BARAT',
          'KALIMANTAN BARAT', 'KALIMANTAN TENGAH', 'KALIMANTAN SELATAN', 'KALIMANTAN TIMUR', 'KALIMANTAN UTARA',
          'SULAWESI SELATAN', 'SULAWESI TENGGARA', 'SULAWESI TENGAH', 'SULAWESI UTARA', 'SULAWESI BARAT', 'GORONTALO',
        ];
        const isCovered = IDE_COD_PROVINCES.some(prov => {
          const p = destProvince.toUpperCase().trim();
          return p.includes(prov) || prov.includes(p);
        });

        if (!isCovered) {
          ai_cod = `Tidak Tercover COD (${destCity}, ${destProvince})`;
        } else {
          const costPayload = new URLSearchParams();
          costPayload.append('origin', originIdVal);
          costPayload.append('destination', dest.id);
          costPayload.append('weight', '1000');
          costPayload.append('courier', 'ide');
          costPayload.append('price', 'lowest');

          const costRes  = await fetch('https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost', {
            method: 'POST',
            headers: { key: komerceKey, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: costPayload.toString(),
          });
          const costData  = await costRes.json();
          const services  = costData?.data || [];
          const hasValid  = services.some(d => d.cost > 0);
          if (hasValid) {
            const cheapest = services.reduce((a, b) => a.cost < b.cost ? a : b);
            ai_cod = `COD Bisa — ${destCity} (${cheapest.etd})`;
          } else {
            ai_cod = `COD Tidak Bisa — ${destCity}, ${destProvince}`;
          }
        }
      }

      res.json({
        ok: true,
        data: {
          ai_alamat: [
            parsed.patokan ? parsed.patokan : null,
            `Kel/Desa ${parsed.desa}`,
            `Kec ${parsed.kecamatan}`,
            parsed.kabupaten || (destLabel ? destLabel.split(',')[2]?.trim() : null),
            parsed.provinsi,
            parsed.kodepos,
          ].filter(Boolean).join(', '),
          desa: parsed.desa,
          kecamatan: parsed.kecamatan,
          kabupaten: parsed.kabupaten,
          patokan: parsed.patokan,
          kodepos: parsed.kodepos,
          dest_label: destLabel,
          ai_cod,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/orders/backfill-ai', async (req, res) => {
    const pending = store.orders.filter(o => o.alamat && (!o.ai_alamat || !o.ai_cod));
    if (!pending.length) {
      return res.json({ ok: true, message: 'Semua order sudah memiliki data AI.', processed: 0 });
    }
    res.json({ ok: true, message: `Memproses ${pending.length} order di background...`, processing: pending.length });
    (async () => {
      for (const order of pending) {
        await processOrderAddressAI(order.id);
        await new Promise(r => setTimeout(r, 1500));
      }
      console.log(`Backfill AI selesai: ${pending.length} order diproses.`);
    })();
  });

  app.post('/api/orders/:id/recheck-ai', async (req, res) => {
    const { id } = req.params;
    const order = store.orders.find(o => o.id === id);
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    if (!order.alamat) return res.status(400).json({ error: 'Order tidak punya alamat' });
    delete order.ai_alamat;
    delete order.ai_cod;
    store.save(store.PATHS.ORDER_FILE, store.orders);
    io.emit('order_updated', order);
    res.json({ ok: true, message: 'Sedang memproses ulang...' });
    processOrderAddressAI(order.id).catch(e => console.error('[recheck-ai] Error:', e.message));
  });

  // ═══════════════════════════════════════════════════════════════════
  // CHAT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  app.post('/api/chat/:waId/stop', (req, res) => {
    const waId = decodeURIComponent(req.params.waId);
    const { stopped } = req.body;
    if (!store.settings.stoppedChats) store.settings.stoppedChats = [];

    if (stopped) {
      if (!store.settings.stoppedChats.includes(waId)) store.settings.stoppedChats.push(waId);
      console.log(`Chat ${waId.slice(-4)} di-STOP`);
    } else {
      store.settings.stoppedChats = store.settings.stoppedChats.filter(id => id !== waId);
      console.log(`Chat ${waId.slice(-4)} di-UNSTOP`);
    }

    store.save(store.PATHS.SET_FILE, store.settings);
    persistSettingsToDB(store.settings);
    io.emit('settings_updated', store.settings);
    res.json({ ok: true, stopped: !!stopped });
  });

  app.delete('/api/chat/:waId', async (req, res) => {
    const waId  = decodeURIComponent(req.params.waId);
    const phone = waId.replace(/@s\.whatsapp\.net|@c\.us/g, '');
    console.log(`Hapus semua chat untuk ${waId}...`);

    try {
      // 1. Hapus dari in-memory messages
      const before = store.messages.length;
      store.messages = store.messages.filter(m => {
        const mFrom  = m.from || '';
        const mPhone = mFrom.replace(/@s\.whatsapp\.net|@c\.us/g, '');
        return mFrom !== waId && mPhone !== phone;
      });
      console.log(`  Messages: ${before} -> ${store.messages.length} (${before - store.messages.length} dihapus)`);
      store.save(store.PATHS.MSG_FILE, store.messages);

      // 2. Hapus order state
      store.orderStates.delete(waId);
      store.orderStates.delete(phone);

      // 3. Hapus sent product images
      store.sentProductImages.delete(waId);
      store.sentProductImages.delete(phone);

      // 4. Hapus active claims
      store.activeClaims.delete(waId);
      store.activeClaims.delete(phone);
      await db.deleteActiveClaim(waId).catch(e => console.warn('[Delete] activeClaim error:', e.message));

      // 5. Hapus pending buffer & processing
      store.pendingBuffers.delete(waId);
      store.pendingBuffers.delete(phone);
      if (store.activeProcessing.has(waId)) {
        const task = store.activeProcessing.get(waId);
        if (task.controller) task.controller.abort();
        store.activeProcessing.delete(waId);
      }
      store.userLocks.delete(waId);
      store.userLocks.delete(phone);

      // 6. Hapus pending escalations untuk nomor ini
      store.pendingEscalations = store.pendingEscalations.filter(
        e => e.from !== waId && (e.from || '').replace(/@s\.whatsapp\.net|@c\.us/g, '') !== phone
      );

      // 7. Hapus dari DB
      if (db && db.pool) {
        await db.pool.query('DELETE FROM messages WHERE wa_id = $1 OR wa_id = $2', [waId, phone]).catch(e => console.warn('[Delete] DB messages error:', e.message));
        await db.pool.query('DELETE FROM orders WHERE wa_id = $1 OR wa_id = $2', [waId, phone]).catch(e => console.warn('[Delete] DB orders error:', e.message));
      }

      // 8. Hapus dari stopped list
      if (store.settings.stoppedChats?.includes(waId) || store.settings.stoppedChats?.includes(phone)) {
        store.settings.stoppedChats = store.settings.stoppedChats.filter(id => id !== waId && id !== phone);
        store.save(store.PATHS.SET_FILE, store.settings);
        persistSettingsToDB(store.settings);
      }

      // 9. Update dashboard
      io.emit('messages', store.messages);

      console.log(`Chat ${waId} berhasil dihapus`);
      res.json({ ok: true, deleted: before - store.messages.length });
    } catch (err) {
      console.error(`Gagal hapus chat ${waId}:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/chat/send-media', multerMemory.single('file'), async (req, res) => {
    const { number, caption } = req.body;
    const file = req.file;
    if (!file || !number) return res.status(400).json({ error: 'File dan nomor tujuan wajib diisi' });
    if (store.settings.channel === 'macrodroid') return res.status(400).json({ error: 'Kirim media dari dashboard tidak didukung untuk channel MacroDroid.' });
    if (!waConfigured) return res.status(400).json({ error: 'WhatsApp Cloud API belum dikonfigurasi' });

    try {
      const target    = normalizeIdNumber(number);
      const mimetype  = file.mimetype;
      const mediaType = mimetype.startsWith('video/') ? 'video' : 'image';
      console.log(`[Chat Media] Upload ${mediaType} "${file.originalname}" ke Meta...`);
      const mediaId = await uploadWhatsAppMediaBuffer(file.buffer, mimetype, file.originalname);
      if (!mediaId) return res.status(500).json({ error: 'Gagal upload media ke WhatsApp' });
      console.log(`[Chat Media] Kirim ${mediaType} ke ${target}...`);

      const metaResp = await sendWhatsAppMediaById(target, mediaId, mediaType, caption || '');
      if (!metaResp?.messages?.[0]?.id) return res.status(500).json({ error: 'WhatsApp tidak mengkonfirmasi pengiriman media' });
      console.log(`[Chat Media] Berhasil! Message ID: ${metaResp.messages[0].id}`);

      const label = mediaType === 'video' ? 'Video' : 'Gambar';
      const msgObj = {
        id: 'man-' + Date.now(),
        from: target,
        body: '[Anda mengirim pesan]',
        timestamp: new Date().toISOString(),
        replied: true,
        aiReply: caption ? `${label}: ${caption}` : `${label} dikirim`,
        manual: true,
      };
      store.messages.unshift(msgObj);
      if (store.messages.length > config.MESSAGE_LIMIT) store.messages = store.messages.slice(0, config.MESSAGE_LIMIT);
      store.save(store.PATHS.MSG_FILE, store.messages);
      try { store.persistMessageToDB(msgObj); } catch(e) {}
      io.emit('messages', store.messages);
      res.json({ ok: true });
    } catch(e) {
      console.error(`[Chat Media] Error:`, e.message, e.graphError || '');
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // API KEY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════

  const MAX_API_KEY_SLOTS = config.MAX_API_KEY_SLOTS;

  app.post('/api/savekey', (req, res) => {
    const body = req.body || {};
    const anyFilled = Array.from({ length: MAX_API_KEY_SLOTS }, (_, i) => body[`key${i + 1}`]).some(v => v);
    if (!anyFilled) return res.status(400).json({ error: 'Isi minimal 1 API key' });
    if (body.key1 && body.key1.length < 10) return res.status(400).json({ error: 'API Key 1 terlalu pendek' });

    const envPath = path.join(__dirname, '.env');
    let env = '';
    try { env = fs.readFileSync(envPath, 'utf8'); } catch(e) {}

    const setEnvVar = (envStr, name, value) => {
      if (value === undefined) return envStr;
      const v = (value || '').trim();
      const marker = `${name}=`;
      if (envStr.includes(marker)) {
        return envStr.split('\n').map(line => line.startsWith(marker) ? `${name}=${v}` : line).join('\n');
      }
      return envStr + `\n${name}=${v}`;
    };

    for (let i = 1; i <= MAX_API_KEY_SLOTS; i++) {
      const val = body[`key${i}`];
      env = setEnvVar(env, `GEMINI_API_KEY_${i}`, val);
      if (val !== undefined) process.env[`GEMINI_API_KEY_${i}`] = (val || '').trim();
    }
    fs.writeFileSync(envPath, env.trim() + '\n');

    emitKeyStatuses();
    res.json({ ok: true });
  });

  app.post('/api/testkey', async (req, res) => {
    const slot = Number(req.body?.slot) || 1;
    const keys = getApiKeys();
    const key  = keys[slot - 1];
    if (!key) return res.json({ ok: false, error: `Key ${slot} belum diisi` });
    try {
      const model = store.settings.modelName || config.DEFAULT_MODEL;
      const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const r     = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Halo, balas dengan kata OK saja.' }] }] }),
      });
      const data = await r.json();
      if (!r.ok) return res.json({ ok: false, error: data?.error?.message || ('HTTP ' + r.status) });
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '(kosong)';
      res.json({ ok: true, reply: text });
    } catch(e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.post('/api/retry', (req, res) => {
    retryFailedMessages();
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════════════
  // MANUAL SEND
  // ═══════════════════════════════════════════════════════════════════

  app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Isi number dan message' });
    if (store.settings.channel === 'macrodroid') {
      return res.status(400).json({ error: 'Kirim manual dari dashboard belum didukung untuk channel MacroDroid.' });
    }
    if (!waConfigured) return res.status(400).json({ error: 'WhatsApp Cloud API belum dikonfigurasi (cek WHATSAPP_TOKEN & PHONE_NUMBER_ID di .env)' });

    try {
      const target = normalizeIdNumber(number);
      console.log(`[Manual Send] Kirim ke: ${target}, panjang pesan: ${message.length} karakter`);
      const metaResponse = await sendWhatsAppText(target, message);
      console.log(`[Manual Send] Respons Meta:`, JSON.stringify(metaResponse));
      if (!metaResponse || !metaResponse.messages?.[0]?.id) {
        console.error(`[Manual Send] Meta tidak mengembalikan message ID! Response:`, metaResponse);
        return res.status(500).json({ error: 'WhatsApp tidak mengkonfirmasi pengiriman pesan. Kemungkinan nomor tidak terdaftar di WhatsApp atau di luar jendela 24 jam.' });
      }
      console.log(`[Manual Send] Berhasil! Message ID: ${metaResponse.messages[0].id}`);
      const msgObj = {
        id: 'man-' + Date.now(),
        from: target,
        body: '[Anda mengirim pesan]',
        timestamp: new Date().toISOString(),
        replied: true,
        aiReply: message,
        manual: true,
      };
      store.messages.unshift(msgObj);
      if (store.messages.length > config.MESSAGE_LIMIT) store.messages = store.messages.slice(0, config.MESSAGE_LIMIT);
      store.save(store.PATHS.MSG_FILE, store.messages);
      store.persistMessageToDB(msgObj);
      io.emit('messages', store.messages);
      res.json({ ok: true });
    } catch(e) {
      console.error(`[Manual Send] Error:`, e.message, e.graphError || '');
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // AI TEST MODE
  // ═══════════════════════════════════════════════════════════════════

  app.post('/api/ai-test/start', async (req, res) => {
    if (activeTestSession?.status === 'running') {
      return res.status(409).json({ error: 'Test session sudah berjalan' });
    }
    const sessionId = 'test_' + Date.now();
    res.json({ ok: true, sessionId });
    runAITestSession(sessionId).catch(e => {
      console.error('[AI Test] Error:', e.message);
      if (activeTestSession) activeTestSession.status = 'error';
      io.emit('ai_test_update', { type: 'error', message: e.message });
    });
  });

  app.post('/api/ai-test/stop', (req, res) => {
    if (activeTestSession) activeTestSession.status = 'stopped';
    res.json({ ok: true });
  });

  app.get('/api/ai-test/result', (req, res) => {
    res.json(activeTestSession || { status: 'idle' });
  });

  // ═══════════════════════════════════════════════════════════════════
  // INTERNAL TEST MODE
  // ═══════════════════════════════════════════════════════════════════

  app.post('/api/test/internal/send', async (req, res) => {
    const { sender, message, senderName } = req.body || {};
    if (!sender || !message) return res.status(400).json({ error: 'Isi sender dan message' });

    const from = sender.replace(/\D/g, '');
    const name = senderName || sender;
    const wamid = 'test_internal_' + Date.now();

    const entry = {
      id: Date.now(), from, senderName: name, body: message, wamid,
      timestamp: new Date().toISOString(), replied: false, aiReply: null, type: 'text',
    };
    store.messages.unshift(entry);
    store.save(store.PATHS.MSG_FILE, store.messages);
    io.emit('new_message', entry);

    processCustomerMessage(from, name, message, wamid, null, null, null, null, null)
      .catch(e => console.error('[Internal Test] Error:', e.message));

    await new Promise(r => setTimeout(r, 3000));
    const updated = store.messages.find(m => m.wamid === wamid);
    res.json({ ok: true, received: true, entryId: entry.id, aiReplyPending: !updated?.aiReply, message: 'Pesan diterima, AI sedang proses...' });
  });

  app.post('/api/test/internal/reset', (req, res) => {
    store.testTurns.length = 0;
    store.testRawCaptures.length = 0;
    store._rawCaptureId = 0;
    store._capturedGeminiRequest  = null;
    store._capturedGeminiResponse = null;
    store._prevTestStep = null;
    try { fs.writeFileSync(store.PATHS.RAW_CAP_FILE, '[]'); } catch(e) {}
    console.log('[Internal Test] State di-reset');
    res.json({ ok: true });
  });

  app.get('/api/test/internal/turns', (req, res) => {
    res.json(store.testTurns);
  });

  app.get('/api/test/internal/raw-captures', (req, res) => {
    res.json(store.testRawCaptures);
  });

} // end registerApiRoutes

// ─────────────────────────────────────────────────────────────────────
// AI Test Session Runner
// Runs persona scripts through aiReply() + evaluator, emits to dashboard.
// ─────────────────────────────────────────────────────────────────────
async function runAITestSession(sessionId) {
  const ioRef = store.io;

  console.log(`\n[AI Test] Sesi ${sessionId} dimulai`);

  activeTestSession = {
    id: sessionId,
    status: 'running',
    startedAt: new Date().toISOString(),
    personas: AI_TEST_PERSONAS.map(p => ({
      id: p.id, name: p.name, label: p.label,
      turns: [], avgSkor: null, done: false,
    })),
  };

  ioRef?.emit('ai_test_update', { type: 'session_start', session: activeTestSession });

  for (const persona of AI_TEST_PERSONAS) {
    const personaState = activeTestSession.personas.find(p => p.id === persona.id);
    const history = [];

    for (let i = 0; i < persona.script.length; i++) {
      if (activeTestSession?.status === 'stopped') break;

      const customerMsg = persona.script[i];
      ioRef?.emit('ai_test_update', { type: 'turn_start', personaId: persona.id, turnIndex: i, customerMsg });

      let botReply = null;
      try {
        botReply = await aiReply(customerMsg, persona.name, history, null);
      } catch (e) {
        botReply = '[ERROR: ' + e.message + ']';
      }
      if (!botReply) botReply = '[Tidak ada balasan — key habis atau error]';

      await sleep(20000);

      const evalResult = await evaluateTestTurn(persona.name, customerMsg, botReply, i);

      const turn = {
        index: i,
        customerMsg,
        botReply: botReply.replace(/\[ORDER_DATA\][\s\S]*?\[\/ORDER_DATA\]/g, '[ORDER_DATA — tersimpan]'),
        evalResult,
        timestamp: new Date().toISOString(),
      };

      personaState.turns.push(turn);
      history.push({ body: customerMsg, aiReply: botReply });
      ioRef?.emit('ai_test_update', { type: 'turn_done', personaId: persona.id, turn });

      await sleep(20000);
    }

    const skors = personaState.turns.map(t => t.evalResult?.skor || 0).filter(s => s > 0);
    personaState.avgSkor = skors.length ? (skors.reduce((a, b) => a + b, 0) / skors.length).toFixed(1) : null;
    personaState.done = true;
    ioRef?.emit('ai_test_update', { type: 'persona_done', personaId: persona.id, avgSkor: personaState.avgSkor });
    console.log(`[AI Test] ${persona.name} selesai — avg skor: ${personaState.avgSkor}`);
  }

  activeTestSession.status = 'done';
  activeTestSession.finishedAt = new Date().toISOString();
  ioRef?.emit('ai_test_update', { type: 'session_done', session: activeTestSession });
  console.log(`[AI Test] Sesi ${sessionId} selesai`);
}

// ─────────────────────────────────────────────────────────────────────
// AI Test Evaluator — evaluates one bot turn using Gemini as judge
// ─────────────────────────────────────────────────────────────────────
async function evaluateTestTurn(personaName, customerMsg, botReply, turnIndex) {
  const picked = getAvailableKey();
  if (!picked) return { skor: 0, catatan: 'Key tidak tersedia untuk evaluasi' };

  const evalPrompt = `Kamu adalah evaluator kualitas chatbot CS toko online Indonesia.

Persona customer: "${personaName}" (giliran ke-${turnIndex + 1})
Pesan customer: "${customerMsg}"
Jawaban bot: "${botReply}"

Nilai jawaban bot ini dari 1-5 berdasarkan:
1. Relevansi — menjawab pertanyaan dengan tepat
2. Gaya bahasa — ramah, tidak kaku, natural
3. CTA — ada ajakan/pertanyaan lanjutan yang mendorong ke closing
4. Kepatuhan aturan — tidak mengarang info di luar KB, tidak membujuk jika batal, dll

Balas HANYA JSON valid (tidak ada teks lain):
{"skor": <1-5>, "aspek": {"relevansi": <1-5>, "gaya": <1-5>, "cta": <1-5>, "kepatuhan": <1-5>}, "catatan": "<1 kalimat singkat>"}`;

  try {
    const result = await callGeminiDirect(picked.key, picked.slot, evalPrompt, 'evaluator', [], null);
    if (!result.ok) {
      if (result.status429) markKeyLimited(picked.pos, result.quotaId, result.retryDelaySec);
      return { skor: 0, catatan: 'Evaluasi gagal: ' + (result.error || 'unknown') };
    }
    const clean = result.text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return { skor: 0, catatan: 'Parse error: ' + e.message };
  }
}

const { normalizeIdNumber } = require('./config');

module.exports = { registerApiRoutes };
