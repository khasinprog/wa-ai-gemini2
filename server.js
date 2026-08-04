const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');
const crypto     = require('crypto');

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Auto-generate ADMIN_PASSWORD if missing
if (!process.env.ADMIN_PASSWORD) {
  const generatedPassword = crypto.randomBytes(6).toString('hex');
  process.env.ADMIN_PASSWORD = generatedPassword;
  const envPath = path.join(__dirname, '.env');
  fs.appendFileSync(envPath, `\nADMIN_PASSWORD=${generatedPassword}\n`);
  console.log('\n\x1b[33m========================================================\x1b[0m');
  console.log('\x1b[31m[KEAMANAN]\x1b[0m \x1b[33mPassword Admin untuk Web Dashboard dibuat otomatis!\x1b[0m');
  console.log(`\x1b[32mPASSWORD: ${generatedPassword}\x1b[0m`);
  console.log('\x1b[33mHarap catat password ini. Anda bisa mengubahnya di file .env\x1b[0m');
  console.log('\x1b[33m========================================================\n\x1b[0m');
}

const SERVER_AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

// ── WhatsApp Cloud API (Meta) config ──────────────────────────────
// WHATSAPP_TOKEN   : System User access token permanen (Meta App Dashboard > System Users)
// PHONE_NUMBER_ID  : Phone Number ID hasil Embedded Signup (bukan nomor telepon itu sendiri)
// WEBHOOK_VERIFY_TOKEN : token bebas buatan sendiri, dipakai saat handshake verifikasi webhook
// META_APP_SECRET  : App Dashboard > Settings > Basic > App Secret, dipakai validasi signature
// GRAPH_API_VERSION: versi Graph API, boleh dikosongkan (pakai default)
const WHATSAPP_TOKEN      = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID     = process.env.PHONE_NUMBER_ID || '';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || '';
const META_APP_SECRET     = process.env.META_APP_SECRET || '';
const GRAPH_API_VERSION   = process.env.GRAPH_API_VERSION || 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}`;
const waConfigured = !!(WHATSAPP_TOKEN && PHONE_NUMBER_ID);

if (!waConfigured) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m WHATSAPP_TOKEN / PHONE_NUMBER_ID belum diisi di .env — bot belum bisa kirim pesan lewat WhatsApp Cloud API.');
}
if (!WEBHOOK_VERIFY_TOKEN || !META_APP_SECRET) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m WEBHOOK_VERIFY_TOKEN / META_APP_SECRET belum diisi di .env — verifikasi webhook & validasi signature belum aktif.');
}

// ── MacroDroid bridge (HP Android + WA asli) config ───────────────
// MACRODROID_BRIDGE_TOKEN : token bebas buatan sendiri, dicek lewat header
// "X-Bridge-Token" tiap request dari MacroDroid ke /webhook/wa-incoming,
// supaya endpoint ini tidak bisa dipanggil sembarang orang dari luar.
const MACRODROID_BRIDGE_TOKEN = process.env.MACRODROID_BRIDGE_TOKEN || '';
if (!MACRODROID_BRIDGE_TOKEN) {
  console.log('\x1b[33m[PERINGATAN]\x1b[0m MACRODROID_BRIDGE_TOKEN belum diisi di .env — endpoint /webhook/wa-incoming belum terproteksi token.');
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// Auth middleware for Socket.io
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token === SERVER_AUTH_TOKEN) {
    next();
  } else {
    next(new Error("Unauthorized"));
  }
});

app.use(cors());
// Simpan raw body juga (dibutuhkan buat verifikasi X-Hub-Signature-256 dari Meta)
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');
const SET_FILE = path.join(DATA_DIR, 'settings.json');
const ORDER_FILE = path.join(DATA_DIR, 'orders.json');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

app.use('/images', express.static(IMAGES_DIR));

// Endpoint Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ token: SERVER_AUTH_TOKEN });
  } else {
    res.status(401).json({ error: 'Password salah' });
  }
});

// Middleware auth untuk semua rute API setelah login
app.use('/api', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${SERVER_AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
  next();
});

// Buffer pesan per pengirim: kalau customer kirim beberapa bubble berurutan
// dalam waktu singkat (misal "Halo, mau tanya X" lalu "cek harga" beberapa
// detik kemudian), kita tunggu sebentar dan gabungkan semuanya jadi SATU
// pesan sebelum diproses AI, supaya tidak terbalas dobel/parsial.
// Key: wa_id pengirim (digit saja, format Cloud API), Value: { texts: [], timer, lastWamid }
// Durasi tunggu & delay balas diatur lewat settings.debounceSeconds /
// settings.replyDelayMin / settings.replyDelayMax (bisa diubah di dashboard).
const pendingBuffers = new Map();
const userLocks = new Map(); // Menyimpan antrean promise per pengirim
const activeProcessing = new Map(); // from -> { controller, timeoutId, resolveDelay }

// Dedup pesan masuk berdasarkan wamid — webhook Meta bisa mengirim ulang
// event yang sama (misal kalau respon kita telat), jadi kita tolak wamid
// yang sudah pernah diproses. Disimpan sebagai array (FIFO) supaya gampang dibatasi ukurannya.
const processedWamids = [];
const processedWamidsSet = new Set();
function markWamidProcessed(id) {
  if (!id) return;
  processedWamidsSet.add(id);
  processedWamids.push(id);
  if (processedWamids.length > 2000) {
    const old = processedWamids.shift();
    processedWamidsSet.delete(old);
  }
}
function isWamidProcessed(id) {
  return !!id && processedWamidsSet.has(id);
}

[DATA_DIR, IMAGES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const DEF = {
  autoReply: true,
  // channel: 'cloudapi' -> kirim balasan lewat WhatsApp Cloud API (Graph API resmi Meta)
  //          'macrodroid' -> kirim balasan lewat bridge MacroDroid (HP Android + WA asli)
  // Kedua endpoint webhook tetap aktif; setting ini hanya menentukan mana yang
  // sedang "dipakai" (dipakai untuk validasi & ditampilkan di dashboard).
  channel: 'cloudapi',
  persona: 'Kamu adalah asisten CS toko online yang ramah, sopan, dan helpful.',
  language: 'Indonesia',
  tone: 'Santai',
  opHours: { enabled: false, start: '08:00', end: '17:00' },
  whitelist: [],
  knowledgeBase: '',
  followUp: '',
  modelName: 'gemini-3.1-flash-lite',
  temperature: 0.7,
  adminNumber: '085210127796', // nomor superadmin - kirim on/off ke nomor bot untuk kontrol auto-reply
  debounceSeconds: 10, // E3: dinaikkan 6→10 karena WABA webhook delivery bisa selisih beberapa detik
  replyDelayMin: 10, // delay untuk balasan SINGKAT (di bawah REPLY_LENGTH_THRESHOLD karakter)
  replyDelayMax: 15, // delay untuk balasan PANJANG (di atas REPLY_LENGTH_THRESHOLD karakter)
  productImages: {}
};

let settings = { ...DEF };
let messages  = [];
let orders    = [];

try { if (fs.existsSync(SET_FILE)) settings = { ...DEF, ...JSON.parse(fs.readFileSync(SET_FILE, 'utf8')) }; } catch(e) {}
try { if (fs.existsSync(MSG_FILE)) messages  = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); } catch(e) {}
try { if (fs.existsSync(ORDER_FILE)) orders  = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')); } catch(e) {}

const save = (file, data) => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {} };

// ── Multi API Key (rotasi dinamis key Gemini) ────────────────────
// Tambah key cukup di .env: GEMINI_API_KEY_1, GEMINI_API_KEY_2, dst.
// Tidak perlu ubah kode / frontend — otomatis terbaca semua.
let activeKeyIndex = 0; // index (di array getApiKeys() mentah) dari key yang terakhir dipakai — dipakai dashboard


function getApiKeys() {
  const keys = [];
  let i = 1;
  while (true) {
    const val = process.env[`GEMINI_API_KEY_${i}`];
    if (val === undefined) break;
    keys.push(val.trim());
    i++;
  }
  if (keys.length === 0 && process.env.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY.trim());
  }
  return keys;
}

// ── Rate-limit REAKTIF per key ────────────────────────────────────
// Tidak ada lagi prediksi/hitung kuota RPM/RPD sebelum request dikirim.
// Semua key dianggap "ON" (available) sampai terbukti kena limit lewat
// response error 429 dari Gemini API. Status per key:
//   status: 'ON' | 'WAITING_RPM' | 'OFF_RPD'
//   retry_at: timestamp ms (null kalau status 'ON')
// Index array ini mengikuti urutan valid keys (key yang terisi di .env),
// bukan nomor slot mentah — supaya round-robin tidak melompat-lompat
// karena slot kosong.
let apiKeyStates = [];
let lastUsedKeyIndex = 0; // posisi (di validKeys) terakhir yang dicoba, buat round-robin

function ensureKeyStates(n) {
  while (apiKeyStates.length < n) apiKeyStates.push({ status: 'ON', retry_at: null });
  if (apiKeyStates.length > n) apiKeyStates.length = n;
}

function getValidKeys() {
  return getApiKeys()
    .map((k, i) => ({ key: k, slot: i }))
    .filter(x => x.key && x.key.length >= 10);
}

// Hitung timestamp (ms) tengah malam BERIKUTNYA di zona waktu Pacific Time.
// Dipakai sebagai retry_at saat key kena limit harian (RPD), karena kuota
// harian Gemini API di-reset jam 00:00 Pacific Time.
function getNextMidnightPT() {
  const tz = 'America/Los_Angeles';
  const now = new Date();

  // Ambil tanggal hari ini menurut kalender PT (bukan kalender lokal server).
  const todayPT = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // "YYYY-MM-DD"
  const [y, m, d] = todayPT.split('-').map(Number);

  // Tebakan awal: perlakukan "besok jam 00:00" seolah-olah itu sudah UTC.
  const guessUTC = Date.UTC(y, m - 1, d + 1, 0, 0, 0);

  // Cari tahu offset PT yang berlaku di sekitar waktu itu (otomatis
  // menangani PST/PDT) dengan membaca ulang jam PT pada instant guessUTC.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(guessUTC)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const ptReadingAsUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
  const offsetMs = guessUTC - ptReadingAsUTC;

  let target = guessUTC + offsetMs;
  // Jaga-jaga (mis. dipanggil tepat di sekitar pergantian hari): pastikan hasilnya di masa depan.
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000;
  return target;
}

// Ambil key yang tersedia (status 'ON'), round-robin mulai dari key
// terakhir yang dipakai. Key yang retry_at-nya sudah lewat otomatis
// di-refresh jadi 'ON' di sini (lazy refresh, bukan timer terpisah).
function getAvailableKey() {
  const validKeys = getValidKeys();
  const n = validKeys.length;
  if (n === 0) return null;
  ensureKeyStates(n);

  const now = Date.now();
  for (let tried = 0; tried < n; tried++) {
    const pos = (lastUsedKeyIndex + tried) % n;
    const state = apiKeyStates[pos];

    if (state.status !== 'ON' && state.retry_at !== null && now >= state.retry_at) {
      state.status = 'ON';
      state.retry_at = null;
    }

    if (state.status === 'ON') {
      lastUsedKeyIndex = (pos + 1) % n; // key berikutnya jadi starting point round-robin selanjutnya
      return { key: validKeys[pos].key, slot: validKeys[pos].slot, pos };
    }
  }
  return null; // semua key habis
}

// Tandai key kena limit berdasarkan quotaId & retryDelay dari response 429.
function markKeyLimited(pos, quotaId, retryDelaySec) {
  const state = apiKeyStates[pos];
  if (!state) return;

  if (quotaId && quotaId.includes('PerDay')) {
    state.status = 'OFF_RPD';
    state.retry_at = getNextMidnightPT();
  } else if (quotaId && quotaId.includes('PerMinute')) {
    state.status = 'WAITING_RPM';
    const delaySec = (typeof retryDelaySec === 'number' && !isNaN(retryDelaySec) && retryDelaySec > 0) ? retryDelaySec : 60;
    state.retry_at = Date.now() + delaySec * 1000;
  } else {
    // quotaId tidak dikenali — tetap perlakukan sebagai limit sementara (RPM-style) demi keamanan.
    state.status = 'WAITING_RPM';
    const delaySec = (typeof retryDelaySec === 'number' && !isNaN(retryDelaySec) && retryDelaySec > 0) ? retryDelaySec : 60;
    state.retry_at = Date.now() + delaySec * 1000;
  }
}

// Susun status tiap key (mentah, sesuai urutan slot .env) buat dashboard.
function computeKeyStatuses() {
  const rawKeys = getApiKeys();
  const validKeys = getValidKeys();
  ensureKeyStates(validKeys.length);

  let validPos = -1;
  return rawKeys.map((k, i) => {
    const filled = !!(k && k.length >= 10);
    if (!filled) return { slot: i + 1, filled: false, status: 'standby', cooldownUntil: 0 };
    validPos++;
    const state = apiKeyStates[validPos] || { status: 'ON', retry_at: null };
    let status;
    if (state.status !== 'ON') status = 'quota';
    else status = (i === activeKeyIndex) ? 'active' : 'standby';
    return { slot: i + 1, filled: true, status, cooldownUntil: state.retry_at || 0 };
  });
}

function emitKeyStatuses() {
  io.emit('key_status_update', { keys: computeKeyStatuses(), log: [] });
}



// ── WhatsApp Cloud API: kirim & terima pesan lewat Graph API Meta ──

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

// Kirim pesan teks. quotedWamid opsional — kalau diisi, pesan akan tampil
// sebagai "reply" ke pesan customer tersebut (setara fitur `quoted` di Baileys).
async function sendWhatsAppText(to, text, quotedWamid) {
  if (!waConfigured) { console.error('❌ WhatsApp Cloud API belum dikonfigurasi (WHATSAPP_TOKEN/PHONE_NUMBER_ID kosong)'); return null; }
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text, preview_url: false },
  };
  if (quotedWamid) body.context = { message_id: quotedWamid };
  return graphFetch('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Upload file lokal (gambar produk) ke Graph API, hasilnya media id yang
// dipakai untuk mengirim gambar (Cloud API tidak menerima buffer langsung).
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

async function sendWhatsAppImageByPath(to, filePath, mimetype) {
  const mediaId = await uploadWhatsAppMedia(filePath, mimetype);
  if (!mediaId) throw new Error('Upload media ke WhatsApp gagal (tidak dapat media id)');
  const body = { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId } };
  return graphFetch('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Tandai pesan sudah dibaca, sekalian tampilkan indikator "sedang mengetik"
// (fitur typing_indicator Cloud API — otomatis hilang begitu kita kirim balasan
// atau setelah ±25 detik). Best-effort, jangan sampai bikin proses utama gagal.
async function markAsReadWithTyping(wamid, withTyping = true) {
  if (!waConfigured || !wamid) return;
  const body = { messaging_product: 'whatsapp', status: 'read', message_id: wamid };
  if (withTyping) body.typing_indicator = { type: 'text' };
  try { await graphFetch('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch(e) { /* non-fatal */ }
}

// Verifikasi X-Hub-Signature-256 dari Meta supaya payload webhook dipastikan asli
function isValidMetaSignature(req) {
  if (!META_APP_SECRET) return true; // kalau belum diisi, skip (tetap bisa jalan pas awal testing)
  const signatureHeader = req.get('X-Hub-Signature-256');
  if (!signatureHeader || !req.rawBody) return false;
  const expectedHash = crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  const expected = `sha256=${expectedHash}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isOpHour() {
  if (!settings.opHours?.enabled) return true;
  const now = new Date();
  const [sh, sm] = settings.opHours.start.split(':').map(Number);
  const [eh, em] = settings.opHours.end.split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start <= end) {
    return cur >= start && cur <= end;
  }
  // rentang melewati tengah malam
  return cur >= start || cur <= end;
}

