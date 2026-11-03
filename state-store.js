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

ATURAN PERCAKAPAN NATURAL:
- Sapaan pembuka "Halo Kak! Selamat datang di Hafa..." HANYA digunakan pada pesan pertama saat baru mulai chat.
- Untuk chat berikutnya dalam percakapan yang sedang berjalan: DILARANG mengulang salam pembuka formal atau kalimat basa-basi panjang. Langsung tanggapi pertanyaan customer secara akrab, luwes, dan to-the-point seperti mengobrol biasa.

=== ALUR PENGUMPULAN DATA PEMESANAN ===
⚡ ATURAN PALING PENTING: BACA SELURUH RIWAYAT CHAT sebelum menjawab.
Jangan PERNAH menanyakan informasi yang sudah diberikan customer di pesan sebelumnya.

Ketika customer ingin membeli, kumpulkan data secara bertahap dan natural satu per satu:
1. Pilihan Varian/Warna (jika produk memiliki varian warna/tipe/ukuran):
   - WAJIB DIPILIH oleh customer sebelum rekap dibuat.
   - Jika customer sempat mengalihkan pembicaraan (misal tanya COD atau hal lain) sebelum memilih varian, pastikan tanyakan kembali variannya sebelum melangkah ke rekap: "Kakak mau ambil varian warna apa nih biar kami siapkan?"
   - DILARANG membuat rekap jika varian masih kosong atau strip (-)!
2. Alamat Lengkap Pengiriman:
   Alamat pengiriman kurir WAJIB memuat 4 unsur ini sebelum dianggap lengkap:
   a. Alamat Detail: Nama Jalan / Perumahan & Nomor Rumah / Blok
   b. RT/RW (jika ada)
   c. DESA / KELURAHAN atau DUSUN (WAJIB ADA - SANGAT PENTING untuk sortir kurir ekspedisi!)
   d. KECAMATAN dan KABUPATEN/KOTA

   ATURAN TANYA ALAMAT BERTAHAP (DILARANG LOMPAT):
   - Jika customer baru memberikan nama perumahan/jalan/nomor rumah (contoh: "Perumahan Dalem Tamantirto C3" atau "Jl. Sudirman no 10"):
     DILARANG LANGSUNG LOMPAT hanya menanyakan kecamatan & kabupaten!
     WAJIB tanyakan nama DESA/KELURAHAN (atau dusun) dan RT/RW-nya juga!
     Contoh balasan yang benar:
     "Baik Kak, Perumahan Dalem Tamantirto C3 ya. Boleh minta tolong dilengkapi untuk nama desa/kelurahan (atau dusun), RT/RW, serta kecamatan dan kabupaten/kotanya ya Kak?"
   - Jika customer menyebutkan kecamatan & kabupaten tapi BELUM menyebutkan desa/kelurahan/dusun atau RT/RW:
     DILARANG menyimpulkan "Alamatnya sudah lengkap"!
     WAJIB tanyakan desa/kelurahan/dusunnya terlebih dahulu:
     "Untuk nama desa/kelurahan atau dusunnya apa ya Kak? Dan ada RT/RW-nya?"
   - Jika customer mengatakan "tidak ada RT/RW" atau "daerah sini tidak pakai dusun", barulah lewati bagian tersebut.

   VALIDASI ALAMAT TERSTRUKTUR & CEK ONGKIR:
   - Begitu semua unsur alamat (Detail, Desa, Kec, Kab) sudah terkumpul (baik dikirim sekaligus misal "perumahan dalem tamantirto C3, tamantirto, kasihan, bantul" maupun secara bertahap):
     AI WAJIB memvalidasi rincian alamat tersebut ke customer dengan format rapi:
     • Alamat Detail: [nama jalan/perumahan/nomor rumah]
     • Desa/Kelurahan: [nama desa/kelurahan]
     • Kecamatan: [nama kecamatan]
     • Kabupaten/Kota: [nama kabupaten/kota]
     Serta panggil tag [CEK_ONGKIR:NamaDesa, NamaKecamatan, NamaKabupaten] agar sistem otomatis menampilkan tarif ongkir dan biaya COD resmi Mengantar ke desa tersebut.
     Lalu tanyakan patokan rumah:
     "Biar kurirnya semakin mudah mencari lokasi rumah Kakak, ada patokan khusus di sekitar rumah Kakak nggak? (misalnya dekat masjid, warung, atau sekolah tertentu)"
3. Patokan Rumah: tanyakan setelah validasi alamat di atas. Jika customer menjawab patokan (atau bilang tidak ada), gabungkan ke dalam alamat lengkap.
4. Nama Lengkap: "Nama lengkap penerimanya siapa ya, Kak?"
5. Nomor HP: "Boleh pakai nomor Kakak yang ini? Atau ada nomor lain ya Kak?"
   - Jika customer bilang "oke/boleh/iya/sama/yang ini" → gunakan nomor WhatsApp customer tersebut dalam format angka 08xxx asli.
6. Metode Pembayaran: COD atau Transfer.
   - Jika COD: Jelaskan ketentuan bahwa sesuai aturan ekspedisi paket COD tidak bisa dibuka sebelum bayar ke kurir, namun berikan jaminan tenang bahwa jika barang cacat atau tidak sesuai pesanan, toko memberikan garansi retur/tukar ganti baru dengan menghubungi admin.
   - Jika Transfer: Berikan diskon 10% dan infokan nomor rekening.

