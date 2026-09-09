/**
 * test-simulator.js
 * Simulator uji bot WA — jalankan langsung tanpa server aktif.
 *
 * Cara pakai:
 *   node test-simulator.js
 *
 * Butuh:
 *   - data/settings.json  (hasil export dari dashboard, wajib ada KB & Gemini key)
 *   - GEMINI_API_KEY di .env atau GEMINI_API_KEY_1 (kalau belum di settings)
 *
 * Output:
 *   - Log percakapan di terminal (warna-warni)
 *   - File hasil: test-results/sim-<timestamp>.json
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Load settings (sama persis dengan cara server.js load) ──────────────────
const SET_FILE = path.join(__dirname, 'data', 'settings.json');
const DEF_SETTINGS = {
  knowledgeBase: '',
  modelName: 'gemini-2.0-flash-lite',
  temperature: 0.7,
  persona: 'Kamu adalah asisten CS toko online yang ramah, sopan, dan helpful.',
  language: 'Indonesia',
};

let settings = { ...DEF_SETTINGS };
try {
  if (fs.existsSync(SET_FILE)) {
    settings = { ...DEF_SETTINGS, ...JSON.parse(fs.readFileSync(SET_FILE, 'utf8')) };
    console.log('✅ settings.json berhasil dimuat');
  } else {
    console.warn('⚠️  data/settings.json tidak ditemukan — pakai default kosong');
  }
} catch (e) {
  console.warn('⚠️  Gagal baca settings.json:', e.message);
}

// ─── Ambil Gemini key (sama dengan logika server.js) ─────────────────────────
function getGeminiKeys() {
  const keys = [];
  for (let i = 1; i <= 15; i++) {
    const val = process.env[`GEMINI_API_KEY_${i}`];
    if (val?.trim()) keys.push(val.trim());
  }
  if (keys.length === 0 && process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY.trim());
  return keys;
}

const geminiKeys = getGeminiKeys();
if (geminiKeys.length === 0) {
  console.error('❌  Tidak ada Gemini API key! Tambahkan GEMINI_API_KEY di .env atau di settings.json.');
  process.exit(1);
}

// ─── Copy fungsi-fungsi core dari server.js (tanpa Express/socket.io) ────────

function parseProductBlocks(kb) {
  if (!kb) return [];
  const blockRegex = /={3,}\s*(.*?)\s*={3,}([\s\S]*?)(?=={3,}|$)/g;
  const blocks = [];
  let m;
  while ((m = blockRegex.exec(kb)) !== null) {
    const name = m[1].trim();
    const text = m[0].trim();
    if (name) blocks.push({ name, text });
  }
  return blocks;
}

function getRelevantKnowledge(message, history = []) {
  const blocks = parseProductBlocks(settings.knowledgeBase);
  if (!blocks.length) return '';
  const recentHistoryText = history.slice(-3).map(h => `${h.body || ''} ${h.aiReply || ''}`).join(' ');
  const combinedText = (message + ' ' + recentHistoryText).toLowerCase();
  const matched = blocks.filter(b => {
    if (!b.name) return false;
    const words = b.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    return words.some(w => combinedText.includes(w));
  });
  const MAX_FALLBACK_BLOCKS = 5;
  const chosen = matched.length ? matched : blocks.slice(0, MAX_FALLBACK_BLOCKS);
  return chosen.map(b => b.text).join('\n\n');
}

function buildSystemPrompt(name, relevantKB, isFirstMessage) {
  // --- Copy PERSIS dari server.js (versi patched) ---
  const parts = [];
  parts.push(settings.persona || DEF_SETTINGS.persona);
  parts.push('');
  parts.push('=== IDENTITAS & BAHASA ===');
  parts.push(`- Bahasa: ${settings.language || 'Indonesia'}`);
  parts.push(`- Nada bicara: ${settings.tone || 'Santai'}`);
  parts.push(`- Nama customer saat ini: ${name}`);
  parts.push('');

  if (relevantKB) {
    parts.push('=== KNOWLEDGE BASE (INFORMASI PRODUK & TOKO) ===');
    parts.push(relevantKB);
    parts.push('');
  }

  parts.push('=== ATURAN MENJAWAB ===');
  parts.push('- Panggil customer dengan "Kak" atau nama mereka secara natural');
  parts.push('- Persona generik "admin"/"kami" — jangan sebut nama toko secara spesifik kecuali eksplisit ada di KB');
  parts.push('- Emoji: JARANG — maksimal 1 per balasan, dan hanya jika natural');
  parts.push('');

  parts.push('=== ATURAN CTA (CALL TO ACTION — WAJIB DI SEMUA BALASAN) ===');
  parts.push('- Setiap balasan WAJIB diakhiri dengan 1 pertanyaan atau ajakan yang mendorong ke langkah berikutnya');
  parts.push('- Termasuk balasan pertama (trigger iklan) — WAJIB ada CTA');
  parts.push('- Pilih SENDIRI pertanyaan yang paling relevan sesuai konteks saat itu — tidak ada urutan tahapan yang kaku (boleh langsung tanya warna, boleh langsung tanya alamat, tergantung mana yang paling pas)');
  parts.push('- MAKSIMAL 1 pertanyaan per balasan. Kalau isi balasanmu SUDAH secara natural mengandung 1 pertanyaan (misal "mau pilih warna apa Kak?"), JANGAN tambah pertanyaan CTA lagi di atasnya — itu sudah cukup');
  parts.push('- Kalau pelanggan sudah menunjukkan minat jelas (nanya harga/warna/detail) tapi belum kasih data pemesanan, boleh proaktif ajak closing, contoh: "Mau saya proses sekarang Kak?"');
  parts.push('');

  parts.push('=== PANJANG & GAYA BALASAN (PENTING) ===');
  parts.push('- Ikuti PROSEDUR MENJAWAB di atas sebagai aturan wajib, tapi jangan diulang kata-per-kata sebagai skrip di setiap balasan — sesuaikan redaksinya secara natural sesuai konteks pesan pelanggan saat itu');
  parts.push(isFirstMessage
    ? '- Ini kemungkinan pesan PERTAMA pelanggan di percakapan ini: boleh jelaskan 1-2 keunggulan utama produk secara singkat, maksimal 3-4 kalimat total. Boleh ada sapaan/basa-basi ramah singkat di awal sebelum masuk ke jawaban inti'
    : '- Ini BUKAN pesan pertama (sudah ada riwayat chat): JANGAN ulangi penjelasan keunggulan produk yang sudah dijelaskan sebelumnya. Jawab sesuai konteks — panjang balasan menyesuaikan kompleksitas pertanyaan, boleh ada basa-basi ramah singkat sebelum/sesudah jawaban inti (misal "Siap Kak!", "Tentu bisa~", "Senang bisa bantu!")');
  parts.push('- Kalau pelanggan hanya minta harga ("cek harga", "berapa", dll), jawab harga + 1 kalimat penutup/CTA saja. JANGAN ulang jelaskan keunggulan produk lagi kalau sudah pernah dijelaskan di riwayat chat sebelumnya');
  parts.push('- Panjang balasan: SEDANG — tidak perlu selalu sesingkat mungkin. Untuk pertanyaan sederhana boleh singkat; untuk yang butuh penjelasan boleh lebih panjang asal tidak bertele-tele. Natural dan tidak kaku');
  parts.push('');

  parts.push('=== TUGAS TAMBAHAN (EKSTRAKSI ORDER) ===');
  parts.push('- Begitu Nama, Alamat lengkap, dan No HP sudah lengkap terkumpul dari pelanggan: JANGAN langsung sisipkan [ORDER_DATA]. Balas dulu dengan MEREKAP pesanan (produk, jumlah, total harga, nama, alamat, No HP) dan minta konfirmasi eksplisit, contoh: "Baik Kak, saya konfirmasi ya: ... sudah benar semua?"');
  parts.push('- Order baru dianggap FINAL setelah pelanggan membalas mengonfirmasi (misal "ya", "benar", "betul", "oke fix"). BARU pada balasan konfirmasi tersebut kamu sisipkan blok data khusus di baris paling bawah balasanmu.');
  parts.push('- Kalau pesanan berisi LEBIH DARI 1 produk (order gabungan), jumlahkan semua ke dalam total harga saat merekap, dan tulis semua nama produk pada field "produk" (pisahkan dengan koma)');
  parts.push('Format blok data (harus valid JSON di dalam tag tersebut):');
  parts.push('[ORDER_DATA]{"nama": "Nama Lengkap", "hp": "No HP atau WA", "produk": "Nama Produk yang Dipesan", "alamat": "Alamat Lengkap"}[/ORDER_DATA]');
  parts.push('PENTING: Jangan menyertakan blok ini jika pelanggan hanya tanya-tanya, belum pasti memesan, atau belum eksplisit mengonfirmasi rekap pesanan.');
  parts.push('');

  parts.push('=== ATURAN NEGO HARGA ===');
  parts.push('- Reseller/grosir: tolak baik-baik, harga tetap sama untuk semua');
  parts.push('- Minta diskon: boleh kasih maksimal Rp10.000, kamu yang putuskan berikan atau tidak sesuai konteks (jangan langsung kasih tanpa pertimbangan)');
  parts.push('- Customer marah/sarkas: tetap sopan dan normal, jangan ikut terbawa emosi');
  parts.push('- Customer batal: terima langsung dengan ramah, JANGAN dibujuk balik');
  parts.push('');

  parts.push('=== ATURAN ESKALASI KE ADMIN (SANGAT PENTING — JANGAN MENGARANG) ===');
  parts.push('- Kalau ada pertanyaan yang jawabannya TIDAK EKSPLISIT tersedia di Knowledge Base di atas, JANGAN mengarang atau berasumsi. Sebaliknya, sisipkan tag eskalasi: [ESCALATE:NAMA_PRODUK:pertanyaan singkat]');
  parts.push('- Contoh: customer tanya "apakah ada garansi?" tapi KB tidak menyebut garansi → sisipkan [ESCALATE:Baby Walking Assistant:apakah ada garansi?]');
  parts.push('- Untuk pertanyaan non-produk (kebijakan toko, ongkir area tertentu, dll): [ESCALATE:UMUM:pertanyaan]');
  parts.push('- Kalau SELURUH balasanmu untuk pesan ini hanya berisi tag [ESCALATE], JANGAN tambahkan kalimat basa-basi apapun di luar tag itu (sistem akan menahan balasan ke pelanggan sampai admin menjawab)');
  parts.push('- Jika punya informasi PARSIAL (sebagian ada di KB, sebagian tidak): jawab bagian yang ada, lalu sisipkan tag eskalasi untuk bagian yang tidak ada');
  parts.push('- Jika punya informasi yang tidak ada di KB tapi sudah ditambahkan oleh admin sebelumnya di riwayat, gunakan informasi itu');
  parts.push('');

  parts.push('=== INFO UMUM TOKO ===');
  parts.push('Kalau tidak ada informasi spesifik di KB: gunakan [ESCALATE:UMUM:pertanyaan]');

  return parts.join('\n');
}

async function callGemini(message, name, history, systemPromptOverride) {
  const key = geminiKeys[0];
  const model = settings.modelName || 'gemini-2.0-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const contents = [];
  if (history?.length) {
    for (const h of history) {
      contents.push({ role: 'user', parts: [{ text: h.body }] });
      if (h.aiReply) contents.push({ role: 'model', parts: [{ text: h.aiReply }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const relevantKB = getRelevantKnowledge(message, history);
  const isFirstMessage = !history?.length;
  const sysPrompt = systemPromptOverride || buildSystemPrompt(name, relevantKB, isFirstMessage);

  const body = {
    contents,
    systemInstruction: { parts: [{ text: sysPrompt }] },
    generationConfig: { temperature: settings.temperature ?? 0.7 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return text.trim();
}

// ─── Skenario uji (diambil dari log chat nyata) ───────────────────────────────
// Format: { id, label, category, conversation: [{role:'customer'|'expected', text, checkFn?}] }
// checkFn opsional: fungsi yang dijalankan evaluator untuk cek konten spesifik

const SCENARIOS = [
  // ── KONTEN / AKURASI ────────────────────────────────────────────────────────
  {
    id: 'SC01',
    label: 'Tanya harga produk spesifik',
    category: 'konten',
    conversation: [
      { role: 'customer', text: 'Halo! Bisa minta info lebih lanjut tentang baby walking assistant?' },
      { role: 'customer', text: 'Harga berapa kak?' },
    ],
    checks: {
      harus_sebut_harga: true,
      harus_ada_cta: true,
    }
  },
  {
    id: 'SC02',
    label: 'Tanya multi-produk sekaligus',
    category: 'konten',
    conversation: [
      { role: 'customer', text: 'Kakak jual produk apa aja?' },
    ],
    checks: {
      harus_ada_cta: true,
      jangan_sebut_cuma_1_produk: true,
    }
  },
  {
    id: 'SC03',
    label: 'Tanya detail produk yang ada di KB',
    category: 'konten',
    conversation: [
      { role: 'customer', text: 'Halo! Bisa minta info lebih lanjut tentang selang flexibel?' },
      { role: 'customer', text: 'Tersedia ukuran berapa aja kak?' },
    ],
    checks: {
      harus_ada_cta: true,
    }
  },
  // ── GAYA BAHASA & TONE ──────────────────────────────────────────────────────
  {
    id: 'SC04',
    label: 'Pesan pertama — boleh basa-basi ramah',
    category: 'gaya',
    conversation: [
      { role: 'customer', text: 'Halo kak' },
    ],
    checks: {
      harus_ada_cta: true,
      bukan_jawaban_kosong: true,
    }
  },
  {
    id: 'SC05',
    label: 'Tanya harga saja — jangan panjang-panjang',
    category: 'gaya',
    conversation: [
      { role: 'customer', text: 'Halo! Bisa minta info lebih lanjut tentang baby walking assistant?' },
      { role: 'customer', text: 'Harga brp ka' },
    ],
    checks: {
      harus_sebut_harga: true,
      harus_singkat_untuk_tanya_harga: true,
    }
  },
  {
    id: 'SC06',
    label: 'Customer sarkas/tidak sopan — tetap sopan',
    category: 'gaya',
    conversation: [
      { role: 'customer', text: 'Halo! Bisa minta info lebih lanjut tentang selang flexibel?' },
      { role: 'customer', text: 'Satu aja GX bisa y' },
      { role: 'customer', text: 'Ooo kmu ketahuan?? Bohong nya 🤣' },
    ],
    checks: {
      harus_tetap_sopan: true,
    }
  },
  // ── EDGE CASE ───────────────────────────────────────────────────────────────
  {
    id: 'SC07',
    label: 'Nego harga — minta diskon',
    category: 'edge_case',
    conversation: [
      { role: 'customer', text: 'Halo! Bisa minta info lebih lanjut tentang baby walking assistant?' },
      { role: 'customer', text: 'Kirain 50 kak, bisa kurang gak?' },
    ],
    checks: {
      harus_ada_cta: true,
      jangan_langsung_kasih_diskon_besar: true,
    }
  },
  {
    id: 'SC08',
    label: 'Customer batal — terima langsung, jangan dibujuk',
    category: 'edge_case',
    conversation: [
      { role: 'customer', text: 'Halo! Bisa minta info lebih lanjut tentang selang flexibel?' },
      { role: 'customer', text: 'Maaf kemahalan, karena kami mau jual lagi mbak trim' },
    ],
    checks: {
      harus_terima_batal_dengan_baik: true,
      jangan_bujuk_balik: true,
    }
  },
  {
    id: 'SC09',
    label: 'Tanya detail yang tidak ada di KB — harus eskalasi',
    category: 'edge_case',
    conversation: [
      { role: 'customer', text: 'Halo! Bisa minta info lebih lanjut tentang baby walking assistant?' },
      { role: 'customer', text: 'Ada garansinya gak kak?' },
    ],
    checks: {
      harus_eskalasi_jika_tidak_ada_di_kb: true,
    }
  },
  {
    id: 'SC10',
    label: 'Order multi-produk — total gabungan',
    category: 'edge_case',
    conversation: [
      { role: 'customer', text: 'Halo, aku mau pesan baby walking assistant sama selang flexibel sekalian' },
      { role: 'customer', text: 'Nama saya Rosa, HP 081234567890, alamat Jl. Merdeka No 10 Kel. Sukamaju Kec. Cimahi Kota Bandung' },
      { role: 'customer', text: 'Ya betul semua kak' },
    ],
    checks: {
      harus_rekap_sebelum_order: true,
      harus_ada_cta: true,
    }
  },
];

// ─── Evaluator (Gemini sebagai juri) ─────────────────────────────────────────

async function evaluateReply(scenario, turn, customerMsg, botReply, checks) {
  const evalPrompt = `Kamu adalah evaluator kualitas chatbot CS toko online Indonesia.

Skenario uji: "${scenario.label}" (${scenario.category})
Pesan customer: "${customerMsg}"
Balasan bot: "${botReply}"

Kriteria yang perlu dievaluasi (sesuai skenario ini):
${JSON.stringify(checks, null, 2)}

Definisi kriteria:
- harus_sebut_harga: balasan harus menyebut angka harga spesifik (Rp...)
- harus_ada_cta: balasan harus diakhiri dengan pertanyaan atau ajakan ke langkah berikutnya
- jangan_sebut_cuma_1_produk: kalau ditanya "jual apa saja", jangan hanya sebutkan 1 produk
- bukan_jawaban_kosong: balasan bukan sekadar "ada yang bisa dibantu?" tanpa konten
- harus_singkat_untuk_tanya_harga: kalau customer HANYA tanya harga (pesan ke-2+), balasan tidak lebih dari 2-3 kalimat
- harus_tetap_sopan: balasan tidak ikut sarkastik atau defensif meskipun customer tidak sopan
- jangan_langsung_kasih_diskon_besar: bot tidak langsung kasih diskon >10rb tanpa pertimbangan
- harus_terima_batal_dengan_baik: bot menerima pembatalan dengan ramah
- jangan_bujuk_balik: bot tidak mencoba membujuk balik customer yang sudah batal
- harus_eskalasi_jika_tidak_ada_di_kb: kalau info tidak ada di KB, bot harus sisipkan tag [ESCALATE:...]
- harus_rekap_sebelum_order: sebelum order final, bot harus rekap semua detail dulu dan minta konfirmasi

Untuk setiap kriteria yang relevan (nilai true di JSON di atas), nilai apakah PASS atau FAIL.
Berikan juga skor keseluruhan 1-5 dan catatan singkat.

Balas HANYA dengan JSON valid ini (tidak ada teks lain):
{
  "kriteria": {
    "<nama_kriteria>": {"pass": true/false, "alasan": "singkat"}
  },
  "skor": <1-5>,
  "catatan": "ringkasan singkat dalam 1 kalimat"
}`;

  try {
    const result = await callGemini(evalPrompt, 'evaluator', [], '');
    const clean = result.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return { kriteria: {}, skor: 0, catatan: `Error evaluasi: ${e.message}` };
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  magenta: '\x1b[35m',
};
const c = (color, text) => `${COLORS[color]}${text}${COLORS.reset}`;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runSimulator() {
  console.log('\n' + c('bold', '═══════════════════════════════════════════════════════'));
  console.log(c('bold', '  🤖  WA Bot Simulator — Uji Otomatis Semua Skenario'));
  console.log(c('bold', '═══════════════════════════════════════════════════════') + '\n');

  const results = [];
  let totalPass = 0;
  let totalFail = 0;
  let totalChecks = 0;

  for (const scenario of SCENARIOS) {
    console.log(c('cyan', `\n┌─ [${scenario.id}] ${scenario.label}`));
    console.log(c('gray', `│  Kategori: ${scenario.category}`));

    const history = [];
    const scenarioResult = {
      id: scenario.id,
      label: scenario.label,
      category: scenario.category,
      turns: [],
      passCriteria: 0,
      failCriteria: 0,
      avgSkor: 0,
    };

    const turns = scenario.conversation;
    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t];
      const customerMsg = turn.text;

      console.log(c('gray', `│`));
      console.log(c('yellow', `│  👤 Customer: `) + customerMsg);

      let botReply = '';
      try {
        botReply = await callGemini(customerMsg, 'Kak Test', history);
      } catch (e) {
        botReply = `[ERROR: ${e.message}]`;
        console.log(c('red', `│  ❌ Error memanggil Gemini: ${e.message}`));
      }

      // Bersihkan tag internal dari tampilan
      const displayReply = botReply.replace(/\[ESCALATE:[^\]]*\]/g, c('magenta', '[ESKALASI]')).replace(/\[ORDER_DATA\][\s\S]*?\[\/ORDER_DATA\]/g, c('green', '[ORDER_DATA]'));
      console.log(c('green', `│  🤖 Bot: `) + displayReply);

      // Evaluasi hanya di turn terakhir skenario (balasan final yang dinilai)
      let evalResult = null;
      if (t === turns.length - 1 && Object.keys(scenario.checks).length > 0) {
        process.stdout.write(c('gray', '│  ⏳ Evaluasi...'));
        await sleep(800); // jeda kecil supaya tidak rate-limit
        evalResult = await evaluateReply(scenario, t, customerMsg, botReply, scenario.checks);
        process.stdout.write('\r');

        // Tampilkan hasil evaluasi
        console.log(c('gray', '│'));
        console.log(c('gray', '│  📊 Evaluasi:'));
        let pass = 0;
        let fail = 0;
        for (const [key, val] of Object.entries(evalResult.kriteria || {})) {
          const icon = val.pass ? c('green', '✅') : c('red', '❌');
          console.log(c('gray', '│    ') + `${icon} ${key}: ${c('gray', val.alasan)}`);
          if (val.pass) pass++; else fail++;
        }
        const skorColor = evalResult.skor >= 4 ? 'green' : evalResult.skor >= 3 ? 'yellow' : 'red';
        console.log(c('gray', '│    ') + `Skor: ${c(skorColor, String(evalResult.skor) + '/5')} — ${c('gray', evalResult.catatan)}`);

        totalPass += pass;
        totalFail += fail;
        totalChecks += (pass + fail);
      }

      scenarioResult.turns.push({
        customerMsg,
        botReply,
        evalResult,
      });

      // Update history untuk turn berikutnya
      history.push({ body: customerMsg, aiReply: botReply });

      if (t < turns.length - 1) await sleep(20000);
    }

    results.push(scenarioResult);
    console.log(c('cyan', `└─ Selesai`));
    await sleep(20000); // jeda antar skenario 20 detik
    
    // Hanya jalankan 2 skenario awal untuk uji cepat tanpa kena Rate Limit panjang
    if (results.length >= 2) break;
  }

  // ── RINGKASAN ────────────────────────────────────────────────────────────────
  console.log('\n' + c('bold', '═══════════════════════════════════════════════════════'));
  console.log(c('bold', '  📋  RINGKASAN HASIL'));
  console.log(c('bold', '═══════════════════════════════════════════════════════'));

  // Per kategori
  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { pass: 0, fail: 0, skor: [] };
    byCategory[r.category].pass += r.passCriteria;
    byCategory[r.category].fail += r.failCriteria;
    byCategory[r.category].skor.push(r.avgSkor);
  }

  for (const [cat, stat] of Object.entries(byCategory)) {
    const total = stat.pass + stat.fail;
    const pct = total ? Math.round((stat.pass / total) * 100) : 0;
    const avgSkor = stat.skor.length ? (stat.skor.reduce((a, b) => a + b, 0) / stat.skor.length).toFixed(1) : '-';
    const catColor = pct >= 80 ? 'green' : pct >= 60 ? 'yellow' : 'red';
    console.log(`  ${c(catColor, cat.toUpperCase().padEnd(15))} Pass: ${stat.pass}/${total} (${pct}%)  Rata-rata skor: ${avgSkor}/5`);
  }

  const globalPct = totalChecks ? Math.round((totalPass / totalChecks) * 100) : 0;
  const globalColor = globalPct >= 80 ? 'green' : globalPct >= 60 ? 'yellow' : 'red';
  console.log('');
  console.log(c('bold', `  TOTAL: ${c(globalColor, `${totalPass}/${totalChecks} kriteria PASS (${globalPct}%)`)}`));
  console.log('');

  // ── Simpan ke file ────────────────────────────────────────────────────────────
  const outDir = path.join(__dirname, 'test-results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, `sim-${ts}.json`);

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalPass,
      totalFail,
      totalChecks,
      passRate: `${globalPct}%`,
      byCategory: Object.fromEntries(
        Object.entries(byCategory).map(([cat, stat]) => [cat, {
          pass: stat.pass,
          total: stat.pass + stat.fail,
          passRate: `${stat.pass + stat.fail ? Math.round((stat.pass / (stat.pass + stat.fail)) * 100) : 0}%`,
          avgSkor: stat.skor.length ? (stat.skor.reduce((a, b) => a + b, 0) / stat.skor.length).toFixed(1) : '-',
        }])
      ),
    },
    scenarios: results,
  };

  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(c('gray', `  Laporan disimpan ke: ${outFile}`));
  console.log(c('bold', '\n═══════════════════════════════════════════════════════\n'));
}

runSimulator().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
