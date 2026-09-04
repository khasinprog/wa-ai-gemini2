require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const fs         = require('fs');
const db         = require('./db');
const config     = require('./config');
const ongkirHelper = require('./ongkir-helper'); // P2-C: helper cek ongkir Mengantar
const tg         = require('./telegram-service'); // P2-D: eskalasi via Telegram
const scheduler  = require('./followup-scheduler'); // F3: follow-up timer otomatis

const path       = require('path');
const cors       = require('cors');
const crypto     = require('crypto');
const multer     = require('multer');

// ── Login Rate Limiting ────────────────────────────────────────────
// Track login attempts per IP to prevent brute force attacks
const loginAttempts = new Map(); // key: IP, value: { count, resetAt }
const LOGIN_MAX_ATTEMPTS = config.LOGIN_MAX_ATTEMPTS;
const LOGIN_WINDOW_MS = config.LOGIN_WINDOW_MS;


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
const ESC_FILE = path.join(DATA_DIR, 'escalations.json'); // pertanyaan yang di-escalate ke admin (belum terjawab)
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');

// ── F1: Konfigurasi Pembayaran ────────────────────────────────────
const PAYMENT = {
  bankName:       process.env.PAYMENT_BANK_NAME        || '',
  accountNumber:  process.env.PAYMENT_ACCOUNT_NUMBER   || '',
  accountName:    process.env.PAYMENT_ACCOUNT_NAME     || '',
  ewallet:        process.env.PAYMENT_EWALLET          || '',
  discountPercent: parseFloat(process.env.TRANSFER_DISCOUNT_PERCENT || '10'),
};

// Urutan prioritas kurir untuk ditampilkan ke customer
// Bisa di-override dari settings dashboard (settings.courierPriority)
const DEFAULT_COURIER_PRIORITY = (process.env.COURIER_PRIORITY || 'J&T,iDexpress,JNE')
  .split(',').map(s => s.trim()).filter(Boolean);


app.use('/images', express.static(IMAGES_DIR));
app.use('/audio', express.static(AUDIO_DIR));

// P2-C: Mount router ongkir — endpoint proxy ke Mengantar API
// Dipasang SEBELUM auth middleware agar bisa diakses internal jika perlu
app.use('/api/ongkir', require('./routes/ongkir'));


// Endpoint Login (with rate limiting)
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();

  // Get or initialize attempt tracking for this IP
  const attempts = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };

  // Reset counter if window has passed
  if (now > attempts.resetAt) {
    attempts.count = 0;
    attempts.resetAt = now + LOGIN_WINDOW_MS;
  }

  // Check if rate limited
  if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
    const secondsLeft = Math.ceil((attempts.resetAt - now) / 1000);
    console.log(`🔒 Login rate limited dari IP ${ip} (${attempts.count} percobaan)`);
    return res.status(429).json({
      error: `Terlalu banyak percobaan login. Coba lagi dalam ${secondsLeft} detik.`,
      retryAfter: secondsLeft
    });
  }

  // Increment attempt counter
  attempts.count++;
  loginAttempts.set(ip, attempts);

  // Validate input
  const { password } = req.body;
  if (typeof password !== 'string' || password.length > 100) {
    return res.status(400).json({ error: 'Input tidak valid' });
  }

  // Check password
  if (password === process.env.ADMIN_PASSWORD) {
    loginAttempts.delete(ip); // Reset on success
    console.log(`✅ Login berhasil dari IP ${ip}`);
    res.json({ token: SERVER_AUTH_TOKEN });
  } else {
    console.log(`❌ Login gagal dari IP ${ip} (percobaan ${attempts.count}/${LOGIN_MAX_ATTEMPTS})`);
    res.status(401).json({ error: 'Password salah' });
  }
});

