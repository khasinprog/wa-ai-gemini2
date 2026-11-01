/**
 * gemini-service.js — Gemini API logic extracted from server.js
 * Handles key management, API calls, retry logic, and request logging.
 */

'use strict';

const store  = require('./state-store');
const config = require('./config');
const path   = require('path');
const fs     = require('fs');

const { getRelevantKnowledge } = require('./knowledge-base');

// ── File paths ─────────────────────────────────────────────────────
const RAW_CAP_FILE = store.PATHS.RAW_CAP_FILE;

// ═══════════════════════════════════════════════════════════════════
// INTERNAL STATE
// ═══════════════════════════════════════════════════════════════════
let activeKeyIndex   = 0;
let apiKeyStates     = [];
let lastUsedKeyIndex = 0;

// ═══════════════════════════════════════════════════════════════════
// PROMPT RULES (step rules + draft rules)
// ═══════════════════════════════════════════════════════════════════

// ── Payment config (used in system prompt) ─────────────────────────
const PAYMENT = {
  bankName:      process.env.PAYMENT_BANK_NAME      || '',
  accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER || '',
  accountName:   process.env.PAYMENT_ACCOUNT_NAME   || '',
};

// ═══════════════════════════════════════════════════════════════════
// 1. getApiKeys
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// 2. getValidKeys
// ═══════════════════════════════════════════════════════════════════
function getValidKeys() {
  return getApiKeys()
    .map((k, i) => ({ key: k, slot: i }))
    .filter(x => x.key && x.key.length >= 10);
}

// ═══════════════════════════════════════════════════════════════════
// 3. getAvailableKey — round-robin with rate-limit state
// ═══════════════════════════════════════════════════════════════════
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
      return { key: validKeys[pos].key, slot: validKeys[pos].slot, pos };
    }
  }
  return null; // all keys exhausted
}

