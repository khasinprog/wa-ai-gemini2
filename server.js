/**
 * server.js — Main orchestrator
 * Wires up all modules, initializes Express + Socket.io, starts server.
 *
 * Modules:
 *   state-store.js       — Shared state (settings, messages, orders, etc)
 *   knowledge-base.js    — KB parsing & relevance
 *   gemini-service.js    — Gemini API calls, key rotation, rate-limit
 *   gemini-thinker.js    — Intent classifier (Thinker stage)
 *   order-state.js       — Order flow management
 *   message-postprocess.js — Post-process: tags, validation
 *   message-processor.js — Chat processing pipeline
 *   chat-helpers.js      — History building, reply delay
 *   whatsapp-api.js      — WhatsApp Cloud API send/download
 *   webhook-handler.js   — Meta + MacroDroid webhooks
 *   api-routes.js        — Dashboard API routes
 *   admin-escalation.js  — Admin escalation handling
 *   address-ai.js        — AI address extraction
 *   config.js            — Constants
 *   db.js                — PostgreSQL
 *   ongkir-helper.js     — Shipping cost
 *   telegram-service.js  — Telegram escalation bot
 *   followup-scheduler.js — Follow-up timers
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const cors       = require('cors');
const crypto     = require('crypto');
const multer     = require('multer');

// ── Modules ──
const store    = require('./state-store');
const config   = require('./config');
const db       = require('./db');
const tg       = require('./telegram-service');
const scheduler = require('./followup-scheduler');
const { registerWebhookRoutes } = require('./webhook-handler');
const { registerApiRoutes }     = require('./api-routes');
const { loadOrderStates, startCleanupInterval } = require('./order-state');
const { retryFailedMessages }   = require('./message-processor');
const { waConfigured }          = require('./whatsapp-api');
const { notifyAdminEscalationAnswer } = require('./admin-escalation');

// ── Auto-generate ADMIN_PASSWORD if missing ──
if (!process.env.ADMIN_PASSWORD) {
  const generatedPassword = crypto.randomBytes(6).toString('hex');
  process.env.ADMIN_PASSWORD = generatedPassword;
  const fs = require('fs');
  const envPath = path.join(__dirname, '.env');
  fs.appendFileSync(envPath, `\nADMIN_PASSWORD=${generatedPassword}\n`);
  console.log('\n\x1b[33m========================================================\x1b[0m');
  console.log('\x1b[31m[KEAMANAN]\x1b[0m \x1b[33mPassword Admin untuk Web Dashboard dibuat otomatis!\x1b[0m');
  console.log(`\x1b[32mPASSWORD: ${generatedPassword}\x1b[0m`);
  console.log('\x1b[33mHarap catat password ini. Anda bisa mengubahnya di file .env\x1b[0m');
  console.log('\x1b[33m========================================================\n\x1b[0m');
}

const SERVER_AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

// ── WhatsApp config checks ──
if (!waConfigured) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m WHATSAPP_TOKEN / PHONE_NUMBER_ID belum diisi di .env');
}
if (!process.env.WEBHOOK_VERIFY_TOKEN || !process.env.META_APP_SECRET) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m WEBHOOK_VERIFY_TOKEN / META_APP_SECRET belum diisi di .env');
}
if (!process.env.MACRODROID_BRIDGE_TOKEN) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m MACRODROID_BRIDGE_TOKEN belum diisi di .env');
}

// ── Express + Socket.io ──
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// Set io reference in state store
store.setIo(io);

// Auth middleware for Socket.io
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token === SERVER_AUTH_TOKEN) next();
  else next(new Error("Unauthorized"));
});

app.use(cors());
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Static file serving
app.use('/images', express.static(store.PATHS.IMAGES_DIR));
app.use('/audio', express.static(store.PATHS.AUDIO_DIR));
app.use('/api/ongkir', require('./routes/ongkir'));

// ── Login endpoint (before auth middleware) ──
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = config.LOGIN_MAX_ATTEMPTS;
const LOGIN_WINDOW_MS = config.LOGIN_WINDOW_MS;

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (now > attempts.resetAt) { attempts.count = 0; attempts.resetAt = now + LOGIN_WINDOW_MS; }
  if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
    const secondsLeft = Math.ceil((attempts.resetAt - now) / 1000);
    return res.status(429).json({ error: `Terlalu banyak percobaan login. Coba lagi dalam ${secondsLeft} detik.`, retryAfter: secondsLeft });
  }
  attempts.count++;
  loginAttempts.set(ip, attempts);
  const { password } = req.body;
  if (typeof password !== 'string' || password.length > 100) return res.status(400).json({ error: 'Input tidak valid' });
  if (password === process.env.ADMIN_PASSWORD) {
    loginAttempts.delete(ip);
    console.log(`✅ Login berhasil dari IP ${ip}`);
    res.json({ token: SERVER_AUTH_TOKEN });
  } else {
    console.log(`❌ Login gagal dari IP ${ip}`);
    res.status(401).json({ error: 'Password salah' });
  }
});

// HasKey check (no auth needed)
app.get('/api/haskey', (_, res) => {
  const { getApiKeys } = require('./gemini-service');
  const keys = getApiKeys();
  res.json({ ok: keys.some(k => k.length >= 10), keys: keys.map(k => !!(k && k.length >= 10)) });
});

// Auth middleware for all subsequent /api routes
app.use('/api', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${SERVER_AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
  next();
});

// ── Register routes from modules ──
registerWebhookRoutes(app);
registerApiRoutes(app, io);

// ── Socket.io connection ──
io.on('connection', socket => {
  console.log('Browser terhubung ke dashboard');
  socket.emit('status', waConfigured ? 'connected' : 'disconnected');
  socket.emit('qr', null);
});

// ── Test simulate endpoint ──
const { processCustomerMessage } = require('./message-processor');

app.post('/test/simulate', async (req, res) => {
  const testToken = req.headers['x-test-token'];
  const expectedToken = process.env.TEST_TOKEN || '';
  if (expectedToken && testToken !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { sender, message, senderName } = req.body || {};
    if (!sender || !message) return res.status(400).json({ error: 'Isi sender dan message' });

    const from = sender.replace(/\D/g, '');
    const name = senderName || sender;
    const wamid = 'test_' + Date.now();

    const entry = {
      id: Date.now(), from, body: message, timestamp: Date.now(),
      wamid, replied: false, aiReply: null, type: 'text',
    };
    store.messages.unshift(entry);
    store.save(store.PATHS.MSG_FILE, store.messages);
    io.emit('new_message', entry);

    processCustomerMessage(from, name, message, wamid, null, null, null, null, null)
      .catch(e => console.error('🧪 [TEST] Error:', e.message));

    await new Promise(r => setTimeout(r, 3000));
    const updated = store.messages.find(m => m.wamid === wamid);
    res.json({ ok: true, received: true, entryId: entry.id, aiReplyPending: !updated?.aiReply, message: 'Pesan diterima, AI sedang proses...' });
  } catch (e) {
    console.error('🧪 [TEST] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/test/response/:phone', (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const entries = store.messages.filter(m => m.from === phone).sort((a, b) => a.id - b.id).slice(-5);
  res.json({
    phone,
    totalMessages: store.messages.filter(m => m.from === phone).length,
    last5: entries.map(e => ({ id: e.id, body: e.body, aiReply: e.aiReply, replied: e.replied, timestamp: new Date(e.timestamp).toISOString() })),
  });
});

// ── Start Server ──
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log('\n==========================================');
  console.log('  WA AI Assistant (Cloud API + MacroDroid) berjalan!');
  try { await db.initDB(); } catch(e) { console.error('Failed to init DB:', e.message); }
  loadOrderStates();
  startCleanupInterval();
  console.log(`  Buka browser: http://localhost:${PORT}`);
  console.log(`  Channel aktif: ${store.settings.channel === 'macrodroid' ? 'MacroDroid' : 'WhatsApp Cloud API'}`);
  console.log('==========================================\n');

  setInterval(retryFailedMessages, 5 * 60 * 1000);

  if (tg.isConfigured()) {
    tg.startPolling().then(ok => {
      if (ok) console.log('✅ [P2-D] Telegram escalation bot aktif');
    }).catch(e => console.error('[P2-D] Telegram bot error:', e.message));
    // Register admin answer handler
    tg.onReply(async ({ adminText }) => {
      try { await notifyAdminEscalationAnswer(adminText); }
      catch(e) { console.error('[P2-D] Error handle admin reply:', e.message); }
    });
  }
});

module.exports = { app, server, io };
