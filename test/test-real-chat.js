#!/usr/bin/env node
/**
 * Test Script: Simulasi percakapan REAL customer "Khafastore"
 *
 * Percakapan asli:
 *   1. "Kakak punya produk apa?"
 *   2. "Baby walking asistannya ada?"
 *   3. "Aku mau order ka"           ← AI hilang konteks di sini
 *   4. "Baby walking asistan"       ← customer harus ulang sendiri
 *   5. "Biru"
 *   6. "Cek ongkir nya dulu dong ke tamantirto, kasihan, bantul"
 *   7. "Tanyakan owner aku pengen tahu biaya kirim nya"
 *
 * Yang diuji:
 * - Turn 3: AI harus ingat sedang bahas Baby Walking, tidak tanya "produk apa?"
 * - Turn 4: TIDAK BOLEH terjadi (customer tidak perlu ulang)
 * - Turn 6-7: AI harus tahu sedang bahas Baby Walking + ongkir
 *
 * Cara pakai:
 *   node test-real-chat.js
 *   node test-real-chat.js --verbose
 */

require('dotenv').config();

// ── Load API keys ──────────────────────────────────────────────────
function getApiKeys() {
  const keys = [];
  for (let i = 1; i <= 20; i++) {
    const val = process.env[`GEMINI_API_KEY_${i}`];
    if (val && val.trim()) keys.push(val.trim());
  }
  if (keys.length === 0 && process.env.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY.trim());
  }
  return keys;
}