// ═══════════════════════════════════════════════════════════════════
// 4. markKeyLimited — mark key as limited (RPM or RPD)
// ═══════════════════════════════════════════════════════════════════
function markKeyLimited(pos, quotaId, retryDelaySec) {
  const state = apiKeyStates[pos];
  if (!state) return;

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
    state.status = 'WAITING_RPM';
    const delaySec = (typeof retryDelaySec === 'number' && !isNaN(retryDelaySec) && retryDelaySec > 0) ? retryDelaySec : 60;
    state.retry_at = Date.now() + delaySec * 1000;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5. computeKeyStatuses — status per key for dashboard
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// 6. emitKeyStatuses — emit via io
// ═══════════════════════════════════════════════════════════════════
function emitKeyStatuses() {
  store.io?.emit('key_status_update', { keys: computeKeyStatuses(), log: [] });
}

// ═══════════════════════════════════════════════════════════════════
// 7. getNextMidnightPT — next midnight Pacific Time
// ═══════════════════════════════════════════════════════════════════
function getNextMidnightPT() {
  const tz = 'America/Los_Angeles';
  const now = new Date();

  const todayPT = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const [y, m, d] = todayPT.split('-').map(Number);

  const guessUTC = Date.UTC(y, m - 1, d + 1, 0, 0, 0);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(guessUTC)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const ptReadingAsUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
  const offsetMs = guessUTC - ptReadingAsUTC;

  let target = guessUTC + offsetMs;
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000;
  return target;
}

// ═══════════════════════════════════════════════════════════════════
// 8. ensureKeyStates — ensure apiKeyStates array has n entries
// ═══════════════════════════════════════════════════════════════════
function ensureKeyStates(n) {
  while (apiKeyStates.length < n) apiKeyStates.push({ status: 'ON', retry_at: null });
  if (apiKeyStates.length > n) apiKeyStates.length = n;
}

// ═══════════════════════════════════════════════════════════════════
// 9. estimateTokens — rough token estimate
// ═══════════════════════════════════════════════════════════════════
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ═══════════════════════════════════════════════════════════════════
// 10. logGeminiRequest — log request/response + persistent capture
// ═══════════════════════════════════════════════════════════════════
function logGeminiRequest(direction, data) {
  const SEP = '═'.repeat(60);

  if (direction === 'request') {
    const { user, phone, systemPrompt, history, message, tokenEstimate } = data;
    const ts = new Date().toLocaleTimeString('id-ID');

    console.log(`\n${SEP}`);
    console.log(`📤 GEMINI REQUEST [${ts}] User: ${user} (${phone})`);
    console.log(SEP);

    // FULL SYSTEM PROMPT
    console.log(`\n┌─── SYSTEM PROMPT (${tokenEstimate?.system || '?'} tokens) ───`);
    const lines = (systemPrompt || '').split('\n');
    for (const line of lines) {
      if (line.startsWith('==='))  console.log(`│ 🔹 ${line}`);
      else if (line.startsWith('→'))  console.log(`│ ⚠️  ${line}`);
      else if (line.startsWith('STEP')) console.log(`│ 📌 ${line}`);
      else console.log(`│    ${line}`);
    }
    console.log(`└─── END SYSTEM PROMPT ───`);

    // HISTORY
    console.log(`\n┌─── HISTORY (${history?.length || 0} entries) ───`);
    (history || []).forEach((h) => {
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

    // CURRENT MESSAGE
    console.log(`\n┌─── CURRENT MESSAGE ───`);
    console.log(`│ 👤 "${message}"`);
    console.log(`└─── END MESSAGE ───`);

    // TOKEN ESTIMATE
    console.log(`\n📊 Tokens → System: ${tokenEstimate?.system || '?'} | History: ${tokenEstimate?.history || '?'} | Current: ${tokenEstimate?.current || '?'}`);
    console.log(SEP);

    // Capture request for test mode
    if (phone === store.TEST_PHONE) {
      store._capturedGeminiRequest = { systemPrompt, history, message, tokenEstimate };
    }
    // Persistent capture — all phones
    store.testRawCaptures.push({
      id: ++store._rawCaptureId,
      phone,
      systemPrompt,
      history,
      message,
      tokenEstimate,
      timestamp: new Date().toISOString(),
    });
    if (store.testRawCaptures.length > 200) store.testRawCaptures.splice(0, store.testRawCaptures.length - 200);
    store.save(RAW_CAP_FILE, store.testRawCaptures);
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

    // Capture response for test mode
    if (phone === store.TEST_PHONE && ok) {
      store._capturedGeminiResponse = { rawText: text, outputTokens, duration };
    }
    // Persistent capture — update last entry with response
    if (ok) {
      const lastCapture = store.testRawCaptures[store.testRawCaptures.length - 1];
      if (lastCapture && lastCapture.phone === phone) {
        lastCapture.rawGemini = text;
        lastCapture.outputTokens = outputTokens;
        lastCapture.duration = duration;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// BUILD SYSTEM PROMPT (All-in-One Master Prompt + Knowledge Base)
// ═══════════════════════════════════════════════════════════════════
function buildSystemPrompt(name, relevantKB, isFirstMessage, from, sentImagesForFrom) {
  const settings = store.settings;
  const masterPrompt = (settings.systemPrompt || store.DEFAULT_SYSTEM_PROMPT || '').trim();

  const parts = [masterPrompt];

  // Sisipkan Knowledge Base produk di bawah Master Prompt
  if (relevantKB?.trim()) {
    parts.push('\n\n=== INFORMASI PRODUK (KNOWLEDGE BASE) ===');
    parts.push(relevantKB.trim());
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 11. callGeminiDirect — full Gemini API call with multimodal support
// ═══════════════════════════════════════════════════════════════════
async function callGeminiDirect(key, keySlot, message, name, history, signal, from, imagePath, audioPath) {
  const startTime = Date.now();
  const settings = store.settings;
  const model = settings.modelName || config.DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // Build contents from history — kirim SEMUA history agar AI bisa baca konteks lengkap
  const contents = [];
  if (history?.length) {
    for (const h of history) {
      // Skip summary entries — they are appended to system prompt, not contents
      if (h._summary) continue;
      contents.push({ role: 'user', parts: [{ text: h.body }] });
      // B4: Skip cancelled/held replies so internal strings don't leak to Gemini context
      if (h.aiReply && !h.cancelledEntry && !h.heldReply) {
        contents.push({ role: 'model', parts: [{ text: h.aiReply }] });
      }
    }
  }

  // P2-B: Include image as multimodal inline_data
  const userParts = [];
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const imgBuffer = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).toLowerCase().replace('.', '');
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      const mime = mimeMap[ext] || 'image/jpeg';
      userParts.push({ inline_data: { mime_type: mime, data: imgBuffer.toString('base64') } });
      console.log(`[P2-B] Gambar disertakan ke Gemini: ${path.basename(imagePath)} (${Math.round(imgBuffer.length / 1024)}KB)`);
    } catch (e) {
      console.warn('[P2-B] Gagal baca gambar untuk Gemini:', e.message);
    }
  }

  // P2-B2: Include audio as multimodal inline_data
  if (audioPath && fs.existsSync(audioPath)) {
    try {
      const audioBuffer = fs.readFileSync(audioPath);
      const ext = path.extname(audioPath).toLowerCase().replace('.', '');
      const audioMime = ext === 'mp4' ? 'audio/mp4' : 'audio/ogg';
      userParts.push({ inline_data: { mime_type: audioMime, data: audioBuffer.toString('base64') } });
      console.log(`[P2-B2] Audio disertakan ke Gemini: ${path.basename(audioPath)} (${Math.round(audioBuffer.length / 1024)}KB)`);
    } catch (e) {
      console.warn('[P2-B2] Gagal baca audio untuk Gemini:', e.message);
    }
  }

  userParts.push({ text: message || '[customer mengirim pesan suara]' });
  contents.push({ role: 'user', parts: userParts });

  // Get relevant KB and build system prompt
  const relevantKB = getRelevantKnowledge(message, history);
  const isFirstMessage = !history?.length;
  const sentImagesForFrom = store.sentProductImages.get(from) || null;
  let systemPromptText = buildSystemPrompt(name, relevantKB, isFirstMessage, from, sentImagesForFrom);

  // Append summary from old conversations to system prompt
  const summaryEntry = history?.find(h => h._summary);
  if (summaryEntry) {
    systemPromptText += '\n\n=== RINGKASAN PERCAKAPAN SEBELUMNYA ===\n' + summaryEntry.summary;
  }

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPromptText }] },
    generationConfig: { temperature: settings.temperature ?? config.DEFAULT_TEMPERATURE },
  };

  // Log the request
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

  // Raw payload log
  const rawLog = {
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    systemInstruction: { parts: [{ text: systemPromptText }] },
    contents: contents.map(c => ({
      role: c.role,
      parts: c.parts.map(p => p.text ? { text: p.text } : { inline_data: { mime_type: p.inline_data?.mime_type, data: '[base64...]' } })
    })),
    generationConfig: body.generationConfig,
  };
  console.log(`\nRAW PAYLOAD KE GEMINI:`);
  console.log(JSON.stringify(rawLog, null, 2));
  console.log(`END RAW PAYLOAD\n`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: e.message };
  }

  // Handle error responses
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    let errData = null;
    try {
      errData = await res.json();
      msg = errData?.error?.message || msg;
    } catch (e) {}

    // 429 — Rate limit: parse quotaId and retryDelay
    if (res.status === 429) {
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
      } catch (e) {}
      return { ok: false, status429: true, quotaId, retryDelaySec, error: msg };
    }

    // 503 — Transient overload
    if (res.status === 503) {
      return { ok: false, status503: true, error: msg };
    }

    return { ok: false, error: msg };
  }

  // Parse successful response
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text.trim()) return { ok: false, error: 'Respons kosong dari Gemini' };

  const usage = data.usageMetadata;
  const duration = Date.now() - startTime;
  if (usage) {
    console.log(`[Token] Key ${keySlot + 1} | Prompt: ${usage.promptTokenCount} | Output: ${usage.candidatesTokenCount}`);
  }

  const cleanText = text.trim().replace(/^["'`]+|["'`]+$/g, '').trim();

  // Log the response
  logGeminiRequest('response', {
    ok: true,
    text: cleanText,
    duration,
    outputTokens: usage?.candidatesTokenCount || 0,
    phone: from,
  });

  return { ok: true, text: cleanText };
}

// ═══════════════════════════════════════════════════════════════════
// 12. callGeminiRaw — simple Gemini call for internal tasks
// ═══════════════════════════════════════════════════════════════════
async function callGeminiRaw(systemPrompt, userText) {
  const picked = getAvailableKey();
  if (!picked) return null;
  const model = store.settings.modelName || config.DEFAULT_MODEL;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': picked.key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.1 },
      }),
    });
    if (res.status === 429) {
      let errData = null;
      try { errData = await res.json(); } catch (e) {}
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
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// 13. aiReply — retry loop with key rotation
// ═══════════════════════════════════════════════════════════════════
async function aiReply(message, name, history, signal, from, imagePath, audioPath) {
  if (getValidKeys().length === 0) {
    console.error('Tidak ada API key yang valid di .env');
    return null;
  }

  const MAX_503_RETRIES = 3;
  const RETRY_503_DELAY_MS = 2000;
  let retry503Count = 0;
  const tried503Keys = new Set();

  while (true) {
    if (signal?.aborted) return null;

    const picked = getAvailableKey();
    if (!picked) {
      console.warn('Semua API key sedang kena limit -> pesan diqueue untuk retry');
      emitKeyStatuses();
      return null;
    }

    activeKeyIndex = picked.slot;
    emitKeyStatuses();
    console.log(`Mencoba Key ${picked.slot + 1}...`);

    const result = await callGeminiDirect(picked.key, picked.slot, message, name, history, signal, from, imagePath, audioPath);

    if (result.ok) {
      emitKeyStatuses();
      return result.text;
    }
    if (result.aborted) return null;

    // 429 — Rate limit hit: mark key as limited and try next key
    if (result.status429) {
      markKeyLimited(picked.pos, result.quotaId, result.retryDelaySec);
      const st = apiKeyStates[picked.pos];
      console.warn(`Key ${picked.slot + 1} kena limit (${result.quotaId || 'tidak diketahui'}) -> ${st.status}, retry_at=${new Date(st.retry_at).toISOString()}`);
      emitKeyStatuses();
      continue;
    }

    // 503 — Transient overload: try another key with short delay
    if (result.status503) {
      retry503Count++;
      tried503Keys.add(picked.pos);

      const totalKeys = getValidKeys().length;
      if (retry503Count >= MAX_503_RETRIES || tried503Keys.size >= totalKeys) {
        console.warn(`${retry503Count}x 503 "high demand" setelah coba ${tried503Keys.size} key -> pesan diqueue untuk retry`);
        emitKeyStatuses();
        return null;
      }

      lastUsedKeyIndex = (picked.pos + 1) % Math.max(totalKeys, 1);
      console.warn(`Key ${picked.slot + 1} 503 "high demand" -> skip, coba key lain (${retry503Count}/${MAX_503_RETRIES})`);
      emitKeyStatuses();
      await new Promise(r => setTimeout(r, RETRY_503_DELAY_MS));
      continue;
    }

    // Other errors: try another key
    retry503Count++;
    tried503Keys.add(picked.pos);
    const totalKeys = getValidKeys().length;

    if (retry503Count >= MAX_503_RETRIES || tried503Keys.size >= totalKeys) {
      console.error(`${retry503Count}x error setelah coba ${tried503Keys.size} key: ${result.error?.slice(0, 150)} -> pesan diqueue untuk retry`);
      emitKeyStatuses();
      return null;
    }

    lastUsedKeyIndex = (picked.pos + 1) % Math.max(totalKeys, 1);
    console.warn(`Key ${picked.slot + 1} error (${result.error?.slice(0, 80)}) -> skip, coba key lain (${retry503Count}/${MAX_503_RETRIES})`);
    emitKeyStatuses();
    await new Promise(r => setTimeout(r, RETRY_503_DELAY_MS));
    continue;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MODULE EXPORTS
// ═══════════════════════════════════════════════════════════════════
module.exports = {
  // Key management
  getApiKeys,
  getValidKeys,
  getAvailableKey,
  markKeyLimited,
  computeKeyStatuses,
  emitKeyStatuses,
  ensureKeyStates,
  getNextMidnightPT,

  // API calls
  callGeminiDirect,
  aiReply,
  callGeminiRaw,

  // Utilities
  estimateTokens,
  logGeminiRequest,

  // Internal state accessors (for server.js integration)
  get activeKeyIndex() { return activeKeyIndex; },
  set activeKeyIndex(v) { activeKeyIndex = v; },
  get lastUsedKeyIndex() { return lastUsedKeyIndex; },
  set lastUsedKeyIndex(v) { lastUsedKeyIndex = v; },
  get apiKeyStates() { return apiKeyStates; },
  set apiKeyStates(v) { apiKeyStates = v; },

  // Helpers exposed for other modules
  buildSystemPrompt,
};
