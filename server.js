const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const qrcode     = require('qrcode');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');
const pino       = require('pino');
const crypto     = require('crypto');

require('dotenv').config();

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

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion;

async function loadBaileys() {
  const B = await import('@whiskeysockets/baileys');
  makeWASocket              = B.default || B.makeWASocket;
  useMultiFileAuthState     = B.useMultiFileAuthState;
  DisconnectReason          = B.DisconnectReason;
  fetchLatestBaileysVersion = B.fetchLatestBaileysVersion;
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
app.use(express.json({limit: '10mb'}));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');
const SET_FILE = path.join(DATA_DIR, 'settings.json');
const ORDER_FILE = path.join(DATA_DIR, 'orders.json');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
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
// Key: JID pengirim, Value: { texts: [], timer, lastMsgObj }
// Durasi tunggu & delay balas diatur lewat settings.debounceSeconds /
// settings.replyDelayMin / settings.replyDelayMax (bisa diubah di dashboard).
const pendingBuffers = new Map();
const userLocks = new Map(); // Menyimpan antrean promise per pengirim
const activeProcessing = new Map(); // fromJid -> { controller, timeoutId, resolveDelay }

[DATA_DIR, AUTH_DIR, IMAGES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const DEF = {
  autoReply: true,
  persona: 'Kamu adalah asisten CS toko online yang ramah, sopan, dan helpful.',
  language: 'Indonesia',
  tone: 'Santai',
  opHours: { enabled: false, start: '08:00', end: '17:00' },
  whitelist: [],
  knowledgeBase: '',
  followUp: '',
  modelName: 'gemini-2.5-flash',
  temperature: 0.7,
  adminNumber: '085210127796', // nomor superadmin - kirim on/off ke nomor bot untuk kontrol auto-reply
  debounceSeconds: 6, // tunggu berapa detik sejak pesan terakhir sebelum digabung & diproses AI
  replyDelayMin: 15, // minimal durasi pura-pura ngetik
  replyDelayMax: 25, // maksimal durasi pura-pura ngetik
  productImages: {}
};

let settings = { ...DEF };
let messages  = [];
let orders    = [];

try { if (fs.existsSync(SET_FILE)) settings = { ...DEF, ...JSON.parse(fs.readFileSync(SET_FILE, 'utf8')) }; } catch(e) {}
try { if (fs.existsSync(MSG_FILE)) messages  = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); } catch(e) {}
try { if (fs.existsSync(ORDER_FILE)) orders  = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')); } catch(e) {}

const save = (file, data) => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {} };

// ── Multi API Key (rotasi 3 key Gemini) ──────────────────────────
// Urutan: key1 -> key2 -> key3 -> key1 -> ...
// Pindah ke key berikutnya kalau key yang aktif gagal terus setelah MAX_RETRY percobaan.
let activeKeyIndex = 0; // 0 = key1, 1 = key2, 2 = key3

function getApiKeys() {
  return [
    process.env.GEMINI_API_KEY_1 || '',
    process.env.GEMINI_API_KEY_2 || '',
    process.env.GEMINI_API_KEY_3 || '',
  ];
}

function getActiveKey() {
  const keys = getApiKeys();
  // Lewati slot yang kosong, cari key valid mulai dari activeKeyIndex
  for (let i = 0; i < keys.length; i++) {
    const idx = (activeKeyIndex + i) % keys.length;
    if (keys[idx] && keys[idx].length >= 10) {
      activeKeyIndex = idx;
      return { key: keys[idx], index: idx };
    }
  }
  return { key: '', index: -1 };
}

function rotateToNextKey() {
  const keys = getApiKeys();
  const filledCount = keys.filter(k => k && k.length >= 10).length;
  if (filledCount <= 1) return false; // gak ada key lain buat dipindah
  const prevIndex = activeKeyIndex;
  for (let i = 1; i <= keys.length; i++) {
    const idx = (activeKeyIndex + i) % keys.length;
    if (keys[idx] && keys[idx].length >= 10) {
      activeKeyIndex = idx;
      break;
    }
  }
  console.log(`🔄 Rotasi API Key: dari Key ${prevIndex + 1} ke Key ${activeKeyIndex + 1}`);
  io.emit('key_rotated', { from: prevIndex + 1, to: activeKeyIndex + 1 });
  return true;
}

let waStatus = 'disconnected', qrData = null, sock = null;

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
  // Kalau tidak ketemu/ambigu, kirim semua sebagai fallback supaya tetap akurat.
  const chosen = matched.length ? matched : blocks;
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


// Satu kali panggilan ke Gemini REST API (pakai key yang sedang aktif dari rotasi)
async function callGemini(message, name, history, signal) {
  const { key, index } = getActiveKey();
  if (!key) return { ok: false, fatal: true, error: 'Belum ada API key yang diisi' };

  const model = settings.modelName || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const contents = [];
  if (history?.length) {
    for (const h of history.slice(-8)) {
      contents.push({ role: 'user', parts: [{ text: h.body }] });
      if (h.aiReply) contents.push({ role: 'model', parts: [{ text: h.aiReply }] });
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
    return { ok: false, error: e.message, keyIndex: index };
  }

  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const errData = await res.json();
      msg = errData?.error?.message || msg;
    } catch(e) {}
    return { ok: false, error: msg, keyIndex: index };
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text.trim()) return { ok: false, error: 'Respons kosong dari Gemini', keyIndex: index };

  const usage = data.usageMetadata;
  if (usage) {
    console.log(`📊 [Token Usage] Prompt: ${usage.promptTokenCount} | Output: ${usage.candidatesTokenCount} | Total: ${usage.totalTokenCount}`);
  }

  return { ok: true, text: text.trim().replace(/^["'`]+|["'`]+$/g, '').trim(), keyIndex: index };
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

// ── Panggil Gemini dengan retry otomatis 3x per key, lalu rotasi key kalau masih gagal ──
async function aiReply(message, name, history, signal) {
  const MAX_RETRY = 3;          // percobaan per key sebelum dianggap "habis"/bermasalah
  const RETRY_DELAY_MS = 3000;
  const totalKeys = getApiKeys().filter(k => k && k.length >= 10).length;
  const MAX_KEY_SWITCH = Math.max(totalKeys, 1); // jangan berputar lebih dari jumlah key yang ada

  for (let keyTry = 1; keyTry <= MAX_KEY_SWITCH; keyTry++) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const result = await callGemini(message, name, history, signal);

        if (result.ok) return result.text;
        if (result.aborted) return null; // diam-diam berhenti jika dibatalkan

        if (result.fatal) {
          console.error('Gemini error (fatal):', result.error);
          return null;
        }

        lastError = result.error;
        console.error(`Gemini error [Key ${result.keyIndex + 1}] (percobaan ${attempt}/${MAX_RETRY}):`, result.error);

        if (attempt < MAX_RETRY) {
          console.log(`Mencoba ulang dalam ${RETRY_DELAY_MS / 1000} detik...`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        // Sudah 3x gagal pakai key ini -> lanjut ke rotasi key di bawah
      } catch(e) {
        lastError = e.message;
        console.error(`Gemini fetch error (percobaan ${attempt}/${MAX_RETRY}):`, e.message);
        if (attempt < MAX_RETRY) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
      }
    }

    // Sampai sini berarti key yang aktif sudah gagal MAX_RETRY kali (atau error non-retryable).
    // Kalau ini error quota/limit, atau memang sudah mentok retry - coba pindah ke key lain.
    if (keyTry < MAX_KEY_SWITCH) {
      const switched = rotateToNextKey();
      if (!switched) break; // gak ada key lain, berhenti
      console.log(`⏭️  Lanjut coba dengan Key ${activeKeyIndex + 1}...`);
    } else {
      console.error(`❌ Semua API key (${totalKeys}) sudah dicoba dan gagal. Terakhir:`, lastError);
    }
  }
  return null;
}

async function retryFailedMessages() {
  if (!settings.autoReply) return;
  const nowTime = Date.now();
  const failedEntries = messages.filter(m => !m.replied && (nowTime - new Date(m.timestamp).getTime() < 7200000));
  if (!failedEntries.length) return;

  console.log(`♻️ Mencoba membalas ulang ${failedEntries.length} pesan yang tertunda...`);
  
  for (const entry of failedEntries) {
    const prevTask = userLocks.get(entry.from) || Promise.resolve();
    const nextTask = prevTask.then(async () => {
      // Pastikan belum dibalas manual saat antre
      if (entry.replied) return;
      if (!isOpHour() || !isWhitelisted(entry.from)) return;

      const history = messages.filter(m => m.from === entry.from && m.id !== entry.id).slice(0, 8).reverse();
      let reply = await aiReply(entry.body, entry.senderName, history);
      
      if (reply) {
         reply = extractOrder(reply, entry.from);

         try { await sock.sendPresenceUpdate('composing', entry.from); } catch(e) {}
         await sleep(2000); 
         try { await sock.sendPresenceUpdate('paused', entry.from); } catch(e) {}
         
         let cleanReply = reply;
         const imgMatches = [...reply.matchAll(/\[KIRIM_GAMBAR:(.*?)\]/gi)];
         const productsToImage = [];
         for (const match of imgMatches) {
           productsToImage.push(match[1].trim());
           cleanReply = cleanReply.replace(match[0], '').trim();
         }

         await sock.sendMessage(entry.from, { text: cleanReply });
         
         for (const productToImage of productsToImage) {
           if (settings.productImages && settings.productImages[productToImage]) {
             for (const filename of settings.productImages[productToImage]) {
               if (filename) {
                  const imgPath = path.join(IMAGES_DIR, filename);
                  if (fs.existsSync(imgPath)) {
                    try {
                      const imgBuffer = fs.readFileSync(imgPath);
                      const ext = filename.split('.').pop().toLowerCase();
                      const mimetype = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
                      await sock.sendMessage(entry.from, { image: imgBuffer, mimetype: mimetype });
                    } catch(e) { console.error('Gagal kirim gambar retry:', e); }
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
      }
    }).catch(e => console.error('Retry error:', e.message));
    
    userLocks.set(entry.from, nextTask);
  }
}

async function initWA() {
  try {
    console.log('Menginisialisasi WhatsApp...');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const logger = pino({ level: 'silent' });

    // Catatan: versi default Baileys ternyata ditolak server WhatsApp (error 405,
    // QR tidak muncul sama sekali). Jadi kita pakai fetchLatestBaileysVersion()
    // lagi supaya koneksi diterima.
    //
    // Soal ikon "!" / "may be using old version" di Linked Devices (HP):
    // Ini BUKAN bug di kode ini. Baileys adalah client pihak ketiga (bukan WA
    // resmi), jadi WhatsApp selalu menandainya begitu meski versi protokol sudah
    // yang terbaru (lihat isLatest di log bawah). Tidak ada cara untuk
    // menghilangkan label ini selama pakai Baileys - fungsinya tetap normal.
    let version, isLatest;
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version;
      isLatest = v.isLatest;
      console.log(`WA Protocol Version: ${version.join('.')} (isLatest: ${isLatest})`);
    } catch(e) {
      console.log('Gagal ambil versi terbaru, pakai default bawaan library.');
    }

    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state, logger,
      printQRInTerminal: false,
      browser: ['Chrome (Linux)', 'Chrome', '128.0.0.0'],
      connectTimeoutMs: 60000,
      markOnlineOnConnect: true,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('QR siap! Silakan scan.');
        qrData = await qrcode.toDataURL(qr).catch(() => null);
        waStatus = 'waiting_qr';
        io.emit('qr', qrData);
        io.emit('status', waStatus);
      }
      if (connection === 'open') {
        console.log('✅ WhatsApp terhubung!');
        waStatus = 'connected'; qrData = null;
        io.emit('status', 'connected');
        io.emit('qr', null);
        
        // Coba ulang pesan yang gagal saat server baru connect
        setTimeout(retryFailedMessages, 3000);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log('WA terputus. Kode:', code);
        waStatus = 'disconnected'; qrData = null;
        io.emit('status', 'disconnected');
        if (code !== DisconnectReason?.loggedOut) {
          setTimeout(initWA, 5000);
        } else {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch(e) {}
          setTimeout(initWA, 3000);
        }
      }
    });

    // Proses satu "giliran" pelanggan (bisa gabungan beberapa bubble yang
    // dikirim berurutan dalam window debounce) lalu kirim balasan AI.
    async function processCustomerMessage(from, senderName, combinedBody, quotedMsg, allKeys) {
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
        id: Date.now(), from, senderName, body: combinedBody,
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

          try { await sock.readMessages(allKeys); } catch(e) {}

          // Fetch history here. Pesan sebelumnya yang batal terbalas akan terbaca di sini!
          const history = messages.filter(m => m.from === from && m.id !== entry.id).slice(0, 8).reverse();
          let reply = await aiReply(combinedBody, senderName, history, controller.signal);

          if (reply) {
            reply = extractOrder(reply, from);

            try { await sock.sendPresenceUpdate('composing', from); } catch(e) {}

            const minS = Math.max(0, Number(settings.replyDelayMin) ?? 15);
            const maxS = Math.max(minS, Number(settings.replyDelayMax) ?? 25);
            const delayMs = minS * 1000 + Math.random() * (maxS - minS) * 1000;
            
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
               entry.aiReply = '(Dibatalkan karena pesan susulan)';
               save(MSG_FILE, messages);
               return; 
            }

            try { await sock.sendPresenceUpdate('paused', from); } catch(e) {}

            // Hapus dari activeProcessing karena sudah mau dikirim
            activeProcessing.delete(from);

            // Cek tag [KIRIM_GAMBAR:Nama Produk]
            let cleanReply = reply;
            const imgMatches = [...reply.matchAll(/\[KIRIM_GAMBAR:(.*?)\]/gi)];
            const productsToImage = [];
            for (const match of imgMatches) {
              productsToImage.push(match[1].trim());
              cleanReply = cleanReply.replace(match[0], '').trim();
            }

            await sock.sendMessage(from, { text: cleanReply }, { quoted: quotedMsg });
            
            // Kirim gambar jika diminta dan tersedia
            for (const productToImage of productsToImage) {
              if (settings.productImages && settings.productImages[productToImage]) {
                for (const filename of settings.productImages[productToImage]) {
                  if (filename) {
                     const imgPath = path.join(IMAGES_DIR, filename);
                     if (fs.existsSync(imgPath)) {
                       try {
                         const imgBuffer = fs.readFileSync(imgPath);
                         const ext = filename.split('.').pop().toLowerCase();
                         const mimetype = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
                         await sock.sendMessage(from, { image: imgBuffer, mimetype: mimetype });
                       } catch(e) { console.error('Gagal kirim gambar:', e); }
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
               entry.aiReply = '(Dibatalkan karena pesan susulan)';
               save(MSG_FILE, messages);
            } else {
              console.log('⚠️ AI tidak membalas (cek error di atas atau quota)');
            }
          }
        }
      }).catch(e => {
        activeProcessing.delete(from);
        console.error('Error in user queue:', e);
      });

      userLocks.set(from, nextTask);
    }

    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
      if (type !== 'notify') return;
      for (const msg of msgs) {
        try {
          const from = msg.key.remoteJid;
          if (!from || from.endsWith('@g.us')) continue;

          if (msg.key.fromMe) {
            const entryToUpdate = messages.find(m => m.from === from && !m.replied);
            if (entryToUpdate) {
              entryToUpdate.replied = true;
              entryToUpdate.aiReply = '(Dibalas manual oleh Admin)';
              save(MSG_FILE, messages);
              io.emit('message_updated', entryToUpdate);
            }
            continue;
          }
          if (!msg.message) continue;

          let m = msg.message;
          if (m.ephemeralMessage) m = m.ephemeralMessage.message;
          if (m.viewOnceMessage) m = m.viewOnceMessage.message;
          if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;

          const body =
            m?.conversation ||
            m?.extendedTextMessage?.text ||
            m?.imageMessage?.caption ||
            m?.videoMessage?.caption || '';
            
          if (!body.trim()) continue;

          const senderName = msg.pushName || from.split('@')[0];
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

              try { await sock.sendMessage(from, { text: confirmText }); } catch(e) {}
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
            existing.quotedMsg = msg; // pakai pesan terakhir sebagai quoted reply
            existing.keys.push(msg.key);
          }
          const buffer = existing || { texts: [body], quotedMsg: msg, senderName, keys: [msg.key] };
          const debounceMs = Math.max(1, Number(settings.debounceSeconds) || 6) * 1000;
          buffer.timer = setTimeout(() => {
            pendingBuffers.delete(from);
            const combinedBody = buffer.texts.join('\n');
            processCustomerMessage(from, buffer.senderName, combinedBody, buffer.quotedMsg, buffer.keys)
              .catch(e => console.error('Msg error:', e.message));
          }, debounceMs);
          pendingBuffers.set(from, buffer);

        } catch(e) { console.error('Msg error:', e.message); }
      }
    });

  } catch(e) {
    console.error('Init error:', e.message);
    setTimeout(initWA, 5000);
  }
}

// ── API ──
app.get('/api/keystatus', (_, res) => {
  const keys = getApiKeys();
  res.json({
    filled: keys.map(k => !!(k && k.length >= 10)),
    activeIndex: activeKeyIndex,
  });
});

app.get('/api/status',   (_, res) => res.json({ status: waStatus }));
app.get('/api/qr',       (_, res) => res.json({ qr: qrData }));
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

  const { key, index } = getActiveKey();
  if (!key) return res.status(400).json({ error: 'Belum ada API key yang diisi' });

  const model = settings.modelName || 'gemini-2.5-flash';
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

app.post('/api/retry', (req, res) => {
  retryFailedMessages();
  res.json({ ok: true });
});

app.post('/api/savekey', (req, res) => {
  const { key1, key2, key3 } = req.body;
  if (!key1 && !key2 && !key3) return res.status(400).json({ error: 'Isi minimal 1 API key' });

  const envPath = path.join(__dirname, '.env');
  let env = '';
  try { env = fs.readFileSync(envPath, 'utf8'); } catch(e) {}

  const setEnvVar = (envStr, name, value) => {
    if (value === undefined) return envStr; // gak diisi di request -> jangan diubah
    const v = (value || '').trim();
    return envStr.includes(`${name}=`)
      ? envStr.replace(new RegExp(`${name}=.*`), `${name}=${v}`)
      : envStr + `\n${name}=${v}`;
  };

  env = setEnvVar(env, 'GEMINI_API_KEY_1', key1);
  env = setEnvVar(env, 'GEMINI_API_KEY_2', key2);
  env = setEnvVar(env, 'GEMINI_API_KEY_3', key3);
  fs.writeFileSync(envPath, env.trim() + '\n');

  if (key1 !== undefined) process.env.GEMINI_API_KEY_1 = (key1 || '').trim();
  if (key2 !== undefined) process.env.GEMINI_API_KEY_2 = (key2 || '').trim();
  if (key3 !== undefined) process.env.GEMINI_API_KEY_3 = (key3 || '').trim();

  activeKeyIndex = 0; // reset balik ke key1 tiap kali ada update key
  res.json({ ok: true });
});

// Test koneksi salah satu API key (slot 1/2/3) - berguna untuk debugging cepat
app.post('/api/testkey', async (req, res) => {
  const slot = Number(req.body?.slot) || 1; // 1, 2, atau 3
  const keys = getApiKeys();
  const key = keys[slot - 1];
  if (!key) return res.json({ ok: false, error: `Key ${slot} belum diisi` });
  try {
    const model = settings.modelName || 'gemini-2.5-flash';
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
  if (waStatus !== 'connected') return res.status(400).json({ error: 'WA belum terhubung' });
  try {
    await sock.sendMessage(number.replace(/\D/g, '') + '@s.whatsapp.net', { text: message });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', async (_, res) => {
  try { await sock?.logout(); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

io.on('connection', socket => {
  console.log('Browser terhubung ke dashboard');
  socket.emit('status', waStatus);
  if (qrData) socket.emit('qr', qrData);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log('\n==========================================');
  console.log('  WA AI Assistant berjalan!');
  console.log(`  Buka browser: http://localhost:${PORT}`);
  console.log('==========================================\n');
  await loadBaileys();
  initWA();
  
  // Jalankan pengecekan rutin pesan tertunda setiap 2 menit
  setInterval(retryFailedMessages, 2 * 60 * 1000);
});

process.on('uncaughtException',  e => console.error('Error:', e.message));
process.on('unhandledRejection', e => console.error('Rejection:', e?.message || e));
