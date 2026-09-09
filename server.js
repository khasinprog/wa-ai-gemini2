/**
 * server.js — Main orchestrator
 * Minimal entry point: wires up Express + Socket.io, registers module routes,
 * handles login/auth, PWA push, and test endpoints.
 *
 * Core logic lives in modules:
 *   state-store.js, order-state.js, message-processor.js, webhook-handler.js,
 *   gemini-service.js, gemini-thinker.js, chat-helpers.js, whatsapp-api.js,
 *   message-postprocess.js, admin-escalation.js, address-ai.js,
 *   knowledge-base.js, config.js, db.js, api-routes.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');
const crypto     = require('crypto');
const multer     = require('multer');
const bcrypt     = require('bcryptjs');

// ── Module imports ──────────────────────────────────────────────────
const db         = require('./db');
const config     = require('./config');
const store      = require('./state-store');
const tg         = require('./telegram-service');
const { loadOrderStates, startCleanupInterval } = require('./order-state');
const { retryFailedMessages, processCustomerMessage } = require('./message-processor');
const { registerWebhookRoutes } = require('./webhook-handler');
const { registerApiRoutes }     = require('./api-routes');
const { waConfigured }          = require('./whatsapp-api');
const { getApiKeys, activeKeyIndex: geminiActiveKeyIndex } = require('./gemini-service');
const { sendWhatsAppText }      = require('./whatsapp-api');
const { normalizeIdNumber }     = require('./config');

// ── PWA Push Notification (VAPID) ──────────────────────────────────
const webpush = require('web-push');
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:admin@trustiomart.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
const PUSH_SUB_FILE = path.join(__dirname, 'push-subscriptions.json');
let pushSubscriptions = [];
try { if (fs.existsSync(PUSH_SUB_FILE)) pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_SUB_FILE, 'utf8')); } catch(e) {}
function savePushSubscriptions() {
  try { fs.writeFile(PUSH_SUB_FILE, JSON.stringify(pushSubscriptions, null, 2), () => {}); } catch(e) {}
}
async function sendPushNotification(data) {
  if (!pushSubscriptions.length || !VAPID_PUBLIC_KEY) return;
  const payload = JSON.stringify(data);
  const dead = [];
  for (const sub of pushSubscriptions) {
    try { await webpush.sendNotification(sub, payload); }
    catch (err) { if (err.statusCode === 410) dead.push(sub.endpoint); }
  }
  if (dead.length) {
    pushSubscriptions = pushSubscriptions.filter(s => !dead.includes(s.endpoint));
    savePushSubscriptions();
  }
}

// ── Login Rate Limiting ────────────────────────────────────────────
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = config.LOGIN_MAX_ATTEMPTS;
const LOGIN_WINDOW_MS = config.LOGIN_WINDOW_MS;

// ── Auto-generate ADMIN_PASSWORD if missing ─────────────────────────
const SALT_ROUNDS = 10;
if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) {
  const generatedPassword = crypto.randomBytes(6).toString('hex');
  const hash = bcrypt.hashSync(generatedPassword, SALT_ROUNDS);
  const envPath = path.join(__dirname, '.env');
  fs.appendFileSync(envPath, `\nADMIN_PASSWORD_HASH=${hash}\n`);
  console.log('\n\x1b[33m========================================================\x1b[0m');
  console.log('\x1b[31m[KEAMANAN]\x1b[0m \x1b[33mPassword Admin untuk Web Dashboard dibuat otomatis!\x1b[0m');
  console.log(`\x1b[32mPASSWORD: ${generatedPassword}\x1b[0m`);
  console.log('\x1b[33mHarap catat password ini. Password disimpan sebagai hash di .env\x1b[0m');
  console.log('\x1b[33m========================================================\n\x1b[0m');
  process.env.ADMIN_PASSWORD = generatedPassword; // keep in memory for this session
}

// Migrate plaintext password to hash if needed
if (process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, SALT_ROUNDS);
  const envPath = path.join(__dirname, '.env');
  try {
    let env = fs.readFileSync(envPath, 'utf8');
    env = env.replace(/ADMIN_PASSWORD=(.+)/m, `ADMIN_PASSWORD_HASH=${hash}\n# ADMIN_PASSWORD migrated to hash`);
    fs.writeFileSync(envPath, env);
    console.log('✅ [KEAMANAN] Password lama sudah di-hash dan disimpan ke ADMIN_PASSWORD_HASH');
  } catch(e) {}
  process.env.ADMIN_PASSWORD_HASH = hash;
}

const SERVER_AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

// ── Env warnings ────────────────────────────────────────────────────
if (!waConfigured) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m WHATSAPP_TOKEN / PHONE_NUMBER_ID belum diisi di .env — bot belum bisa kirim pesan lewat WhatsApp Cloud API.');
}
if (!process.env.WEBHOOK_VERIFY_TOKEN || !process.env.META_APP_SECRET) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m WEBHOOK_VERIFY_TOKEN / META_APP_SECRET belum diisi di .env — verifikasi webhook & validasi signature belum aktif.');
}
if (!process.env.MACRODROID_BRIDGE_TOKEN) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m MACRODROID_BRIDGE_TOKEN belum diisi di .env — endpoint /webhook/wa-incoming belum terproteksi token.');
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS + SOCKET.IO SETUP
// ═══════════════════════════════════════════════════════════════════
// ── CORS whitelist ──────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS }
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token === SERVER_AUTH_TOKEN) next();
  else next(new Error("Unauthorized"));
});

store.setIo(io);

app.use(cors({
  origin: function(origin, callback) {
    if (ALLOWED_ORIGINS.includes('*')) return callback(null, true);
    if (!origin) return callback(null, true); // mobile apps, curl
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('CORS: Origin tidak diizinkan'));
  }
}));
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Static directories ──────────────────────────────────────────────
app.use('/images', express.static(store.PATHS.IMAGES_DIR));
app.use('/audio',  express.static(store.PATHS.AUDIO_DIR));

// ── PWA Push: VAPID key (no auth — frontend needs before login) ────
app.get('/api/push/vapid-key', (_, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

// ── Ongkir router (no auth — internal proxy) ────────────────────────
app.use('/api/ongkir', require('./routes/ongkir'));

// ═══════════════════════════════════════════════════════════════════
// LOGIN ENDPOINT (with rate limiting — NO auth required)
// ═══════════════════════════════════════════════════════════════════
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();

  const attempts = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (now > attempts.resetAt) {
    attempts.count = 0;
    attempts.resetAt = now + LOGIN_WINDOW_MS;
  }

  if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
    const secondsLeft = Math.ceil((attempts.resetAt - now) / 1000);
    console.log(`🔒 Login rate limited dari IP ${ip} (${attempts.count} percobaan)`);
    return res.status(429).json({
      error: `Terlalu banyak percobaan login. Coba lagi dalam ${secondsLeft} detik.`,
      retryAfter: secondsLeft
    });
  }

  attempts.count++;
  loginAttempts.set(ip, attempts);

  const { password } = req.body;
  if (typeof password !== 'string' || password.length > 100) {
    return res.status(400).json({ error: 'Input tidak valid' });
  }

  // Check password (bcrypt hash or plaintext fallback for backward compat)
  const storedHash = process.env.ADMIN_PASSWORD_HASH;
  const storedPlain = process.env.ADMIN_PASSWORD;
  let passwordValid = false;
  if (storedHash) {
    passwordValid = bcrypt.compareSync(password, storedHash);
  } else if (storedPlain) {
    passwordValid = (password === storedPlain);
  }

  if (passwordValid) {
    loginAttempts.delete(ip);
    console.log(`✅ Login berhasil dari IP ${ip}`);
    res.json({ token: SERVER_AUTH_TOKEN });
  } else {
    console.log(`❌ Login gagal dari IP ${ip} (percobaan ${attempts.count}/${LOGIN_MAX_ATTEMPTS})`);
    res.status(401).json({ error: 'Password salah' });
  }
});

// ── Haskey check (NO auth — called before login) ───────────────────
app.get('/api/haskey', (_, res) => {
  const keys = getApiKeys();
  res.json({
    ok: keys.some(k => k.length >= 10),
    keys: keys.map(k => !!(k && k.length >= 10)),
    activeIndex: geminiActiveKeyIndex || 0,
  });
});

// ── Auth middleware for ALL /api/* routes after this ────────────────
app.use('/api', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${SERVER_AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
  next();
});

// ── PWA Push subscribe/unsubscribe (auth required) ──────────────────
app.post('/api/push/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
  pushSubscriptions.push(subscription);
  savePushSubscriptions();
  console.log(`🔔 Push subscription ditambahkan (${pushSubscriptions.length} total)`);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
  savePushSubscriptions();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
// REGISTER MODULE ROUTES
// ═══════════════════════════════════════════════════════════════════
registerWebhookRoutes(app);
registerApiRoutes(app, io);

// ═══════════════════════════════════════════════════════════════════
// TEST ENDPOINTS (NOT in api-routes module)
// ═══════════════════════════════════════════════════════════════════
app.post('/test/simulate', async (req, res) => {
  const testToken = req.headers['x-test-token'];
  const expectedToken = process.env.TEST_TOKEN || '';
  if (expectedToken && testToken !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized: X-Test-Token tidak cocok' });
  }
  try {
    const { sender, message, senderName } = req.body || {};
    if (!sender || !message) return res.status(400).json({ error: 'Isi sender dan message' });

    const from = sender.replace(/\D/g, '');
    const name = senderName || sender;
    const wamid = 'test_' + Date.now();

    console.log(`\n🧪 [TEST SIMULATE] ${name} (${from}): "${message}"`);

    const entry = {
      id: Date.now(), from, body: message, timestamp: Date.now(),
      wamid, replied: false, aiReply: null, type: 'text',
    };
    store.messages.unshift(entry);
    store.save(store.PATHS.MSG_FILE, store.messages);
    store.io?.emit('new_message', entry);

    processCustomerMessage(from, name, message, wamid, null, null, null, null, null)
      .catch(e => console.error('🧪 [TEST] Error:', e.message));

    await new Promise(r => setTimeout(r, 3000));

    const updated = store.messages.find(m => m.wamid === wamid);
    res.json({
      ok: true, received: true, entryId: entry.id,
      aiReplyPending: !updated?.aiReply,
      message: 'Pesan diterima, AI sedang proses...'
    });
  } catch (e) {
    console.error('🧪 [TEST] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/test/response/:phone', (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const entries = store.messages
    .filter(m => m.from === phone)
    .sort((a, b) => a.id - b.id)
    .slice(-5);

  res.json({
    phone,
    totalMessages: store.messages.filter(m => m.from === phone).length,
    last5: entries.map(e => ({
      id: e.id, body: e.body, aiReply: e.aiReply, replied: e.replied,
      timestamp: new Date(e.timestamp).toISOString(),
    })),
  });
});

// ═══════════════════════════════════════════════════════════════════
// SOCKET.IO + SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════
io.on('connection', socket => {
  console.log('Browser terhubung ke dashboard');
  socket.emit('status', waConfigured ? 'connected' : 'disconnected');
  socket.emit('qr', null);
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log('\n==========================================');
  console.log('  WA AI Assistant (Cloud API + MacroDroid) berjalan!');
  try { await db.initDB(); } catch(e) { console.error('Failed to init DB:', e.message); }
  loadOrderStates();
  startCleanupInterval();
  console.log(`  Buka browser: http://localhost:${PORT}`);
  console.log(`  Channel aktif saat ini: ${store.settings.channel === 'macrodroid' ? 'MacroDroid' : 'WhatsApp Cloud API'} (bisa diganti di dashboard)`);
  console.log(`  Webhook Cloud API (Meta App Dashboard): https://<domain-kamu>/webhook`);
  console.log(`  Webhook MacroDroid (Macro 1 - HTTP Request): https://<domain-kamu>/webhook/wa-incoming`);
  console.log('==========================================\n');

  setInterval(retryFailedMessages, 5 * 60 * 1000);

  // P2-D: Telegram bot polling untuk eskalasi
  if (tg.isConfigured()) {
    tg.startPolling().then(ok => {
      if (ok) console.log('✅ [P2-D] Telegram escalation bot aktif');
    });
    tg.onReply(async (adminText) => {
      console.log('[P2-D] Balasan admin dari Telegram diterima, diproses...');
      const { handleAdminEscalationAnswer } = require('./admin-escalation');
      await handleAdminEscalationAnswer(adminText);
    });
    tg.onTransferApproved(async ({ customerPhone, customerName, orderId, approved }) => {
      const jid = normalizeIdNumber(customerPhone);
      if (approved) {
        const msg =
          `✅ Halo Kak! Pembayaran transfer kakak sudah kami verifikasi dan diterima 🎉\n\n` +
          `Pesanan kakak langsung kami proses untuk packing dan pengiriman ya. Terima kasih sudah order! 🙏`;
        sendWhatsAppText(jid, msg).catch(e => console.error('[F2] Gagal kirim konfirmasi approve:', e.message));
        if (orderId) db.updateOrder(orderId, { status: 'diproses' }).catch(() => {});
        console.log(`[F2] ✅ Transfer approved → konfirmasi WA terkirim ke ${customerPhone}`);
      } else {
        const msg =
          `Halo Kak, mohon maaf — bukti transfer yang kami terima belum bisa kami verifikasi 🙏\n\n` +
          `Boleh kakak cek ulang dan kirim kembali bukti transfernya ya? Pastikan nominal dan rekening tujuan sudah sesuai.`;
        sendWhatsAppText(jid, msg).catch(e => console.error('[F2] Gagal kirim notif reject:', e.message));
        console.log(`[F2] ❌ Transfer rejected → notif WA terkirim ke ${customerPhone}`);
      }
    });
  } else {
    console.log('ℹ️ [P2-D] Telegram bot tidak aktif (TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_CHAT_ID belum diisi)');
  }
});