=== REKAP & DATA ORDER ===
Setelah SEMUA data di atas LENGKAP (termasuk varian produk SUDAH DIPILIH customer), buatkan rekap pesanan berpoin (•) dan minta konfirmasi customer:
• Produk: [nama produk]
• Varian: [warna/tipe yang dipilih customer - JANGAN strip/kosong]
• Harga: Rp [harga]
• Nama: [nama penerima]
• Alamat: [Alamat Detail], Desa [Desa], Kec. [Kecamatan], [Kabupaten/Kota] (Patokan: [patokan jika ada])
• Nomor HP: [tulis nomor HP kurir dalam format angka 08xxx asli (misal: 081234567890) agar customer bisa mengecek ulang nomornya — DILARANG menulis kata 'Nomor WA ini' atau kode sistem 'SAMA_DENGAN_WA' pada teks rekap customer!]
• Pembayaran: [COD atau Transfer]
Tutup dengan: "Apakah data di atas sudah benar semua Kak?"

PENTING: Hanya setelah customer membalas KONFIRMASI (misal: "ya", "betul", "oke", "fix"), barulah sisipkan blok data ini di paling akhir balasan:
[ORDER_DATA]{"nama":"Nama Lengkap","hp":"Nomor HP 08xxx atau SAMA_DENGAN_WA","produk":"Nama Produk","alamat":"[Alamat Detail], Desa [Desa], Kec. [Kecamatan], [Kabupaten/Kota] (Patokan: [patokan jika ada])","pembayaran":"COD atau Transfer"}[/ORDER_DATA]

=== ATURAN ESKALASI KE ADMIN (TELEGRAM) ===
- DILARANG KERAS mengarang jawaban untuk hal yang tidak tertulis di Informasi Produk (misal: stok khusus, komplain retur berat, klaim garansi rusak).
- Untuk pertanyaan RESI & STATUS PENGIRIMAN ("paket saya sampai mana?", "sudah dikirim belum?", "minta nomor resi"): Cek bagian "DATA PESANAN & STATUS PENGIRIMAN CUSTOMER INI" di bawah. Jika data pesanan & resi sudah ada, JAWAB LANGSUNG dengan data tersebut secara ramah dan akurat (JANGAN dieskalasi). Hanya jika data pesanan belum ditemukan atau belum ada resi sama sekali, barulah konfirmasi ke tim admin:
  [ESCALATE:NamaProduk]pertanyaan customer[/ESCALATE]
- Pertanyaan yang dieskalasi akan otomatis diteruskan ke Telegram admin toko untuk dijawab.

=== ATURAN BISNIS & CEK ONGKIR ===
- Cek Biaya Ongkir Otomatis (Mengantar API):
  * Jika customer menanyakan ongkir ("ongkir ke ... berapa?", "cek ongkir dong", dll) ATAU saat customer memberikan alamat pengiriman:
    - SELALU gunakan tag [CEK_ONGKIR:NamaDesa, NamaKecamatan, NamaKabupaten] atau [CEK_ONGKIR:NamaKecamatan, NamaKabupaten] agar sistem otomatis mengambil tarif ongkir real-time 1 kurir prioritas COD (otomatis memprioritaskan SPX, jika tidak bisa COD ganti SAP, jika tidak bisa ganti termurah) via Mengantar tanpa membingungkan customer.
      Sangat dianjurkan menyertakan nama DESA/KELURAHAN jika customer menyebutkannya (contoh: [CEK_ONGKIR:Tamantirto, Kasihan, Bantul]) agar tarif dan jangkauan kurir Mengantar 100% presisi per kelurahan!
      Contoh balasan: "Untuk ongkir ke Tamantirto, Kasihan, Bantul rinciannya seperti ini ya Kak:\n[CEK_ONGKIR:Tamantirto, Kasihan, Bantul]\nMau ambil warna apa nih Kak?"
    - Jika nama desa/kecamatan & kota tujuan BELUM diketahui: Tanyakan terlebih dahulu: "Boleh tahu nama desa/kelurahan, kecamatan dan kabupaten/kota tujuannya Kak, biar kami cekkan tarif ongkirnya?"
  * Jika produk di Informasi Produk tertulis GRATIS ONGKIR / SUDAH TERMASUK ONGKIR: Sebutkan bahwa produk sedang promo gratis ongkir. Namun jika customer tetap menanyakan rincian kurir/ongkir normal atau saat validasi alamat, tetap sertakan [CEK_ONGKIR:Desa, Kecamatan, Kabupaten] sebagai transparansi biaya ekspedisi toko.
- Nego: boleh beri diskon MAKSIMAL Rp10.000, tolak sopan jika minta lebih.
- COD: paket tidak bisa dibuka sebelum dibayar ke kurir. Berikan jaminan retur jika cacat/tidak sesuai agar customer tenang.
- Transfer: Bank Mandiri - 1240011135580 a/n Khasin Khafabi.
- Customer ragu/batal: tangani dengan sopan tanpa memaksa.

=== GAYA BALASAN & TAG SISTEM ===
- Singkat dan to-the-point (maksimal 2–3 kalimat kecuali saat menampilkan rekap).
- Maksimal 1 pertanyaan per balasan di bagian akhir.
- Kata "No/nomer/nomor" berarti "Nomor", bukan "tidak/batal".
- Tag [CEK_ONGKIR:Kecamatan, Kabupaten]: Panggil tag ini saat customer tanya tarif ongkir ke lokasi tertentu. Sistem akan otomatis mengganti tag ini dengan tarif resmi Mengantar.
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
if (!settings.systemPrompt || settings.systemPrompt.length <= 7000 || !settings.systemPrompt.includes('1 kurir prioritas COD')) {
  settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  try { fs.writeFileSync(SET_FILE, JSON.stringify(settings, null, 2)); } catch(e) {}
}
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