function isWhitelisted(num) {
  if (!settings.whitelist?.length) return true;
  return settings.whitelist.some(w => num.includes(w.replace(/\D/g, '')));
}

// Normalisasi nomor Indonesia: ubah prefix 0xxx jadi 62xxx biar bisa dicocokkan
// dengan format JID WhatsApp (62xxx@s.whatsapp.net)
function normalizeIdNumber(num) {
  let n = (num || '').replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  return n;
}

// Cek apakah JID pengirim adalah nomor superadmin (untuk command on/off)
function isAdminNumber(fromJid) {
  if (!settings.adminNumber) return false;
  const adminNorm = normalizeIdNumber(settings.adminNumber);
  // JID Baileys kadang ada suffix device, misal "6285xxx:12@s.whatsapp.net" - buang dulu
  const fromNorm = (fromJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return adminNorm && fromNorm === adminNorm;
}

// ── Smart filtering: pecah knowledge base jadi blok per produk ────
// Format yang diharapkan di textarea:
// === PRODUK: Nama Produk ===
// ...detail...
// ---
// === PRODUK: Produk Lain ===
// ...detail...
function parseProductBlocks(kb) {
  if (!kb?.trim()) return [];
  return kb.split(/^---$/m)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const headerMatch = block.match(/===\s*PRODUK:\s*(.+?)\s*===/i);
      return { name: headerMatch ? headerMatch[1].trim() : null, text: block };
    });
}

// Cari blok produk yang relevan dengan pesan pelanggan (cocokkan kata di nama produk)
function getRelevantKnowledge(message, history = []) {
  const blocks = parseProductBlocks(settings.knowledgeBase);
  if (!blocks.length) return '';

  // Ambil beberapa pesan terakhir (user & AI) untuk digabungkan sebagai konteks pencarian produk
  const recentHistoryText = history.slice(-3).map(h => `${h.body || ''} ${h.aiReply || ''}`).join(' ');
  const combinedText = (message + ' ' + recentHistoryText).toLowerCase();

  const matched = blocks.filter(b => {
    if (!b.name) return false;
    const words = b.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    return words.some(w => combinedText.includes(w));
  });

  // Kalau ketemu kecocokan jelas, kirim hanya itu (hemat token).
  // E2: Kalau tidak ada match (pertanyaan di luar topik produk), kirim max 3 blok pertama
  // saja sebagai konteks minimal — jangan kirim semua produk sekaligus supaya tidak
  // boros token dan AI tidak confused.
  const MAX_FALLBACK_BLOCKS = 3;
  const chosen = matched.length ? matched : blocks.slice(0, MAX_FALLBACK_BLOCKS);
  return chosen.map(b => b.text).join('\n\n');
}