// Cek apakah Gemini API Key sudah terkonfigurasi — tidak butuh auth,
// karena dipanggil saat init app (sebelum/sesudah login) untuk tampilkan
// popup setup jika key belum ada. Tidak mengekspos data sensitif.
app.get('/api/haskey', (_, res) => {
  const keys = getApiKeys();
  res.json({
    ok: keys.some(k => k.length >= 10),
    keys: keys.map(k => !!(k && k.length >= 10)),
    activeIndex: activeKeyIndex,
  });
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

// ═══════════════════════════════════════════════════════════════════
// ORDER STATE: Track status order per user (step-based system)
// ═══════════════════════════════════════════════════════════════════
const ORDER_STATE_FILE = path.join(__dirname, 'orderStates.json');
const ORDER_STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 minggu

const orderStates = new Map();

// ── Persist: simpan ke file saat state berubah ──
// IMP-2A: Debounce 2s — jika ada banyak update berturut-turut, tulis sekali saja
let _persistTimer = null;
function _doPersistOrderState() {
  const obj = {};
  for (const [phone, state] of orderStates) obj[phone] = state;
  try {
    fs.writeFileSync(ORDER_STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('⚠️  [OrderState] Gagal persist:', e.message);
  }
}
function persistOrderState(urgent = false) {
  if (urgent) { _doPersistOrderState(); return; }
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(_doPersistOrderState, 2000);
}

// ── Load: muat dari file saat server start, auto-cleanup >14 hari ──
function loadOrderStates() {
  try {
    const data = JSON.parse(fs.readFileSync(ORDER_STATE_FILE, 'utf-8'));
    const now = Date.now();
    let loaded = 0, cleaned = 0;
    for (const [phone, state] of Object.entries(data)) {
      if (!state.lastUpdate || (now - state.lastUpdate) > ORDER_STATE_TTL_MS) {
        cleaned++; continue;
      }
      orderStates.set(phone, state);
      loaded++;
    }
    console.log(`📦 [OrderState] Loaded ${loaded} state, cleaned ${cleaned} expired`);
    // Hapus file jika ada yang di-cleanup
    if (cleaned > 0) persistOrderState();
  } catch {
    console.log('📦 [OrderState] File tidak ada, mulai fresh');
  }
}

function createOrderState(product) {
  return {
    step: 1,
    product,
    color: null,
    namaLengkap: null,
    namaVerified: false,
    dusun: null,
    desa: null,
    kecamatan: null,
    kota: null,
    rtRw: null,
    patokan: null,
    patokanSkipped: false,  // IMP-3B: customer bilang tidak ada patokan
    alamatLengkap: null,
    noHp: null,
    orderConfirmed: false,
    lastUpdate: Date.now(),
  };
}

function detectProductFocus(message) {
  const blocks = parseProductBlocks(settings.knowledgeBase);
  if (!blocks.length) return null;
  const lowerMsg = message.toLowerCase();
  for (const b of blocks) {
    if (!b.name) continue;
    // IMP-2C: naikkan threshold 3→4 agar kata pendek (cat, abu, dll) tidak false match
    const words = b.name.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    if (words.some(w => lowerMsg.includes(w))) return b.name;
  }
  return null;
}

function detectOrderData(message, currentStep) {
  const lower = message.toLowerCase().trim();
  const data = {};

  // ═══ WARNA: Step 1-2 (product inquiry / follow-up) ═══
  if ([1, 2].includes(currentStep)) {
    const colorMap = {
      'biru muda': 'Biru Muda', 'biru': 'Biru Muda',
      'pink muda': 'Pink Muda', 'pink': 'Pink Muda',
      'abu': 'Abu-abu', 'abu-abu': 'Abu-abu',
      'navy': 'Navy', 'red': 'Red', 'merah': 'Red',
    };
    for (const [key, val] of Object.entries(colorMap)) {
      if (lower === key || (lower.includes(key) && !lower.includes('bukan'))) {
        data.color = val;
        break;
      }
    }
  }

  // ═══ HP: Step 3 (collecting data) ═══
  if (currentStep === 3) {
    // BUG-07 fix: gunakan word boundary pada teks asli (bukan stripped) agar tidak false match ke "RT 08/05" dll
    const phoneMatch = message.match(/\b(08\d{8,12})\b/);
    if (phoneMatch) {
      data.phone = phoneMatch[1];
    }
  }

  return data;
}

function updateOrderState(from, message) {
  let state = orderStates.get(from);
  const detectedProduct = detectProductFocus(message);
  const lower = message.toLowerCase().trim();

  // Product lock: berubah hanya kalau customer tanya produk LAIN
  if (detectedProduct && (!state || state.product !== detectedProduct)) {
    state = createOrderState(detectedProduct);
    orderStates.set(from, state);
    persistOrderState();
  }

  if (!state) return null;

  // ── EXTRACT FIELDS DULU (sebelum step transitions) ───────────────
  const data = detectOrderData(message, state.step);

  // Hanya auto-detect yang PASTI benar: warna + HP
  if (data.color && !state.color) {
    state.color = data.color;
  } else if (data.phone && !state.noHp) {
    state.noHp = data.phone;
  }

  // Step 3+: extract fields dari pesan customer (name, address, RT/RW, patokan)
  if (state.step >= 3) {
    extractCustomerFields(state, message);
  }
  // ──────────────────────────────────────────────────────────────────

  // ── AUTO-DETECT STEP TRANSITION ──────────────────────────────────
  const priorReplies = messages.filter(m => m.from === from && m.aiReply && !m.cancelledEntry).length;
  const prevStep = state.step;

  // Step 1→2: AI sudah jawab produk ≥1x
  // BUG-02 fix: jangan naik ke 2 kalau pesan ini detect produk BARU (sudah di-reset ke step 1)
  if (state.step === 1 && priorReplies >= 1 && !detectedProduct) {
    state.step = 2;
  }

  // Step 2→3: Customer tunjukkan intent order
  // IMP-1A: Hilangkan "iya" dan "mau" tunggal — terlalu ambigu, bisa trigger step 3 saat customer
  // hanya ack pertanyaan biasa. Gunakan pola yang lebih eksplisit menyebut order/beli/proses.
  const orderIntent = /\b(mau\s+(order|pesan|beli|ambil)|saya\s+(order|pesan|beli)|lanjut\s+order|proses\s+aja|oke\s*(bayar|proses|lanjut)|setuju\s+order)\b|\border\b|\bpesan\b/i;
  if (state.step === 2 && orderIntent.test(lower)) {
    state.step = 3;
  }

  // Step 3→4: Semua data terkumpul + customer kasih sinyal konfirmasi
  // Fix-1: pakai \b (word boundary) agar cocok dalam kalimat pendek (≤5 kata),
  // bukan hanya kata tunggal persis — lebih toleran tanpa false positive
  const confirmPattern = /\b(ya|y|iya|oke|ok|betul|benar|siap|fix|setuju|sudah|lengkap|mantap|gas|proses|lanjut|boleh)\b/i;
  const isShortConfirm = lower.split(/\s+/).length <= 5;
  if (state.step === 3 && confirmPattern.test(lower) && isShortConfirm) {
    const missing = getMissingFields(state);
    if (missing.length === 0) {
      state.step = 4;
    }
  }

  // Step 3→5: Eskalasi
  if ([3, 4].includes(state.step)) {
    const escKeywords = ['estimasi', 'berapa hari', 'stok', 'retur', 'garansi', 'komplain',
      'batal', 'gak jadi', 'kirim kapan', 'kirim kapn', 'hari sampai', 'kurir sampai', 'kapan sampai'];
    const isEscalation = escKeywords.some(k => lower.includes(k));
    const isConfirm = confirmPattern.test(lower);
    if (isEscalation && !isConfirm) {
      state.step = 5;
    }
  }

  // Log step transition
  if (state.step !== prevStep) {
    console.log(`📊 [Step] ${from.slice(-4)}: ${prevStep}→${state.step} (${message.slice(0, 40)})`);
  }
  // ──────────────────────────────────────────────────────────────────

  state.lastUpdate = Date.now();
  orderStates.set(from, state);
  persistOrderState();
  return state;
}

// ═══════════════════════════════════════════════════════════════════
// EXTRACT CUSTOMER FIELDS: Deteksi input customer di Step 3
// ═══════════════════════════════════════════════════════════════════
function extractCustomerFields(state, message) {
  const lower = message.toLowerCase().trim();
  const words = message.trim().split(/\s+/);

  // Guard: jangan extract kata-kata konfirmasi/generic
  const skipWords = /^(ya|y|oke|ok|baik|siap|betul|benar|sama|boleh|mantap|gas|proses|lanjut|fix|setuju|iya|noted|ok\s*ku|iya\s*ka|oke\s*ka|baik\s*ka|siap\s*ka|oke\s*kak|siap\s*kak|ya\s*ka|ya\s*kak|noted\s*ka|betul\s*ka|benar\s*ka|proses\s*ka|lanjut\s*ka|fix\s*ka|mantap\s*ka|gas\s*ka|setuju\s*ka|boleh\s*ka|sama\s*ka)$/;
  if (skipWords.test(lower)) return;

  // ── RT/RW "gak ada" — detect SEBELUM address parsing ──
  // BUG-03 fix: hanya trigger jika ada konteks RT/RW dalam pesan yang sama
  if (!state.rtRw && /\b(gak|nggak|ga|tidak)\s*(ada)?\b/i.test(lower)
      && /\b(rt|rw|rukun)\b/i.test(lower)) {
    state.rtRw = '-';
  }

  // IMP-3B: Patokan optional — jika customer bilang tidak ada patokan
  if (!state.patokan && !state.patokanSkipped
      && /\b(gak ada|ga ada|tidak ada|gak punya|ga punya|gapunya)\b/i.test(lower)
      && /\b(patokan|panduan|penanda|acuan|landmark)\b/i.test(lower)) {
    state.patokanSkipped = true;
  }

  // IMP-3A: noHp SAMA_DENGAN_WA — detect "pakai nomor ini aja", "boleh nomor WA ini"
  if (!state.noHp
      && /\b(sama|boleh|pakai|pake|aja|nomor\s*ini|wa\s*ini|whatsapp\s*ini|nomor\s*wa)\b/i.test(lower)
      && !/\b08\d{8}/.test(message)) {
    state.noHp = 'SAMA_DENGAN_WA';
  }

  // ── NAMA: ≥ 2 kata → langsung catat sebagai nama verified ──
  // BUG-01 fix: pesan yang mengandung koma (pemisah alamat) JANGAN dianggap nama
  const hasComma = message.includes(',');
  if (!state.namaLengkap || !state.namaVerified) {
    if (words.length >= 2 && !hasComma && !looksLikeAddress(lower) && !looksLikeQuestion(lower)) {
      state.namaLengkap = message.trim();
      state.namaVerified = true;
    } else if (words.length === 1 && !hasComma && !looksLikeAddress(lower) && !looksLikeQuestion(lower)) {
      // 1 kata → catat tapi belum verified (AI akan verifikasi)
      if (!state.namaLengkap) {
        state.namaLengkap = message.trim();
        state.namaVerified = false;
      }
    }
  }

  // ── ALAMAT: Deteksi dusun, desa, kecamatan, kota dari pesan ──
  if (!state.desa || !state.kecamatan || !state.kota) {
    // Extract RT/RW dulu dari pesan, buang dari sisa sebelum parse alamat
    const rtMatch = message.match(/rt\s*(\d{1,3})\s*\/?\s*rw\s*(\d{1,3})/i);
    const addrRaw = rtMatch ? message.replace(/rt\s*\d+\s*\/\s*(?:rw\s*)?\d+/gi, '') : message;
    const parts = addrRaw.split(/[,\n]+/).map(p => p.trim()).filter(Boolean);

    if (parts.length === 2) {
      // 2 items: desa, kecamatan
      if (!state.desa) state.desa = parts[0];
      if (!state.kecamatan) state.kecamatan = parts[1];
    } else if (parts.length === 3) {
      // 3 items: desa, kecamatan, kota
      if (!state.desa) state.desa = parts[0];
      if (!state.kecamatan) state.kecamatan = parts[1];
      if (!state.kota) state.kota = parts[2];
    } else if (parts.length >= 4) {
      // 4+ items: dusun, desa, kecamatan, kota
      if (!state.dusun && !/^\d/.test(parts[0])) state.dusun = parts[0];
      if (!state.desa) state.desa = parts[1];
      if (!state.kecamatan) state.kecamatan = parts[2];
      if (!state.kota) state.kota = parts[3];
    }
  }

  // ── RT/RW — handle "RT 03/RW 05", "RT 03/05", "rt03/rw05" ──
  if (!state.rtRw) {
    const rtMatch = message.match(/rt\s*(\d{1,3})\s*\/\s*(?:rw\s*)?(\d{1,3})/i);
    if (rtMatch) {
      state.rtRw = `RT ${rtMatch[1]}/RW ${rtMatch[2]}`;
    }
  }

  // ── PATOKAN: baris yang bukan nama/bukan alamat/bukan HP ──
  if (!state.patokan && !state.patokanSkipped) {
    const lowerClean = lower.replace(/rt\s*\d+\s*\/?\s*rw\s*\d+/gi, '').trim();
    if (
      lowerClean.length > 3 &&
      !/^\d{8,13}$/.test(lowerClean.replace(/\s/g, '')) &&
      !looksLikeAddress(lower) &&
      words.length >= 2
    ) {
      // Patokan biasanya kalimat pendek: "deket masjid", "sebelah warung"
      const patokanKeywords = ['dekat', 'deket', 'sebelah', 'samping', 'belakang', 'depan', 'sudut', 'ujung', 'masjid', 'sekolah', 'warung', 'jalan'];
      if (patokanKeywords.some(k => lowerClean.includes(k))) {
        state.patokan = message.trim();
      }
    }
  }
}

function looksLikeAddress(text) {
  // BUG-09 fix: tambah keyword umum alamat Indonesia
  return /jalan|jl\.|jl\s|gg\.|gang|rt\s|rw\s|\brt\b|\brw\b|desa|kelurahan|kel\.|kecamatan|kec\.|kota|kabupaten|kab\.|dusun|rukeman|kampung|perum|perumahan|blok|no\.|nomor|kompleks|komplek/.test(text);
}

function looksLikeQuestion(text) {
  return /\?|harga|berapa|stok|warna|ukuran|manfaat|cara|kirim|tok/.test(text);
}

function getNextOrderField(state) {
  if (!state.color) return 'warna';
  if (!state.namaLengkap || !state.namaVerified) return 'nama lengkap penerima';
  if (!state.desa) return 'alamat (dusun, desa, kecamatan, kota)';
  if (!state.patokan) return 'patokan rumah';
  if (!state.rtRw) return 'RT/RW';
  if (!state.noHp) return 'nomor HP';
  return null;
}

// IMP-2B: POST_ORDER_TTL — reset state 3 hari setelah order confirmed agar customer bisa order lagi
const POST_ORDER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// Cleanup order state: hapus idle >30 menit, reset post-order >3 hari
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [from, state] of orderStates) {
    // Hapus state yang sudah idle > 30 menit (belum order)
    if (!state.orderConfirmed && now - state.lastUpdate > 30 * 60 * 1000) {
      orderStates.delete(from);
      changed = true;
      continue;
    }
    // IMP-2B: Reset state 3 hari setelah order confirmed → customer bisa order lagi dari step 1
    if (state.orderConfirmed && now - state.lastUpdate > POST_ORDER_TTL_MS) {
      orderStates.set(from, createOrderState(state.product)); // reset ke step 1, produk tetap
      changed = true;
    }
  }
  // BUG-04 fix: persist ke file agar state tidak di-load ulang saat server restart
  if (changed) persistOrderState(true); // urgent=true agar tidak di-debounce
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// INTERNAL TEST MODE: Intercept WABA I/O + Gemini payload
// ═══════════════════════════════════════════════════════════════════
const TEST_PHONE = 'test_internal_0000'; // nomor virtual, tidak menyentuh WABA nyata
const testTurns = [];                    // { id, input, aiOutput, geminiRequest, geminiResponse, step, validation, timestamp }
let _capturedGeminiRequest = null;       // capture sementara Gemini request per turn
let _capturedGeminiResponse = null;      // capture sementara Gemini response per turn
let _prevTestStep = null;                // step sebelumnya untuk validasi V8

// Validation engine — cek apakah AI reply sesuai ekspektasi
function validateTestTurn({ step, prevStep, rawGeminiText, aiOutput }) {
  const results = [];
  const add = (id, label, pass, note = '') => results.push({ id, label, pass, note });

  // V1: Output tidak kosong
  add('V1', 'Output tidak kosong', (aiOutput || '').length > 0);

  // V2: Step 2 — max 2 kalimat (tidak boleh terlalu panjang)
  if (step === 2) {
    const sentences = (aiOutput || '').split(/[.!?]+/).filter(s => s.trim().length > 3);
    add('V2', 'Step 2 — max 2 kalimat', sentences.length <= 2, `${sentences.length} kalimat terdeteksi`);
  }

  // V3 & V4: [ORDER_DATA] valid dan lengkap
  const orderMatch = (rawGeminiText || '').match(/\[ORDER_DATA\]([\s\S]*?)\[\/ORDER_DATA\]/);
  if (orderMatch) {
    try {
      const od = JSON.parse(orderMatch[1].trim());
      add('V3', '[ORDER_DATA] JSON valid', true);
      const requiredFields = ['nama', 'hp', 'produk', 'alamat', 'pembayaran'];
      const missingFields = requiredFields.filter(f => !od[f]);
      add('V4', '[ORDER_DATA] field lengkap', missingFields.length === 0,
        missingFields.length ? `Kurang: ${missingFields.join(', ')}` : '');
    } catch(e) {
      add('V3', '[ORDER_DATA] JSON valid', false, e.message);
      add('V4', '[ORDER_DATA] field lengkap', false, 'JSON tidak valid');
    }
  }

  // V5: Tidak ada tanggal karangan di output
  const datePattern = /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/;
  add('V5', 'Tidak ada tanggal karangan', !datePattern.test(aiOutput || ''));

  // V6: [ESCALATE] format benar (tag buka = tag tutup)
  const escOpen = (rawGeminiText || '').match(/\[ESCALATE:/g);
  const escClose = (rawGeminiText || '').match(/\[\/ESCALATE\]/g);
  if (escOpen) {
    add('V6', '[ESCALATE] format benar', escOpen.length === (escClose || []).length,
      `Buka: ${escOpen.length}, Tutup: ${(escClose || []).length}`);
  }

  // V7: Tidak sebut nama persona (AI tidak boleh bilang namanya sendiri)
  const personaMatch = (settings?.persona || '').match(/(?:namaku|nama saya|saya adalah|bernama)\s+([A-Za-z]+)/i);
  if (personaMatch?.[1]) {
    add('V7', 'Tidak sebut nama persona', !(aiOutput || '').includes(personaMatch[1]),
      `Nama: "${personaMatch[1]}"`);
  }

  // V8: Step tidak loncat lebih dari 1 (kecuali 3→5 eskalasi)
  if (prevStep != null && step != null) {
    const isValidEsc = (prevStep === 3 && step === 5);
    const isValidReset = (step === 1); // reset produk baru ok
    add('V8', `Step tidak loncat (${prevStep}→${step})`,
      Math.abs(step - prevStep) <= 1 || isValidEsc || isValidReset,
      `${prevStep}→${step}`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// TESTING LOG: Log semua data yang dikirim ke Gemini
// ═══════════════════════════════════════════════════════════════════
function logGeminiRequest(direction, data) {
  const SEP = '═'.repeat(60);

  if (direction === 'request') {
    const { user, phone, systemPrompt, history, message, tokenEstimate } = data;
    const ts = new Date().toLocaleTimeString('id-ID');

    console.log(`\n${SEP}`);
    console.log(`📤 GEMINI REQUEST [${ts}] User: ${user} (${phone})`);
    console.log(SEP);

    // ── FULL SYSTEM PROMPT ──
    console.log(`\n┌─── SYSTEM PROMPT (${tokenEstimate?.system || '?'} tokens) ───`);
    const lines = (systemPrompt || '').split('\n');
    for (const line of lines) {
      if (line.startsWith('==='))  console.log(`│ 🔹 ${line}`);
      else if (line.startsWith('→'))  console.log(`│ ⚠️  ${line}`);
      else if (line.startsWith('STEP')) console.log(`│ 📌 ${line}`);
      else console.log(`│    ${line}`);
    }
    console.log(`└─── END SYSTEM PROMPT ───`);

    // ── HISTORY ──
    console.log(`\n┌─── HISTORY (${history?.length || 0} entries) ───`);
    (history || []).forEach((h, i) => {
      if (h._summary) {
        console.log(`│ 📝 [summary] ${h.summary}`);
      } else {
        const userText = (h.body || '').slice(0, 100);
        const aiText  = (h.aiReply || '').slice(0, 100);
        console.log(`│ 👤 User: "${userText}"`);
        console.log(`│ 🤖 AI:   "${aiText}"`);
      }
    });
    console.log(`└─── END HISTORY ───`);

    // ── CURRENT MESSAGE ──
    console.log(`\n┌─── CURRENT MESSAGE ───`);
    console.log(`│ 👤 "${message}"`);
    console.log(`└─── END MESSAGE ───`);

    // ── TOKEN ESTIMATE ──
    console.log(`\n📊 Tokens → System: ${tokenEstimate?.system || '?'} | History: ${tokenEstimate?.history || '?'} | Current: ${tokenEstimate?.current || '?'}`);
    console.log(SEP);
    // Capture request untuk test mode
    if (phone === TEST_PHONE) {
      _capturedGeminiRequest = { systemPrompt, history, message, tokenEstimate };
    }
  }

  if (direction === 'response') {
    const { ok, text, error, duration, outputTokens, phone } = data;
    const ts = new Date().toLocaleTimeString('id-ID');
    console.log(`\n┌─── GEMINI RESPONSE [${ts}] (${duration}ms) ───`);
    if (ok) {
      console.log(`│ 🤖 "${text?.slice(0, 300)}"`);
      if (text?.length > 300) console.log(`│    ... (panjang total: ${text.length} chars)`);
      console.log(`│ 📊 Output tokens: ${outputTokens}`);
    } else {
      console.log(`│ ❌ ERROR: ${error}`);
    }
    console.log(`└─── END RESPONSE ───\n`);
    // Capture response untuk test mode
    if (phone === TEST_PHONE && ok) {
      _capturedGeminiResponse = { rawText: text, outputTokens, duration };
    }
  }
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ═══════════════════════════════════════════════════════════════════
// HISTORY BUILDING: Dynamic length + summary untuk percakapan panjang
// ═══════════════════════════════════════════════════════════════════
function buildHistory(from, currentEntryId, maxEntries = 20) {
  const relevantMessages = messages
    .filter(m => m.from === from && m.id !== currentEntryId && !m.cancelledEntry && m.aiReply)
    .sort((a, b) => a.id - b.id);

  if (relevantMessages.length <= maxEntries) {
    return relevantMessages;
  }

  const recent = relevantMessages.slice(-maxEntries);
  const old = relevantMessages.slice(0, -maxEntries);
  const summary = buildConversationSummary(old);

  return [{ _summary: true, summary }, ...recent];
}

function buildConversationSummary(oldEntries) {
  const products = new Set();
  const discussed = [];
  // Hanya scan 5 entries terakhir (bukan semua histori) supaya produk lama tidak bocor ke ringkasan
  const recentEntries = oldEntries.slice(-5);
  for (const entry of recentEntries) {
    const userText = (entry.body || '').toLowerCase();
    if (userText.includes('baby walking')) products.add('Baby Walking Assistant');
    if (userText.includes('pasta dempul')) products.add('Pasta Dempul');
    if (userText.includes('selang')) products.add('Selang Kran Fleksibel 360°');
    if (userText.includes('mini sealer')) products.add('Mini Sealer Portable');
    if (userText.includes('harga') || userText.includes('berapa')) discussed.push('harga');
    if (userText.includes('warna') || userText.includes('biru') || userText.includes('pink')) discussed.push('warna');
    if (userText.includes('order') || userText.includes('mau')) discussed.push('order');
    if (userText.includes('alamat') || userText.includes('jalan') || userText.includes('jl')) discussed.push('alamat');
    if (userText.includes('ongkir') || userText.includes('kirim')) discussed.push('ongkir');
  }
  const parts = [];
  if (products.size) parts.push(`Produk dibahas: ${[...products].join(', ')}`);
  if (discussed.length) parts.push(`Topik: ${[...new Set(discussed)].join(', ')}`);
  return parts.join('. ') || 'Percakapan sebelumnya.';
}

// Tracking gambar produk yang sudah dikirim otomatis ke tiap nomor customer,
// supaya tidak dikirim berkali-kali dalam 1 percakapan (in-memory saja —
// reset kalau server restart, itu sudah didiskusikan & diterima sebagai batasan).
// Struktur: Map<wa_id, Set<namaProduk>>
const sentProductImages = new Map();
function hasSentProductImage(from, productName) {
  return sentProductImages.get(from)?.has(productName) || false;
}
function markProductImageSent(from, productName) {
  if (!sentProductImages.has(from)) sentProductImages.set(from, new Set());
  sentProductImages.get(from).add(productName);
}

// Dedup pesan masuk berdasarkan wamid — webhook Meta bisa mengirim ulang
// event yang sama (misal kalau respon kita telat), jadi kita tolak wamid
// yang sudah pernah diproses. Disimpan di DB + in-memory cache untuk performa.
const processedWamids = [];
const processedWamidsSet = new Set();

// Load dedup state from database on startup (async, non-blocking)
db.loadActiveClaims?.()?.then(claims => {
  if (claims?.length) {
    for (const c of claims) {
      activeClaims.set(c.wa_id, { description: c.description, timestamp: new Date(c.created_at).getTime() });
    }
    console.log(`📂 Loaded ${claims.length} active claims dari database`);
  }
}).catch(() => {});

function markWamidProcessed(id) {
  if (!id) return;
  // Update in-memory cache
  processedWamidsSet.add(id);
  processedWamids.push(id);
  if (processedWamids.length > config.DEDUP_CACHE_SIZE) {
    const old = processedWamids.shift();
    processedWamidsSet.delete(old);
  }
  // Persist to database (async, non-blocking)
  db.saveProcessedWamid(id);
}

function isWamidProcessed(id) {
  // Fast path: check in-memory cache first
  if (!id) return false;
  if (processedWamidsSet.has(id)) return true;
  // Slow path: check database (async, returns false synchronously on first check)
  // Note: This is a trade-off — first occurrence after restart might have slight delay
  // But prevents duplicate processing which is more critical
  return false;
}

[DATA_DIR, IMAGES_DIR, AUDIO_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

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
  productImages: {},
  courierPriority: DEFAULT_COURIER_PRIORITY, // F1-D: urutan kurir [J&T, iDexpress, JNE, ...]
  stoppedChats: [], // nomor WA yang di-stop AI-nya (per-nomor, bukan global)
};

let settings = { ...DEF };
let messages  = [];
let orders    = [];
// Antrean pertanyaan yang di-escalate ke admin karena Gemini tidak punya info-nya di KB.
// Setiap item: { id, from, senderName, productTag, question, timestamp }
let pendingEscalations = [];
let escalationCounter  = 1; // nomor urut yang ditampilkan ke admin, jalan terus (tidak di-reset)

// F5: Track klaim garansi aktif per customer — Map: from → { description, timestamp }
// In-memory; direset saat server restart (klaim biasanya diselesaikan dalam 1 sesi)
const activeClaims = new Map();

try { if (fs.existsSync(SET_FILE)) settings = { ...DEF, ...JSON.parse(fs.readFileSync(SET_FILE, 'utf8')) }; } catch(e) {}
try { if (fs.existsSync(MSG_FILE)) messages  = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); } catch(e) {}
try { if (fs.existsSync(ORDER_FILE)) orders  = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')); } catch(e) {}
try {
  if (fs.existsSync(ESC_FILE)) {
    const raw = JSON.parse(fs.readFileSync(ESC_FILE, 'utf8'));
    pendingEscalations = raw.items || [];
    escalationCounter  = raw.counter || 1;
  }
} catch(e) {}


// --- DB Sync Helpers ---
async function persistMessageToDB(msg) {
  if(!msg) return;
  try {
    await db.saveMessage(msg);
    const waId = msg.wa_id || msg.from;
    if (waId) await db.upsertContact(waId, msg.sender_name || msg.senderName || 'Unknown');
  } catch(e) { console.error('DB Msg Error:', e.message); }
}
async function persistOrderToDB(order) {
  if(!order) return;
  try { await db.saveOrder(order); } catch(e) { console.error('DB Order Error:', e.message); }
}
async function persistSettingsToDB(settings) {
  if(!settings) return;
  try { await db.saveSettings(settings); } catch(e) { console.error('DB Settings Error:', e.message); }
}
// -----------------------

const save = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch(e) {
    console.error(`❌ [SAVE] Gagal menyimpan file ${path.basename(file)}:`, e.message);
    // Notify dashboard of save error (non-fatal, server continues)
    try { io.emit('save_error', { file: path.basename(file), error: e.message }); } catch(e2) {}
  }
};
const saveEscalations = () => save(ESC_FILE, { counter: escalationCounter, items: pendingEscalations });

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
      // JANGAN geser lastUsedKeyIndex di sini — key hanya berpindah kalau kena 429.
      // Geser dilakukan di markKeyLimited(), bukan di sini.
      return { key: validKeys[pos].key, slot: validKeys[pos].slot, pos };
    }
  }
  return null; // semua key habis
}

// Tandai key kena limit berdasarkan quotaId & retryDelay dari response 429.
// Di sinilah satu-satunya tempat lastUsedKeyIndex digeser — bukan di getAvailableKey().
function markKeyLimited(pos, quotaId, retryDelaySec) {
  const state = apiKeyStates[pos];
  if (!state) return;

  // Geser pointer ke key berikutnya supaya percobaan selanjutnya langsung pakai key lain
  const validKeys = getValidKeys();
  lastUsedKeyIndex = (pos + 1) % Math.max(validKeys.length, 1);

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
  // Intercept untuk nomor test internal — tidak dikirim ke WABA nyata
  if (to === TEST_PHONE) {
    console.log(`[TEST] 📨 Dicegat (tidak dikirim ke WABA): "${text?.slice(0, 80)}"`); 
    return { intercepted: true, text };
  }
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

// ── P2-A: Download gambar dari customer via Graph API ─────────────
// Dijalankan secara async (fire-and-forget) sehingga tidak menghambat
// proses AI reply. Setelah selesai, media_url di DB akan terupdate
// dan dashboard akan menampilkan gambar di bubble customer.
async function downloadAndSaveCustomerMedia(mediaId, wamid, mimetype) {
  if (!waConfigured) return null;
  try {
    // Step 1: Minta URL download sementara dari Graph API
    const infoRes = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    if (!infoRes.ok) throw new Error(`Graph API error ${infoRes.status}`);
    const { url } = await infoRes.json();
    if (!url) throw new Error('URL media tidak ditemukan di response Graph API');

    // Step 2: Download binary dari URL tersebut
    const imgRes = await fetch(url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!imgRes.ok) throw new Error(`Download gagal: HTTP ${imgRes.status}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    // Step 3: Simpan ke disk — data/images/customer_{wamid}.jpg
    const ext = (mimetype || '').includes('png') ? 'png' :
                (mimetype || '').includes('gif') ? 'gif' : 'jpg';
    const safeName = (wamid || Date.now().toString()).replace(/[^a-z0-9_-]/gi, '_');
    const filename = `customer_${safeName}.${ext}`;
    const savePath = path.join(IMAGES_DIR, filename);
    fs.writeFileSync(savePath, buffer);

    // Step 4: Update kolom media_url di DB agar dashboard bisa render gambar
    const mediaUrlPath = `/images/${filename}`;
    try {
      await db.pool.query(
        'UPDATE messages SET media_url = $1 WHERE waba_message_id = $2',
        [mediaUrlPath, wamid]
      );
      console.log(`🖼️ [P2-A] Gambar customer disimpan: ${filename}`);
      // Update in-memory messages agar media_url tersimpan di messages.json
      const inMemMsg = messages.find(m => m.wamid === wamid || m.waba_message_id === wamid);
      if (inMemMsg) {
        inMemMsg.mediaUrl = mediaUrlPath;
        inMemMsg.media_url = mediaUrlPath;
        inMemMsg.messageType = 'image';
        inMemMsg.message_type = 'image';
        save(MSG_FILE, messages);
        console.log(`✅ [P2-A] In-memory updated & saved for wamid: ${wamid}`);
      } else {
        console.warn(`❌ [P2-A] Message NOT found in memory for wamid: ${wamid} (messages count: ${messages.length})`);
      }
      // Emit ke dashboard agar gambar tampil tanpa perlu reload
      io.emit('message_media_updated', { wamid, mediaUrl: mediaUrlPath });
    } catch(dbErr) {
      console.warn('[P2-A] Gagal update media_url di DB:', dbErr.message);
    }
  } catch (e) {
    console.warn(`⚠️ [P2-A] Gagal download gambar customer (mediaId=${mediaId}):`, e.message);
    return null;
  }
}
// ──────────────────────────────────────────────────────────────────

// ── P2-A2: Download pesan suara dari customer via Graph API ───────
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
    const savePath = path.join(AUDIO_DIR, filename);
    fs.writeFileSync(savePath, buffer);

    const mediaUrlPath = `/audio/${filename}`;
    try {
      await db.pool.query(
        'UPDATE messages SET media_url = $1, message_type = $2 WHERE waba_message_id = $3',
        [mediaUrlPath, 'audio', wamid]
      );
      console.log(`🎙️ [P2-A2] Audio customer disimpan: ${filename}`);
      const inMemMsg = messages.find(m => m.wamid === wamid || m.waba_message_id === wamid);
      if (inMemMsg) {
        inMemMsg.mediaUrl = mediaUrlPath;
        inMemMsg.media_url = mediaUrlPath;
        inMemMsg.messageType = 'audio';
        inMemMsg.message_type = 'audio';
        inMemMsg.mediaMimeType = mimetype || 'audio/ogg';
        inMemMsg.media_mime_type = mimetype || 'audio/ogg';
        save(MSG_FILE, messages);
        console.log(`✅ [P2-A2] In-memory updated & saved for wamid: ${wamid}`);
      } else {
        console.warn(`❌ [P2-A2] Message NOT found in memory for wamid: ${wamid}`);
      }
      io.emit('message_media_updated', { wamid, mediaUrl: mediaUrlPath, messageType: 'audio' });
    } catch(dbErr) {
      console.warn('[P2-A2] Gagal update audio di DB:', dbErr.message);
    }
  } catch (e) {
    console.warn(`⚠️ [P2-A2] Gagal download audio customer (mediaId=${mediaId}):`, e.message);
    return null;
  }
}
// ──────────────────────────────────────────────────────────────────


async function sendWhatsAppImageByPath(to, filePath, mimetype) {
  const mediaId = await uploadWhatsAppMedia(filePath, mimetype);
  if (!mediaId) throw new Error('Upload media ke WhatsApp gagal (tidak dapat media id)');
  const body = { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId } };
  return graphFetch('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Upload buffer langsung (dari file yang di-upload dashboard) ke Graph API
async function uploadWhatsAppMediaBuffer(buffer, mimetype, filename) {
  const blob = new Blob([buffer], { type: mimetype });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', blob, filename);
  form.append('type', mimetype);
  const data = await graphFetch('/media', { method: 'POST', body: form });
  return data?.id || null;
}

// Kirim video atau gambar ke nomor WA menggunakan media_id yang sudah diupload
async function sendWhatsAppMediaById(to, mediaId, mediaType, caption) {
  const key = mediaType === 'video' ? 'video' : 'image';
  const mediaObj = { id: mediaId };
  if (caption) mediaObj.caption = caption;
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: key,
    [key]: mediaObj,
  };
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

  // Deteksi query "semua produk" / "jual apa saja" — kirim semua blok supaya AI
  // tidak hanya sebut 1 produk saat customer tanya koleksi secara umum.
  const ALL_PRODUCTS_KEYWORDS = ['apa saja', 'apa aja', 'semua produk', 'produk apa', 'jual apa', 'ada apa', 'ada apa saja', 'produk lain', 'ada produk'];
  const isAskingAllProducts = ALL_PRODUCTS_KEYWORDS.some(kw => combinedText.includes(kw));

  // Kalau ketemu kecocokan jelas, kirim hanya itu (hemat token).
  // E2: Kalau tidak ada match (pertanyaan di luar topik produk), kirim max 5 blok pertama
  // saja sebagai konteks minimal — jangan kirim semua produk sekaligus supaya tidak
  // boros token dan AI tidak confused.
  // E3: Pengecualian — kalau query eksplisit tanya semua produk, kirim semua blok.
  const MAX_FALLBACK_BLOCKS = 5;
  const chosen = isAskingAllProducts ? blocks : (matched.length ? matched : blocks.slice(0, MAX_FALLBACK_BLOCKS));
  return chosen.map(b => b.text).join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════
// STEP RULES: Aturan behavior per step
// ═══════════════════════════════════════════════════════════════════

const STEP1_RULES = `
STEP 1 — JAWAB PRODUK:
- Customer bertanya tentang produk (nama, harga, manfaat, varian, stok)
- Jawab LENGKAP dari informasi produk di atas
- Sebutkan: harga, varian, manfaat utama (1-2 poin), CTA
- JANGAN tanya data order di step ini
`;

const STEP2_RULES = `
STEP 2 — FOLLOW-UP:
- Customer bertanya DETAIL tentang produk yang SUDAH dibahas di Step 1
- Jawab SINGKAT langsung ke inti, JANGAN ulang penjelasan dari Step 1
- Contoh: "ukurannya berapa?" → "250 gram per unit Kak"
- JANGAN sebut manfaat lagi jika sudah dijelaskan di Step 1
- JANGAN sebut harga lagi jika sudah disebut di Step 1
`;

const STEP3_RULES = `
STEP 3 — KUMPULKAN DATA (IKUTI URUTAN INI PERSIS):
- Customer sudah menunjukkan minat order
- Urutan tanya yang WAJIB diikuti:
  1. Nama lengkap penerima (kalau 1 kata → WAJIB verifikasi, JANGAN catat sebagai nama lengkap)
  2. Alamat: desa/kelurahan + kecamatan + kota/kabupaten
     - KECAMATAN dan KOTA/KABUPATEN itu WAJIB — tidak boleh skip atau diasumsikan
     - Kalau customer cuma kasih nama desa/dusun: WAJIB tanya "Kecamatannya apa, Kak? Dan kota/kabupatennya?"
     - Kalau customer kasih 1 baris "Desa A, Kec B, Kota C": langsung catat semua, lanjut ke RT/RW
  3. RT/RW
     - WAJIB tanya ke customer: "RT dan RW-nya berapa, Kak?"
     - HANYA setelah customer jawab "gak ada" / "tidak ada" barulah catat "-"
     - JANGAN asumsikan RT/RW kosong kalau belum ditanya
  4. Patokan rumah (dekat masjid/warung/sekolah/jalan)
  5. Konfirmasi nomor HP ("pakai nomor WhatsApp ini juga ya, Kak?")
  6. REKAP semua data → minta konfirmasi → masuk Step 4

- CEK FLAG: Sebelum tanya, cek field mana yang BELUM terisi.
  JANGAN tanya field yang sudah ada. TAPI: kecamatan, kota, dan RT/RW harus SELALU ditanya kalau belum ada.

- SELALU tanya SATU field per balasan. JANGAN gabung 2 field dalam 1 pesan.

- Tanda akhir: tampilkan tag [STEP=3] di baris terakhir balasanmu.
`;

const STEP4_RULES = `
STEP 4 — KONFIRMASI:
- SEMUA data sudah lengkap (cek flag: nama, desa, kecamatan, kota, patokan, RT/RW, HP)
- Rekap pesanan: produk, warna, harga, nama, alamat lengkap+patokan, HP
- Tanya: "Apakah data sudah benar semua Kak?"
- JANGAN tanya data tambahan di step ini
- Setelah customer konfirmasi "ya/benar/oke":
  - Sisipkan [ORDER_DATA]...[/ORDER_DATA]
  - Tanda akhir: tampilkan tag [STEP=4] di baris terakhir balasanmu
`;

const STEP5_RULES = `
STEP 5 — ESKALASI KE ADMIN:
- Jika ada pertanyaan yang jawabannya TIDAK ada di KB: JANGAN jawab sendiri, JANGAN mengarang.
- Info yang WAJIB di-escalate (JANGAN pernah jawab sendiri):
  * Estimasi pengiriman / kapan dikirim / berapa hari sampai
  * Stok / ketersediaan barang
  * Kebijakan retur, garansi, klaim yang tidak disebutkan di KB
  * Tracking / status pengiriman
  * Info apapun yang TIDAK tertulis eksplisit di INFORMASI PRODUK & BISNIS
- CARA MERESPONS: Balas customer dengan singkat dulu, lalu SISIPKAN tag [ESCALATE]:
  Contoh: "Sebentar ya Kak, saya tanyakan ke admin dulu ya 😊 [ESCALATE:Pasta Dempul Instan Tembok]berapa hari estimasi pengiriman ke Bantul?[/ESCALATE]"
- TIDAK BOLEH: membuat tanggal, waktu, estimasi hari, atau angka yang tidak ada di KB
- JANGAN tanya data tambahan di step ini
`;

// Helper: field mana yang belum terisi
// IMP-3B: patokan opsional jika patokanSkipped=true
function getMissingFields(state) {
  const missing = [];
  if (!state.namaLengkap || !state.namaVerified) missing.push('nama lengkap');
  if (!state.desa)               missing.push('dusun/desa');
  if (!state.kecamatan)          missing.push('kecamatan');
  if (!state.kota)               missing.push('kota');
  if (!state.patokan && !state.patokanSkipped) missing.push('patokan');  // opsional
  if (!state.rtRw)               missing.push('RT/RW');
  if (!state.noHp)               missing.push('nomor HP');
  return missing;
}

function buildSystemPrompt(name, relevantKB, isFirstMessage, from) {
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
  } else if (isFirstMessage && focus) {
    // IMP-3C: Produk terdeteksi tapi tidak ada KB → beri tahu AI agar tidak mengarang
    parts.push(`// CATATAN SISTEM: Produk "${focus}" tidak memiliki informasi di Knowledge Base.`);
    parts.push('// Balas dengan sopan bahwa informasi produk ini belum tersedia, dan tawarkan untuk menghubungi admin.');
    parts.push('');
  }
  // Product focus + Step State: kunci AI ke produk & step order
  const orderState = from ? orderStates.get(from) : null;
  const focus = orderState?.product || null;
  if (focus) {
    parts.push(`=== PRODUK FOKUS: ${focus} ===`);
    parts.push(`Customer sedang membahas "${focus}". Fokus HANYA pada produk ini. Jika customer tanya produk lain, barulah pindah fokus.`);
    parts.push('');
  }

  // Step State + flags: beri tahu AI posisi saat ini & field yang sudah terisi
  if (orderState && orderState.step) {
    parts.push('=== STATUS SAAT INI ===');
    parts.push(`Step: ${orderState.step}`);
    if (orderState.color) parts.push(`Warna: ${orderState.color}`);
    if (orderState.namaLengkap) parts.push(`Nama: ${orderState.namaLengkap} (verified: ${orderState.namaVerified})`);
    if (orderState.desa) parts.push(`Desa: ${orderState.desa}`);
    if (orderState.kecamatan) parts.push(`Kecamatan: ${orderState.kecamatan}`);
    if (orderState.kota) parts.push(`Kota: ${orderState.kota}`);
    if (orderState.rtRw) parts.push(`RT/RW: ${orderState.rtRw}`);
    if (orderState.patokan) parts.push(`Patokan: ${orderState.patokan}`);
    if (orderState.noHp) parts.push(`HP: ${orderState.noHp}`);

    // BUG-06 fix: missing fields hanya ditampilkan di Step 3+ agar tidak
    // membingungkan AI di Step 1/2 yang belum boleh tanya data order
    const missing = getMissingFields(orderState);
    if (missing.length && orderState.step >= 3) {
      parts.push(`→ Belum ada: ${missing.join(', ')}`);
      parts.push(`Tanyakan field yang masih kurang, satu per satu.`);
    }
    parts.push('');
  }
  if (settings.followUp?.trim()) {
    parts.push('=== PROSEDUR MENJAWAB (WAJIB DIIKUTI, BUKAN SEKADAR REFERENSI) ===');
    parts.push(settings.followUp.trim());
    parts.push('');
  }
  // Step rules: hanya kirim rules untuk step saat ini
  if (!orderState || orderState.step === 1) parts.push(STEP1_RULES);
  else if (orderState.step === 2) parts.push(STEP2_RULES);
  else if (orderState.step === 3) parts.push(STEP3_RULES);
  else if (orderState.step === 4) parts.push(STEP4_RULES);
  else if (orderState.step === 5) parts.push(STEP5_RULES);
  parts.push('=== ATURAN MENJAWAB ===');
  parts.push('- FOKUS pada produk yang sedang ditanyakan customer SAAT INI. Jangan campur informasi produk lain dari riwayat chat sebelumnya. Contoh: kalau customer tanya "pasta dempul", jawab HANYA tentang pasta dempul — jangan membahas baby walking assistant');
  parts.push('- Balas secara natural seperti manusia, bukan robot');
  parts.push('- Gunakan bahasa percakapan sehari-hari yang hangat, gaya tetap profesional (bukan lebay/berlebihan)');
  parts.push('- JANGAN gunakan tanda petik di awal atau akhir pesan');
  parts.push('- Jika menerima pesan suara (audio), DENGARKAN isi audionya dan balas berdasarkan konten suara pelanggan. Jangan mengabaikan audio');
  parts.push('- Kamu mengaku sebagai "admin"/"kami" toko — JANGAN pakai nama persona apapun, dan JANGAN sebut bahwa kamu AI kecuali ditanya langsung');
  parts.push('- Emoji dipakai JARANG saja (boleh sesekali, jangan tiap kalimat) — jangan berlebihan');
  parts.push('- Pisahkan paragraf dengan baris baru (enter) agar mudah dibaca. Contoh: sapaan di baris pertama, informasi produk di baris berikutnya, lalu CTA/pertanyaan di baris terakhir. Jangan gabung semua jadi 1 blok teks panjang');
  parts.push('');
  parts.push('=== ATURAN NEGO HARGA & SITUASI SULIT ===');
  parts.push('- Kalau pelanggan minta nego/diskon harga: boleh kasih potongan MAKSIMAL Rp10.000 dari harga normal, putuskan sendiri tanpa perlu tanya admin. Kalau minta lebih dari itu, tetap tolak sopan dan pertahankan harga setelah potongan Rp10.000 tersebut');
  parts.push('- Kalau pelanggan minta harga reseller/grosir/mau dijual lagi: TOLAK dengan sopan, harga tetap sama berapa pun jumlah/tujuan pembeliannya, tidak ada harga khusus reseller');
  parts.push('- Kalau pelanggan marah, kecewa, sarkas, atau menuduh (misal bilang bot bohong/gak jelas): tetap balas dengan SOPAN dan NORMAL seperti biasa, jangan defensif berlebihan, jangan anggap itu masalah besar');
  parts.push('- Kalau pelanggan bilang batal/gak jadi/mundur/kemahalan/tidak jadi beli: TERIMA langsung dengan ucapan terima kasih yang sopan dan TUTUP percakapan dengan baik. DILARANG KERAS menawarkan apapun sebagai "penggantinya" — termasuk diskon, sampel, harga khusus, alternatif produk lain, atau ajakan coba-coba dulu. Kalimat penutup cukup seperti "Tidak apa-apa Kak, terima kasih sudah mampir ya. Kalau nanti berubah pikiran, kami siap membantu 😊" — dan berhenti di situ');
  parts.push('');
  parts.push('=== ATURAN CTA / ARAHKAN KE CLOSING (PENTING) ===');
  parts.push('- SETIAP balasan (apapun jenisnya — jawab info produk, harga, kirim foto, bahkan balasan template dari trigger iklan) WAJIB diakhiri dengan 1 pertanyaan yang mengarahkan percakapan lebih dekat ke closing (contoh: tanya varian/warna, jumlah pesanan, lokasi kirim, atau langsung ajak proses order) — JANGAN biarkan balasan berhenti begitu saja tanpa mengajak pelanggan lanjut ke langkah berikutnya. TERMASUK balasan konfirmasi order final — setelah mengucapkan terima kasih/pesanan diproses, TETAP tambahkan 1 kalimat penutup seperti "Ada lagi yang bisa saya bantu Kak?" atau "Semoga si kecil suka ya Kak! 😊"');
  parts.push('- Pilih SENDIRI pertanyaan yang paling relevan sesuai konteks saat itu — tidak ada urutan tahapan yang kaku (boleh langsung tanya warna, boleh langsung tanya alamat, tergantung mana yang paling pas)');
  parts.push('- MAKSIMAL 1 pertanyaan per balasan. Kalau isi balasanmu SUDAH secara natural mengandung 1 pertanyaan (misal "mau pilih warna apa Kak?"), JANGAN tambah pertanyaan CTA lagi di atasnya — itu sudah cukup');
  parts.push('- Kalau pelanggan sudah menunjukkan minat jelas (nanya harga/warna/detail) tapi belum kasih data pemesanan, boleh proaktif ajak closing, contoh: "Mau saya proses sekarang Kak?"');
  parts.push('');
  parts.push('=== PANJANG & GAYA BALASAN (PENTING) ===');
  parts.push('- Ikuti PROSEDUR MENJAWAB di atas sebagai aturan wajib, tapi jangan diulang kata-per-kata sebagai skrip di setiap balasan — sesuaikan redaksinya secara natural sesuai konteks pesan pelanggan saat itu');
  parts.push(isFirstMessage
    ? '- Ini kemungkinan pesan PERTAMA pelanggan di percakapan ini: boleh jelaskan 1-2 keunggulan utama produk secara singkat, maksimal 3-4 kalimat total. Boleh ada sapaan/basa-basi ramah singkat di awal sebelum masuk ke jawaban inti'
    : '- Ini BUKAN pesan pertama (sudah ada riwayat chat): JANGAN ulangi penjelasan keunggulan produk yang sudah dijelaskan sebelumnya. Jawab sesuai konteks — boleh ada basa-basi ramah singkat sebelum/sesudah jawaban inti (misal "Siap Kak!", "Tentu bisa~", "Senang bisa bantu!")');
  parts.push('- JANGAN sebut nama produk berulang kali. Kalau produk sudah disebut/ditetapkan di percakapan sebelumnya, cukup referensikan dengan "produknya", "pesanan", atau langsung ke inti tanpa menyebut nama produk lagi. Contoh SALAH: "Siap Kak, untuk Pasta Dempul Instan Tembok-nya, boleh minta alamat?" → Contoh BENAR: "Siap Kak, boleh minta alamat lengkapnya?"');
  parts.push('- Kalau pelanggan hanya minta harga ("cek harga", "berapa", dll), jawab harga + 1 kalimat penutup/CTA saja. JANGAN ulang jelaskan keunggulan produk lagi kalau sudah pernah dijelaskan di riwayat chat sebelumnya');
  parts.push('');
  parts.push('=== BATAS KALIMAT PER STEP (PENTING) ===');
  parts.push('- Step 1 (produk): MAKSIMAL 2 kalimat — jawab pertanyaan produk + CTA');
  parts.push('- Step 2 (follow-up): 1 kalimat — langsung jawab pertanyaan + CTA');
  parts.push('- Step 3 (kumpul data): 1 kalimat — tanya SATU field spesifik. Boleh lebih kalau perlu verifikasi (misal: "Ini sudah nama lengkap Kak? Mohon nama lengkap ya.")');
  parts.push('- Step 4 (konfirmasi): MAKSIMAL 2 kalimat — konfirmasi pesanan + penutup');
  parts.push('- Step 5 (eskalasi): Sapa customer singkat (misal "Sebentar ya Kak") + sisipkan tag [ESCALATE]. Admin akan jawab dari Telegram');
  parts.push('- Di luar aturan di atas, SINGKAT dan langsung ke inti. Jangan ada basa-basi berlebihan');
  parts.push('');
  parts.push('=== ATURAN DATA PEMESANAN (IKUTI STEP3 RULES, PENTING) ===');
  parts.push('- Untuk pengumpulan data alamat dan data customer, IKUTI urutan di STEP3 RULES di atas (satu field per balasan).');
  parts.push('- ATURAN INI tidak menggantikan STEP3 — STEP3 lebih detail dan harus diikuti.');
  parts.push('- Untuk No HP: JANGAN langsung minta diketik. Tanya dulu: "Boleh pakai nomor WhatsApp ini juga untuk dihubungi kurir ya, Kak?" — kalau setuju → catat "SAMA_DENGAN_WA" di field hp pada [ORDER_DATA]; kalau mau kasih nomor lain → minta diketik');
  parts.push('- HATI-HATI KATA AMBIGU: Kata "No", "no", "nomer", "nomor" dalam chat bahasa Indonesia SERING berarti "Nomor" (misal: "No WA ini kak", "no hp ini aja"), BUKAN berarti "tidak/batal". JANGAN tafsirkan sebagai pembatalan kecuali ada konteks sangat jelas (misal "gak jadi", "batal", "tidak jadi beli"). Kalau ambigu, konfirmasi dulu: "Maksudnya pakai nomor WhatsApp ini ya, Kak?" — jangan langsung tutup percakapan.');
  parts.push('- Tetap patuhi ATURAN CTA (maksimal 1 pertanyaan per balasan) — jangan gabungkan 2 langkah di atas jadi 1 balasan');
  parts.push('- Begitu SEMUA data (Alamat+patokan bila perlu, Nama, konfirmasi No HP) sudah lengkap terkumpul: JANGAN langsung sisipkan [ORDER_DATA]. Balas dulu dengan MEREKAP pesanan (produk, varian, jumlah, total harga, nama, alamat lengkap+patokan, No HP) dan minta konfirmasi eksplisit, contoh: "Baik Kak, saya konfirmasi ya: ... sudah benar semua?"');
  parts.push('- Order baru dianggap FINAL setelah pelanggan membalas mengonfirmasi (misal "ya", "benar", "betul", "oke fix"). BARU pada balasan konfirmasi tersebut kamu sisipkan blok data khusus di baris paling bawah balasanmu.');
  parts.push('- Kalau pesanan berisi LEBIH DARI 1 produk (order gabungan), jumlahkan semua ke dalam total harga saat merekap, dan tulis semua nama produk pada field "produk" (pisahkan dengan koma)');
  parts.push('Format blok data (harus valid JSON di dalam tag tersebut, dipakai sistem otomatis kami untuk mencatat pesanan — akan disembunyikan otomatis dari mata pelanggan):');
  parts.push('[ORDER_DATA]{"nama": "Nama Lengkap", "hp": "No HP, atau SAMA_DENGAN_WA kalau pelanggan setuju pakai nomor WA yang sama", "produk": "Nama Produk yang Dipesan", "alamat": "Alamat lengkap: nama jalan, nomor rumah, RT/RW, kelurahan, kecamatan, kota/kabupaten, dan patokan bila ada", "pembayaran": "COD atau Transfer"}[/ORDER_DATA]');
  parts.push('PENTING: Jangan menyertakan blok ini jika pelanggan hanya tanya-tanya, belum pasti memesan, atau belum eksplisit mengonfirmasi rekap pesanan.');
  parts.push('- WAJIB VERIFIKASI SEBELUM REKAP: Sebelum mengirim rekap pesanan, cek satu per satu apakah data berikut SUDAH pernah disebutkan EKSPLISIT oleh customer di percakapan ini (jangan asumsikan dari nama WA atau konteks lain):');
  parts.push('    (1) Nama lengkap penerima — HARUS customer yang menyebutnya sendiri');
  parts.push('    (2) Alamat lengkap dengan RT/RW, kelurahan, kecamatan, kota/kabupaten');
  parts.push('    (3) Konfirmasi nomor HP');
  parts.push('  Kalau ada yang BELUM terpenuhi -> JANGAN rekap dulu. Tanyakan field yang masih kurang, satu per satu.');
  parts.push('- DILARANG KERAS menyisipkan [ORDER_DATA] jika nama penerima atau alamat detail BELUM pernah dikirimkan oleh customer.');
  parts.push('');
  parts.push('=== KALIMAT PENUTUP KHUSUS UNTUK PRODUK COD (PENTING) ===');
  parts.push('- Cek INFORMASI PRODUK & BISNIS: kalau produk yang dipesan ini menyatakan bisa COD (misal tertulis "COD: bisa" atau sejenisnya), maka PADA BALASAN KONFIRMASI ORDER FINAL (balasan yang menyertakan [ORDER_DATA]) WAJIB tambahkan kalimat berikut PERSIS setelah kalimat "pesanan diproses" dan SEBELUM kalimat CTA penutup biasa: "Kalau sering di luar rumah, boleh titip uangnya ke keluarga ya, biar paket tetap bisa diterima pas kurir datang 😊 Kalau ada yang mau ditanyakan lagi nanti, tinggal chat ke sini aja ya Kak."');
  parts.push('- Kalimat ini HANYA untuk produk yang statusnya bisa COD. Kalau produk tidak COD (atau statusnya tidak disebutkan), JANGAN tambahkan kalimat ini sama sekali.');
  parts.push('- Kalimat ini boleh disesuaikan redaksinya secara natural (tidak perlu kata-per-kata), tapi wajib menyampaikan 2 hal: (1) titip uang ke keluarga kalau customer sering di luar rumah supaya kurir tetap bisa nyerahin paket, (2) boleh chat lagi ke nomor ini kalau ada yang mau ditanyakan');
  parts.push('');
  parts.push('=== ATURAN ESKALASI KE ADMIN (SANGAT PENTING — JANGAN MENGARANG) ===');
  parts.push('- Kalau ada pertanyaan yang jawabannya TIDAK tertulis eksplisit di INFORMASI PRODUK & BISNIS di atas (contoh: asal/lokasi pengiriman, estimasi hari sampai yang spesifik, stok riil, kebijakan yang tidak disebutkan) — JANGAN PERNAH mengarang atau menebak jawaban, walau kedengarannya masuk akal');
  parts.push('- Untuk kasus itu, sisipkan tag berikut di balasanmu (boleh lebih dari satu kalau ada beberapa hal yang tidak diketahui sekaligus): [ESCALATE:Nama Produk Persis Sesuai Header Info Produk]pertanyaan singkat untuk admin[/ESCALATE]. Kalau pertanyaannya bukan soal produk tertentu (misal jam operasional toko, kebijakan retur umum), gunakan tag [ESCALATE:UMUM]pertanyaan singkat[/ESCALATE]');
  parts.push('- Kalau SELURUH balasanmu untuk pesan ini hanya berisi tag [ESCALATE], JANGAN tambahkan kalimat basa-basi apapun di luar tag itu (sistem akan menahan balasan ke pelanggan sampai admin menjawab)');
  parts.push('- Kalau sebagian pertanyaan pelanggan BISA dijawab dari info yang ada dan sebagian TIDAK, jawab dulu bagian yang bisa secara normal (termasuk CTA-nya), lalu tambahkan tag [ESCALATE] untuk bagian yang tidak diketahui itu');
  parts.push('- Kalau pelanggan bertanya soal produk/topik yang BENAR-BENAR di luar bisnis toko ini sama sekali (bukan variasi istilah dari produk yang ada, misal toko jual alat rumah tangga tapi ditanya soal jasa servis HP) — ini BUKAN kasus eskalasi, cukup jawab jujur dan ramah bahwa itu tidak tersedia, lalu tawarkan produk lain yang relevan jika ada');
  parts.push('');
  parts.push('=== ANTI-HALLUCINATION: INFO YANG BOLEH vs TIDAK BOLEH (SANGAT PENTING) ===');
  parts.push('- INFO YANG BOLEH disebutkan (hanya kalau tertulis eksplisit di KB): nama produk, harga, varian/warna, manfaat/kegunaan, cara pakai, harga sudah termasuk ongkir atau belum');
  parts.push('- INFO YANG TIDAK BOLEH dibuat/ditebak sendiri (JANGAN PERNAH, WALAU KEDENGERAN MASUK AKAL):');
  parts.push('  * Tanggal atau hari pengiriman (misal "dikirim tanggal 18", "besok dikirim", "2-3 hari lagi sampai")');
  parts.push('  * Estimasi waktu sampai ("3-5 hari", "seminggu lagi")');
  parts.push('  * Status stok ("ready", "kosong", "sisa 5")');
  parts.push('  * Nama kurir / jasa pengiriman');
  parts.push('  * Lokasi toko / alamat pengirim');
  parts.push('  * Info kebijakan yang tidak disebutkan (retur, garansi, klaim)');
  parts.push('- Kalau customer tanya salah satu info di atas: JANGAN jawab dengan informasi buatan sendiri. Gunakan tag [ESCALATE] untuk meneruskan ke admin');
  parts.push('- RISIKO: jawaban palsu soal tanggal/stok/estimasi bisa bikin customer kecewa dan komplain. Lebih baik diam dan tanya admin daripada mengarang');
  parts.push('');
  parts.push('=== ATURAN SPLIT BUBBLE (PENTING) ===');
  parts.push('- Ketika customer menyebut nama produk untuk PERTAMA KALI di percakapan ini (dan produk belum pernah dikonfirmasi sebelumnya di history), WAJIB pisahkan balasanmu menjadi 2 bagian menggunakan tag [SPLIT]:');
  parts.push('    Bagian 1 (sebelum [SPLIT]): Hanya 1 kalimat singkat yang mengkonfirmasi nama produk yang ditanyakan.');
  parts.push('    Contoh Bagian 1: "Baby Walking Assistant ya Kak" atau "Selang fleksibel ya Kak" atau "Pasta Dempul Tembok ya Kak"');
  parts.push('    Bagian 2 (setelah [SPLIT]): Isi jawaban lengkap (harga, varian, detail produk, CTA).');
  parts.push('- Tujuan [SPLIT]: mengunci konteks produk di bubble pertama supaya tidak terlupakan di percakapan panjang.');
  parts.push('- JANGAN gunakan [SPLIT] kalau produk sudah pernah dikonfirmasi di history percakapan ini.');
  parts.push('- JANGAN gunakan [SPLIT] untuk balasan non-produk: tanya alamat, tanya nama, konfirmasi order, rekap, dll.');
  parts.push('- JANGAN gunakan [SPLIT] lebih dari 1 kali dalam 1 percakapan untuk produk yang sama.');
  parts.push('');
  const productsWithImages = Object.keys(settings.productImages || {}).filter(k => settings.productImages[k] && settings.productImages[k].some(img => img));
  if (productsWithImages.length > 0) {
    const alreadyImaged = productsWithImages.filter(p => hasSentProductImage(from, p));
    const notYetImaged = productsWithImages.filter(p => !hasSentProductImage(from, p));
    parts.push('=== ATURAN GAMBAR (PENTING) ===');
    parts.push(`Produk berikut memiliki gambar yang siap dikirim: ${productsWithImages.join(', ')}.`);
    parts.push('- Begitu kamu SUDAH menjelaskan produk dan menawarkan/menyebutkan varian yang tersedia (bukan sebelum itu), WAJIB tambahkan persis kode ini di akhir kalimatmu: [KIRIM_GAMBAR:Nama Produk]. Contoh jika nama produknya "Massage Gun": "[KIRIM_GAMBAR:Massage Gun]". Ini berlaku OTOMATIS — TIDAK perlu menunggu pelanggan minta foto secara eksplisit.');
    parts.push('- Sistem akan otomatis mengirim gambar ke WhatsApp pelanggan jika kode itu disertakan.');
    parts.push('- Gambar HANYA dikirim SEKALI per produk dalam 1 percakapan. JANGAN sertakan kode [KIRIM_GAMBAR:...] untuk produk yang gambarnya SUDAH pernah dikirim sebelumnya di percakapan ini (lihat daftar di bawah) — kecuali pelanggan secara eksplisit minta dikirim ulang.');
    if (alreadyImaged.length) parts.push(`- Produk yang GAMBARNYA SUDAH dikirim di percakapan ini (jangan kirim ulang kecuali diminta eksplisit): ${alreadyImaged.join(', ')}.`);
    if (notYetImaged.length) parts.push(`- Produk yang gambarnya BELUM dikirim di percakapan ini: ${notYetImaged.join(', ')}.`);
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
  parts.push('- Jika pelanggan menanyakan produk yang JELAS di luar bisnis toko ini (bukan produk yang dijual sama sekali), jawab jujur dan ramah bahwa produk tersebut tidak tersedia di toko, lalu tawarkan produk lain yang relevan dari daftar jika memungkinkan — ini beda dengan kasus di ATURAN ESKALASI (yang soal DETAIL suatu produk/topik yang belum diketahui)');
  parts.push('');
  parts.push('=== ATURAN GAMBAR DARI CUSTOMER ===');
  parts.push('- Jika customer mengirim gambar (foto), kamu akan menerimanya sebagai bagian dari pesan. Analisis gambar tersebut dengan konteks percakapan');
  parts.push('- Gambar produk yang dicari: identifikasi produk, cocokkan dengan INFORMASI PRODUK & BISNIS di atas, dan jawab sesuai harga/detail produk yang cocok');
  parts.push('- Gambar alamat (tulisan, plang, foto rumah): ekstrak info alamat yang terlihat, gunakan sebagai konfirmasi, lalu minta customer lengkapi detail yang kurang (RT/RW, kelurahan, kecamatan, kota)');
  parts.push('- Gambar tidak jelas relevansinya: tanya sopan apa yang ingin disampaikan customer melalui gambar tersebut');
  parts.push('- JANGAN abaikan gambar — selalu respons bahwa gambar sudah diterima dan jelaskan apa yang kamu lihat');
  parts.push('');
  parts.push('=== ATURAN CEK ONGKIR OTOMATIS ===');
  parts.push('- Ketika customer sudah menyebutkan KECAMATAN dan KOTA/KABUPATEN tujuan pengiriman, sisipkan tag berikut di AKHIR balasanmu: [CEK_ONGKIR:NamaKecamatan,NamaKota]');
  parts.push('  Contoh: [CEK_ONGKIR:Cibinong,Bogor] atau [CEK_ONGKIR:Lowokwaru,Malang]');
  parts.push('- Sistem akan otomatis mengecek tarif kurir dan menambahkan hasilnya ke balasanmu — kamu TIDAK perlu sebut angka ongkir sendiri.');
  parts.push('- JANGAN gunakan tag ini kalau kecamatan/kota tujuan BELUM jelas disebut. Tanya dulu.');
  parts.push('- JANGAN sebut angka ongkir manual tanpa tag ini — biarkan sistem yang cek agar akurat.');

  // F1-B: Instruksi pembayaran (inject info rekening dari ENV)
  if (PAYMENT.bankName || PAYMENT.accountNumber) {
    parts.push('');
    parts.push('=== ATURAN PEMBAYARAN ===');
    parts.push('Setelah customer setuju order dan alamat sudah lengkap, WAJIB tawarkan 2 metode pembayaran:');
    parts.push('');
    parts.push('**TRANSFER (ada diskon ' + PAYMENT.discountPercent + '%):**');
    parts.push('- Sebut dulu keuntungan transfer: ada diskon ' + PAYMENT.discountPercent + '% dari harga produk');
    parts.push('- Hitung dan sebutkan harga setelah diskon secara eksplisit (misal: "Rp89.000 jadi Rp80.100")');
    parts.push('- Ongkir tetap dihitung normal, TIDAK ikut didiskon');
    if (PAYMENT.bankName) parts.push('- Info rekening: ' + PAYMENT.bankName + ' · ' + PAYMENT.accountNumber + ' a.n. ' + PAYMENT.accountName);
    if (PAYMENT.ewallet) parts.push('- E-wallet: ' + PAYMENT.ewallet);
    parts.push('- Minta customer kirim bukti transfer setelah transfer');
    parts.push('');
    parts.push('**COD (bayar di tempat):**');
    parts.push('- Sebelum konfirmasi COD, WAJIB edukasi customer dengan kalimat seperti:');
    parts.push('  "Untuk COD, paket kami dikemas rapat/disegel — kurir tidak bisa melayani buka paket sebelum pembayaran. Apakah Kakak setuju dengan ketentuan ini?"');
    parts.push('- Jika customer tidak setuju → tawarkan Transfer + sebut diskon ' + PAYMENT.discountPercent + '% sebagai alternatif');
    parts.push('- Jika customer setuju → lanjut konfirmasi order');
    parts.push('');
    parts.push('**PENTING:**');
    parts.push('- Selalu sebutkan diskon transfer LEBIH DULU sebagai "nudge" sebelum menyebut COD');
    parts.push('- JANGAN sebutkan info rekening/transfer sampai customer memilih metode Transfer');
    parts.push('- Setelah customer pilih metode, simpan pilihannya dengan menambahkan field "pembayaran" ke [ORDER_DATA]');
  }

  // F2-A: Instruksi bukti transfer
  if (PAYMENT.bankName) {
    parts.push('');
    parts.push('=== ATURAN BUKTI TRANSFER ===');
    parts.push('- Jika customer mengirim gambar/foto dan konteks percakapan menunjukkan mereka memilih metode Transfer, gambar tersebut kemungkinan besar adalah bukti transfer pembayaran.');
    parts.push('- Dalam kasus ini, sisipkan tag [BUKTI_TRANSFER] di awal balasanmu (sebelum teks apapun).');
    parts.push('- Contoh balasan: "[BUKTI_TRANSFER] Bukti transfernya sudah kami terima Kak, sedang kami verifikasi ya. Kami akan konfirmasi setelah pembayaran terkonfirmasi 🙏"');
    parts.push('- Jika gambar dari customer jelas BUKAN bukti transfer (misal foto produk, foto alamat), JANGAN gunakan tag ini — proses seperti biasa.');
    parts.push('- JANGAN minta customer kirim ulang bukti jika tag ini sudah disisipkan.');
  }

  // F3-B: Instruksi ghost follow-up (via AI prompt, sesuai keputusan user)
  parts.push('');
  parts.push('=== ATURAN FOLLOW-UP CUSTOMER TIDAK BALAS ===');
  parts.push('- Jika kamu melihat dari history percakapan bahwa pesan terakhirmu sudah LAMA tidak dibalas customer (terlihat dari gap waktu atau konteks), dan percakapan sedang di tengah proses penjualan (tanya produk, negosiasi, atau pengisian data), kamu boleh kirim 1x follow-up ramah.');
  parts.push('- Contoh follow-up: "Halo Kak, masih ada yang bisa kami bantu? 😊 Kalau ada pertanyaan soal produknya, kami siap membantu ya Kak."');
  parts.push('- Jika setelah follow-up customer MASIH tidak balas, JANGAN kirim lagi. Cukup 1x follow-up.');
  parts.push('- JANGAN follow-up jika customer baru saja bertanya atau percakapan sedang berjalan normal.');

  // F4-A1: Instruksi delay summary order (15 menit setelah konfirmasi bayar)
  parts.push('');
  parts.push('=== ATURAN SUMMARY ORDER (PENTING) ===');
  parts.push('- Setelah customer KONFIRMASI SETUJU untuk membayar (baik COD maupun Transfer), sisipkan tag [DELAY_SUMMARY] DI AKHIR balasanmu (setelah semua teks).');
  parts.push('- Tag ini akan memicu pengiriman summary order otomatis 15 menit kemudian — jadi JANGAN kirim summary sendiri sekarang, biarkan sistem yang kirim.');
  parts.push('- Gunakan [DELAY_SUMMARY] HANYA SEKALI, tepat saat customer menyatakan setuju/konfirmasi bayar.');
  parts.push('- JANGAN gunakan [DELAY_SUMMARY] jika customer masih ragu, masih tanya-tanya, atau belum konfirmasi.');

  // F5-A1: Instruksi klaim garansi
  parts.push('');
  parts.push('=== ATURAN KLAIM GARANSI ===');
  parts.push('- Jika customer mengeluh tentang produk (kata kunci: rusak, tidak sesuai, salah produk, cacat, kecewa, tidak berfungsi, garansi, komplain, retur, kembalikan, dll):');
  parts.push('  1. Sampaikan permintaan maaf yang tulus dan empati: "Mohon maaf banget ya Kak! Kami sangat menyesal mendengar ini 🙏"');
  parts.push('  2. Minta foto produk bermasalah: "Boleh kirimkan foto produknya Kak, supaya kami bisa bantu proseskan?"');
  parts.push('  3. Sisipkan tag [KLAIM_GARANSI:deskripsi singkat masalah] di akhir balasanmu. Ganti "deskripsi singkat masalah" dengan ringkasan masalah customer, contoh: [KLAIM_GARANSI:produk rusak saat diterima]');
  parts.push('- JANGAN langsung janji refund/ganti produk sebelum admin memverifikasi foto.');
  parts.push('- Setelah customer kirim foto, balas: "Foto sudah kami terima Kak, laporan sedang kami teruskan ke tim. Kami akan segera follow up ya 🙏"');
  parts.push('- JANGAN gunakan [BUKTI_TRANSFER] untuk foto klaim — keduanya berbeda konteks.');

  return parts.join('\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Panggil Gemini REST API langsung dengan key tertentu
async function callGeminiDirect(key, keySlot, message, name, history, signal, from, imagePath, audioPath) {
  const startTime = Date.now();
  const model = settings.modelName || 'gemini-3.1-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const contents = [];
  if (history?.length) {
    for (const h of history) {
      // Summary entries: append ke system prompt, bukan ke contents
      if (h._summary) continue;
      contents.push({ role: 'user', parts: [{ text: h.body }] });
      // B4: Jangan inject model reply dari entry yang di-cancel (cancelledEntry)
      // supaya string internal tidak bocor ke konteks Gemini
      if (h.aiReply && !h.cancelledEntry) contents.push({ role: 'model', parts: [{ text: h.aiReply }] });
    }
  }

  // P2-B: Kalau ada gambar dari customer, sisipkan sebagai multimodal (inline_data)
  const userParts = [];
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const imgBuffer = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).toLowerCase().replace('.', '');
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      const mime = mimeMap[ext] || 'image/jpeg';
      userParts.push({ inline_data: { mime_type: mime, data: imgBuffer.toString('base64') } });
      console.log(`🖼️ [P2-B] Gambar disertakan ke Gemini: ${path.basename(imagePath)} (${Math.round(imgBuffer.length/1024)}KB)`);
    } catch (e) {
      console.warn('[P2-B] Gagal baca gambar untuk Gemini:', e.message);
    }
  }
  // P2-B2: Sertakan audio pesan suara ke Gemini (multimodal audio input)
  if (audioPath && fs.existsSync(audioPath)) {
    try {
      const audioBuffer = fs.readFileSync(audioPath);
      const ext = path.extname(audioPath).toLowerCase().replace('.', '');
      const audioMime = ext === 'mp4' ? 'audio/mp4' : 'audio/ogg';
      userParts.push({ inline_data: { mime_type: audioMime, data: audioBuffer.toString('base64') } });
      console.log(`🎙️ [P2-B2] Audio disertakan ke Gemini: ${path.basename(audioPath)} (${Math.round(audioBuffer.length/1024)}KB)`);
    } catch (e) {
      console.warn('[P2-B2] Gagal baca audio untuk Gemini:', e.message);
    }
  }
  userParts.push({ text: message || '[customer mengirim pesan suara]' });
  contents.push({ role: 'user', parts: userParts });
  // ─────────────────────────────────────────────────────────────────────────

  const relevantKB = getRelevantKnowledge(message, history);
  const isFirstMessage = !history?.length;

  let systemPromptText = buildSystemPrompt(name, relevantKB, isFirstMessage, from);

  // Tambah summary dari percakapan lama ke system prompt
  const summaryEntry = history?.find(h => h._summary);
  if (summaryEntry) {
    systemPromptText += '\n\n=== RINGKASAN PERCAKAPAN SEBELUMNYA ===\n' + summaryEntry.summary;
  }

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPromptText }] },
    generationConfig: { temperature: settings.temperature ?? 0.7 },
  };

  // Testing log: log semua data yang dikirim ke Gemini
  logGeminiRequest('request', {
    user: name,
    phone: from,
    systemPrompt: systemPromptText,
    history: history || [],
    message,
    tokenEstimate: {
      system: estimateTokens(systemPromptText),
      history: estimateTokens(JSON.stringify(history || [])),
      current: estimateTokens(message),
    },
  });

  // RAW PAYLOAD LOG — JSON lengkap yang dikirim ke Gemini API
  const rawLog = {
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    systemInstruction: { parts: [{ text: systemPromptText }] },
    contents: contents.map(c => ({
      role: c.role,
      parts: c.parts.map(p => p.text ? { text: p.text } : { inline_data: { mime_type: p.inline_data?.mime_type, data: '[base64...]' } })
    })),
    generationConfig: body.generationConfig,
  };
  console.log(`\n🔍 RAW PAYLOAD KE GEMINI:`);
  console.log(JSON.stringify(rawLog, null, 2));
  console.log(`🔍 END RAW PAYLOAD\n`);

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

    // 503 "high demand" → transient overload, bisa dicoba lagi dengan key lain
    if (res.status === 503) {
      return { ok: false, status503: true, error: msg };
    }

    return { ok: false, error: msg };
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text.trim()) return { ok: false, error: 'Respons kosong dari Gemini' };

  const usage = data.usageMetadata;
  const duration = Date.now() - startTime;
  if (usage) {
    console.log(`📊 [Token] Key ${keySlot + 1} | Prompt: ${usage.promptTokenCount} | Output: ${usage.candidatesTokenCount}`);
  }

  const cleanText = text.trim().replace(/^["'`]+|["'`]+$/g, '').trim();

  // Testing log: log response dari Gemini
  logGeminiRequest('response', {
    ok: true,
    text: cleanText,
    duration,
    outputTokens: usage?.candidatesTokenCount || 0,
    phone: from,  // dibutuhkan untuk capture test mode
  });

  return { ok: true, text: cleanText };
}

function extractOrder(replyText, fromJid) {
  let cleanReply = replyText;
  const match = replyText.match(/\[ORDER_DATA\]([\s\S]*?)\[\/ORDER_DATA\]/);
  if (match) {
    try {
      const data = JSON.parse(match[1].trim());
      // Kalau customer konfirmasi pakai nomor WA yang sama (Gemini menulis
      // placeholder ini persis sesuai instruksi ATURAN DATA PEMESANAN),
      // isi otomatis dari nomor JID pengirim — customer gak perlu ngetik ulang.
      let hpValue = data.hp || '';
      if (/SAMA_DENGAN_WA/i.test(hpValue)) {
        hpValue = (fromJid || '').split('@')[0];
      }
      const order = {
        id: Date.now().toString() + Math.floor(Math.random()*1000),
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

      // ── Guard P1-C: Tolak ORDER_DATA kalau field wajib tidak lengkap ──
      // Ini safety net kalau AI "nekat" rekap tanpa nama/alamat. Balasan AI
      // tetap terkirim ke customer, tapi order tidak masuk ke sistem.
      const missingFields = [];
      if (!order.nama?.trim() || order.nama.trim().length < 3) missingFields.push('nama');
      if (!order.produk?.trim()) missingFields.push('produk');
      if (!order.alamat?.trim() || order.alamat.trim().length < 10) missingFields.push('alamat');
      if (missingFields.length > 0) {
        console.warn(`⚠️ ORDER_DATA ditolak — field belum lengkap: ${missingFields.join(', ')} | dari: ${fromJid}`);
        cleanReply = replyText.replace(/\[ORDER_DATA\][\s\S]*?\[\/ORDER_DATA\]/g, '').trim();
        return cleanReply;
      }
      // ─────────────────────────────────────────────────────────────────
      // Pengecekan Duplikasi: 5 Menit dari nomor WhatsApp yang sama.
      // (Waktu diperpendek dari 1 jam menjadi 5 menit. Ini agar jika pelanggan 
      // yang sama memesan barang BERBEDA di jam berikutnya, orderannya tetap masuk.
      // 5 menit sudah sangat cukup untuk menangkal duplikat dari chat beruntun/AI error).
      const isDuplicate = orders.some(o => 
        o.jid === fromJid && 
        o.produk === order.produk &&
        (Date.now() - new Date(o.timestamp).getTime() < config.ORDER_DEDUP_WINDOW_MS)
      );
      
      if (!isDuplicate) {
        orders.unshift(order);
        save(ORDER_FILE, orders); if (typeof order !== 'undefined') persistOrderToDB(order);
        io.emit('new_order', order);
        console.log('🛒 Order baru tertangkap:', order.nama);
        // Fix-2: Update orderState → step 4 + orderConfirmed=true setelah ORDER_DATA diterima
        const _st = orderStates.get(fromJid);
        if (_st) {
          _st.step = 4;
          _st.orderConfirmed = true;
          _st.lastUpdate = Date.now();
          orderStates.set(fromJid, _st);
          persistOrderState();
          console.log(`📊 [Step] ${fromJid.slice(-4)}: →4 (ORDER_DATA diterima, order confirmed)`);
        }
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

// ── F4-B1: Build summary order (dikirim 15 menit setelah konfirmasi bayar) ────
// Mengambil order terakhir customer, format ke teks rekap dengan framing garansi.
function buildOrderSummary(from) {
  const order = orders.find(o => o.jid === from || o.wa_id === from);
  if (!order) return null;

  const pay = order.payment_method || 'belum ditentukan';
  const payInfo = pay === 'Transfer'
    ? `💳 Transfer ke ${PAYMENT.bankName} ${PAYMENT.accountNumber} a.n. ${PAYMENT.accountName}`
    : `📦 COD (bayar saat paket tiba)`;

  const lines = [
    `✅ *Rekap Pesananmu*`,
    ``,
    `👤 *Nama:* ${order.nama}`,
    `📦 *Produk:* ${order.produk}`,
    `📍 *Alamat:* ${order.alamat}`,
    `📱 *No. HP:* ${order.hp === 'SAMA_DENGAN_WA' ? '(sama dengan WhatsApp)' : order.hp}`,
    `💰 *Metode Bayar:* ${payInfo}`,
    ``,
    `🛡️ *Garansi Produk:* Jika ada kerusakan atau tidak sesuai, hubungi kami dalam 24 jam setelah paket diterima ya Kak — kami siap bantu 🙏`,
    ``,
    `📦 Pesanan akan segera kami proses & kirim. Kurir akan menghubungi kakak sebelum datang.`,
    ``,
    `Terima kasih sudah order di kami Kak! Semoga produknya sesuai harapan ya 😊`,
  ];

  return lines.join('\n');
}

// ── Escalation ke Admin ────────────────────────────────────────────
// Dipakai saat Gemini menemukan pertanyaan yang jawabannya TIDAK eksplisit
// ada di Knowledge Base — daripada mengarang, Gemini menyisipkan tag
// [ESCALATE:Tag][/ESCALATE] yang ditangkap di sini, lalu dikirim ke WA
// superadmin untuk dijawab manual.

// Parse semua tag [ESCALATE:tag]pertanyaan[/ESCALATE] dari balasan Gemini,
// buat entri pending baru untuk masing-masing, dan bersihkan tag itu dari
// teks yang akan dikirim ke customer.
function extractEscalations(replyText, fromJid, senderName) {
  const regex = /\[ESCALATE:(.*?)\]([\s\S]*?)\[\/ESCALATE\]/gi;
  const found = [];
  let cleanReply = replyText.replace(regex, (match, tag, question) => {
    const item = {
      id: escalationCounter++,
      from: fromJid,
      senderName,
      productTag: (tag || 'UMUM').trim(),
      question: question.trim(),
      timestamp: new Date().toISOString(),
    };
    pendingEscalations.push(item);
    found.push(item);
    return '';
  });
  cleanReply = cleanReply.trim();
  if (found.length) {
    saveEscalations();
    io.emit('escalations_updated', pendingEscalations);
    notifyAdminEscalations().catch(e => console.error('Gagal kirim notifikasi eskalasi ke admin:', e.message));
  }
  return { cleanReply, escalations: found };
}

// P2-D: Ganti notifikasi WA admin → Telegram
// Dipanggil setiap ada eskalasi baru dari extractEscalations()
async function notifyAdminEscalations() {
  if (!pendingEscalations.length) return;

  // Coba via Telegram dulu (P2-D)
  if (tg.isConfigured()) {
    const questions = pendingEscalations.map(e => ({
      id: e.id,
      productTag: e.productTag,
      question: e.question,
      senderName: e.senderName,
    }));
    await tg.notifyAdminEscalations(questions);
    return;
  }

  // Fallback: kirim via WhatsApp ke adminNumber (flow lama)
  if (!settings.adminNumber) return;
  const lines = pendingEscalations.map(e => `${e.id}. [${e.productTag}] ${e.question}`);
  const text = `🔔 Ada ${pendingEscalations.length} pertanyaan yang perlu dijawab manual:\n\n${lines.join('\n')}\n\nBalas semua di 1 pesan aja ya Kak, urut sesuai nomor.`;
  await sendWhatsAppText(normalizeIdNumber(settings.adminNumber), text);
}

// Sisipkan Q&A ke Knowledge Base secara PERMANEN. Kalau productTag cocok
// persis dengan header salah satu blok "=== PRODUK: ... ===", FAQ ditaruh
// di blok itu. Kalau tidak match (atau tag "UMUM"), taruh ke blok
// "=== INFO UMUM TOKO ===" (dibuat otomatis kalau belum ada).
function appendFaqToKB(productTag, question, answer) {
  const faqLine = `Q: ${question}\nA: ${answer}\n`;
  const kb = settings.knowledgeBase || '';
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
      settings.knowledgeBase = newBlocks.join('---');
      save(SET_FILE, settings); persistSettingsToDB(settings);
      io.emit('settings_updated', settings);
      return;
    }
  }

  // Fallback: tidak match produk manapun, atau memang tag UMUM -> blok info umum toko
  const umumHeaderRegex = /===\s*INFO UMUM TOKO\s*===/i;
  if (umumHeaderRegex.test(kb)) {
    const blocks = kb.split(/^---$/m);
    const newBlocks = blocks.map(block => umumHeaderRegex.test(block) ? block.replace(/\s*$/, '') + '\n' + faqLine : block);
    settings.knowledgeBase = newBlocks.join('---');
  } else {
    const sep = kb.trim() ? '\n---\n' : '';
    settings.knowledgeBase = kb.trim() + sep + `=== INFO UMUM TOKO ===\n${faqLine}`;
  }
  save(SET_FILE, settings); persistSettingsToDB(settings);
  io.emit('settings_updated', settings);
}

// Panggilan Gemini sederhana (tanpa histori/KB produk) untuk tugas internal:
// memetakan balasan borongan admin ke ID pertanyaan pending yang sesuai.
// Pakai getAvailableKey() supaya ikut rotasi & state yang sama dengan aiReply().
async function callGeminiRaw(systemPrompt, userText) {
  const picked = getAvailableKey();
  if (!picked) return null;
  const model = settings.modelName || 'gemini-3.1-flash-lite';
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(picked.key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.1 },
      }),
    });
    if (res.status === 429) {
      let errData = null;
      try { errData = await res.json(); } catch(e) {}
      const details = errData?.error?.details || [];
      let quotaId = null, retryDelaySec = null;
      for (const d of details) {
        if (!quotaId && Array.isArray(d.violations)) {
          for (const v of d.violations) { if (v?.quotaId) { quotaId = v.quotaId; break; } }
        }
        if (retryDelaySec === null && d?.retryDelay) {
          const rd = d.retryDelay;
          const m = typeof rd === 'string' ? rd.match(/^(\d+(?:\.\d+)?)s?$/) : null;
          retryDelaySec = m ? parseFloat(m[1]) : (typeof rd === 'number' ? rd : null);
        }
      }
      markKeyLimited(picked.pos, quotaId, retryDelaySec);
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    return text.trim() || null;
  } catch(e) { return null; }
}

// Dipanggil saat superadmin membalas WA (bukan command on/off) DAN ada
// pertanyaan pending. Memetakan balasan borongan admin -> jawaban per ID
// pakai Gemini, simpan tiap jawaban ke KB permanen, lalu kirim jawaban
// final ke masing-masing customer asal (silent-hold selesai di sini).
async function handleAdminEscalationAnswer(adminText) {
  if (!pendingEscalations.length) return;

  const pendingList = pendingEscalations.map(e => `${e.id}. [${e.productTag}] ${e.question}`).join('\n');
  const sysPrompt = [
    'Kamu bertugas memetakan balasan admin toko ke daftar pertanyaan yang sedang pending.',
    'Daftar pertanyaan pending (format: ID. [Produk] Pertanyaan):',
    pendingList,
    '',
    'Petakan tiap bagian balasan admin ke ID pertanyaan yang paling sesuai (biasanya berdasar urutan nomor yang disebut admin; kalau admin tidak menyebut nomor sama sekali, cocokkan berdasarkan isi jawabannya dengan pertanyaan yang relevan).',
    'Keluarkan HANYA JSON array valid, TANPA markdown/backtick, format PERSIS seperti ini: [{"id": <angka>, "answer": "<jawaban admin untuk pertanyaan itu, tulis ulang jadi kalimat lengkap>"}]',
    'Kalau ada pertanyaan yang TIDAK terjawab sama sekali di balasan admin ini, JANGAN masukkan ID itu ke output (biarkan tetap pending).',
  ].join('\n');

  const rawResult = await callGeminiRaw(sysPrompt, adminText);
  if (!rawResult) { console.error('⚠️ Gagal memetakan balasan admin (Gemini tidak merespons)'); return; }

  let parsed;
  try {
    parsed = JSON.parse(rawResult.replace(/```json|```/g, '').trim());
  } catch(e) {
    console.error('⚠️ Gagal parse hasil pemetaan balasan admin:', e.message, '| raw:', rawResult);
    return;
  }
  if (!Array.isArray(parsed)) return;

  for (const row of parsed) {
    const item = pendingEscalations.find(e => e.id === row.id);
    if (!item || !row.answer) continue;

    appendFaqToKB(item.productTag, item.question, row.answer);

    const isGreetingLike = /^(halo|hai|iya|baik|oke|ok)\b/i.test(row.answer.trim());
    const customerMsg = isGreetingLike ? row.answer.trim() : `Halo Kak, ${row.answer.trim()}`;
    try {
      await sendWhatsAppText(item.from, customerMsg);
      console.log(`✅ Jawaban eskalasi #${item.id} terkirim ke ${item.senderName || item.from}`);
      // Fix-3: Step 5 → kembali ke step sebelumnya (4 jika sudah confirmed, 3 jika belum)
      const _escSt = orderStates.get(item.from);
      if (_escSt && _escSt.step === 5) {
        const prevStep = _escSt.orderConfirmed ? 4 : 3;
        _escSt.step = prevStep;
        _escSt.lastUpdate = Date.now();
        orderStates.set(item.from, _escSt);
        persistOrderState();
        console.log(`📊 [Step] ${item.from.slice(-4)}: 5→${prevStep} (admin jawab eskalasi #${item.id})`);
      }
    } catch(e) {
      console.error(`❌ Gagal kirim jawaban eskalasi #${item.id} ke customer:`, e.message);
    }

    pendingEscalations = pendingEscalations.filter(e => e.id !== item.id);
  }
  saveEscalations();
  io.emit('escalations_updated', pendingEscalations);
}

// ── Rotasi key REAKTIF: anggap semua key 'ON' sampai terbukti kena 429 ──
async function aiReply(message, name, history, signal, from, imagePath, audioPath) {
  if (getValidKeys().length === 0) {
    console.error('❌ Tidak ada API key yang valid di .env');
    return null;
  }

  const MAX_503_RETRIES = 3;       // maksimal fast-retry untuk 503 transient
  const RETRY_503_DELAY_MS = 2000; // jeda antar retry 503 (2 detik)
  let retry503Count = 0;
  const tried503Keys = new Set();  // track key yang sudah gagal503 di sesi ini

  while (true) {
    if (signal?.aborted) return null;

    const picked = getAvailableKey();
    if (!picked) {
      console.warn('⏸️ Semua API key sedang kena limit → pesan diqueue untuk retry');
      emitKeyStatuses();
      return null;
    }

    activeKeyIndex = picked.slot;
    emitKeyStatuses();
    console.log(`🔑 Mencoba Key ${picked.slot + 1}...`);

    const result = await callGeminiDirect(picked.key, picked.slot, message, name, history, signal, from, imagePath, audioPath);

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

    // 503 "high demand" → transient overload, coba key lain dengan jeda singkat
    if (result.status503) {
      retry503Count++;
      tried503Keys.add(picked.pos);

      // Jika sudah coba semua key atau max retries tercapai → fallback ke retry queue
      const totalKeys = getValidKeys().length;
      if (retry503Count >= MAX_503_RETRIES || tried503Keys.size >= totalKeys) {
        console.warn(`⚠️ ${retry503Count}x 503 "high demand" setelah coba ${tried503Keys.size} key → pesan diqueue untuk retry`);
        emitKeyStatuses();
        return null; // kembali ke retry queue (bukan throw!)
      }

      // Skip key ini sementara, geser pointer ke key berikutnya
      lastUsedKeyIndex = (picked.pos + 1) % Math.max(totalKeys, 1);
      console.warn(`⚠️ Key ${picked.slot + 1} 503 "high demand" → skip, coba key lain (${retry503Count}/${MAX_503_RETRIES})`);
      emitKeyStatuses();

      // Jeda singkat sebelum retry (transient error, biasanya cepat recover)
      await new Promise(r => setTimeout(r, RETRY_503_DELAY_MS));
      continue;
    }

    // Error selain 429/503 → coba key lain dulu (transient error), jangan throw
    retry503Count++;
    tried503Keys.add(picked.pos);
    const totalKeys = getValidKeys().length;

    if (retry503Count >= MAX_503_RETRIES || tried503Keys.size >= totalKeys) {
      console.error(`❌ ${retry503Count}x error setelah coba ${tried503Keys.size} key: ${result.error?.slice(0, 150)} → pesan diqueue untuk retry`);
      emitKeyStatuses();
      return null; // ke retry queue daripada throw
    }

    lastUsedKeyIndex = (picked.pos + 1) % Math.max(totalKeys, 1);
    console.warn(`⚠️ Key ${picked.slot + 1} error (${result.error?.slice(0, 80)}) → skip, coba key lain (${retry503Count}/${MAX_503_RETRIES})`);
    emitKeyStatuses();
    await new Promise(r => setTimeout(r, RETRY_503_DELAY_MS));
    continue;
  }
}
async function retryFailedMessages() {
  if (!settings.autoReply) return;

  // Tidak ada lagi "cycle rest" global — tiap pesan langsung dicoba lagi;
  // kalau semua key masih kena limit, aiReply() akan return null lagi (lihat di bawah)
  // dan pesan tetap diqueue untuk retry berikutnya.

  const MAX_RETRY_COUNT = config.MAX_RETRY_COUNT;
  const nowTime = Date.now();
  const failedEntries = messages.filter(m => !m.replied && (nowTime - new Date(m.timestamp).getTime() < config.RETRY_WINDOW_MS) && (m.retryCount || 0) < MAX_RETRY_COUNT);
  if (!failedEntries.length) return;

  console.log(`♻️ Mencoba membalas ulang ${failedEntries.length} pesan yang tertunda...`);
  
  for (const entry of failedEntries) {
    const prevTask = userLocks.get(entry.from) || Promise.resolve();
    const nextTask = prevTask.then(async () => {
      // Pastikan belum dibalas manual saat antre
      if (entry.replied) return;
      if (!isOpHour() || !isWhitelisted(entry.from)) return;

      // History — dynamic length + summary
      const history = buildHistory(entry.from, entry.id);
      // Tambah hitungan retry
      entry.retryCount = (entry.retryCount || 0) + 1;

      let reply = await aiReply(entry.body, entry.senderName, history, null, entry.from);
      
      if (reply) {
         reply = extractOrder(reply, entry.from);

         const escResult = extractEscalations(reply, entry.from, entry.senderName);
         reply = escResult.cleanReply;
         if (!reply.trim()) {
           entry.replied = true;
           entry.aiReply = null;
           entry.awaitingAdmin = true;
           save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
           console.log(`⏳ Balasan untuk ${entry.senderName} ditahan (retry) — menunggu admin menjawab ${escResult.escalations.length} pertanyaan.`);
           return;
         }

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
           if (hasSentProductImage(entry.from, productToImage)) {
             console.log(`⏭️  Lewati kirim gambar "${productToImage}" (retry) ke ${entry.senderName} — sudah pernah dikirim.`);
             continue;
           }
           if (settings.productImages && settings.productImages[productToImage]) {
             let anySent = false;
             for (const filename of settings.productImages[productToImage]) {
               if (filename) {
                  const imgPath = path.join(IMAGES_DIR, filename);
                  if (fs.existsSync(imgPath)) {
                    try {
                      const ext = filename.split('.').pop().toLowerCase();
                      const mimetype = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
                      await sendWhatsAppImageByPath(entry.from, imgPath, mimetype);
                      anySent = true;
                    } catch(e) { console.error('Gagal kirim gambar retry:', e.message); }
                  }
               }
             }
             if (anySent) markProductImageSent(entry.from, productToImage);
           }
         }

         entry.replied = true;
         entry.aiReply = cleanReply;
         save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
         io.emit('message_updated', entry);
         console.log(`🤖 AI (Retry) -> ${entry.from}: ${reply}`);
      } else if (entry.retryCount >= MAX_RETRY_COUNT) {
        // Sudah MAX_RETRY_COUNT kali gagal, hentikan retry agar tidak bakar quota
        // BUG FIX (B3): jangan tulis string status ke aiReply — hanya null + flag
        // supaya tidak bocor ke history percakapan Gemini.
        entry.replied = true;
        entry.aiReply = null;
        entry.cancelledEntry = true;
        save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
        console.warn(`⚠️ Pesan dari ${entry.from} dihentikan setelah ${MAX_RETRY_COUNT}x gagal`);
      } else {
        // Belum sampai limit, simpan retryCount yang sudah diupdate
        save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
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
async function processCustomerMessage(from, senderName, combinedBody, lastWamid, imagePath, customerMediaId, customerMediaMime, customerAudioId, customerAudioMime) {
  // PREEMPTION: Batalkan proses AI sebelumnya dari user ini jika masih berjalan
  if (activeProcessing.has(from)) {
    const currentTask = activeProcessing.get(from);
    if (currentTask.controller) currentTask.controller.abort();
    if (currentTask.timeoutId) clearTimeout(currentTask.timeoutId);
    if (currentTask.resolveDelay) currentTask.resolveDelay(); // cegah promise menggantung
    activeProcessing.delete(from);
    console.log(`⚡ Menghentikan proses AI sebelumnya untuk ${senderName} karena ada pesan baru masuk.`);
  }

  // F3: Customer kirim pesan → batalkan timer follow-up transfer (sudah aktif kembali)
  scheduler.cancel(from, 'transfer');

  const entry = {
    id: Date.now(), from, senderName, body: combinedBody, wamid: lastWamid,
    waba_message_id: lastWamid, // P2-A: dipakai untuk update media_url setelah download gambar
    message_type: imagePath ? 'image' : 'text', // P2-B: tandai jika ada gambar
    timestamp: new Date().toISOString(),
    replied: false, aiReply: null,
  };

  // 1. Munculkan langsung di dashboard dan history
  // IMP-4A: Tambah orderStep ke entry agar dashboard bisa tampilkan step badge
  entry.orderStep = orderStates.get(from)?.step || null;
  messages.unshift(entry);
  if (messages.length > config.MESSAGE_LIMIT) messages = messages.slice(0, config.MESSAGE_LIMIT);
  save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
  // IMP-4B: Log ringkas satu baris untuk monitoring production
  const _st = orderStates.get(from);
  console.log(`📨 [${from.slice(-4)}] step=${_st?.step ?? '-'} | "${message.slice(0, 45)}${message.length > 45 ? '…' : ''}" → AI`);
  io.emit('new_message', entry);

  // P2-A (deferred): Update in-memory message dengan media_url
  // Dipanggil SETELAH message masuk array agar messages.find() berhasil
  if (customerMediaId && customerMediaMime) {
    downloadAndSaveCustomerMedia(customerMediaId, lastWamid, customerMediaMime)
      .catch(e => console.warn('[P2-A] deferred download error:', e.message));
  }
  // P2-A2 (deferred): Update in-memory message dengan audio media_url
  if (customerAudioId && customerAudioMime) {
    downloadAndSaveCustomerAudio(customerAudioId, lastWamid, customerAudioMime)
      .catch(e => console.warn('[P2-A2] deferred download error:', e.message));
  }

  // 2. Masukkan proses AI ke dalam antrean (queue) khusus user ini
  const prevTask = userLocks.get(from) || Promise.resolve();
  
  const nextTask = prevTask.then(async () => {
    if (settings.autoReply && isOpHour() && isWhitelisted(from)) {
      const controller = new AbortController();
      const taskState = { controller, timeoutId: null };
      activeProcessing.set(from, taskState);

      try { await markAsReadWithTyping(lastWamid, true); } catch(e) {}

      // Fetch history — dynamic length + summary untuk percakapan panjang
      const history = buildHistory(from, entry.id);
      // P2-B2: Cek apakah audio pesan suara sudah di-download
      let audioPathForAI = null;
      if (customerAudioId) {
        const audioExt = (customerAudioMime || '').includes('mp4') ? 'mp4' : 'ogg';
        const audioSafeName = (lastWamid || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const audioFilename = `customer_${audioSafeName}.${audioExt}`;
        const audioFullPath = path.join(AUDIO_DIR, audioFilename);
        if (fs.existsSync(audioFullPath)) {
          audioPathForAI = audioFullPath;
          console.log(`🎙️ [P2-B2] Audio ditemukan di disk: ${audioFilename}`);
        } else {
          console.log(`🎙️ [P2-B2] Audio belum ada di disk: ${audioFilename}, download dulu...`);
          try {
            const audioUrl = await downloadAndSaveCustomerAudio(customerAudioId, lastWamid, customerAudioMime);
            if (audioUrl) audioPathForAI = path.join(AUDIO_DIR, path.basename(audioUrl));
          } catch(e) { console.warn('[P2-B2] Gagal download audio untuk Gemini:', e.message); }
        }
      }
      // Update order state — deteksi produk + data order dari pesan customer
      const orderState = updateOrderState(from, combinedBody);
      if (orderState) {
        console.log(`📋 [OrderState] ${senderName}: step=${orderState.step}, product=${orderState.product}, color=${orderState.color || '-'}, nama=${orderState.namaLengkap || '-'} desa=${orderState.desa || '-'}`);
      }
      let reply = await aiReply(combinedBody, senderName, history, controller.signal, from, imagePath, audioPathForAI);


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
          save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
          return;
        }
        // ────────────────────────────────────────────────────────────────────

        // B2: extractOrder SETELAH hold check — cegah order tersimpan
        // padahal reply tidak jadi terkirim ke customer
        reply = extractOrder(reply, from);

        // Escalation: pisahkan tag [ESCALATE:...] dari balasan. Kalau SETELAH
        // dibersihkan tidak ada sisa teks (seluruh balasan cuma escalate),
        // jangan kirim apa pun ke customer — tahan sampai admin menjawab.
        const escResult = extractEscalations(reply, from, senderName);
        reply = escResult.cleanReply;
        if (!reply.trim()) {
          activeProcessing.delete(from);
          entry.replied = true;
          entry.aiReply = null;
          entry.cancelledEntry = true;
          entry.awaitingAdmin = true;
          save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
          io.emit('message_updated', entry);
          console.log(`⏳ Balasan untuk ${senderName} ditahan — menunggu admin menjawab ${escResult.escalations.length} pertanyaan.`);
          return;
        }

        // Cek tag [KIRIM_GAMBAR:Nama Produk] & bersihkan dulu SEBELUM hitung delay,
        // supaya panjang teks yang dipakai untuk menentukan delay itu akurat
        // (tag gambar bukan bagian dari isi balasan yang dibaca customer).
        let cleanReply = reply;

        // P2-C: Proses tag [CEK_ONGKIR:kecamatan,kabupaten] — cek ongkir otomatis
        const ongkirMatch = cleanReply.match(/\[CEK_ONGKIR:([^\]]+)\]/i);
        if (ongkirMatch) {
          cleanReply = cleanReply.replace(/\[CEK_ONGKIR:[^\]]+\]/gi, '').trim();
          const tagContent = ongkirMatch[1].trim();
          try {
            // Ambil harga produk dari history/entry untuk itemValue (pakai 100000 default)
            const courierPri = settings.courierPriority || DEFAULT_COURIER_PRIORITY;
            const ongkirResult = await ongkirHelper.processCekOngkirTag(tagContent, 100000, courierPri);
            if (ongkirResult?.formatted) {
              cleanReply = cleanReply + '\n\n' + ongkirResult.formatted;
              console.log(`[P2-C] Ongkir berhasil dicek untuk: ${tagContent}`);
            } else {
              console.warn(`[P2-C] Ongkir tidak bisa dicek untuk: ${tagContent}`);
            }
          } catch (ongkirErr) {
            console.warn('[P2-C] Error cek ongkir:', ongkirErr.message);
          }
        }
        // ────────────────────────────────────────────────────────────────

        // F2-A2: Proses tag [BUKTI_TRANSFER] — forward gambar ke Telegram admin
        if (cleanReply.includes('[BUKTI_TRANSFER]')) {
          cleanReply = cleanReply.replace(/\[BUKTI_TRANSFER\]/gi, '').trim();
          // F3-C2: Customer kirim bukti → cancel timer follow-up transfer
          scheduler.cancel(from, 'transfer');
          if (tg.isConfigured() && imagePath) {
            // Cari order terakhir dari customer ini
            const lastOrder = orders.find(o => o.jid === from || o.wa_id === from);
            tg.sendTransferProof({
              imagePath,
              customerPhone: from.replace('@s.whatsapp.net', '').replace('@c.us', ''),
              customerName:  senderName,
              order:         lastOrder,
            }).catch(e => console.error('[F2] Gagal forward bukti transfer:', e.message));
            console.log(`[F2] Bukti transfer dari ${senderName} diteruskan ke Telegram admin`);
          } else if (!imagePath) {
            console.warn('[F2] [BUKTI_TRANSFER] tag ada tapi tidak ada imagePath — skip forward');
          }
        }
        // ────────────────────────────────────────────────────────────────

        // F4-A2 + F4-B2: Proses tag [DELAY_SUMMARY] — kirim summary 15 menit kemudian
        if (cleanReply.includes('[DELAY_SUMMARY]')) {
          cleanReply = cleanReply.replace(/\[DELAY_SUMMARY\]/gi, '').trim();
          const SUMMARY_DELAY_MS = 15 * 60 * 1000; // 15 menit
          scheduler.schedule(from, 'summary', SUMMARY_DELAY_MS, async () => {
            const summary = buildOrderSummary(from);
            if (summary) {
              await sendWhatsAppText(from, summary)
                .catch(e => console.error('[F4] Gagal kirim summary:', e.message));
              console.log(`[F4] 📋 Summary order dikirim ke ${senderName} (15 menit setelah konfirmasi)`);
            } else {
              console.warn(`[F4] Tidak ada order ditemukan untuk ${senderName} — summary dibatalkan`);
            }
          });
          console.log(`[F4] ⏰ Timer summary 15 menit dimulai untuk ${senderName}`);
        }
        // ────────────────────────────────────────────────────────────────

        // F5-A2: Proses tag [KLAIM_GARANSI:desc] — simpan klaim aktif ke Map + DB
        const klaimMatch = cleanReply.match(/\[KLAIM_GARANSI:([^\]]*)\]/i);
        if (klaimMatch) {
          const claimDesc = klaimMatch[1].trim() || 'tidak dijelaskan';
          cleanReply = cleanReply.replace(/\[KLAIM_GARANSI:[^\]]*\]/gi, '').trim();
          activeClaims.set(from, { description: claimDesc, timestamp: Date.now() });
          // Persist to database
          db.saveActiveClaim(from, claimDesc);
          console.log(`[F5] ⚠️ Klaim garansi tercatat dari ${senderName}: "${claimDesc}"`);
        }

        // F5-B1: Jika ada gambar + customer punya active claim → forward sebagai klaim (bukan transfer)
        // (Hanya jika bukan [BUKTI_TRANSFER] — sudah dihandle di atas)
        if (imagePath && activeClaims.has(from) && !klaimMatch) {
          const claim = activeClaims.get(from);
          const lastOrder = orders.find(o => o.jid === from || o.wa_id === from);
          if (tg.isConfigured()) {
            tg.sendClaimAlert({
              imagePath,
              customerPhone: from.replace('@s.whatsapp.net', '').replace('@c.us', ''),
              customerName:  senderName,
              description:   claim.description,
              order:         lastOrder,
            }).catch(e => console.error('[F5] Gagal forward klaim:', e.message));
            console.log(`[F5] 📸 Foto klaim dari ${senderName} diteruskan ke Telegram admin`);
          }
          // Hapus active claim setelah foto diterima (selesai 1 siklus klaim)
          activeClaims.delete(from);
          db.deleteActiveClaim(from);
        }
        // ────────────────────────────────────────────────────────────────

        const imgMatches = [...cleanReply.matchAll(/\[KIRIM_GAMBAR:(.*?)\]/gi)];
        let productsToImage = [];
        for (const match of imgMatches) {
          productsToImage.push(match[1].trim());
          cleanReply = cleanReply.replace(match[0], '').trim();
        }

        // Fallback: jika AI tidak sertakan tag [KIRIM_GAMBAR:...] tapi menyebut nama produk,
        // kirim gambar otomatis berdasarkan nama produk yang ada di response
        if (productsToImage.length === 0 && settings.productImages) {
          const lowerReply = cleanReply.toLowerCase();
          for (const productName of Object.keys(settings.productImages)) {
            if (!hasSentProductImage(from, productName) && lowerReply.includes(productName.toLowerCase())) {
              productsToImage.push(productName);
            }
          }
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
           save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
           return;
        }

        // ── B1 Hold Check #2: cek lagi SETELAH delay sebelum kirim ──────
        // Pesan susulan bisa datang selama reply delay (10-15 detik).
        // B1 Hold #1 sudah lewat, jadi cek ulang di sini.
        const hasNewerMessageAfterDelay = messages.some(m =>
          m.from === from && m.id > entry.id && !m.replied
        );
        if (pendingBuffers.has(from) || hasNewerMessageAfterDelay) {
          console.log(`⏸️ Reply untuk ${senderName} ditahan (post-delay) — ada pesan susulan.`);
          entry.replied = true;
          entry.aiReply = null;
          entry.cancelledEntry = true;
          save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
          return;
        }
        // ────────────────────────────────────────────────────────────────────

        // Hapus dari activeProcessing karena sudah mau dikirim
        activeProcessing.delete(from);

        // Step tag detection: [STEP=X] → override step via AI tag (secondary mechanism)
        const stepTagMatch = cleanReply.match(/\[STEP=(\d)\]/i);
        if (stepTagMatch) {
          const newStep = parseInt(stepTagMatch[1]);
          const st = orderStates.get(from);
          if (st && [1,2,3,4,5].includes(newStep) && st.step !== newStep) {
            console.log(`📊 [Step] ${from.slice(-4)}: ${st.step}→${newStep} (via AI tag [STEP=${newStep}])`);
            st.step = newStep;
            st.lastUpdate = Date.now();
            orderStates.set(from, st);
            persistOrderState();
          }
          cleanReply = cleanReply.replace(/\[STEP=\d\]/gi, '').trim();
          entry.aiReply = cleanReply; // update DB supaya tag [STEP=X] tidak tersimpan
        }

        // E1: Wrap send — kalau gagal (Meta down/timeout), jangan tandai replied=true
        // supaya retry logic (retryFailedMessages) bisa handle. extractOrder sudah punya
        // dedup 5 menit, jadi tidak akan double-save order saat retry.
        // P1-A: Split reply jadi beberapa bubble kalau ada tag [SPLIT]
        try {
          const bubbles = cleanReply.split('[SPLIT]').map(b => b.trim()).filter(Boolean);
          for (let bi = 0; bi < bubbles.length; bi++) {
            if (bi > 0) await sleep(config.BUBBLE_DELAY_MS); // jeda natural antar bubble
            await sendWhatsAppText(from, bubbles[bi], bi === 0 ? lastWamid : undefined);
          }
        } catch (sendErr) {
          console.error(`❌ Gagal kirim reply ke ${senderName}:`, sendErr.message);
          save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
          return;
        }
        
        // Kirim gambar jika diminta dan tersedia
        for (const productToImage of productsToImage) {
          // Jaga-jaga ganda: walau prompt sudah diinstruksikan jangan kirim ulang,
          // dedupe fisik di sini biar tidak dobel walau AI kelewat menyertakan tag lagi.
          if (hasSentProductImage(from, productToImage)) {
            console.log(`⏭️  Lewati kirim gambar "${productToImage}" ke ${senderName} — sudah pernah dikirim di percakapan ini.`);
            continue;
          }
          if (settings.productImages && settings.productImages[productToImage]) {
            let anySent = false;
            for (const filename of settings.productImages[productToImage]) {
              if (filename) {
                 const imgPath = path.join(IMAGES_DIR, filename);
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
        
        // Update entry dengan balasan AI
    // P1-A: Bersihkan tag [SPLIT] dari aiReply yang disimpan ke DB
    // (DB menyimpan teks gabungan, tanpa tag)
    entry.replied = true;
    entry.aiReply = cleanReply.replace(/\[SPLIT\]/gi, ' ').replace(/\s+/g, ' ').trim();
        save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
        io.emit('message_updated', entry);
        console.log(`🤖 AI (delay ${Math.round(delayMs/1000)}s): ${cleanReply}`);

        // TEST MODE: Emit test_turn dengan semua data tercapture
        if (from === TEST_PHONE) {
          const currentStep = orderStates.get(from)?.step ?? null;
          const validation = validateTestTurn({
            step: currentStep,
            prevStep: _prevTestStep,
            rawGeminiText: _capturedGeminiResponse?.rawText,
            aiOutput: cleanReply,
          });
          const turn = {
            id: Date.now(),
            input: message,
            aiOutput: cleanReply,
            geminiRequest: _capturedGeminiRequest,
            geminiResponse: _capturedGeminiResponse,
            step: currentStep,
            validation,
            timestamp: new Date().toISOString(),
          };
          testTurns.unshift(turn);
          if (testTurns.length > 100) testTurns.length = 100; // batas 100 turn
          io.emit('test_turn', turn);
          _prevTestStep = currentStep;
          _capturedGeminiRequest = null;
          _capturedGeminiResponse = null;
          console.log(`[TEST] ✅ Turn dikirim ke dashboard | Validasi: ${validation.filter(v=>v.pass).length}/${validation.length} pass`);
        }
        
        // Picu retry untuk pesan tertunda lainnya secara background
        setTimeout(retryFailedMessages, 5000);

        // F3-C1: Jika reply mengandung info rekening transfer → set timer follow-up 3 jam
        // Deteksi: reply menyebut nomor rekening (dari PAYMENT.accountNumber) berarti customer pilih Transfer
        if (PAYMENT.accountNumber && cleanReply.includes(PAYMENT.accountNumber) && !scheduler.isActive(from, 'transfer')) {
          const TRANSFER_FOLLOWUP_MS = 3 * 60 * 60 * 1000; // 3 jam
          scheduler.schedule(from, 'transfer', TRANSFER_FOLLOWUP_MS, async () => {
            const followUpMsg =
              `Halo Kak 😊 Kami ingin memastikan, apakah pembayaran transfer sudah berhasil dilakukan?\n\n` +
              `Kalau kakak butuh info rekening lagi atau ada kendala, kami siap membantu ya 🙏`;
            sendWhatsAppText(from, followUpMsg)
              .catch(e => console.error('[F3] Gagal kirim follow-up transfer:', e.message));
            // F3-D2: Tandai sebagai cold lead di DB (tidak ada bukti setelah 3 jam)
            const lastOrder = orders.find(o => o.jid === from || o.wa_id === from);
            if (lastOrder?.id) {
              db.updateOrder(lastOrder.id, { cold_lead: true }).catch(() => {});
              lastOrder.cold_lead = true;
              io.emit('order_updated', lastOrder);
            }
            console.log(`[F3] ⏰ Follow-up transfer dikirim ke ${senderName} — ditandai cold lead`);
          });
        }

      } else {
        activeProcessing.delete(from);
        // null bisa berarti dibatalkan (AbortError) atau fatal error.
        if (controller.signal.aborted) {
           console.log(`⚠️ Proses fetch untuk ${senderName} dibatalkan karena ada pesan susulan.`);
           entry.replied = true;
           // B3: null + flag, bukan string status supaya tidak bocor ke Gemini
           entry.aiReply = null;
           entry.cancelledEntry = true;
           save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
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

// ═══════════════════════════════════════════════════════════════════
// MESSAGE BUFFERING: Proses buffer + cek susulan sebelum kirim reply
// ═══════════════════════════════════════════════════════════════════
async function processBufferedMessages(from) {
  const buf = pendingBuffers.get(from);
  if (!buf || buf.texts.length === 0) return;

  // Tandai sedang proses
  const controller = new AbortController();
  activeProcessing.set(from, { controller, timeoutId: null });

  try {
    while (buf.texts.length > 0) {
      // Ambil semua pesan yang pending
      const texts = buf.texts.splice(0);
      const combinedBody = texts.join('\n');
      const currentWamid = buf.lastWamid;
      const currentSenderName = buf.senderName;

      console.log(`🔄 [Buffer] Proses ${texts.length} pesan: "${combinedBody.slice(0, 60)}"`);

      // P2-B: Siapkan gambar jika ada
      let imagePathForAI = null;
      if (buf.mediaId) {
        try {
          const ext = (buf.mediaMime || '').includes('png') ? 'png' : 'jpg';
          const safeName = (buf.mediaWamid || Date.now().toString()).replace(/[^a-z0-9_-]/gi, '_');
          const filename = `customer_${safeName}.${ext}`;
          const savePath = path.join(IMAGES_DIR, filename);
          if (fs.existsSync(savePath)) {
            imagePathForAI = savePath;
          } else {
            const mediaUrlPath = await downloadAndSaveCustomerMedia(buf.mediaId, buf.mediaWamid, buf.mediaMime);
            if (mediaUrlPath) imagePathForAI = path.join(IMAGES_DIR, path.basename(mediaUrlPath));
          }
        } catch(imgErr) {
          console.warn('[Buffer] Gagal siapkan gambar untuk AI:', imgErr.message);
        }
      }

      // Siapkan audio jika ada
      let audioPathForAI = null;
      if (buf.audioId) {
        try {
          const audioExt = (buf.audioMime || '').includes('mp4') ? 'mp4' : 'ogg';
          const audioSafeName = (buf.audioWamid || currentWamid || '').replace(/[^a-zA-Z0-9_-]/g, '_');
          const audioFilename = `customer_${audioSafeName}.${audioExt}`;
          const audioFullPath = path.join(AUDIO_DIR, audioFilename);
          if (fs.existsSync(audioFullPath)) {
            audioPathForAI = audioFullPath;
          } else {
            const audioUrl = await downloadAndSaveCustomerAudio(buf.audioId, buf.audioWamid || currentWamid, buf.audioMime);
            if (audioUrl) audioPathForAI = path.join(AUDIO_DIR, path.basename(audioUrl));
          }
        } catch(audErr) {
          console.warn('[Buffer] Gagal siapkan audio untuk AI:', audErr.message);
        }
      }

      // Proses ke AI (via processCustomerMessage yang sudah ada)
      await processCustomerMessage(from, currentSenderName, combinedBody, currentWamid, imagePathForAI, buf.mediaId, buf.mediaMime, buf.audioId, buf.audioMime);

      // ═══════════════════════════════════════════════════════════
      // CEK SUSULAN: Sebelum lanjut, apakah ada pesan baru masuk?
      // ═══════════════════════════════════════════════════════════
      if (buf.texts.length > 0) {
        console.log(`⚡ [Buffer] Ada ${buf.texts.length} susulan → gabung & proses ulang`);
        continue; // loop lagi → gabung pesan lama + susulan
      }

      // Tidak ada susulan → selesai
      break;
    }
  } finally {
    activeProcessing.delete(from);
    pendingBuffers.delete(from);
  }
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

  // Validasi struktur payload
  if (!validateWebhookPayload(req.body)) {
    console.log('⚠️ Payload webhook tidak valid (struktur tidak sesuai) — diabaikan');
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
            else if (msg.type === 'image') {
              body = msg.image?.caption || '';
              // P2-A: Download gambar customer ke disk (async untuk dashboard)
              // P2-B: Juga simpan path image agar Gemini bisa membaca gambar ini
              if (msg.image?.id && wamid) {
                const mediaId = msg.image.id;
                const mimetype = msg.image?.mime_type || 'image/jpeg';
                // Fire-and-forget untuk P2-A (update DB & dashboard)
                downloadAndSaveCustomerMedia(mediaId, wamid, mimetype)
                  .catch(e => console.warn('[P2-A] download error:', e.message));
                // Untuk P2-B: simpan info gambar di buffer agar Gemini bisa baca
                if (!pendingBuffers.has(from)) {
                  pendingBuffers.set(from, { texts: [], lastWamid: wamid, senderName: contactName || from });
                }
                const imgBuf = pendingBuffers.get(from);
                imgBuf.mediaId = mediaId;
                imgBuf.mediaMime = mimetype;
                imgBuf.mediaWamid = wamid;
                if (!body.trim()) body = '[gambar]'; // placeholder agar tidak di-skip
              }
            }
            else if (msg.type === 'video') body = msg.video?.caption || '';
            else if (msg.type === 'button') body = msg.button?.text || '';
            else if (msg.type === 'interactive') body = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
            // ── P1-D: Handle tipe non-teks ───────────────────────────────────
            else if (msg.type === 'sticker') {
              // Stiker: skip diam-diam, tidak perlu dibalas AI
              console.log(`ℹ️ [P1-D] Stiker dari ${from}, dilewati`);
              continue;
            }
            else if (msg.type === 'reaction') {
              // Reaction (like/emoji): skip diam-diam
              console.log(`ℹ️ [P1-D] Reaction dari ${from}, dilewati`);
              continue;
            }
            else if (msg.type === 'audio' || msg.type === 'voice') {
              body = '[Customer mengirim pesan suara. Dengarkan audio yang disertakan dan balas berdasarkan isi suaranya. Jika tidak bisa memahami, minta dengan sopan untuk mengetik ulang.]';
              // Download audio ke disk untuk ditampilkan di dashboard
              if (msg.audio?.id && wamid) {
                const audioMimetype = msg.audio?.mime_type || 'audio/ogg';
                downloadAndSaveCustomerAudio(msg.audio.id, wamid, audioMimetype)
                  .catch(e => console.warn('[P2-A2] audio download error:', e.message));
                // Simpan metadata audio di buffer agar bisa dikirim ke Gemini
                if (!pendingBuffers.has(from)) {
                  pendingBuffers.set(from, { texts: [], lastWamid: wamid, senderName: contactName || from });
                }
                const audioBuf = pendingBuffers.get(from);
                audioBuf.audioId = msg.audio.id;
                audioBuf.audioMime = audioMimetype;
                audioBuf.audioWamid = wamid;
              }
            }
            else if (msg.type === 'document') {
              // File/dokumen: beri tahu customer bahwa AI tidak memproses file
              body = '[customer mengirim dokumen/file — mohon balas dengan sopan bahwa kamu hanya bisa menerima pesan teks atau foto produk, dan minta customer ketik ulang pertanyaannya]';
            }
            else if (msg.type === 'location') {
              // Lokasi yang dikirim manual oleh customer (bukan dari tracker kita)
              const lat = msg.location?.latitude;
              const lng = msg.location?.longitude;
              const locName = msg.location?.name || '';
              if (lat && lng) {
                body = `[customer mengirim lokasi GPS: koordinat ${lat}, ${lng}${locName ? `, nama lokasi: ${locName}` : ''}. Gunakan info ini sebagai konfirmasi alamat pengiriman jika relevan, dan minta customer lengkapi dengan RT/RW, kelurahan, kecamatan, kota/kabupaten jika belum ada]`;
              }
              // Kalau koordinat tidak ada, biarkan body kosong → akan di-skip di bawah
            }
            // ──────────────────────────────────────────────────────────────────

            if (!body.trim()) { console.log(`ℹ️ Pesan tipe "${msg.type}" tanpa teks/caption, dilewati`); continue; }

            const senderName = contactName || from;
            console.log(`📩 ${senderName}: ${body}`);

            // ── Command superadmin: on/off untuk toggle auto-reply dari nomor admin ──
            if (isAdminNumber(from)) {
              const cmd = body.trim().toLowerCase();
              if (cmd === 'on' || cmd === 'off') {
                settings.autoReply = (cmd === 'on');
                save(SET_FILE, settings); persistSettingsToDB(settings);
                io.emit('settings_updated', settings);

                const confirmText = settings.autoReply
                  ? '✅ Bot diaktifkan. Auto-reply AI menyala kembali.'
                  : '⛔ Bot dimatikan. Auto-reply AI nonaktif, semua chat masuk perlu dibalas manual.';

                sendWhatsAppText(from, confirmText).catch(e => console.error(e.message));
                console.log(`🔐 Admin command: ${cmd.toUpperCase()} -> autoReply=${settings.autoReply}`);
                continue; // skip AI reply hanya jika command adalah on/off
              }
              // Bukan command on/off — kalau ada pertanyaan pending, anggap ini
              // balasan borongan admin untuk eskalasi, JANGAN diproses sebagai chat biasa.
              if (pendingEscalations.length > 0) {
                handleAdminEscalationAnswer(body).catch(e => console.error('Gagal proses balasan eskalasi admin:', e.message));
                continue;
              }
              // Tidak ada pending sama sekali — biarkan lanjut diproses sebagai chat biasa
            }

            // ── Stop chat per nomor: skip AI jika nomor ini di-stop ──
            if (settings.stoppedChats?.includes(from)) {
              console.log(`⛔ Chat ${senderName} (${from.slice(-4)}) di-stop — AI tidak memproses.`);
              continue;
            }

            // ── Buffer & cek susulan: seperti cara kerja manusia ──
            // Pesan masuk → masuk buffer → proses AI → sebelum kirim, cek ada susulan?
            // Kalau ada: gabung & proses ulang. Kalau tidak: kirim jawaban.
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
              console.log(`📥 [Buffer] ${senderName}: "${body}" (pending: ${existing.texts.length})`);
            } else {
              pendingBuffers.set(from, { texts: [body], lastWamid: wamid, senderName });
              console.log(`📥 [Buffer] ${senderName}: "${body}" (pending: 1)`);
            }

            // Mulai proses jika belum ada yang proses
            if (!activeProcessing.has(from)) {
              processBufferedMessages(from).catch(e => console.error('Buffer error:', e.message));
            }

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
        save(SET_FILE, settings); persistSettingsToDB(settings);
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
  if (messages.length > config.MESSAGE_LIMIT) messages = messages.slice(0, config.MESSAGE_LIMIT);
  save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
  // IMP-4A: orderStep untuk dashboard badge (MacroDroid channel)
  entry.orderStep = orderStates.get(from)?.step || null;
  io.emit('new_message', entry);

  // Antre per-pengirim (userLocks dipakai bersama dengan channel Cloud API supaya
  // tidak ada dua balasan AI yang berjalan bersamaan untuk kontak yang sama).
  const prevTask = userLocks.get(from) || Promise.resolve();
  const nextTask = prevTask.then(async () => {
    if (entry.replied) return; // sudah dibalas manual saat antre

    const history = buildHistory(from, entry.id);
    let reply = await aiReply(combinedBody, senderName, history, null, from);

    if (!reply) {
      save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
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
    // Dedupe sama seperti jalur Cloud API: skip & jangan tandai ulang produk yang
    // gambarnya sudah pernah dikirim di percakapan ini.
    const imageUrls = [];
    for (const p of productsToImage) {
      if (hasSentProductImage(from, p)) continue;
      const files = settings.productImages?.[p];
      let anySent = false;
      if (files) for (const f of files) if (f) { imageUrls.push(`/images/${f}`); anySent = true; }
      if (anySent) markProductImageSent(from, p);
    }

    // P1-A: Split reply jadi beberapa bubble di MacroDroid channel
    // MacroDroid hanya mengirim 1 string reply, jadi gabungkan saja dengan newline
    // (MacroDroid tidak bisa kirim multi-bubble secara terpisah dari server).
    // [SPLIT] tag diganti newline agar teks tetap terbaca di HP Android.
    const finalCleanReply = cleanReply.replace(/\[SPLIT\]/gi, '\n').replace(/\n{3,}/g, '\n\n').trim();

    entry.replied = true;
    entry.aiReply = finalCleanReply;
    save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
    io.emit('message_updated', entry);
    console.log(`🤖 AI (MacroDroid) -> ${senderName}: ${finalCleanReply}`);

    try { finalRes.json({ reply: finalCleanReply, images: imageUrls }); } catch (e) {}
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
app.get('/api/messages', (_, res) => res.json(messages.slice(0, 2000)));
app.get('/api/settings', (_, res) => res.json(settings));
// /api/haskey dipindah sebelum middleware auth (baris ~101) — tidak ada duplikat di sini.

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
    save(SET_FILE, settings); persistSettingsToDB(settings);
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
    save(SET_FILE, settings); persistSettingsToDB(settings);
    res.json({ok: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/settings', (req, res) => {
  const body = { ...req.body };

  // Validasi originId: HARUS berupa angka (numeric string)
  // Mencegah user salah isi nama kota alih-alih ID numerik
  if (body.originId !== undefined) {
    const rawOrigin = (body.originId || '').trim();
    if (rawOrigin && !/^\d+$/.test(rawOrigin)) {
      return res.status(400).json({
        error: `Origin ID harus berupa angka, bukan nama kota. Nilai "${rawOrigin}" tidak valid.\n` +
               `Cari ID kecamatan gudangmu di: https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=NAMA_KECAMATAN&limit=5\n` +
               `Contoh yang benar: 73528 (Serua, Ciputat, Tangerang Selatan)`,
        field: 'originId'
      });
    }
    body.originId = rawOrigin; // simpan versi sudah di-trim
  }

  settings = { ...settings, ...body };
  save(SET_FILE, settings); persistSettingsToDB(settings);
  res.json({ ok: true });
});
app.post('/api/format-kb', async (req, res) => {
  const { knowledgeBase, followUp } = req.body;
  if (!knowledgeBase || !knowledgeBase.trim()) {
    settings.knowledgeBase = '';
    settings.followUp = followUp || '';
    save(SET_FILE, settings); persistSettingsToDB(settings);
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
      save(SET_FILE, settings); persistSettingsToDB(settings);
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
    save(ORDER_FILE, orders); if (typeof order !== 'undefined') persistOrderToDB(order);
    io.emit('order_updated', order);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Order tidak ditemukan' });
  }
});
app.delete('/api/orders/:id', async (req, res) => {
  const id = req.params.id;
  const initLength = orders.length;
  orders = orders.filter(o => o.id !== id);
  if (orders.length < initLength) {
    save(ORDER_FILE, orders);
    try { await db.deleteOrder(id); } catch(e) { console.error('DB delete order error:', e.message); }
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Order tidak ditemukan' });
  }
});

// ── Chat Management: Stop AI & Delete Chat per nomor ──

// POST /api/chat/:waId/stop — toggle stop AI untuk 1 nomor
app.post('/api/chat/:waId/stop', (req, res) => {
  const waId = decodeURIComponent(req.params.waId);
  const { stopped } = req.body;
  if (!settings.stoppedChats) settings.stoppedChats = [];

  if (stopped) {
    if (!settings.stoppedChats.includes(waId)) settings.stoppedChats.push(waId);
    console.log(`⛔ Chat ${waId.slice(-4)} di-STOP`);
  } else {
    settings.stoppedChats = settings.stoppedChats.filter(id => id !== waId);
    console.log(`▶️ Chat ${waId.slice(-4)} di-UNSTOP`);
  }

  save(SET_FILE, settings); persistSettingsToDB(settings);
  io.emit('settings_updated', settings);
  res.json({ ok: true, stopped: !!stopped });
});

// DELETE /api/chat/:waId — hapus semua data chat untuk 1 nomor
app.delete('/api/chat/:waId', async (req, res) => {
  const waId = decodeURIComponent(req.params.waId);
  console.log(`🗑️ Hapus semua chat untuk ${waId.slice(-4)}...`);

  try {
    // 1. Hapus dari in-memory messages
    const before = messages.length;
    messages = messages.filter(m => m.from !== waId);
    console.log(`  📨 Messages: ${before} → ${messages.length} (${before - messages.length} dihapus)`);
    save(MSG_FILE, messages);

    // 2. Hapus order state
    const phone = waId.replace(/@s\.whatsapp\.net|@c\.us/g, '');
    orderStates.delete(waId);
    orderStates.delete(phone);
    persistOrderState();

    // 3. Hapus sent product images
    sentProductImages.delete(waId);

    // 4. Hapus active claims
    activeClaims.delete(waId);
    await db.deleteActiveClaim(waId).catch(e => console.warn('[Delete] activeClaim error:', e.message));

    // 5. Hapus pending buffer & processing
    pendingBuffers.delete(waId);
    if (activeProcessing.has(waId)) {
      const task = activeProcessing.get(waId);
      if (task.controller) task.controller.abort();
      activeProcessing.delete(waId);
    }
    userLocks.delete(waId);

    // 6. Hapus pending escalations untuk nomor ini
    pendingEscalations = pendingEscalations.filter(e => e.from !== waId);

    // 7. Hapus dari DB
    await db.pool.query('DELETE FROM messages WHERE wa_id = $1', [waId]).catch(e => console.warn('[Delete] DB messages error:', e.message));
    await db.pool.query('DELETE FROM orders WHERE wa_id = $1', [waId]).catch(e => console.warn('[Delete] DB orders error:', e.message));

    // 8. Hapus dari stopped list jika ada
    if (settings.stoppedChats?.includes(waId)) {
      settings.stoppedChats = settings.stoppedChats.filter(id => id !== waId);
      save(SET_FILE, settings); persistSettingsToDB(settings);
    }

    // 9. Update dashboard
    io.emit('messages', messages);

    console.log(`✅ Chat ${waId.slice(-4)} berhasil dihapus`);
    res.json({ ok: true, deleted: before - messages.length });
  } catch (err) {
    console.error(`❌ Gagal hapus chat ${waId.slice(-4)}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Manual Cek Alamat & Ongkir (Tools Baru) ──
app.post('/api/cek-alamat-manual', async (req, res) => {
  const { alamat } = req.body;
  if (!alamat) return res.status(400).json({ error: 'Alamat tidak boleh kosong' });

  // Gunakan getKomerceKey() / getOriginId() yang sudah punya default fallback,
  // konsisten dengan processOrderAddressAI — tidak blokir kalau config belum diisi.
  const picked = getAvailableKey();
  if (!picked) return res.status(500).json({ error: 'Semua API Key kena limit' });
  
  try {
    const model = settings.modelName || 'gemini-3.1-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(picked.key)}`;

    const systemPrompt = `Kamu adalah asisten ekstraksi alamat pengiriman Indonesia. Dari teks alamat berikut, ekstrak informasi dan kembalikan HANYA JSON murni (tanpa markdown backticks, tanpa komentar) dengan struktur PERSIS ini:
{"desa": "nama desa atau kelurahan saja (tanpa kata Desa/Kel)", "kecamatan": "nama kecamatan saja (tanpa kata Kec)", "kabupaten": "nama kabupaten atau kota (tanpa kata Kab/Kota)", "provinsi": "nama provinsi", "patokan": "nama jalan, nomor rumah, atau patokan lokasi jika ada — kosongkan jika tidak ada", "kodepos": "kode pos 5 digit jika ada — kosongkan jika tidak diketahui", "alamat_baku": "alamat lengkap rapi format: [patokan jika ada], Desa [desa], Kec [kecamatan], [kabupaten], [provinsi] [kodepos]"}\nJika ada informasi yang tidak tersedia dalam teks, isi dengan string kosong. Jangan mengarang informasi yang tidak ada.`;
    
    const body = {
      contents: [{ role: 'user', parts: [{ text: alamat }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.1 },
    };

    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    // Pastikan kabupaten tersedia (fallback dari destData nanti)
    if (!parsed.kabupaten) parsed.kabupaten = '';
    if (!parsed.patokan) parsed.patokan = '';
    if (!parsed.kodepos) parsed.kodepos = '';

    let ai_cod = '⚠️ Area tidak tercover';
    let destLabel = null;
    
    // Search RajaOngkir destination
    const searchUrl = 'https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=' + encodeURIComponent(parsed.desa + ' ' + parsed.kecamatan) + '&limit=1';
    const destRes = await fetch(searchUrl, { headers: { 'key': getKomerceKey() } });
    const destData = await destRes.json();
    
    if (destData?.data && destData.data.length > 0) {
      const dest = destData.data[0];
      destLabel = dest.label || null;
      const destProvince = dest.province_name || '';
      const destCity = dest.city_name || '';

      // Validasi coverage ID Express COD berdasarkan provinsi
      const isCovered = isIDECODCovered(destProvince);
      
      if (!isCovered) {
        ai_cod = `❌ Tidak Tercover COD (${destCity}, ${destProvince})`;
      } else {
        const costPayload = new URLSearchParams();
        costPayload.append('origin', getOriginId());
        costPayload.append('destination', dest.id);
        costPayload.append('weight', '1000');
        costPayload.append('courier', 'ide');
        costPayload.append('price', 'lowest');

        const costRes = await fetch('https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost', {
          method: 'POST',
          headers: { 'key': getKomerceKey(), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: costPayload.toString()
        });
        
        const costData = await costRes.json();
        const services = costData?.data || [];
        const hasValidService = services.some(d => d.cost > 0);
        if (hasValidService) {
          const cheapest = services.reduce((a, b) => a.cost < b.cost ? a : b);
          ai_cod = `✅ COD Bisa — ${destCity} (${cheapest.etd})`;
        } else {
          ai_cod = `❌ COD Tidak Bisa — ${destCity}, ${destProvince}`;
        }
      }
    }

    res.json({
      ok: true,
      data: {
        // Susun ai_alamat dari komponen terstruktur, diperkaya destLabel dari RajaOngkir
        ai_alamat: [
          parsed.patokan ? parsed.patokan : null,
          `Kel/Desa ${parsed.desa}`,
          `Kec ${parsed.kecamatan}`,
          parsed.kabupaten || (destLabel ? destLabel.split(',')[2]?.trim() : null),
          parsed.provinsi,
          parsed.kodepos
        ].filter(Boolean).join(', '),
        desa: parsed.desa,
        kecamatan: parsed.kecamatan,
        kabupaten: parsed.kabupaten,
        patokan: parsed.patokan,
        kodepos: parsed.kodepos,
        dest_label: destLabel,
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

// ── Cek Ulang AI address & COD untuk 1 order spesifik (tombol Cek Ulang di dashboard) ──
app.post('/api/orders/:id/recheck-ai', async (req, res) => {
  const { id } = req.params;
  const order = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  if (!order.alamat) return res.status(400).json({ error: 'Order tidak punya alamat' });
  // Reset dulu supaya bisa diproses ulang
  delete order.ai_alamat;
  delete order.ai_cod;
  res.json({ ok: true, message: 'Sedang memproses ulang...' });
  // Jalankan di background
  processOrderAddressAI(order.id).catch(e => console.error('[recheck-ai] Error:', e.message));
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
    const target = normalizeIdNumber(number);
    console.log(`📤 [Manual Send] Kirim ke: ${target}, panjang pesan: ${message.length} karakter`);
    const metaResponse = await sendWhatsAppText(target, message);
    console.log(`📤 [Manual Send] Respons Meta:`, JSON.stringify(metaResponse));
    if (!metaResponse || !metaResponse.messages?.[0]?.id) {
      console.error(`❌ [Manual Send] Meta tidak mengembalikan message ID! Response:`, metaResponse);
      return res.status(500).json({ error: 'WhatsApp tidak mengkonfirmasi pengiriman pesan. Kemungkinan nomor tidak terdaftar di WhatsApp atau di luar jendela 24 jam.' });
    }
    console.log(`✅ [Manual Send] Berhasil! Message ID: ${metaResponse.messages[0].id}`);
    const msgObj = {
      id: 'man-' + Date.now(),
      from: target,
      body: '[Anda mengirim pesan]',
      timestamp: new Date().toISOString(),
      replied: true,
      aiReply: message,
      manual: true
    };
    messages.unshift(msgObj);
    if (messages.length > config.MESSAGE_LIMIT) messages = messages.slice(0, config.MESSAGE_LIMIT);
    save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);
    io.emit('messages', messages);
    res.json({ ok: true });
  } catch(e) {
    console.error(`❌ [Manual Send] Error:`, e.message, e.graphError || '');
    res.status(500).json({ error: e.message });
  }
});

// ── Kirim Video/Gambar dari chat panel dashboard ke customer ──────────────
const multerMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } }); // max 64MB
app.post('/api/chat/send-media', multerMemory.single('file'), async (req, res) => {
  const { number, caption } = req.body;
  const file = req.file;
  if (!file || !number) return res.status(400).json({ error: 'File dan nomor tujuan wajib diisi' });
  if (settings.channel === 'macrodroid') return res.status(400).json({ error: 'Kirim media dari dashboard tidak didukung untuk channel MacroDroid.' });
  if (!waConfigured) return res.status(400).json({ error: 'WhatsApp Cloud API belum dikonfigurasi' });
  try {
    const target = normalizeIdNumber(number);
    const mimetype = file.mimetype;
    const mediaType = mimetype.startsWith('video/') ? 'video' : 'image';
    console.log(`📤 [Chat Media] Upload ${mediaType} "${file.originalname}" ke Meta...`);
    const mediaId = await uploadWhatsAppMediaBuffer(file.buffer, mimetype, file.originalname);
    if (!mediaId) return res.status(500).json({ error: 'Gagal upload media ke WhatsApp' });
    console.log(`📤 [Chat Media] Kirim ${mediaType} ke ${target}...`);
    const metaResp = await sendWhatsAppMediaById(target, mediaId, mediaType, caption || '');
    if (!metaResp?.messages?.[0]?.id) return res.status(500).json({ error: 'WhatsApp tidak mengkonfirmasi pengiriman media' });
    console.log(`✅ [Chat Media] Berhasil! Message ID: ${metaResp.messages[0].id}`);
    const label = mediaType === 'video' ? '🎥 Video' : '🖼️ Gambar';
    const msgObj = {
      id: 'man-' + Date.now(),
      from: target,
      body: '[Anda mengirim pesan]',
      timestamp: new Date().toISOString(),
      replied: true,
      aiReply: caption ? `${label}: ${caption}` : `${label} dikirim`,
      manual: true
    };
    messages.unshift(msgObj);
    if (messages.length > config.MESSAGE_LIMIT) messages = messages.slice(0, config.MESSAGE_LIMIT);
    save(MSG_FILE, messages);
    try { persistMessageToDB(msgObj); } catch(e) {}
    io.emit('messages', messages);
    res.json({ ok: true });
  } catch(e) {
    console.error(`❌ [Chat Media] Error:`, e.message, e.graphError || '');
    res.status(500).json({ error: e.message });
  }
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
// getKomerceKey() & getOriginId() dibaca dari settings (bisa diubah di dashboard)
// Nilai hardcoded di bawah hanya sebagai fallback awal — setelah disimpan via
// dashboard, nilai dari settings.json yang akan dipakai.
const KOMERCE_API_KEY_DEFAULT = 'Yzx2NjTb1c484631212a74562TQwiwSB';
const ORIGIN_ID_DEFAULT = '73528'; // Serua Ciputat
function getKomerceKey() { return (settings.komerceApiKey || '').trim() || KOMERCE_API_KEY_DEFAULT; }
function getOriginId()   { return (settings.originId    || '').trim() || ORIGIN_ID_DEFAULT; }

// Provinsi yang dicover ID Express COD (berdasarkan jangkauan resmi ID Express)
// Sumber: https://idexpress.com/coverage
const IDE_COD_PROVINCES = [
  'ACEH', 'SUMATERA UTARA', 'SUMATERA BARAT', 'RIAU', 'KEPULAUAN RIAU',
  'JAMBI', 'BENGKULU', 'SUMATERA SELATAN', 'KEPULAUAN BANGKA BELITUNG', 'LAMPUNG',
  'BANTEN', 'DKI JAKARTA', 'JAWA BARAT', 'JAWA TENGAH', 'DI YOGYAKARTA', 'JAWA TIMUR',
  'BALI', 'NUSA TENGGARA BARAT',
  'KALIMANTAN BARAT', 'KALIMANTAN TENGAH', 'KALIMANTAN SELATAN', 'KALIMANTAN TIMUR', 'KALIMANTAN UTARA',
  'SULAWESI SELATAN', 'SULAWESI TENGGARA', 'SULAWESI TENGAH', 'SULAWESI UTARA', 'SULAWESI BARAT', 'GORONTALO',
];

function isIDECODCovered(provinceName) {
  if (!provinceName) return false;
  const p = provinceName.toUpperCase().trim();
  return IDE_COD_PROVINCES.some(prov => p.includes(prov) || prov.includes(p));
}

async function processOrderAddressAI(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order || !order.alamat) return;

  // Skip kalau konfigurasi pengiriman belum diisi (pakai fallback default)
  if (!(settings.komerceApiKey || '').trim()) {
    console.warn(`⚠️ [AI Alamat] Komerce API Key belum diisi di settings — menggunakan key default. Isi di dashboard tab "Cek Resi" untuk key kustom.`);
  }

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

    const systemPrompt = `Kamu adalah asisten ekstraksi alamat pengiriman Indonesia. Dari teks alamat berikut, ekstrak informasi dan kembalikan HANYA JSON murni (tanpa markdown backticks, tanpa komentar) dengan struktur PERSIS ini:
{"desa": "nama desa atau kelurahan saja (tanpa kata Desa/Kel)", "kecamatan": "nama kecamatan saja (tanpa kata Kec)", "kabupaten": "nama kabupaten atau kota (tanpa kata Kab/Kota)", "provinsi": "nama provinsi", "patokan": "nama jalan, nomor rumah, atau patokan lokasi jika ada — kosongkan jika tidak ada", "kodepos": "kode pos 5 digit jika ada — kosongkan jika tidak diketahui", "alamat_baku": "alamat lengkap rapi format: [patokan jika ada], Desa [desa], Kec [kecamatan], [kabupaten], [provinsi] [kodepos]"}\nJika ada informasi yang tidak tersedia dalam teks, isi dengan string kosong. Jangan mengarang informasi yang tidak ada.`;
    
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
    if (!parsed.kabupaten) parsed.kabupaten = '';
    if (!parsed.patokan) parsed.patokan = '';
    if (!parsed.kodepos) parsed.kodepos = '';

    // Susun ai_alamat terstruktur: patokan + desa + kecamatan + kabupaten + provinsi + kodepos
    const parts_alamat = [
      parsed.patokan || null,
      `Kel/Desa ${parsed.desa}`,
      `Kec ${parsed.kecamatan}`,
      parsed.kabupaten,
      parsed.provinsi,
      parsed.kodepos
    ].filter(Boolean);
    order.ai_alamat = parts_alamat.join(', ') || parsed.alamat_baku || order.alamat;
    io.emit('order_updated', order); // update UI partially

    // Search RajaOngkir destination (gunakan desa + kecamatan untuk akurasi)
    const searchUrl = 'https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=' + encodeURIComponent(parsed.desa + ' ' + parsed.kecamatan) + '&limit=1';
    const destRes = await fetch(searchUrl, { headers: { 'key': getKomerceKey() } });
    const destData = await destRes.json();
    
    if (destData?.data && destData.data.length > 0) {
      const destObj = destData.data[0];
      const destId = destObj.id;
      const destProvince = destObj.province_name || '';
      const destCity = destObj.city_name || '';
      const destLabel = destObj.label || '';
      
      // Validasi coverage ID Express COD berdasarkan provinsi
      const isCovered = isIDECODCovered(destProvince);
      
      if (!isCovered) {
        // Provinsi di luar jangkauan COD ID Express sama sekali
        order.ai_cod = `❌ Tidak Tercover COD (${destCity}, ${destProvince})`;
      } else {
        // Check Cost for ID Express (hanya untuk provinsi yang covered)
        const costPayload = new URLSearchParams();
        costPayload.append('origin', getOriginId());
        costPayload.append('destination', destId);
        costPayload.append('weight', '1000');
        costPayload.append('courier', 'ide');
        costPayload.append('price', 'lowest');

        const costRes = await fetch('https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost', {
          method: 'POST',
          headers: { 'key': getKomerceKey(), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: costPayload.toString()
        });
        
        const costData = await costRes.json();
        const services = costData?.data || [];
        const hasValidService = services.some(d => d.cost > 0);
        
        if (hasValidService) {
          const cheapest = services.reduce((a, b) => a.cost < b.cost ? a : b);
          order.ai_cod = `✅ COD Bisa — ${destCity} (${cheapest.etd})`;
        } else {
          order.ai_cod = `❌ COD Tidak Bisa — ${destCity}, ${destProvince}`;
        }
      }
    } else {
      order.ai_cod = '⚠️ Area tidak tercover';
    }

    save(ORDER_FILE, orders); if (typeof order !== 'undefined') persistOrderToDB(order);
    io.emit('order_updated', order);
  } catch (e) {
    console.error('AI Address Process Error:', e.message);
  }
}
// ──────────────────────────────────────────────


// ══════════════════════════════════════════════════════════════════════════════
// AI-to-AI TEST SESSION
// Jalankan 3 persona customer palsu (dari log chat nyata) → aiReply() produksi
// → AI Evaluator nilai setiap jawaban → emit hasil ke dashboard realtime.
// TIDAK ada pesan yang dikirim ke WA — aman dijalankan di produksi.
// ══════════════════════════════════════════════════════════════════════════════

// Persona diambil dari log chat nyata (pola tanya-jawab yang representatif)
const AI_TEST_PERSONAS = [
  {
    id: 'persona_1',
    name: 'Khasin',
    label: '🧑 Khasin — buyer produk rumah tangga',
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
    label: '👩 Azizah — calon beli tapi ragu-ragu',
    script: [
      'Halo! Bisa minta info lebih lanjut tentang selang flexibel?',
      'Cek harga ya?',
      'Tertarik sama selang nya sih, tapi ngak semua kran yg pas sama selang nya kali ya?',
      'Oh gitu tapi KK gantilah dulu kran nya, sekarang ini model nya yg kyk lengkung, maunya yg langsung k dinding aja, nantiklh di kbrin ya, cuman mau ngecek harga aja dulu.',
      'Iya sama sama 🙏',
    ],
  },
  {
    id: 'persona_3',
    name: 'Rosa',
    label: '👩 Rosa — buyer baby walking assistant, order sampai konfirmasi',
    script: [
      'Halo! Bisa minta info lebih lanjut tentang baby walking assistant?',
      'Benar ni udah termasuk ongkir cuman lapan buluh sembilan ribu',
      'Warna NaVi boleh kk',
      'Alamat sipang kelurahan desa sipang kecamatan Batang Cenaku, 081363429837',
      'Ok kira2 tg berapa ya kk datang ny biar langsung di siap kan uang ny',
    ],
  },
];

// Evaluasi satu giliran pakai Gemini sebagai juri
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

// State test session aktif
let activeTestSession = null;

async function runAITestSession(sessionId) {
  console.log(`\n🧪 [AI Test] Sesi ${sessionId} dimulai`);

  activeTestSession = {
    id: sessionId,
    status: 'running',
    startedAt: new Date().toISOString(),
    personas: AI_TEST_PERSONAS.map(p => ({
      id: p.id, name: p.name, label: p.label,
      turns: [], avgSkor: null, done: false,
    })),
  };

  io.emit('ai_test_update', { type: 'session_start', session: activeTestSession });

  // Jalankan persona secara berurutan (sekuensial) agar aman dari limit 15 RPM Gemini
  for (const persona of AI_TEST_PERSONAS) {
    const personaState = activeTestSession.personas.find(p => p.id === persona.id);
    const history = []; // history lokal per persona, tidak mempengaruhi messages produksi

    for (let i = 0; i < persona.script.length; i++) {
      if (activeTestSession?.status === 'stopped') break;

      const customerMsg = persona.script[i];

      // Emit: customer baru kirim pesan
      io.emit('ai_test_update', {
        type: 'turn_start',
        personaId: persona.id,
        turnIndex: i,
        customerMsg,
      });

      // Panggil aiReply() produksi langsung — TIDAK kirim ke WA
      let botReply = null;
      try {
        botReply = await aiReply(customerMsg, persona.name, history, null);
      } catch (e) {
        botReply = '[ERROR: ' + e.message + ']';
      }

      if (!botReply) botReply = '[Tidak ada balasan — key habis atau error]';

      // Jeda 20 detik untuk menghindari rate limit 15 RPM Gemini sebelum memanggil API Evaluator
      await sleep(20000);

      // Evaluasi giliran ini
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

      // Emit progress ke dashboard
      io.emit('ai_test_update', { type: 'turn_done', personaId: persona.id, turn });

      // Jeda 20 detik antar giliran
      await sleep(20000);
    }

    // Hitung rata-rata skor persona ini
    const skors = personaState.turns.map(t => t.evalResult?.skor || 0).filter(s => s > 0);
    personaState.avgSkor = skors.length ? (skors.reduce((a, b) => a + b, 0) / skors.length).toFixed(1) : null;
    personaState.done = true;

    io.emit('ai_test_update', { type: 'persona_done', personaId: persona.id, avgSkor: personaState.avgSkor });
    console.log(`✅ [AI Test] ${persona.name} selesai — avg skor: ${personaState.avgSkor}`);
  }

  activeTestSession.status = 'done';
  activeTestSession.finishedAt = new Date().toISOString();
  io.emit('ai_test_update', { type: 'session_done', session: activeTestSession });
  console.log(`🏁 [AI Test] Sesi ${sessionId} selesai`);
}

// Endpoint: mulai test session
app.post('/api/ai-test/start', async (req, res) => {
  if (activeTestSession?.status === 'running') {
    return res.status(409).json({ error: 'Test session sudah berjalan' });
  }
  const sessionId = 'test_' + Date.now();
  res.json({ ok: true, sessionId });
  // Jalankan async, tidak block response
  runAITestSession(sessionId).catch(e => {
    console.error('[AI Test] Error:', e.message);
    if (activeTestSession) activeTestSession.status = 'error';
    io.emit('ai_test_update', { type: 'error', message: e.message });
  });
});

// Endpoint: stop test session
app.post('/api/ai-test/stop', (req, res) => {
  if (activeTestSession) activeTestSession.status = 'stopped';
  res.json({ ok: true });
});

// Endpoint: ambil hasil session terakhir
app.get('/api/ai-test/result', (req, res) => {
  res.json(activeTestSession || { status: 'idle' });
});

// ═══════════════════════════════════════════════════════════════════
// INTERNAL TEST ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

// POST /api/test/internal/send — kirim pesan test (intercept I/O)
// Pakai prefix /api/ agar tercakup auth middleware app.use('/api', ...)
app.post('/api/test/internal/send', async (req, res) => {
  const { message, senderName } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Isi message' });

  const name = senderName || 'Tester Internal';
  const wamid = 'test_int_' + Date.now();

  // Reset capture untuk turn ini
  _capturedGeminiRequest = null;
  _capturedGeminiResponse = null;

  console.log(`\n🧪 [INTERNAL TEST] Pesan: "${message}"`);

  // Simpan ke messages array seperti pesan biasa (tapi dari TEST_PHONE)
  const entry = {
    id: Date.now(),
    from: TEST_PHONE,
    senderName: name,
    body: message,
    wamid,
    timestamp: new Date().toISOString(),
    replied: false,
    aiReply: null,
    type: 'text',
    isTestInternal: true,
  };
  messages.unshift(entry);
  save(MSG_FILE, messages);

  // Proses AI secara async
  processCustomerMessage(TEST_PHONE, name, message, wamid, null, null, null, null, null)
    .catch(e => console.error('🧪 [TEST] Error:', e.message));

  res.json({ ok: true, wamid, message: 'Sedang diproses...' });
});

// POST /api/test/internal/reset — hapus history test dan reset order state
app.post('/api/test/internal/reset', (req, res) => {
  // Hapus semua pesan dari TEST_PHONE
  const before = messages.length;
  messages = messages.filter(m => m.from !== TEST_PHONE);
  save(MSG_FILE, messages);

  // Reset order state
  orderStates.delete(TEST_PHONE);
  persistOrderState(true);

  // Reset turn history + capture
  testTurns.length = 0;
  _capturedGeminiRequest = null;
  _capturedGeminiResponse = null;
  _prevTestStep = null;

  console.log(`🧪 [INTERNAL TEST] Reset: hapus ${before - messages.length} pesan test, state direset`);
  io.emit('test_reset');
  res.json({ ok: true, message: 'Test session direset' });
});

// GET /api/test/internal/turns — ambil semua turn (untuk load awal dashboard)
app.get('/api/test/internal/turns', (req, res) => {
  res.json({ ok: true, turns: testTurns });
});

// ═══════════════════════════════════════════════════════════════════
// TEST ENDPOINT: Simulasi pesan customer untuk testing flow
// ═══════════════════════════════════════════════════════════════════
app.post('/test/simulate', async (req, res) => {
  // IMP-1B: Auth check — wajib X-Test-Token header di production
  const testToken = req.headers['x-test-token'];
  const expectedToken = process.env.TEST_TOKEN || '';
  if (expectedToken && testToken !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized: X-Test-Token tidak cocok' });
  }
  try {
    const { sender, message, senderName } = req.body || {};
    if (!sender || !message) {
      return res.status(400).json({ error: 'Isi sender dan message' });
    }

    const from = sender.replace(/\D/g, '');
    const name = senderName || sender;
    const wamid = 'test_' + Date.now();

    console.log(`\n🧪 [TEST SIMULATE] ${name} (${from}): "${message}"`);

    // Simulasi incoming message — proses seperti webhook biasa
    const entry = {
      id: Date.now(),
      from,
      body: message,
      timestamp: Date.now(),
      wamid,
      replied: false,
      aiReply: null,
      type: 'text',
    };
    // IMP-1C: unshift (bukan push) agar urutan array konsisten dengan processCustomerMessage
    messages.unshift(entry);
    save(MSG_FILE, messages);

    // Emit ke dashboard
    io.emit('new_message', entry);

    // Proses via processCustomerMessage (async, tidak block response)
    processCustomerMessage(from, name, message, wamid, null, null, null, null, null)
      .catch(e => console.error('🧪 [TEST] Error:', e.message));

    // Tunggu 5 detik lalu kirim response awal
    await new Promise(r => setTimeout(r, 3000));

    // Cek apakah ada reply
    const updated = messages.find(m => m.wamid === wamid);
    res.json({
      ok: true,
      received: true,
      entryId: entry.id,
      aiReplyPending: !updated?.aiReply,
      message: 'Pesan diterima, AI sedang proses...'
    });
  } catch (e) {
    console.error('🧪 [TEST] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// TEST ENDPOINT: Cek response terakhir untuk nomor tertentu
// ═══════════════════════════════════════════════════════════════════
app.get('/test/response/:phone', (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const entries = messages
    .filter(m => m.from === phone)
    .sort((a, b) => a.id - b.id)
    .slice(-5);

  res.json({
    phone,
    totalMessages: messages.filter(m => m.from === phone).length,
    last5: entries.map(e => ({
      id: e.id,
      body: e.body,
      aiReply: e.aiReply,
      replied: e.replied,
      timestamp: new Date(e.timestamp).toISOString(),
    })),
  });
});

server.listen(PORT, async () => {
  console.log('\n==========================================');
  console.log('  WA AI Assistant (Cloud API + MacroDroid) berjalan!');
  try { await db.initDB(); } catch(e) { console.error('Failed to init DB:', e.message); }
  loadOrderStates();
  console.log(`  Buka browser: http://localhost:${PORT}`);
  console.log(`  Channel aktif saat ini: ${settings.channel === 'macrodroid' ? 'MacroDroid' : 'WhatsApp Cloud API'} (bisa diganti di dashboard)`);
  console.log(`  Webhook Cloud API (Meta App Dashboard): https://<domain-kamu>/webhook`);
  console.log(`  Webhook MacroDroid (Macro 1 - HTTP Request): https://<domain-kamu>/webhook/wa-incoming`);
  console.log('==========================================\n');

  // Jalankan pengecekan rutin pesan tertunda setiap 5 menit
  setInterval(retryFailedMessages, 5 * 60 * 1000);

  // P2-D: Mulai Telegram bot polling untuk eskalasi
  if (tg.isConfigured()) {
    tg.startPolling().then(ok => {
      if (ok) console.log('✅ [P2-D] Telegram escalation bot aktif');
    });

    // Ketika admin balas di Telegram → teruskan ke handleAdminEscalationAnswer
    tg.onReply(async (adminText) => {
      console.log('[P2-D] Balasan admin dari Telegram diterima, diproses...');
      await handleAdminEscalationAnswer(adminText);
    });

    // F2-C2&C3: Ketika admin approve/reject bukti transfer di Telegram
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

process.on('uncaughtException',  e => console.error('Error:', e.message));
process.on('unhandledRejection', e => console.error('Rejection:', e?.message || e));
