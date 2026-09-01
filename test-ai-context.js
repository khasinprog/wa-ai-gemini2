#!/usr/bin/env node
/**
 * Test Script: Simulasi percakapan customer → AI
 *
 * Tujuan:
 * 1. Test context retention (Baby Walking Assistant → order → tidak hilang konteks)
 * 2. Test respon tidak berulang
 * 3. Simulasi multi-turn conversation
 *
 * Cara pakai:
 *   node test-ai-context.js                    # test context retention
 *   node test-ai-context.js --turns 5          # test 5 turn conversation
 *   node test-ai-context.js --verbose          # show full history sent to Gemini
 */

require('dotenv').config();
const path = require('path');

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
  // Build conversation history (same format as server.js)
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

// ── System prompt (simplified version from server) ─────────────────
const SYSTEM_PROMPT = `Kamu adalah asisten AI untuk toko online baby organizer.
Jual produk: Baby Walking Assistant (Rp 95.000), diaper bag, dll.
Warna tersedia: biru muda, pink, abu-abu.

Aturan:
- Jawab dengan singkat dan ramah
- Jika customer tanya harga, sebutkan harga
- Jika customer mau order, tanyakan nama, alamat, no HP
- Jangan ulangi penjelasan yang sudah diberikan sebelumnya
- Jika ditanya tentang sesuatu yang sudah dijelaskan, referensikan jawaban sebelumnya`;

// ── Test Scenarios ─────────────────────────────────────────────────

const TEST_CONTEXT_RETENTION = {
  name: 'Context Retention Test',
  description: 'Test AI ingat percakapan sebelumnya (Baby Walking → Order)',
  turns: [
    {
      label: '1. Customer tanya produk',
      message: 'Baby walking asistannya ada?',
      expect: ['baby walking', '95', 'harga'],
      expectNot: ['tidak tahu', 'tidak ada'],
    },
    {
      label: '2. Customer tanya manfaat',
      message: 'Itu manfaatnya apa aja?',
      expect: ['manfaat'],
      expectNot: ['tidak tahu'],
      // Turn ini harusnya AI ingat sedang bahas Baby Walking Assistant
    },
    {
      label: '3. Customer mau order',
      message: 'Aku mau order ka',
      // AI harus tanya data diri (nama, alamat, HP) — tidak boleh ulang deskripsi produk
      expect: ['nama', 'alamat'],
      expectNot: ['manfaat', 'belajar berjalan'],  // tidak boleh ulang penjelasan manfaat
    },
    {
      label: '4. Customer kasih warna',
      message: 'Biru muda',
      // AI harus acknowledge warna dan lanjut proses (boleh bilang "baik" atau "biru")
      expect: [],
      expectNot: ['manfaat', 'belajar berjalan'],  // tidak boleh ulang penjelasan Baby Walking
    },
    {
      label: '5. Customer kasih data diri',
      message: 'Saya Andi, Jl Merdeka No 5, 08123456789',
      // AI harus konfirmasi order — sebut nama customer
      expect: ['andi'],
      expectNot: ['manfaat', 'belajar berjalan'],  // tidak boleh ulang penjelasan
    },
  ],
};

const TEST_REPEATED_ANSWER = {
  name: 'Repeated Answer Test',
  description: 'Test AI tidak mengulang jawaban yang sama',
  turns: [
    {
      label: '1. Tanya produk',
      message: 'Baby walking assistant ada?',
      expect: ['baby walking', '95'],
    },
    {
      label: '2. Tanya lagi hal sama',
      message: 'Yang baby walking itu berapa harganya?',
      expect: ['95'],
      expectNot: [], // AI boleh sebut harga lagi, tapi tidak boleh ulang deskripsi lengkap
      checkRepeat: true, // cek apakah jawaban terlalu mirip dengan turn 1
    },
    {
      label: '3. Tanya hal berbeda',
      message: 'Warna apa aja yang ada?',
      expect: ['biru', 'pink', 'abu'],
      expectNot: ['baby walking'],
    },
  ],
};

// ── Run Test ───────────────────────────────────────────────────────