function buildSystemPrompt(name, relevantKB, isFirstMessage) {
  const greetingRule = '- Sapaan ke pelanggan: panggil "Kak" saja tanpa menyebut nama sama sekali (jangan pakai nama dari WhatsApp, baik di pesan pertama maupun balasan berikutnya)';

  const parts = [
    `Kamu adalah ${settings.persona}`,
    greetingRule,
    `Bahasa: ${settings.language}`,
    `Tone: ${settings.tone}`,
    '',
  ];
  if (relevantKB?.trim()) {
    parts.push('=== INFORMASI PRODUK & BISNIS ===');
    parts.push(relevantKB.trim());
    parts.push('');
  }
  if (settings.followUp?.trim()) {
    parts.push('=== PROSEDUR MENJAWAB (WAJIB DIIKUTI, BUKAN SEKADAR REFERENSI) ===');
    parts.push(settings.followUp.trim());
    parts.push('');
  }
  parts.push('=== ATURAN MENJAWAB ===');
  parts.push('- Balas secara natural seperti manusia, bukan robot');
  parts.push('- Gunakan bahasa percakapan sehari-hari yang hangat');
  parts.push('- JANGAN gunakan tanda petik di awal atau akhir pesan');
  parts.push('- JANGAN sebut bahwa kamu AI kecuali ditanya langsung');
  parts.push('- Gunakan emoji secukupnya agar terasa lebih ramah, jangan berlebihan');
  parts.push('');
  parts.push('=== PANJANG & GAYA BALASAN (PENTING) ===');
  parts.push('- Ikuti PROSEDUR MENJAWAB di atas sebagai aturan wajib, tapi jangan diulang kata-per-kata sebagai skrip di setiap balasan — sesuaikan redaksinya secara natural sesuai konteks pesan pelanggan saat itu');
  parts.push(isFirstMessage
    ? '- Ini kemungkinan pesan PERTAMA pelanggan di percakapan ini: boleh jelaskan 1-2 keunggulan utama produk secara singkat, maksimal 3-4 kalimat total'
    : '- Ini BUKAN pesan pertama (sudah ada riwayat chat): JANGAN ulangi penjelasan keunggulan produk yang sudah dijelaskan sebelumnya. Jawab LANGSUNG dan SINGKAT sesuai apa yang ditanya pelanggan saat ini saja, idealnya 1-2 kalimat');
  parts.push('- Kalau pelanggan hanya minta harga ("cek harga", "berapa", dll), jawab harga + 1 kalimat penutup/CTA saja. JANGAN ulang jelaskan keunggulan produk lagi kalau sudah pernah dijelaskan di riwayat chat sebelumnya');
  parts.push('- Default-nya selalu pilih jawaban yang LEBIH SINGKAT selama informasi yang diminta tetap tersampaikan');
  parts.push('');
  parts.push('=== TUGAS TAMBAHAN (EKSTRAKSI ORDER) ===');
  parts.push('Jika pelanggan TELAH MEMBERIKAN data pesanan secara lengkap (minimal berisi Nama, Alamat, dan setuju untuk membeli) dan kamu sedang membalas untuk mengonfirmasi pesanan tersebut, kamu WAJIB menyisipkan blok data khusus di baris paling bawah balasanmu.');
  parts.push('Blok ini berfungsi agar sistem otomatis kami dapat mencatat pesanan pelanggan. Formatnya harus persis seperti ini (harus valid JSON di dalam tag tersebut):');
  parts.push('[ORDER_DATA]{"nama": "Nama Lengkap", "hp": "No HP atau WA", "produk": "Nama Produk yang Dipesan", "alamat": "Alamat Lengkap"}[/ORDER_DATA]');
  parts.push('PENTING: Jangan menyertakan blok ini jika pelanggan hanya tanya-tanya atau belum pasti memesan. Blok ini akan disembunyikan otomatis oleh sistem dari mata pelanggan.');
  parts.push('');
  
  const productsWithImages = Object.keys(settings.productImages || {}).filter(k => settings.productImages[k] && settings.productImages[k].some(img => img));
  if (productsWithImages.length > 0) {
    parts.push('=== ATURAN GAMBAR (PENTING) ===');
    parts.push(`Produk berikut memiliki gambar yang siap dikirim: ${productsWithImages.join(', ')}.`);
    parts.push('JIKA pelanggan MEMINTA untuk melihat foto/gambar produk tersebut, balas dengan penjelasan singkat dan WAJIB tambahkan persis kode ini di akhir kalimatmu: [KIRIM_GAMBAR:Nama Produk]. Contoh jika nama produknya "Massage Gun": "[KIRIM_GAMBAR:Massage Gun]".');
    parts.push('Sistem akan otomatis mengirim gambar ke WhatsApp pelanggan jika kode itu disertakan. JANGAN gunakan kode ini jika pelanggan tidak secara eksplisit meminta gambar.');
    parts.push('');
  }
  
  parts.push('=== MENANGANI PESAN DENGAN BEBERAPA MAKSUD SEKALIGUS (PENTING) ===');
  parts.push('- Satu pesan pelanggan bisa berisi BEBERAPA maksud/intent sekaligus, baik dalam satu baris maupun beberapa baris terpisah yang dikirim hampir bersamaan (contoh: "mau tanya pasta dempul tembok? cek harga" = konfirmasi produk + minta harga dalam satu pesan)');
  parts.push('- Baca SELURUH isi pesan pelanggan (semua baris/kalimat) sebelum menjawab, jangan hanya merespons baris terakhir atau baris pertama saja');
  parts.push('- Kalau pelanggan menyebut nama produk DAN sekaligus minta harga/info, anggap produk sudah terkonfirmasi dan langsung jawab harga/info-nya, JANGAN tanya balik "produk yang mana?" kalau nama produknya sudah jelas disebut');
  parts.push('- Gabungkan jawaban untuk semua maksud yang ada dalam pesan itu ke dalam SATU balasan yang ringkas, jangan dipisah jadi beberapa balasan atau hanya jawab sebagian');
  parts.push('');
  parts.push('=== ATURAN ONGKIR (PENTING) ===');
  parts.push('- LANGKAH PERTAMA, SELALU: cek dulu ke INFORMASI PRODUK & BISNIS di atas apakah produk yang ditanya sudah menyatakan status ongkir secara eksplisit (misal "harga sudah termasuk ongkir" atau "belum termasuk ongkir"). Jangan pernah berasumsi sendiri kalau info produk sudah menyebutkan ini dengan jelas — WAJIB ikuti apa yang tertulis di info produk, jangan bertentangan dengannya');
  parts.push('- JIKA info produk menyatakan "harga sudah termasuk ongkir": jawab TEGAS bahwa ongkir sudah termasuk dan TIDAK PERLU tanya kecamatan/kota untuk urusan ongkir (kecamatan/kota tetap boleh ditanya belakangan hanya untuk keperluan alamat pengiriman saat order). JANGAN sampai bilang "sudah termasuk ongkir" lalu beberapa balasan kemudian malah bilang "saya hitungkan ongkirnya" — ini KONTRADIKSI yang harus dihindari mutlak');
  parts.push('- JIKA info produk menyatakan "belum termasuk ongkir", ATAU tidak ada keterangan status ongkir sama sekali di info produk: Jangan PERNAH menyebutkan angka biaya ongkir secara pasti sebelum lokasi tujuan diketahui. Kalau pelanggan menanyakan ongkir/biaya kirim ("udah ongkir belum", "ongkirnya berapa", dll) dan KECAMATAN/KOTA tujuan belum diketahui di chat ini, jawab dengan: konfirmasi bahwa harga belum termasuk ongkir, lalu TANYA BALIK nama kecamatan dan kota/kabupaten tujuan, dengan kalimat kira-kira seperti: "Belum, Kak, ongkirnya nanti dihitung terpisah ya. Boleh tahu kecamatan dan kota/kabupaten tujuannya apa? Nanti saya cek dulu ongkirnya."');
  parts.push('- Kalau pelanggan SUDAH menyebutkan kecamatan/kota di chat ini atau sebelumnya, jangan tanya ulang, cukup konfirmasi bahwa ongkir akan/sedang dicek untuk lokasi tersebut');
  parts.push('- Setelah status ongkir jelas (baik karena sudah termasuk, maupun karena kecamatan/kota sudah diketahui), baru minta detail alamat lengkap (nama, alamat lengkap, no HP) untuk proses order, jangan minta semuanya sekaligus di awal kalau pelanggan baru menanyakan ongkir');
  parts.push('');
  parts.push('=== ATURAN COD (PENTING) ===');
  parts.push('- BACA DENGAN TELITI informasi produk! Jika di keterangan produk tertulis "COD: bisa", "Bisa COD", atau sejenisnya, maka Anda WAJIB menjawab bahwa pesanan BISA dilakukan dengan bayar di tempat (COD). JANGAN PERNAH berasumsi atau mengarang bahwa produk tersebut tidak bisa COD jika di informasinya sudah jelas tertulis bisa.');
  parts.push('');
  parts.push('=== ATURAN PRODUK ===');
  parts.push('- Jika ada info produk, gunakan untuk menjawab pertanyaan pelanggan');
  parts.push('- PENTING: Jika pelanggan menanyakan produk/topik yang TIDAK ADA di informasi produk di atas, jawab dengan jujur dan ramah bahwa produk tersebut belum tersedia di toko. JANGAN mengarang informasi atau berpura-pura produk itu ada');
  parts.push('- Jika produk yang ditanya tidak ada, tawarkan produk lain yang relevan dari daftar jika memungkinkan');
  return parts.join('\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Panggil Gemini REST API langsung dengan key tertentu
async function callGeminiDirect(key, keySlot, message, name, history, signal) {
  const model = settings.modelName || 'gemini-3.1-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const contents = [];
  if (history?.length) {
    for (const h of history.slice(-8)) {
      contents.push({ role: 'user', parts: [{ text: h.body }] });
      // B4: Jangan inject model reply dari entry yang di-cancel (cancelledEntry)
      // supaya string internal tidak bocor ke konteks Gemini
      if (h.aiReply && !h.cancelledEntry) contents.push({ role: 'model', parts: [{ text: h.aiReply }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const relevantKB = getRelevantKnowledge(message, history);
  const isFirstMessage = !history?.length;

  const body = {
    contents,
    systemInstruction: { parts: [{ text: buildSystemPrompt(name, relevantKB, isFirstMessage) }] },
    generationConfig: { temperature: settings.temperature ?? 0.7 },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: e.message };
  }

  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    let errData = null;
    try {
      errData = await res.json();
      msg = errData?.error?.message || msg;
    } catch(e) {}

    if (res.status === 429) {
      // Parse detail error 429: cari quotaId (RPM vs RPD) dan retryDelay (RetryInfo)
      let quotaId = null;
      let retryDelaySec = null;
      try {
        const details = errData?.error?.details || [];
        for (const d of details) {
          if (!quotaId && Array.isArray(d.violations)) {
            for (const v of d.violations) {
              if (v?.quotaId) { quotaId = v.quotaId; break; }
            }
          }
          if (retryDelaySec === null && typeof d?.['@type'] === 'string' && d['@type'].includes('RetryInfo') && d.retryDelay) {
            const rd = d.retryDelay;
            if (typeof rd === 'string') {
              const m = rd.match(/^(\d+(?:\.\d+)?)s?$/);
              if (m) retryDelaySec = parseFloat(m[1]);
            } else if (typeof rd === 'number') {
              retryDelaySec = rd;
            }
          }
        }
      } catch(e) {}
      return { ok: false, status429: true, quotaId, retryDelaySec, error: msg };
    }

    return { ok: false, error: msg };
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text.trim()) return { ok: false, error: 'Respons kosong dari Gemini' };

  const usage = data.usageMetadata;
  if (usage) {
    console.log(`📊 [Token] Key ${keySlot + 1} | Prompt: ${usage.promptTokenCount} | Output: ${usage.candidatesTokenCount}`);
  }

  return { ok: true, text: text.trim().replace(/^["'`]+|["'`]+$/g, '').trim() };
}

function extractOrder(replyText, fromJid) {
  let cleanReply = replyText;
  const match = replyText.match(/\[ORDER_DATA\]([\s\S]*?)\[\/ORDER_DATA\]/);
  if (match) {
    try {
      const data = JSON.parse(match[1].trim());
      const order = {
        id: Date.now().toString() + Math.floor(Math.random()*1000),
        jid: fromJid,
        nama: data.nama || '',
        hp: data.hp || '',
        produk: data.produk || '',
        alamat: data.alamat || '',
        status: 'order',
        timestamp: new Date().toISOString()
      };
      // Pengecekan Duplikasi: 5 Menit dari nomor WhatsApp yang sama.
      // (Waktu diperpendek dari 1 jam menjadi 5 menit. Ini agar jika pelanggan 
      // yang sama memesan barang BERBEDA di jam berikutnya, orderannya tetap masuk.
      // 5 menit sudah sangat cukup untuk menangkal duplikat dari chat beruntun/AI error).
      const isDuplicate = orders.some(o => 
        o.jid === fromJid && 
        o.produk === order.produk &&
        (Date.now() - new Date(o.timestamp).getTime() < 300000)
      );
      
      if (!isDuplicate) {
        orders.unshift(order);
        save(ORDER_FILE, orders);
        io.emit('new_order', order);
        console.log('🛒 Order baru tertangkap:', order.nama);
        // Jalankan background process AI Address & Komerce COD secara asinkron
        processOrderAddressAI(order.id);
      } else {
        console.log('⚠️ Mengabaikan order duplikat dari:', order.nama);
      }
    } catch(e) {
      console.error('Gagal parse ORDER_DATA JSON:', e.message);
    }
    // Hapus tag dari pesan yang akan dikirim ke WA
    cleanReply = replyText.replace(/\[ORDER_DATA\][\s\S]*?\[\/ORDER_DATA\]/g, '').trim();
  }
  return cleanReply;
}

// ── Rotasi key REAKTIF: anggap semua key 'ON' sampai terbukti kena 429 ──
async function aiReply(message, name, history, signal) {
  if (getValidKeys().length === 0) {
    console.error('❌ Tidak ada API key yang valid di .env');
    return null;
  }

  while (true) {
    if (signal?.aborted) return null;

    const picked = getAvailableKey();
    if (!picked) {
      // Semua key sedang WAITING_RPM / OFF_RPD → jangan kirim request sama sekali,
      // pesan akan dicoba lagi oleh retryFailedMessages.
      console.warn('⏸️ Semua API key sedang kena limit → pesan diqueue untuk retry');
      emitKeyStatuses();
      return null;
    }

    activeKeyIndex = picked.slot;
    emitKeyStatuses();
    console.log(`🔑 Mencoba Key ${picked.slot + 1}...`);

    const result = await callGeminiDirect(picked.key, picked.slot, message, name, history, signal);

    if (result.ok) {
      emitKeyStatuses();
      return result.text;
    }
    if (result.aborted) return null;

    if (result.status429) {
      markKeyLimited(picked.pos, result.quotaId, result.retryDelaySec);
      const st = apiKeyStates[picked.pos];
      console.warn(`⚠️ Key ${picked.slot + 1} kena limit (${result.quotaId || 'tidak diketahui'}) → ${st.status}, retry_at=${new Date(st.retry_at).toISOString()}`);
      emitKeyStatuses();
      continue; // otomatis coba key lain untuk pesan yang sama
    }

    // Error selain 429 → lempar seperti biasa, jangan diperlakukan sebagai rate limit
    console.error(`❌ Key ${picked.slot + 1} gagal (bukan rate limit): ${result.error?.slice(0, 200)}`);
    throw new Error(result.error || 'Gagal memanggil Gemini API');
  }
}
async function retryFailedMessages() {
  if (!settings.autoReply) return;

  // Tidak ada lagi "cycle rest" global — tiap pesan langsung dicoba lagi;
  // kalau semua key masih kena limit, aiReply() akan return null lagi (lihat di bawah)
  // dan pesan tetap diqueue untuk retry berikutnya.

  const MAX_RETRY_COUNT = 5; // maksimal 5 kali coba, lalu berhenti agar tidak bakar quota
  const nowTime = Date.now();
  const failedEntries = messages.filter(m => !m.replied && (nowTime - new Date(m.timestamp).getTime() < 7200000) && (m.retryCount || 0) < MAX_RETRY_COUNT);
  if (!failedEntries.length) return;

  console.log(`♻️ Mencoba membalas ulang ${failedEntries.length} pesan yang tertunda...`);
  
  for (const entry of failedEntries) {
    const prevTask = userLocks.get(entry.from) || Promise.resolve();
    const nextTask = prevTask.then(async () => {
      // Pastikan belum dibalas manual saat antre
      if (entry.replied) return;
      if (!isOpHour() || !isWhitelisted(entry.from)) return;

      // BUG FIX: messages disimpan dengan unshift (terbaru di index 0), harus diurutkan
      // dari terlama ke terbaru sebelum dikirim ke Gemini sebagai history percakapan.
      const history = messages
        .filter(m => m.from === entry.from && m.id !== entry.id && !m.cancelledEntry)
        .sort((a, b) => a.id - b.id)
        .slice(-8);
      // Tambah hitungan retry
      entry.retryCount = (entry.retryCount || 0) + 1;

      let reply = await aiReply(entry.body, entry.senderName, history);
      
      if (reply) {
         reply = extractOrder(reply, entry.from);

         try { await markAsReadWithTyping(entry.wamid, true); } catch(e) {}
         await sleep(2000); 
         
         let cleanReply = reply;
         const imgMatches = [...reply.matchAll(/\[KIRIM_GAMBAR:(.*?)\]/gi)];
         const productsToImage = [];
         for (const match of imgMatches) {
           productsToImage.push(match[1].trim());
           cleanReply = cleanReply.replace(match[0], '').trim();
         }

         await sendWhatsAppText(entry.from, cleanReply, entry.wamid);
         
         for (const productToImage of productsToImage) {
           if (settings.productImages && settings.productImages[productToImage]) {
             for (const filename of settings.productImages[productToImage]) {
               if (filename) {
                  const imgPath = path.join(IMAGES_DIR, filename);
                  if (fs.existsSync(imgPath)) {
                    try {
                      const ext = filename.split('.').pop().toLowerCase();
                      const mimetype = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
                      await sendWhatsAppImageByPath(entry.from, imgPath, mimetype);
                    } catch(e) { console.error('Gagal kirim gambar retry:', e.message); }
                  }
               }
             }
           }
         }

         entry.replied = true;
         entry.aiReply = cleanReply;
         save(MSG_FILE, messages);
         io.emit('message_updated', entry);
         console.log(`🤖 AI (Retry) -> ${entry.from}: ${reply}`);
      } else if (entry.retryCount >= MAX_RETRY_COUNT) {
        // Sudah MAX_RETRY_COUNT kali gagal, hentikan retry agar tidak bakar quota
        // BUG FIX (B3): jangan tulis string status ke aiReply — hanya null + flag
        // supaya tidak bocor ke history percakapan Gemini.
        entry.replied = true;
        entry.aiReply = null;
        entry.cancelledEntry = true;
        save(MSG_FILE, messages);
        console.warn(`⚠️ Pesan dari ${entry.from} dihentikan setelah ${MAX_RETRY_COUNT}x gagal`);
      } else {
        // Belum sampai limit, simpan retryCount yang sudah diupdate
        save(MSG_FILE, messages);
      }
    }).catch(e => console.error('Retry error:', e.message))
    .finally(() => {
      // M1: Bersihkan lock kalau tidak ada task pending baru dari nomor ini
      if (userLocks.get(entry.from) === nextTask) userLocks.delete(entry.from);
    });
    
    userLocks.set(entry.from, nextTask);
  }
}

// Panjang teks (karakter) yang jadi ambang batas "balasan singkat" vs "balasan panjang".
// Di bawah ambang ini -> pakai settings.replyDelayMin, di atas -> settings.replyDelayMax.
const REPLY_LENGTH_THRESHOLD = 80;

// Hitung delay (ms) sebelum kirim balasan, berdasarkan panjang teks balasannya:
// balasan singkat (basa-basi/harga) terasa wajar dibalas cepat, balasan panjang
// (penjelasan produk dsb) wajar kalau "diketik" lebih lama. Diberi jitter kecil
// (±2 detik) supaya tidak terasa kaku/persis sama setiap kali.
function getReplyDelayMs(text) {
  // BUG FIX: Number() bisa hasilkan NaN (bukan null), jadi harus pakai || bukan ??
  const shortSec = Math.max(0, Number(settings.replyDelayMin) || 10);
  const longSec  = Math.max(shortSec, Number(settings.replyDelayMax) || 15);
  const baseSec  = (text?.length || 0) > REPLY_LENGTH_THRESHOLD ? longSec : shortSec;
  const jitterSec = (Math.random() * 4) - 2; // -2..+2 detik
  const sec = Math.max(1, baseSec + jitterSec);
  return sec * 1000;
}

// Proses satu "giliran" pelanggan (bisa gabungan beberapa bubble yang
// dikirim berurutan dalam window debounce) lalu kirim balasan AI.
async function processCustomerMessage(from, senderName, combinedBody, lastWamid) {
  // PREEMPTION: Batalkan proses AI sebelumnya dari user ini jika masih berjalan
  if (activeProcessing.has(from)) {
    const currentTask = activeProcessing.get(from);
    if (currentTask.controller) currentTask.controller.abort();
    if (currentTask.timeoutId) clearTimeout(currentTask.timeoutId);
    if (currentTask.resolveDelay) currentTask.resolveDelay(); // cegah promise menggantung
    activeProcessing.delete(from);
    console.log(`⚡ Menghentikan proses AI sebelumnya untuk ${senderName} karena ada pesan baru masuk.`);
  }

  const entry = {
    id: Date.now(), from, senderName, body: combinedBody, wamid: lastWamid,
    timestamp: new Date().toISOString(),
    replied: false, aiReply: null,
  };

  // 1. Munculkan langsung di dashboard dan history
  messages.unshift(entry);
  if (messages.length > 300) messages = messages.slice(0, 300);
  save(MSG_FILE, messages);
  io.emit('new_message', entry);

  // 2. Masukkan proses AI ke dalam antrean (queue) khusus user ini
  const prevTask = userLocks.get(from) || Promise.resolve();
  
  const nextTask = prevTask.then(async () => {
    if (settings.autoReply && isOpHour() && isWhitelisted(from)) {
      const controller = new AbortController();
      const taskState = { controller, timeoutId: null };
      activeProcessing.set(from, taskState);

      try { await markAsReadWithTyping(lastWamid, true); } catch(e) {}

      // Fetch history here. Pesan sebelumnya yang batal terbalas akan terbaca di sini!
      // BUG FIX: messages disimpan dengan unshift (terbaru di index 0), harus diurutkan
      // dari terlama ke terbaru, dan skip cancelledEntry agar tidak membingungkan Gemini.
      const history = messages
        .filter(m => m.from === from && m.id !== entry.id && !m.cancelledEntry)
        .sort((a, b) => a.id - b.id)
        .slice(-8);
      let reply = await aiReply(combinedBody, senderName, history, controller.signal);

      if (reply) {
        // ── B1: Hold check — cek ada pesan susulan sebelum lanjut ──────────
        // Dua kondisi: buffer masih aktif (debounce belum fire) ATAU
        // sudah ada entry baru di messages dari user yang sama (AI lambat,
        // debounce buffer sudah fire dan entry baru sudah dibuat).
        const hasNewerMessage = messages.some(m =>
          m.from === from && m.id > entry.id && !m.replied
        );
        if (pendingBuffers.has(from) || hasNewerMessage) {
          console.log(`⏸️ Reply untuk ${senderName} ditahan — ada pesan susulan.`);
          activeProcessing.delete(from);
          // B3: null + flag, bukan string status supaya tidak bocor ke Gemini
          entry.replied = true;
          entry.aiReply = null;
          entry.cancelledEntry = true;
          save(MSG_FILE, messages);
          return;
        }
        // ────────────────────────────────────────────────────────────────────

        // B2: extractOrder SETELAH hold check — cegah order tersimpan
        // padahal reply tidak jadi terkirim ke customer
        reply = extractOrder(reply, from);

        // Cek tag [KIRIM_GAMBAR:Nama Produk] & bersihkan dulu SEBELUM hitung delay,
        // supaya panjang teks yang dipakai untuk menentukan delay itu akurat
        // (tag gambar bukan bagian dari isi balasan yang dibaca customer).
        let cleanReply = reply;
        const imgMatches = [...reply.matchAll(/\[KIRIM_GAMBAR:(.*?)\]/gi)];
        const productsToImage = [];
        for (const match of imgMatches) {
          productsToImage.push(match[1].trim());
          cleanReply = cleanReply.replace(match[0], '').trim();
        }

        const delayMs = getReplyDelayMs(cleanReply);
        
        // Simpan timeoutId dan resolve agar bisa di-clear/dibatalkan jika ada pesan baru
        await new Promise(resolve => {
          taskState.resolveDelay = resolve;
          taskState.timeoutId = setTimeout(() => {
            taskState.resolveDelay = null;
            resolve();
          }, delayMs);
        });

        // Jika dibatalkan saat sedang delay, jangan kirim pesannya!
        if (controller.signal.aborted) {
           console.log(`⚠️ Pesan untuk ${senderName} batal dikirim karena di-preempt saat delay.`);
           entry.replied = true;
           // B3: null + flag, bukan string status
           entry.aiReply = null;
           entry.cancelledEntry = true;
           save(MSG_FILE, messages);
           return; 
        }

        // Hapus dari activeProcessing karena sudah mau dikirim
        activeProcessing.delete(from);

        // E1: Wrap send — kalau gagal (Meta down/timeout), jangan tandai replied=true
        // supaya retry logic (retryFailedMessages) bisa handle. extractOrder sudah punya
        // dedup 5 menit, jadi tidak akan double-save order saat retry.
        try {
          await sendWhatsAppText(from, cleanReply, lastWamid);
        } catch (sendErr) {
          console.error(`❌ Gagal kirim reply ke ${senderName}:`, sendErr.message);
          save(MSG_FILE, messages); // simpan state entry (belum replied)
          return; // retry akan handle dalam 5 menit
        }
        
        // Kirim gambar jika diminta dan tersedia
        for (const productToImage of productsToImage) {
          if (settings.productImages && settings.productImages[productToImage]) {
            for (const filename of settings.productImages[productToImage]) {
              if (filename) {
                 const imgPath = path.join(IMAGES_DIR, filename);
                 if (fs.existsSync(imgPath)) {
                   try {
                     const ext = filename.split('.').pop().toLowerCase();
                     const mimetype = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
                     await sendWhatsAppImageByPath(from, imgPath, mimetype);
                   } catch(e) { console.error('Gagal kirim gambar:', e.message); }
                 }
              }
            }
          }
        }
        
        // Update entry dengan balasan AI
        entry.replied = true; 
        entry.aiReply = cleanReply;
        save(MSG_FILE, messages);
        io.emit('message_updated', entry);
        console.log(`🤖 AI (delay ${Math.round(delayMs/1000)}s): ${cleanReply}`);
        
        // Picu retry untuk pesan tertunda lainnya secara background
        setTimeout(retryFailedMessages, 5000);
      } else {
        activeProcessing.delete(from);
        // null bisa berarti dibatalkan (AbortError) atau fatal error.
        if (controller.signal.aborted) {
           console.log(`⚠️ Proses fetch untuk ${senderName} dibatalkan karena ada pesan susulan.`);
           entry.replied = true;
           // B3: null + flag, bukan string status supaya tidak bocor ke Gemini
           entry.aiReply = null;
           entry.cancelledEntry = true;
           save(MSG_FILE, messages);
        } else {
          console.log('⚠️ AI tidak membalas (cek error di atas atau quota)');
        }
      }
    }
  }).catch(e => {
    activeProcessing.delete(from);
    console.error('Error in user queue:', e);
  }).finally(() => {
    // M1: Bersihkan lock kalau tidak ada task pending baru dari nomor ini
    if (userLocks.get(from) === nextTask) userLocks.delete(from);
  });

  userLocks.set(from, nextTask);
}

// ── Webhook WhatsApp Cloud API ─────────────────────────────────────

// 1. Handshake verifikasi — dipanggil Meta sekali waktu setup webhook di App Dashboard
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook diverifikasi oleh Meta');
    return res.status(200).send(challenge);
  }
  console.log('❌ Verifikasi webhook gagal — token tidak cocok');
  return res.sendStatus(403);
});

// 2. Event masuk (pesan, status pengiriman, dll)
app.post('/webhook', (req, res) => {
  // Balas 200 DULUAN secepatnya, biar Meta tidak anggap gagal & kirim ulang
  res.sendStatus(200);

  if (!isValidMetaSignature(req)) {
    console.log('⚠️ Signature webhook tidak valid, payload dicurigai palsu — diabaikan');
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
        if (!msgs || !msgs.length) continue; // bukan pesan masuk (mungkin status update read/delivered)

        for (const msg of msgs) {
          try {
            const from = msg.from; // wa_id pengirim, format digit saja mis. "62812xxxxxxxx"
            const wamid = msg.id;
            if (isWamidProcessed(wamid)) { console.log('↩️ Wamid sudah pernah diproses, skip:', wamid); continue; }
            markWamidProcessed(wamid);

            // Tandai dibaca (tidak perlu tunggu hasilnya)
            markAsReadWithTyping(wamid, false);

            let body = '';
            if (msg.type === 'text') body = msg.text?.body || '';
            else if (msg.type === 'image') body = msg.image?.caption || '';
            else if (msg.type === 'video') body = msg.video?.caption || '';
            else if (msg.type === 'button') body = msg.button?.text || '';
            else if (msg.type === 'interactive') body = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';

            if (!body.trim()) { console.log(`ℹ️ Pesan tipe "${msg.type}" tanpa teks/caption, dilewati`); continue; }

            const senderName = contactName || from;
            console.log(`📩 ${senderName}: ${body}`);

            // ── Command superadmin: on/off untuk toggle auto-reply dari nomor admin ──
            if (isAdminNumber(from)) {
              const cmd = body.trim().toLowerCase();
              if (cmd === 'on' || cmd === 'off') {
                settings.autoReply = (cmd === 'on');
                save(SET_FILE, settings);
                io.emit('settings_updated', settings);

                const confirmText = settings.autoReply
                  ? '✅ Bot diaktifkan. Auto-reply AI menyala kembali.'
                  : '⛔ Bot dimatikan. Auto-reply AI nonaktif, semua chat masuk perlu dibalas manual.';

                sendWhatsAppText(from, confirmText).catch(e => console.error(e.message));
                console.log(`🔐 Admin command: ${cmd.toUpperCase()} -> autoReply=${settings.autoReply}`);
                continue; // skip AI reply hanya jika command adalah on/off
              }
              // Jika pesan dari admin bukan "on"/"off", biarkan lanjut diproses sebagai chat biasa
            }

            // ── Buffer & debounce: tunggu beberapa detik untuk menampung bubble
            // berikutnya dari pengirim yang sama sebelum diproses sebagai satu
            // pesan gabungan. Ini mencegah customer yang ngetik dalam beberapa
            // bubble terpisah (misal "Halo mau tanya X" lalu "cek harga") dibalas
            // dua kali secara terpisah/parsial. ──
            const existing = pendingBuffers.get(from);
            if (existing) {
              clearTimeout(existing.timer);
              existing.texts.push(body);
              existing.lastWamid = wamid; // pakai wamid terakhir sebagai context reply
            }
            const buffer = existing || { texts: [body], lastWamid: wamid, senderName };
            const debounceMs = Math.max(1, Number(settings.debounceSeconds) || 6) * 1000;
            buffer.timer = setTimeout(() => {
              pendingBuffers.delete(from);
              const combinedBody = buffer.texts.join('\n');
              processCustomerMessage(from, buffer.senderName, combinedBody, buffer.lastWamid)
                .catch(e => console.error('Msg error:', e.message));
            }, debounceMs);
            pendingBuffers.set(from, buffer);

          } catch(e) { console.error('Msg error:', e.message); }
        }
      }
    }
  } catch(e) {
    console.error('Webhook parse error:', e.message);
  }
});

// ── Webhook MacroDroid (bridge HP Android + WA asli) ──────────────
// Dipanggil oleh Macro 1 di HP tiap ada notifikasi WA baru.
// Request  : { sender, message, senderName? }
// Response : { reply, images: [...url] }  -> dipakai Macro 2 untuk ketik & kirim balasan
// Kalau request ini "tertumpuk" karena ada pesan susulan dalam window debounce yang sama,
// responnya { buffered: true, reply: null } -> MacroDroid TIDAK PERLU kirim apa-apa untuk request ini
// (baru request TERAKHIR dalam satu window yang benar-benar dapat balasan final).
const macrodroidBuffers = new Map(); // key: id percakapan, value: { texts, senderName, timer, pendingRes }

// sender dari notifikasi WA Android bisa berupa nomor (digit) atau nama kontak
// tersimpan. Kalau berupa nomor, normalisasi spy konsisten dgn channel Cloud API
// (yang selalu memakai wa_id digit); kalau nama kontak, pakai apa adanya sebagai id percakapan.
function normalizeMacrodroidSender(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length >= 8) return normalizeIdNumber(digits);
  return (raw || '').trim();
}

app.post('/webhook/wa-incoming', async (req, res) => {
  try {
    if (MACRODROID_BRIDGE_TOKEN && req.headers['x-bridge-token'] !== MACRODROID_BRIDGE_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized: X-Bridge-Token tidak cocok' });
    }
    if (settings.channel !== 'macrodroid') {
      return res.status(409).json({ error: 'Channel MacroDroid tidak sedang aktif. Aktifkan dulu di dashboard (Channel Pengiriman).' });
    }

    const { sender, message, senderName } = req.body || {};
    if (!sender || !message) return res.status(400).json({ error: 'Isi sender dan message' });

    const from = normalizeMacrodroidSender(sender);
    const name = (senderName || sender || '').toString();
    console.log(`📩 [MacroDroid] ${name}: ${message}`);

    if (!settings.autoReply || !isOpHour() || !isWhitelisted(from)) {
      return res.json({ reply: null, skipped: true });
    }

    // Command superadmin: on/off (sama seperti channel Cloud API)
    if (isAdminNumber(from)) {
      const cmd = String(message).trim().toLowerCase();
      if (cmd === 'on' || cmd === 'off') {
        settings.autoReply = (cmd === 'on');
        save(SET_FILE, settings);
        io.emit('settings_updated', settings);
        const confirmText = settings.autoReply
          ? '✅ Bot diaktifkan. Auto-reply AI menyala kembali.'
          : '⛔ Bot dimatikan. Auto-reply AI nonaktif, semua chat masuk perlu dibalas manual.';
        console.log(`🔐 Admin command (MacroDroid): ${cmd.toUpperCase()} -> autoReply=${settings.autoReply}`);
        return res.json({ reply: confirmText });
      }
    }

    // Buffer/debounce: tumpuk pesan berurutan dari sender yang sama dalam window singkat,
    // supaya beberapa bubble berturut-turut dibalas sekaligus (bukan dobel/parsial).
    const existing = macrodroidBuffers.get(from);
    if (existing) {
      clearTimeout(existing.timer);
      existing.texts.push(String(message));
      // Selesaikan request LAMA yang tertumpuk supaya koneksinya tidak menggantung.
      if (existing.pendingRes) {
        try { existing.pendingRes.json({ reply: null, buffered: true }); } catch (e) {}
      }
    }
    const buffer = existing || { texts: [String(message)] };
    buffer.senderName = name;
    buffer.pendingRes = res; // request TERBARU yang akan menerima balasan final
    const debounceMs = Math.max(1, Number(settings.debounceSeconds) || 6) * 1000;
    buffer.timer = setTimeout(() => flushMacrodroidBuffer(from), debounceMs);
    macrodroidBuffers.set(from, buffer);
  } catch (e) {
    console.error('MacroDroid webhook error:', e.message);
    try { res.status(500).json({ error: e.message }); } catch (e2) {}
  }
});

async function flushMacrodroidBuffer(from) {
  const buffer = macrodroidBuffers.get(from);
  if (!buffer) return;
  macrodroidBuffers.delete(from);
  const combinedBody = buffer.texts.join('\n');
  const finalRes = buffer.pendingRes;
  const senderName = buffer.senderName || from;

  const entry = {
    id: Date.now(), from, senderName, body: combinedBody, wamid: null,
    timestamp: new Date().toISOString(), replied: false, aiReply: null, channel: 'macrodroid',
  };
  messages.unshift(entry);
  if (messages.length > 300) messages = messages.slice(0, 300);
  save(MSG_FILE, messages);
  io.emit('new_message', entry);

  // Antre per-pengirim (userLocks dipakai bersama dengan channel Cloud API supaya
  // tidak ada dua balasan AI yang berjalan bersamaan untuk kontak yang sama).
  const prevTask = userLocks.get(from) || Promise.resolve();
  const nextTask = prevTask.then(async () => {
    if (entry.replied) return; // sudah dibalas manual saat antre

    const history = messages.filter(m => m.from === from && m.id !== entry.id).slice(0, 8).reverse();
    let reply = await aiReply(combinedBody, senderName, history);

    if (!reply) {
      save(MSG_FILE, messages);
      console.log('⚠️ [MacroDroid] AI tidak membalas (cek error/quota di atas)');
      try { finalRes.json({ reply: null, error: 'AI tidak membalas, cek quota/log server' }); } catch (e) {}
      return;
    }

    reply = extractOrder(reply, from);
    let cleanReply = reply;
    const imgMatches = [...reply.matchAll(/\[KIRIM_GAMBAR:(.*?)\]/gi)];
    const productsToImage = [];
    for (const match of imgMatches) {
      productsToImage.push(match[1].trim());
      cleanReply = cleanReply.replace(match[0], '').trim();
    }

    // Kumpulkan URL gambar produk yang diminta (kalau ada) — dikirim sebagai info
    // tambahan; pengiriman gambar via MacroDroid perlu macro/step terpisah di HP.
    const imageUrls = [];
    for (const p of productsToImage) {
      const files = settings.productImages?.[p];
      if (files) for (const f of files) if (f) imageUrls.push(`/images/${f}`);
    }

    entry.replied = true;
    entry.aiReply = cleanReply;
    save(MSG_FILE, messages);
    io.emit('message_updated', entry);
    console.log(`🤖 AI (MacroDroid) -> ${senderName}: ${cleanReply}`);

    try { finalRes.json({ reply: cleanReply, images: imageUrls }); } catch (e) {}
  }).catch(e => {
    console.error('MacroDroid flush error:', e.message);
    try { finalRes.json({ reply: null, error: e.message }); } catch (e2) {}
  }).finally(() => {
    // M1: Bersihkan lock kalau tidak ada task pending baru dari nomor ini
    if (userLocks.get(from) === nextTask) userLocks.delete(from);
  });
  userLocks.set(from, nextTask);
}

// ── API ──
app.get('/api/keystatus', (_, res) => {
  const keys = getApiKeys();
  res.json({
    filled: keys.map(k => !!(k && k.length >= 10)),
    activeIndex: activeKeyIndex,
    statuses: computeKeyStatuses(),
    log: [],
  });
});

app.get('/api/status',   (_, res) => {
  const channel = settings.channel === 'macrodroid' ? 'macrodroid' : 'cloudapi';
  const status = channel === 'macrodroid' ? 'connected' : (waConfigured ? 'connected' : 'disconnected');
  res.json({ status, channel });
});
app.get('/api/qr',       (_, res) => res.json({ qr: null })); // Cloud API tidak pakai QR
app.get('/api/messages', (_, res) => res.json(messages.slice(0, 100)));
app.get('/api/settings', (_, res) => res.json(settings));
app.get('/api/haskey', (_, res) => {
  const keys = getApiKeys();
  res.json({
    ok: keys.some(k => k.length >= 10), // minimal 1 key terisi biar app bisa jalan
    keys: keys.map(k => !!(k && k.length >= 10)), // [true/false, true/false, true/false]
    activeIndex: activeKeyIndex,
  });
});

app.post('/api/upload-image', (req, res) => {
  try {
    const { productName, slot, base64 } = req.body;
    if (!productName || slot == null || !base64) return res.status(400).json({error: 'Data tidak lengkap'});
    
    let ext = 'jpg';
    const mimeMatch = base64.match(/^data:image\/(\w+);base64,/);
    if (mimeMatch) ext = mimeMatch[1];
    
    const base64Data = base64.replace(/^data:image\/\w+;base64,/, "");
    const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
    const filePath = path.join(IMAGES_DIR, fileName);
    
    fs.writeFileSync(filePath, base64Data, 'base64');
    
    if (!settings.productImages) settings.productImages = {};
    if (!settings.productImages[productName]) settings.productImages[productName] = [null, null, null];
    
    // delete old image if exists
    if (settings.productImages[productName][slot]) {
       const oldPath = path.join(IMAGES_DIR, settings.productImages[productName][slot]);
       if (fs.existsSync(oldPath)) {
         try { fs.unlinkSync(oldPath); } catch(e) { console.error('Gagal hapus gambar lama:', e); }
       }
    }
    
    settings.productImages[productName][slot] = fileName;
    save(SET_FILE, settings);
    res.json({ ok: true, fileName });
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/delete-image', (req, res) => {
  try {
    const { productName, slot } = req.body;
    if (!settings.productImages || !settings.productImages[productName] || !settings.productImages[productName][slot]) {
      return res.json({ok: true});
    }
    const fileName = settings.productImages[productName][slot];
    const filePath = path.join(IMAGES_DIR, fileName);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch(e) { console.error('Gagal hapus file gambar:', e); }
    }
    
    settings.productImages[productName][slot] = null;
    save(SET_FILE, settings);
    res.json({ok: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/settings', (req, res) => {
  settings = { ...settings, ...req.body };
  save(SET_FILE, settings);
  res.json({ ok: true });
});
app.post('/api/format-kb', async (req, res) => {
  const { knowledgeBase, followUp } = req.body;
  if (!knowledgeBase || !knowledgeBase.trim()) {
    settings.knowledgeBase = '';
    settings.followUp = followUp || '';
    save(SET_FILE, settings);
    return res.json({ ok: true, knowledgeBase: '' });
  }

  const allKeys = getApiKeys();
  const key = allKeys.find(k => k && k.length >= 10);
  if (!key) return res.status(400).json({ error: 'Belum ada API key yang diisi' });

  const model = settings.modelName || 'gemini-3.1-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const errData = await r.json(); msg = errData?.error?.message || msg; } catch(e){}
        throw new Error(msg);
    }
    const data = await r.json();
    let formattedText = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    
    if (formattedText.trim()) {
      formattedText = formattedText.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
      settings.knowledgeBase = formattedText;
      settings.followUp = followUp || '';
      save(SET_FILE, settings);
      res.json({ ok: true, knowledgeBase: formattedText });
    } else {
      res.status(500).json({ error: 'Respons AI kosong' });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders', (_, res) => res.json(orders));
app.post('/api/orders/:id/status', (req, res) => {
  const { status } = req.body;
  const order = orders.find(o => o.id === req.params.id);
  if (order) {
    order.status = status;
    save(ORDER_FILE, orders);
    io.emit('order_updated', order);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Order tidak ditemukan' });
  }
});
app.delete('/api/orders/:id', (req, res) => {
  const initLength = orders.length;
  orders = orders.filter(o => o.id !== req.params.id);
  if (orders.length < initLength) {
    save(ORDER_FILE, orders);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Order tidak ditemukan' });
  }
});

// ── Manual Cek Alamat & Ongkir (Tools Baru) ──
app.post('/api/cek-alamat-manual', async (req, res) => {
  const { alamat } = req.body;
  if (!alamat) return res.status(400).json({ error: 'Alamat tidak boleh kosong' });

  const picked = getAvailableKey();
  if (!picked) return res.status(500).json({ error: 'Semua API Key kena limit' });
  
  try {
    const model = settings.modelName || 'gemini-3.1-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(picked.key)}`;

    const systemPrompt = `Ekstrak alamat berikut. Kembalikan HANYA JSON murni (tanpa markdown backticks) dengan struktur: {"desa": "nama desa/kelurahan saja", "kecamatan": "nama kecamatan saja", "alamat_baku": "alamat rapi lengkap dengan provinsi dan kodepos"}`;
    
    const body = {
      contents: [{ role: 'user', parts: [{ text: alamat }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.1 },
    };

    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('Gagal menghubungi AI');
    
    const aiData = await r.json();
    let text = aiData?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    text = text.trim().replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();
    
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('Respons AI tidak valid format JSON'); }
    if (!parsed.desa || !parsed.kecamatan) throw new Error('Desa atau Kecamatan gagal diekstrak');

    let ai_cod = '⚠️ Area tidak tercover';
    
    // Search RajaOngkir destination
    const searchUrl = 'https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=' + encodeURIComponent(parsed.desa + ' ' + parsed.kecamatan) + '&limit=1';
    const destRes = await fetch(searchUrl, { headers: { 'key': KOMERCE_API_KEY } });
    const destData = await destRes.json();
    
    if (destData?.data && destData.data.length > 0) {
      const destId = destData.data[0].id;
      const costPayload = new URLSearchParams();
      costPayload.append('origin', ORIGIN_ID);
      costPayload.append('destination', destId);
      costPayload.append('weight', '1000');
      costPayload.append('courier', 'ide');
      costPayload.append('price', 'lowest');

      const costRes = await fetch('https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost', {
        method: 'POST',
        headers: { 'key': KOMERCE_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: costPayload.toString()
      });
      
      const costData = await costRes.json();
      const hasValidService = costData?.data?.some(d => d.cost > 0);
      ai_cod = hasValidService ? '✅ ID Express COD Bisa' : '❌ ID Express COD Tidak Bisa';
    }

    res.json({
      ok: true,
      data: {
        ai_alamat: parsed.alamat_baku,
        desa: parsed.desa,
        kecamatan: parsed.kecamatan,
        ai_cod: ai_cod
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Backfill AI address & COD untuk order lama yang belum diproses ──
app.post('/api/orders/backfill-ai', async (req, res) => {
  // Ambil semua order yang belum punya ai_alamat atau ai_cod
  const pending = orders.filter(o => o.alamat && (!o.ai_alamat || !o.ai_cod));
  if (!pending.length) {
    return res.json({ ok: true, message: 'Semua order sudah memiliki data AI.', processed: 0 });
  }
  res.json({ ok: true, message: `Memproses ${pending.length} order di background...`, processing: pending.length });
  // Proses di background, tidak memblokir response
  (async () => {
    for (const order of pending) {
      await processOrderAddressAI(order.id);
      await new Promise(r => setTimeout(r, 1500)); // jeda 1.5 detik antar request agar tidak banjir API
    }
    console.log(`✅ Backfill AI selesai: ${pending.length} order diproses.`);
  })();
});

app.post('/api/retry', (req, res) => {
  retryFailedMessages();
  res.json({ ok: true });
});
const MAX_API_KEY_SLOTS = 15; // jumlah slot key yang didukung form dashboard/setup (GEMINI_API_KEY_1..15)

app.post('/api/savekey', (req, res) => {
  const body = req.body || {};
  const anyFilled = Array.from({ length: MAX_API_KEY_SLOTS }, (_, i) => body[`key${i + 1}`]).some(v => v);
  if (!anyFilled) return res.status(400).json({ error: 'Isi minimal 1 API key' });
  if (body.key1 && body.key1.length < 10) return res.status(400).json({ error: 'API Key 1 terlalu pendek' });

  const envPath = path.join(__dirname, '.env');
  let env = '';
  try { env = fs.readFileSync(envPath, 'utf8'); } catch(e) {}

  const setEnvVar = (envStr, name, value) => {
    if (value === undefined) return envStr; // gak diisi di request -> jangan diubah
    const v = (value || '').trim();
    // BUG FIX: gunakan split/join literal agar aman dari karakter spesial regex di `name`
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

  activeKeyIndex = 0; // reset balik ke key1 tiap kali ada update key
  // Key yang diganti bisa jadi key yang benar-benar baru (belum pernah kena limit),
  // jadi status rate-limit lama (posisi array apiKeyStates) tidak valid lagi.
  apiKeyStates = [];
  lastUsedKeyIndex = 0;
  emitKeyStatuses();
  res.json({ ok: true });
});

// Test koneksi salah satu API key (slot 1/2/..N) - berguna untuk debugging cepat
app.post('/api/testkey', async (req, res) => {
  const slot = Number(req.body?.slot) || 1; // nomor slot sesuai urutan di .env
  const keys = getApiKeys();
  const key = keys[slot - 1];
  if (!key) return res.json({ ok: false, error: `Key ${slot} belum diisi` });
  try {
    const model = settings.modelName || 'gemini-3.1-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
app.post('/api/send', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: 'Isi number dan message' });
  if (settings.channel === 'macrodroid') {
    return res.status(400).json({ error: 'Kirim manual dari dashboard belum didukung untuk channel MacroDroid (server tidak bisa "mendorong" pesan ke HP secara langsung, HP hanya aktif saat ada notifikasi masuk). Balas manual langsung dari WhatsApp di HP.' });
  }
  if (!waConfigured) return res.status(400).json({ error: 'WhatsApp Cloud API belum dikonfigurasi (cek WHATSAPP_TOKEN & PHONE_NUMBER_ID di .env)' });
  try {
    await sendWhatsAppText(normalizeIdNumber(number), message);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', async (_, res) => {
  // Tidak ada sesi/QR untuk di-logout di WhatsApp Cloud API — nomor terpasang
  // lewat Embedded Signup di Meta App Dashboard, bukan lewat scan QR di sini.
  res.json({ ok: true, note: 'WhatsApp Cloud API tidak menggunakan sesi QR. Kelola koneksi nomor dari Meta App Dashboard.' });
});

io.on('connection', socket => {
  console.log('Browser terhubung ke dashboard');
  socket.emit('status', waConfigured ? 'connected' : 'disconnected');
  socket.emit('qr', null);
});

const PORT = process.env.PORT || 3000;

// ── BACKGROUND TASK: AI ALAMAT & COD CHECK ──
const KOMERCE_API_KEY = 'Yzx2NjTb1c484631212a74562TQwiwSB';
const ORIGIN_ID = '73528'; // Serua Ciputat

async function processOrderAddressAI(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order || !order.alamat) return;

  // BUG FIX #1: Gunakan getAvailableKey() agar ikut rotasi round-robin yang benar
  // dan tidak selalu pakai Key 1 saja.
  const picked = getAvailableKey();
  if (!picked) {
    console.warn('⏸️ [AI Alamat] Semua API key sedang kena limit, skip address processing.');
    return;
  }
  const key = picked.key;

  try {
    const model = settings.modelName || 'gemini-3.1-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

    const systemPrompt = `Ekstrak alamat berikut. Kembalikan HANYA JSON murni (tanpa markdown backticks) dengan struktur: {"desa": "nama desa/kelurahan saja", "kecamatan": "nama kecamatan saja", "alamat_baku": "alamat rapi lengkap dengan provinsi dan kodepos"}`;
    
    const body = {
      contents: [{ role: 'user', parts: [{ text: order.alamat }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.1 },
    };

    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return;
    
    const data = await r.json();
    let text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    // BUG FIX #2: Regex yang lebih robust untuk membersihkan markdown code block
    // Menangani pola: ```json\n...\n``` maupun ```\n...\n```
    text = text.trim().replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();
    
    const parsed = JSON.parse(text);
    if (!parsed.desa || !parsed.kecamatan) return;

    order.ai_alamat = parsed.alamat_baku || order.alamat;
    io.emit('order_updated', order); // update UI partially

    // Search RajaOngkir destination
    const searchUrl = 'https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=' + encodeURIComponent(parsed.desa + ' ' + parsed.kecamatan) + '&limit=1';
    const destRes = await fetch(searchUrl, { headers: { 'key': KOMERCE_API_KEY } });
    const destData = await destRes.json();
    
    if (destData?.data && destData.data.length > 0) {
      const destId = destData.data[0].id;
      
      // Check Cost for ID Express
      const costPayload = new URLSearchParams();
      costPayload.append('origin', ORIGIN_ID);
      costPayload.append('destination', destId);
      costPayload.append('weight', '1000');
      costPayload.append('courier', 'ide');
      costPayload.append('price', 'lowest');

      const costRes = await fetch('https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost', {
        method: 'POST',
        headers: { 'key': KOMERCE_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: costPayload.toString()
      });
      
      const costData = await costRes.json();
      // BUG FIX #3: Validasi bahwa ada hasil dengan cost > 0
      // API bisa mengembalikan data array berisi tapi dengan cost:0 jika area tidak tercover
      const hasValidService = costData?.data?.some(d => d.cost > 0);
      if (hasValidService) {
        order.ai_cod = '✅ ID Express COD Bisa';
      } else {
        order.ai_cod = '❌ ID Express COD Tidak Bisa';
      }
    } else {
      order.ai_cod = '⚠️ Area tidak tercover';
    }

    save(ORDER_FILE, orders);
    io.emit('order_updated', order);
  } catch (e) {
    console.error('AI Address Process Error:', e.message);
  }
}
// ──────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log('\n==========================================');
  console.log('  WA AI Assistant (Cloud API + MacroDroid) berjalan!');
  console.log(`  Buka browser: http://localhost:${PORT}`);
  console.log(`  Channel aktif saat ini: ${settings.channel === 'macrodroid' ? 'MacroDroid' : 'WhatsApp Cloud API'} (bisa diganti di dashboard)`);
  console.log(`  Webhook Cloud API (Meta App Dashboard): https://<domain-kamu>/webhook`);
  console.log(`  Webhook MacroDroid (Macro 1 - HTTP Request): https://<domain-kamu>/webhook/wa-incoming`);
  console.log('==========================================\n');

  // Jalankan pengecekan rutin pesan tertunda setiap 5 menit (dikurangi agar tidak terlalu agresif)
  setInterval(retryFailedMessages, 5 * 60 * 1000);
});

process.on('uncaughtException',  e => console.error('Error:', e.message));
process.on('unhandledRejection', e => console.error('Rejection:', e?.message || e));
