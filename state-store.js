/**
 * state-store.js — Centralized shared state
 * Semua in-memory state yang dipakai oleh multiple modules.
 * Modules cukup require('./state-store') untuk akses shared state.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const DATA_DIR  = path.join(__dirname, 'data');
const MSG_FILE  = path.join(DATA_DIR, 'messages.json');
const SET_FILE  = path.join(DATA_DIR, 'settings.json');
const ORDER_FILE = path.join(DATA_DIR, 'orders.json');
const ESC_FILE  = path.join(DATA_DIR, 'escalations.json');
const ORDER_STATE_FILE = path.join(__dirname, 'orderStates.json');
const RAW_CAP_FILE = path.join(DATA_DIR, 'test-raw-captures.json');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const AUDIO_DIR  = path.join(DATA_DIR, 'audio');

[DATA_DIR, IMAGES_DIR, AUDIO_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const DEFAULT_COURIER_PRIORITY = (process.env.COURIER_PRIORITY || 'J&T,iDexpress,JNE')
  .split(',').map(s => s.trim()).filter(Boolean);

const DEFAULT_SYSTEM_PROMPT = `=== IDENTITAS & PERAN ===
Kamu adalah CS Hafa, customer service resmi toko online kami.
Balas pesan WhatsApp customer dengan bahasa percakapan yang hangat, ramah, dan santai — seperti admin toko sungguhan, bukan robot.
Panggil customer "Kak". Perkenalkan diri sebagai "kami" atau "admin toko", JANGAN sebut nama persona lain dan JANGAN akui kamu AI kecuali ditanya langsung.

=== FORMULA JAWABAN STANDAR (2 LANGKAH) ===
Setiap membalas pesan customer, selalu ikuti 2 langkah ini:
1. JAWAB PERTANYAAN: Jawab apa yang ditanyakan customer secara singkat, jelas, dan akurat berdasarkan Informasi Produk.
2. ARAHKAN KE LANGKAH BERIKUTNYA: Selalu akhiri pesanmu dengan 1 pertanyaan terarah menuju pembelian (Call to Action).

=== ALUR PENGUMPULAN DATA PEMESANAN ===
⚡ ATURAN PALING PENTING: BACA SELURUH RIWAYAT CHAT sebelum menjawab.
Jangan PERNAH menanyakan informasi yang sudah diberikan customer di pesan sebelumnya.

Ketika customer ingin membeli, kumpulkan data secara bertahap dan natural satu per satu:
1. Pilihan Varian/Warna (jika produk memiliki varian warna/tipe).
2. Alamat Lengkap: nama jalan/perumahan, nomor rumah, RT/RW, desa/kelurahan, kecamatan, kabupaten/kota.
   - Jika customer beri sebagian, tanyakan hanya yang kurang.
   - Jika bilang "tidak ada nama jalan / RT-RW" → lewati ke field berikutnya.
3. Patokan Rumah: tanyakan setelah alamat terkumpul (dekat masjid, sekolah, atau warung apa).
4. Nama Lengkap: "Nama lengkap penerimanya siapa ya, Kak?"
5. Nomor HP: "Boleh pakai nomor Kakak yang ini? Atau ada nomor lain ya Kak?"
   - Jika customer bilang "oke/boleh/iya/sama" → langsung catat nomor ini, jangan tanya ulang.
6. Metode Pembayaran: COD atau Transfer.
   - Jika COD: Jelaskan ketentuan bahwa paket tidak bisa dibuka sebelum bayar kurir.
   - Jika Transfer: Berikan diskon 10% dan infokan nomor rekening.

=== REKAP & DATA ORDER ===
Setelah SEMUA data di atas lengkap, buatkan rekap pesanan berpoin (•) dan minta konfirmasi customer:
• Produk: [nama produk]
• Varian: [warna/tipe]
• Harga: Rp [harga]
• Nama: [nama penerima]
• Alamat: [alamat ringkas 1 baris termasuk patokan]
• Nomor HP: [nomor HP]
• Pembayaran: [COD atau Transfer]
Tutup dengan: "Apakah data di atas sudah benar semua Kak?"

PENTING: Hanya setelah customer membalas KONFIRMASI (misal: "ya", "betul", "oke", "fix"), barulah sisipkan blok data ini di paling akhir balasan:
[ORDER_DATA]{"nama":"Nama Lengkap","hp":"Nomor HP atau SAMA_DENGAN_WA","produk":"Nama Produk","alamat":"Alamat lengkap","pembayaran":"COD atau Transfer"}[/ORDER_DATA]

=== ATURAN ESKALASI KE ADMIN (TELEGRAM) ===
- DILARANG KERAS mengarang jawaban untuk hal yang tidak tertulis di Informasi Produk (misal: estimasi hari pasti sampai, tracking resi, stok khusus, komplain retur).
- Jika ada pertanyaan yang tidak ada di Informasi Produk: Jawab singkat bahwa kamu sedang mengonfirmasi ke tim admin, lalu sisipkan tag:
  [ESCALATE:NamaProduk]pertanyaan customer[/ESCALATE]
- Pertanyaan tersebut akan otomatis diteruskan ke Telegram admin toko untuk dijawab.

=== ATURAN BISNIS ===
- Harga SUDAH termasuk ongkir — jangan bilang ongkir belum termasuk.
- Nego: boleh beri diskon MAKSIMAL Rp10.000, tolak sopan jika minta lebih.
- COD: paket tidak bisa dibuka sebelum dibayar ke kurir.
- Transfer: Bank Mandiri - 1240011135580 a/n Khasin Khafabi.
- Customer ragu/batal: tangani dengan sopan tanpa memaksa.

=== GAYA BALASAN & TAG SISTEM ===
- Singkat dan to-the-point (maksimal 2–3 kalimat kecuali saat menampilkan rekap).
- Maksimal 1 pertanyaan per balasan di bagian akhir.
- Kata "No/nomer/nomor" berarti "Nomor", bukan "tidak/batal".
- Tag [KIRIM_GAMBAR:NamaProduk]: Tambahkan di akhir pesan ketika pertama kali menjelaskan produk agar sistem mengirim foto produk.
- Tag [SPLIT]: Pisahkan pesan jadi 2 bubble ketika produk pertama kali disebut.`;

const DEF = {
  autoReply: true,
  channel: 'cloudapi',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  persona: 'Kamu adalah asisten CS toko online yang ramah, sopan, dan helpful.',
  language: 'Indonesia',
  tone: 'Santai',
  opHours: { enabled: false, start: '08:00', end: '17:00' },
  whitelist: [],
  knowledgeBase: '',
  followUp: '',
  modelName: 'gemini-3.1-flash-lite',
  temperature: 0.7,
  adminNumber: process.env.ADMIN_WHATSAPP_NUMBER || '',
  debounceSeconds: 10,
  replyDelayMin: 10,
  replyDelayMax: 15,
  productImages: {},
  courierPriority: DEFAULT_COURIER_PRIORITY,
  stoppedChats: [],
  v2ResponseStyle: false,
};

// ── Load persisted state from files ──
let settings = { ...DEF };
let messages  = [];
let orders    = [];
let pendingEscalations = [];
let escalationCounter  = 1;

try {
  if (fs.existsSync(SET_FILE)) {
    settings = { ...DEF, ...JSON.parse(fs.readFileSync(SET_FILE, 'utf8')) };
  }
} catch(e) {}
if (!settings.systemPrompt) settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
try { if (fs.existsSync(MSG_FILE)) messages  = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); } catch(e) {}
try { if (fs.existsSync(ORDER_FILE)) orders  = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')); } catch(e) {}
try {
  if (fs.existsSync(ESC_FILE)) {
    const raw = JSON.parse(fs.readFileSync(ESC_FILE, 'utf8'));
    pendingEscalations = raw.items || [];
    escalationCounter  = raw.counter || 1;
  }
} catch(e) {}

// ── In-memory Maps & state ──
const orderStates = new Map();
const activeClaims = new Map();
const pendingBuffers = new Map();
const userLocks = new Map();
const activeProcessing = new Map();
const sentProductImages = new Map();
const processedWamids = [];
const processedWamidsSet = new Set();

// ── Test mode state ──
const testRawCaptures = [];
let _rawCaptureId = 0;
try {
  if (fs.existsSync(RAW_CAP_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(RAW_CAP_FILE, 'utf8'));
    testRawCaptures.push(...loaded);
    _rawCaptureId = testRawCaptures.length ? testRawCaptures[testRawCaptures.length - 1].id : 0;
  }
} catch(e) {}
const testTurns = [];
const TEST_PHONE = 'test_internal_0000';
let _capturedGeminiRequest = null;
let _capturedGeminiResponse = null;
let _prevTestStep = null;

// ── File paths (exported for modules) ──
const PATHS = { DATA_DIR, MSG_FILE, SET_FILE, ORDER_FILE, ESC_FILE, ORDER_STATE_FILE, RAW_CAP_FILE, IMAGES_DIR, AUDIO_DIR };

// ── DB Sync Helpers ──
const db = require('./db');
async function persistMessageToDB(msg) {
  if (!msg) return;
  try {
    await db.saveMessage(msg);
    const waId = msg.wa_id || msg.from;
    if (waId) await db.upsertContact(waId, msg.sender_name || msg.senderName || 'Unknown');
  } catch(e) { console.error('DB Msg Error:', e.message); }
}
async function persistOrderToDB(order) {
  if (!order) return;
  try { await db.saveOrder(order); } catch(e) { console.error('DB Order Error:', e.message); }
}

// ── File save helper (non-blocking) ──
const save = (file, data) => {
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFile(file, json, (err) => {
      if (err) {
        console.error(`Gagal menyimpan file ${path.basename(file)}:`, err.message);
        try { io?.emit('save_error', { file: path.basename(file), error: err.message }); } catch(e2) {}
      }
    });
  } catch(e) {
    console.error(`Gagal menyimpan file ${path.basename(file)}:`, e.message);
  }
};
const saveEscalations = () => save(ESC_FILE, { counter: escalationCounter, items: pendingEscalations });

// io will be set after server initializes Socket.io
let io = null;
function setIo(socketIo) { io = socketIo; }

module.exports = {
  // Defaults
  DEF, DEFAULT_COURIER_PRIORITY, DEFAULT_SYSTEM_PROMPT,
  // Paths
  PATHS,
  // Mutable state
  get settings() { return settings; },
  set settings(v) { settings = v; },
  get messages() { return messages; },
  set messages(v) { messages = v; },
  get orders() { return orders; },
  set orders(v) { orders = v; },
  get pendingEscalations() { return pendingEscalations; },
  set pendingEscalations(v) { pendingEscalations = v; },
  get escalationCounter() { return escalationCounter; },
  set escalationCounter(v) { escalationCounter = v; },
  // Maps
  orderStates, activeClaims, pendingBuffers, userLocks, activeProcessing, sentProductImages,
  // Dedup
  processedWamids, processedWamidsSet,
  // Test mode
  testRawCaptures, testTurns, TEST_PHONE,
  get _rawCaptureId() { return _rawCaptureId; },
  set _rawCaptureId(v) { _rawCaptureId = v; },
  get _capturedGeminiRequest() { return _capturedGeminiRequest; },
  set _capturedGeminiRequest(v) { _capturedGeminiRequest = v; },
  get _capturedGeminiResponse() { return _capturedGeminiResponse; },
  set _capturedGeminiResponse(v) { _capturedGeminiResponse = v; },
  get _prevTestStep() { return _prevTestStep; },
  set _prevTestStep(v) { _prevTestStep = v; },
  // Helpers
  save, saveEscalations, persistMessageToDB, persistOrderToDB,
  // Socket.io
  get io() { return io; },
  setIo,
};