async function runTest(scenario, apiKey, verbose) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📋 ${scenario.name}`);
  console.log(`   ${scenario.description}`);
  console.log(`${'═'.repeat(60)}`);

  const history = []; // { user, ai } format
  const results = [];
  let totalPrompt = 0, totalOutput = 0;

  for (const turn of scenario.turns) {
    console.log(`\n💬 ${turn.label}`);
    console.log(`   Customer: "${turn.message}"`);

    const res = await callGemini(apiKey, turn.message, history, SYSTEM_PROMPT);

    if (!res.ok) {
      console.log(`   ❌ ERROR: ${res.error} (${res.status || 'N/A'}) [${res.duration}ms]`);
      results.push({ ...turn, passed: false, error: res.error });
      continue;
    }

    console.log(`   AI: "${res.text}"`);
    console.log(`   📊 Tokens: ${res.promptTokens} prompt + ${res.outputTokens} output [${res.duration}ms]`);
    totalPrompt += res.promptTokens;
    totalOutput += res.outputTokens;

    // Check expectations
    const lowerReply = res.text.toLowerCase();
    let passed = true;
    let failures = [];

    // Check expect (should contain)
    if (turn.expect) {
      for (const keyword of turn.expect) {
        if (!lowerReply.includes(keyword.toLowerCase())) {
          passed = false;
          failures.push(`missing "${keyword}"`);
        }
      }
    }

    // Check expectNot (should NOT contain)
    if (turn.expectNot) {
      for (const keyword of turn.expectNot) {
        if (lowerReply.includes(keyword.toLowerCase())) {
          passed = false;
          failures.push(`unexpected "${keyword}"`);
        }
      }
    }

    // Check repeat (compare with previous turn's reply)
    if (turn.checkRepeat && history.length > 0) {
      const prevReply = history[history.length - 1].ai?.toLowerCase() || '';
      const similarity = calculateSimilarity(lowerReply, prevReply);
      if (similarity > 0.6) {
        passed = false;
        failures.push(`too similar to previous reply (${Math.round(similarity * 100)}%)`);
      }
    }

    if (passed) {
      console.log(`   ✅ PASS`);
    } else {
      console.log(`   ❌ FAIL: ${failures.join(', ')}`);
    }

    results.push({ ...turn, passed, reply: res.text, failures });

    // Add to history for next turn
    history.push({ user: turn.message, ai: res.text });

    if (verbose) {
      console.log(`   📜 History sent to Gemini (${history.length} turns):`);
      for (const h of history) {
        console.log(`      user: "${h.user.slice(0, 50)}..."`);
        console.log(`      ai:   "${h.ai.slice(0, 50)}..."`);
      }
    }
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 Summary: ${passed}/${total} passed`);
  console.log(`   Total tokens: ${totalPrompt} prompt + ${totalOutput} output`);

  return { passed, total, results };
}

// ── Similarity check ───────────────────────────────────────────────
function calculateSimilarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = a.split(/\s+/);
  const wordsB = b.split(/\s+/);
  const setB = new Set(wordsB);
  const overlap = wordsA.filter(w => setB.has(w)).length;
  return overlap / Math.max(wordsA.length, wordsB.length);
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const turnsArg = args.find(a => a.startsWith('--turns='));
  const specificTest = args.find(a => a === '--context' || a === '--repeat' || a === '--all');

  const keys = getApiKeys();
  if (keys.length === 0) {
    console.error('❌ Tidak ada GEMINI_API_KEY yang ditemukan di .env');
    process.exit(1);
  }

  const apiKey = keys[0];
  console.log(`🔑 Using Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log(`🤖 Model: gemini-3.1-flash-lite`);

  const scenarios = [];
  if (!specificTest || specificTest === '--all' || specificTest === '--context') {
    scenarios.push(TEST_CONTEXT_RETENTION);
  }
  if (!specificTest || specificTest === '--all' || specificTest === '--repeat') {
    scenarios.push(TEST_REPEATED_ANSWER);
  }

  let allPassed = 0, allTotal = 0;

  for (const scenario of scenarios) {
    const result = await runTest(scenario, apiKey, verbose);
    allPassed += result.passed;
    allTotal += result.total;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🏁 Final: ${allPassed}/${allTotal} tests passed`);
  console.log(`${'═'.repeat(60)}`);

  process.exit(allPassed === allTotal ? 0 : 1);
}

main();