// ── Gemini API call ────────────────────────────────────────────────
async function callGemini(apiKey, message, history, systemPrompt) {
  const model = 'gemini-3.1-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const contents = [];
  if (history?.length) {
    for (const h of history.slice(-8)) {
      contents.push({ role: 'user', parts: [{ text: h.user }] });
      if (h.ai) contents.push({ role: 'model', parts: [{ text: h.ai }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.7 },
  };

  const startTime = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errData = await res.json();
        errMsg = errData?.error?.message || errMsg;
      } catch(e) {}
      return { ok: false, error: errMsg, status: res.status, duration: Date.now() - startTime };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const usage = data?.usageMetadata;

    return {
      ok: true,
      text: text.trim().replace(/^["'`]+|["'`]+$/g, '').trim(),
      promptTokens: usage?.promptTokenCount || 0,
      outputTokens: usage?.candidatesTokenCount || 0,
      duration: Date.now() - startTime,
    };
  } catch (e) {
    return { ok: false, error: e.message, duration: Date.now() - startTime };
  }
}

// ── System prompt (same as server) ─────────────────────────────────
const SYSTEM_PROMPT = `Kamu adalah asisten AI untuk toko online "Khafastore".
Kami menjual produk-produk berikut:
1. Baby Walking Assistant — Rp 95.000 (warna: biru muda, pink, abu-abu)
   Membantu bayi belajar berjalan dengan stabil.
2. Pasta Dempul Instan Tembok — harga bervariasi
   Untuk memperbaiki dinding berlubang/retak.

Aturan:
- Jawab dengan singkat, ramah, dan natural (gunakan "Kak" untuk memanggil customer)
- Jika customer tanya produk, sebutkan produk yang tersedia
- Jika customer tanya harga, sebutkan harga
- Jika customer mau order, tanyakan: nama, alamat lengkap, no HP, warna (jika Baby Walking)
- Jika customer tanya ongkir, cek ongkir ke alamat yang diberikan
- JANGAN ulangi penjelasan yang sama dua kali
- Jika customer menyebut produk yang sedang dibahas, JANGAN tanya lagi "produk apa?" — langsung lanjut
- Ingat konteks percakapan sebelumnya`;

// ── Real conversation turns ────────────────────────────────────────
const REAL_CONVERSATION = [
  {
    label: '1. Customer tanya produk',
    message: 'Kakak punya produk apa?',
    expect: ['baby walking', 'pasta dempul'],
    expectNot: [],
    critical: false,
    note: 'AI harus sebutkan produk yang tersedia',
  },
  {
    label: '2. Customer tanya Baby Walking',
    message: 'Baby walking asistannya ada?',
    expect: ['baby walking', 'ready', '95'],
    expectNot: [],
    critical: false,
    note: 'AI jawab produk ready + harga',
  },
  {
    label: '3. Customer mau order',
    message: 'Aku mau order ka',
    expect: ['nama', 'alamat'],
    expectNot: ['pasta dempul', 'produk apa', 'mana yang'],
    critical: true,
    note: '⚠️ INI MASALAH NYATA — AI harusnya langsung tahu customer mau order Baby Walking, jangan tanya "produk apa?"',
  },
  {
    label: '4. Customer ulang (SEHARUSNYA TIDAK PERLU)',
    message: 'Baby walking asistan',
    // Jika Turn 3 benar, Turn 4 ini seharusnya tidak perlu.
    // Tapi jika terjadi, AI harus langsung lanjut tanya data, tidak ulang deskripsi.
    expect: [],
    expectNot: ['membantu si kecil belajar', 'sangat membantu', 'produk ini ready'],
    critical: false,
    note: 'Jika AI sudah benar di Turn 3, customer tidak perlu ulang. Jika ulang, AI tidak boleh ulang deskripsi.',
    skipIfTurn3Passes: true,
  },
  {
    label: '5. Customer pilih warna',
    message: 'Biru',
    expect: [],
    expectNot: ['membantu si kecil belajar', 'sangat membantu', 'produk ini ready'],
    critical: false,
    note: 'AI catat warna, lanjut tanya data',
  },
  {
    label: '6. Customer tanya ongkir',
    message: 'Cek ongkir nya dulu dong ke tamantirto, kasihan, bantul',
    expect: ['ongkir', 'tamantirto'],
    expectNot: ['membantu si kecil belajar', 'sangat membantu', 'produk ini ready'],
    critical: true,
    note: '⚠️ AI harus tahu sedang bahas Baby Walking + cek ongkir ke alamat',
  },
  {
    label: '7. Customer minta tanya owner',
    message: 'Tanyakan owner aku pengen tahu biaya kirim nya',
    expect: [],
    expectNot: ['membantu si kecil belajar', 'sangat membantu', 'produk ini ready'],
    critical: false,
    note: 'AI harusnya tidak ulang deskripsi produk',
  },
];

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  const verbose = process.argv.includes('--verbose');
  const keys = getApiKeys();
  if (keys.length === 0) {
    console.error('❌ Tidak ada GEMINI_API_KEY yang ditemukan di .env');
    process.exit(1);
  }

  const apiKey = keys[0];
  console.log(`🔑 Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log(`🤖 Model: gemini-3.1-flash-lite`);
  console.log(`\n模拟 percakapan REAL customer "Khafastore"`);

  const history = [];
  const results = [];
  let turn3Passed = false;

  for (const turn of REAL_CONVERSATION) {
    // Skip Turn 4 if Turn 3 passed
    if (turn.skipIfTurn3Passes && turn3Passed) {
      console.log(`\n💬 ${turn.label}`);
      console.log(`   ⏭️  SKIP — Turn 3 sudah benar, customer tidak perlu ulang`);
      results.push({ ...turn, passed: true, skipped: true });
      continue;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`💬 ${turn.label}`);
    console.log(`   Customer: "${turn.message}"`);
    console.log(`   📝 ${turn.note}`);

    const res = await callGemini(apiKey, turn.message, history, SYSTEM_PROMPT);

    if (!res.ok) {
      console.log(`   ❌ ERROR: ${res.error} (${res.status || 'N/A'}) [${res.duration}ms]`);
      results.push({ ...turn, passed: false, error: res.error });
      continue;
    }

    console.log(`   AI: "${res.text}"`);
    console.log(`   📊 Tokens: ${res.promptTokens}+${res.outputTokens} [${res.duration}ms]`);

    // Check expectations
    const lowerReply = res.text.toLowerCase();
    let passed = true;
    let failures = [];

    if (turn.expect?.length) {
      for (const keyword of turn.expect) {
        if (!lowerReply.includes(keyword.toLowerCase())) {
          passed = false;
          failures.push(`missing "${keyword}"`);
        }
      }
    }

    if (turn.expectNot?.length) {
      for (const keyword of turn.expectNot) {
        if (lowerReply.includes(keyword.toLowerCase())) {
          passed = false;
          failures.push(`unexpected "${keyword}"`);
        }
      }
    }

    if (passed) {
      console.log(`   ✅ PASS`);
    } else {
      console.log(`   ❌ FAIL: ${failures.join(', ')}`);
    }

    if (turn.critical && !passed) {
      console.log(`   🚨 CRITICAL FAILURE — ini penyebab masalah di production!`);
    }

    results.push({ ...turn, passed, reply: res.text, failures });

    if (turn.label.includes('3.')) {
      turn3Passed = passed;
    }

    history.push({ user: turn.message, ai: res.text });

    if (verbose) {
      console.log(`   📜 History (${history.length} turns):`);
      for (const h of history) {
        console.log(`      👤 "${h.user.slice(0, 40)}"`);
        console.log(`      🤖 "${h.ai.slice(0, 40)}..."`);
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed && !r.skipped).length;
  const total = results.filter(r => !r.skipped).length;
  const criticals = results.filter(r => r.critical);
  const criticalPassed = criticals.filter(r => r.passed).length;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 HASIL TEST`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`   Total: ${passed}/${total} passed`);

  if (turn3Passed) {
    console.log(`   ✅ Turn 3 (order): AI INGAT konteks Baby Walking — tidak tanya "produk apa?" lagi`);
    console.log(`   ✅ Turn 4 (ulang): TIDAK PERLU — customer tidak perlu ulang`);
  } else {
    console.log(`   ❌ Turn 3 (order): AI HILANG KONTEKS — tanya "produk apa?" padahal sudah bahas Baby Walking`);
    console.log(`   ❌ Turn 4 (ulang): Customer HARUS ulang karena AI tidak ingat`);
    console.log(`   💡 Ini terjadi karena di production, 503 error menyebabkan entry.aiReply kosong`);
    console.log(`   💡 Fix 503 retry sudah di-deploy untuk mencegah ini`);
  }

  console.log(`\n   Critical tests: ${criticalPassed}/${criticals.length}`);

  if (criticals.some(r => !r.passed)) {
    console.log(`\n   🔴 Ada critical test yang gagal — ini masalah yang terjadi di production`);
  } else {
    console.log(`\n   🟢 Semua critical test passed — context retention OK`);
  }

  console.log(`${'═'.repeat(60)}`);
  process.exit(passed === total ? 0 : 1);
}

main();
