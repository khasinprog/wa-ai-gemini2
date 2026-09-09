#!/usr/bin/env node
/**
 * test-step-internal.js — Test internal step system tanpa kirim ke WA
 *
 * Cara pakai:
 *   node test-step-internal.js
 */

// ═══════════════════════════════════════════════════════════════════
// REPLICATE fungsi-fungsi dari server.js untuk testing internal
// ═══════════════════════════════════════════════════════════════════

const orderStates = new Map();
const messages = []; // simulasi messages array

function createOrderState(product) {
  return {
    step: 1, product, color: null,
    namaLengkap: null, namaVerified: false,
    dusun: null, desa: null, kecamatan: null, kota: null,
    rtRw: null, patokan: null, alamatLengkap: null,
    noHp: null, orderConfirmed: false, lastUpdate: Date.now(),
  };
}

function detectProductFocus(message) {
  const lower = message.toLowerCase();
  const products = {
    'pasta dempul': 'Pasta Dempul Instan Tembok',
    'baby walking': 'Baby Walking Assistant',
    'walking assistant': 'Baby Walking Assistant',
    'selang': 'Selang Kran Fleksibel 360°',
    'mini sealer': 'Mini Sealer Portable',
  };
  for (const [keyword, name] of Object.entries(products)) {
    if (lower.includes(keyword)) return name;
  }
  return null;
}

function looksLikeAddress(text) {
  return /jalan|jl|gang|rt|rw|desa|kecamatan|kota|kabupaten|dusun|rukeman|kampung/.test(text);
}

function looksLikeQuestion(text) {
  return /\?|harga|berapa|stok|warna|ukuran|manfaat|cara|kirim|tok/.test(text);
}

function getMissingFields(state) {
  const missing = [];
  if (!state.namaLengkap || !state.namaVerified) missing.push('nama lengkap');
  if (!state.desa)               missing.push('dusun/desa');
  if (!state.kecamatan)          missing.push('kecamatan');
  if (!state.kota)               missing.push('kota');
  if (!state.patokan)            missing.push('patokan');
  if (!state.rtRw)               missing.push('RT/RW');
  if (!state.noHp)               missing.push('nomor HP');
  return missing;
}

function extractCustomerFields(state, message) {
  const lower = message.toLowerCase().trim();
  const words = message.trim().split(/\s+/);

  // Guard: jangan extract kata-kata konfirmasi/generic
  const skipWords = /^(ya|y|oke|ok|baik|siap|betul|benar|sama|boleh|mantap|gas|proses|lanjut|fix|setuju|iya|noted|ok\s*ku|iya\s*ka|oke\s*ka|baik\s*ka|siap\s*ka|oke\s*kak|siap\s*kak|ya\s*ka|ya\s*kak|noted\s*ka|betul\s*ka|benar\s*ka|proses\s*ka|lanjut\s*ka|fix\s*ka|mantap\s*ka|gas\s*ka|setuju\s*ka|boleh\s*ka|sama\s*ka)$/;
  if (skipWords.test(lower)) return;

  // ── RT/RW "gak ada" — detect SEBELUM address parsing ──
  if (!state.rtRw && /\b(gak|nggak|ga|tidak)\s*(ada)?\b/i.test(lower)) {
    state.rtRw = '-';
  }

  // NAMA
  if (!state.namaLengkap || !state.namaVerified) {
    if (words.length >= 2 && !looksLikeAddress(lower) && !looksLikeQuestion(lower)) {
      state.namaLengkap = message.trim();
      state.namaVerified = true;
    } else if (words.length === 1 && !looksLikeAddress(lower) && !looksLikeQuestion(lower)) {
      if (!state.namaLengkap) {
        state.namaLengkap = message.trim();
        state.namaVerified = false;
      }
    }
  }

  // ALAMAT
  if (!state.desa || !state.kecamatan || !state.kota) {
    const rtMatch = message.match(/rt\s*(\d{1,3})\s*\/?\s*rw\s*(\d{1,3})/i);
    const addrRaw = rtMatch ? message.replace(/rt\s*\d+\s*\/?\s*rw\s*\d+/gi, '') : message;
    const parts = addrRaw.split(/[,\n]+/).map(p => p.trim()).filter(Boolean);

    if (parts.length === 2) {
      if (!state.desa) state.desa = parts[0];
      if (!state.kecamatan) state.kecamatan = parts[1];
    } else if (parts.length === 3) {
      if (!state.desa) state.desa = parts[0];
      if (!state.kecamatan) state.kecamatan = parts[1];
      if (!state.kota) state.kota = parts[2];
    } else if (parts.length >= 4) {
      if (!state.dusun && !/^\d/.test(parts[0])) state.dusun = parts[0];
      if (!state.desa) state.desa = parts[1];
      if (!state.kecamatan) state.kecamatan = parts[2];
      if (!state.kota) state.kota = parts[3];
    }
  }

  // RT/RW — handle "RT 03/RW 05", "RT 03/05", "rt03/rw05"
  if (!state.rtRw) {
    const rtMatch = message.match(/rt\s*(\d{1,3})\s*\/\s*(?:rw\s*)?(\d{1,3})/i);
    if (rtMatch) {
      state.rtRw = `RT ${rtMatch[1]}/RW ${rtMatch[2]}`;
    }
  }

  // PATOKAN
  if (!state.patokan) {
    const lowerClean = lower.replace(/rt\s*\d+\s*\/?\s*rw\s*\d+/gi, '').trim();
    if (
      lowerClean.length > 3 &&
      !/^\d{8,13}$/.test(lowerClean.replace(/\s/g, '')) &&
      !looksLikeAddress(lower) &&
      words.length >= 2
    ) {
      const patokanKeywords = ['dekat', 'deket', 'sebelah', 'samping', 'belakang', 'depan', 'sudut', 'ujung', 'masjid', 'sekolah', 'warung', 'jalan'];
      if (patokanKeywords.some(k => lowerClean.includes(k))) {
        state.patokan = message.trim();
      }
    }
  }
}

function updateOrderState(from, message) {
  let state = orderStates.get(from);
  const detectedProduct = detectProductFocus(message);
  const lower = message.toLowerCase().trim();

  if (detectedProduct && (!state || state.product !== detectedProduct)) {
    state = createOrderState(detectedProduct);
    orderStates.set(from, state);
  }

  if (!state) return null;

  const priorReplies = messages.filter(m => m.from === from && m.aiReply && !m.cancelledEntry).length;
  const prevStep = state.step;

  // ── Extract fields dulu (sebelum step transitions) ──
  if (state.step >= 3) {
    extractCustomerFields(state, message);
  }

  // HP auto-detect: "08xxxxxxxxxx"
  if (!state.noHp) {
    const phoneMatch = message.replace(/\s/g, '').match(/(08\d{8,12})/);
    if (phoneMatch) {
      state.noHp = phoneMatch[1];
    }
  }

  // ── Step transitions ──
  // Step 1→2
  if (state.step === 1 && priorReplies >= 1) {
    state.step = 2;
  }

  // Step 2→3
  const orderIntent = /\b(iya|mau|order|pesan|proses|ambil|fix|oke\s*(bayar|proses|lanjut)|setuju)\b/i;
  if (state.step === 2 && orderIntent.test(lower)) {
    state.step = 3;
  }

  // Step 3→4
  const confirmPattern = /^(ya|y|iya|oke|ok|betul|benar|siap|fix|setuju|sudah|lengkap|mantap|gas|proses)$/i;
  if (state.step === 3 && confirmPattern.test(lower)) {
    const missing = getMissingFields(state);
    if (missing.length === 0) {
      state.step = 4;
    }
  }

  // Step 3→5
  if ([3, 4].includes(state.step)) {
    const escKeywords = ['estimasi', 'berapa hari', 'stok', 'retur', 'garansi', 'komplain',
      'batal', 'gak jadi', 'kirim kapan', 'hari sampai', 'kurir sampai', 'kapan sampai'];
    const isEscalation = escKeywords.some(k => lower.includes(k));
    const isConfirm = confirmPattern.test(lower);
    if (isEscalation && !isConfirm) {
      state.step = 5;
    }
  }

  if (state.step !== prevStep) {
    console.log(`  📊 Step ${prevStep}→${state.step}`);
  }

  state.lastUpdate = Date.now();
  orderStates.set(from, state);
  return state;
}

// ═══════════════════════════════════════════════════════════════════
// TEST FLOW
// ═══════════════════════════════════════════════════════════════════

const PHONE = '6281233350792';

const TEST_FLOW = [
  { turn: 1,  msg: 'Halo kak ada pasta dempul?',                     expect: 'step=1, produk dipilih' },
  { turn: 2,  msg: 'Harganya berapa?',                               expect: 'step=2, follow-up' },
  { turn: 3,  msg: 'Ini 1 botol brpa gram',                          expect: 'step=2, detail' },
  { turn: 4,  msg: 'Iya ka',                                         expect: 'step=3, intent order' },
  { turn: 5,  msg: 'Khasin',                                         expect: 'step=3, nama 1 kata (unverified)' },
  { turn: 6,  msg: 'Khasin Khafabi',                                 expect: 'step=3, nama verified' },
  { turn: 7,  msg: 'Tamantirto, Kasihan, Bantul',                    expect: 'step=3, alamat 3 items' },
  { turn: 8,  msg: 'Perum Dalem Tamantirto C3, RT 03/05',            expect: 'step=3, alamat detail + RT/RW' },
  { turn: 9,  msg: 'Deket masjid',                                   expect: 'step=3, patokan' },
  { turn: 10, msg: '081234567890',                                   expect: 'step=3, HP terdeteksi' },
  { turn: 11, msg: 'Iya',                                            expect: 'step=4, konfirmasi' },
  { turn: 12, msg: 'Ini dikirim kapan',                              expect: 'step=5, eskalasi' },
];

function printState(state) {
  if (!state) return '  (null)';
  const f = [];
  if (state.namaLengkap) f.push(`nama=${state.namaLengkap}(${state.namaVerified ? 'V' : 'U'})`);
  if (state.desa) f.push(`desa=${state.desa}`);
  if (state.kecamatan) f.push(`kec=${state.kecamatan}`);
  if (state.kota) f.push(`kota=${state.kota}`);
  if (state.rtRw) f.push(`rtRw=${state.rtRw}`);
  if (state.patokan) f.push(`patokan=${state.patokan}`);
  if (state.noHp) f.push(`hp=${state.noHp}`);
  return f.length ? '  Fields: ' + f.join(', ') : '  Fields: (kosong)';
}

function runTest() {
  console.log('═'.repeat(60));
  console.log('🧪 INTERNAL TEST — Step System');
  console.log('═'.repeat(60));
  console.log(`Phone: ${PHONE}`);
  console.log(`Turns: ${TEST_FLOW.length}`);
  console.log('═'.repeat(60));

  const results = [];

  for (const turn of TEST_FLOW) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`TURN ${turn.turn}: "${turn.msg}"`);
    console.log(`${'─'.repeat(60)}`);

    // Simulasi: push reply SEBELUM updateOrderState (reply dari turn sebelumnya sudah ada)
    if (turn.turn > 1) {
      messages.push({
        from: PHONE,
        id: Date.now() + turn.turn - 1,
        body: TEST_FLOW[turn.turn - 2].msg,
        aiReply: `[simulated reply for turn ${turn.turn - 1}]`,
        replied: true,
        cancelledEntry: false,
        timestamp: new Date().toISOString(),
      });
    }

    // Simulasi: customer kirim pesan → updateOrderState
    const state = updateOrderState(PHONE, turn.msg);

    // Tampilkan hasil
    console.log(`  Step: ${state?.step || '-'}`);
    console.log(printState(state));
    console.log(`  Expected: ${turn.expect}`);

    // Validasi
    let pass = true;
    const actualStep = state?.step;
    if (turn.turn === 1 && actualStep !== 1) pass = false;
    if (turn.turn === 2 && actualStep !== 2) pass = false;
    if (turn.turn === 3 && actualStep !== 2) pass = false;
    if (turn.turn === 4 && actualStep !== 3) pass = false;
    if (turn.turn === 5 && actualStep !== 3) pass = false;
    if (turn.turn === 6 && actualStep !== 3) pass = false;
    if (turn.turn === 7 && actualStep !== 3) pass = false;
    if (turn.turn === 8 && actualStep !== 3) pass = false;
    if (turn.turn === 9 && actualStep !== 3) pass = false;
    if (turn.turn === 10 && actualStep !== 3) pass = false;
    if (turn.turn === 11 && actualStep !== 4) pass = false;
    if (turn.turn === 12 && actualStep !== 5) pass = false;

    // Extra checks
    if (turn.turn === 5 && state?.namaVerified !== false) { pass = false; console.log('  ❌ Nama harus unverified (1 kata)'); }
    if (turn.turn === 6 && state?.namaVerified !== true) { pass = false; console.log('  ❌ Nama harus verified (2 kata)'); }
    if (turn.turn === 6 && state?.namaLengkap !== 'Khasin Khafabi') { pass = false; console.log(`  ❌ Nama salah: ${state?.namaLengkap}`); }
    if (turn.turn === 7 && state?.desa !== 'Tamantirto') { pass = false; console.log(`  ❌ Desa salah: ${state?.desa}`); }
    if (turn.turn === 7 && state?.kecamatan !== 'Kasihan') { pass = false; console.log(`  ❌ Kecamatan salah: ${state?.kecamatan}`); }
    if (turn.turn === 7 && state?.kota !== 'Bantul') { pass = false; console.log(`  ❌ Kota salah: ${state?.kota}`); }
    if (turn.turn === 8 && state?.rtRw !== 'RT 03/RW 05') { pass = false; console.log(`  ❌ RT/RW salah: ${state?.rtRw}`); }
    if (turn.turn === 9 && state?.patokan !== 'Deket masjid') { pass = false; console.log(`  ❌ Patokan salah: ${state?.patokan}`); }
    if (turn.turn === 10 && state?.noHp !== '081234567890') { pass = false; console.log(`  ❌ HP salah: ${state?.noHp}`); }

    results.push({ turn: turn.turn, step: actualStep, pass });
    console.log(pass ? '  ✅ PASS' : '  ❌ FAIL');
  }

  // Summary
  const missing = getMissingFields(orderStates.get(PHONE));
  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 FINAL STATE');
  console.log('═'.repeat(60));
  const s = orderStates.get(PHONE);
  console.log(`Step: ${s?.step}`);
  console.log(`Product: ${s?.product}`);
  console.log(`Nama: ${s?.namaLengkap} (verified: ${s?.namaVerified})`);
  console.log(`Desa: ${s?.desa}`);
  console.log(`Kecamatan: ${s?.kecamatan}`);
  console.log(`Kota: ${s?.kota}`);
  console.log(`RT/RW: ${s?.rtRw}`);
  console.log(`Patokan: ${s?.patokan}`);
  console.log(`HP: ${s?.noHp}`);
  console.log(`Missing: ${missing.length ? missing.join(', ') : '(tidak ada)'}`);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 TEST SUMMARY');
  console.log('═'.repeat(60));
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`✅ PASS: ${passed}/${results.length}`);
  console.log(`❌ FAIL: ${failed}/${results.length}`);
  console.log('─'.repeat(60));
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} Turn ${r.turn}: step=${r.step}`);
  }
  console.log('═'.repeat(60));

  return failed;
}

// ═══════════════════════════════════════════════════════════════════
// TEST 2: "Gak ada RT/RW" scenario
// ═══════════════════════════════════════════════════════════════════
function runTestNoRtRw() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('🧪 TEST 2 — "Gak ada RT/RW" Scenario');
  console.log('═'.repeat(60));

  // Reset state
  orderStates.clear();
  messages.length = 0;

  const PHONE2 = '6281234567890';

  const FLOW = [
    { turn: 1,  msg: 'Pasta dempul ada?',        check: s => s?.step === 1 },
    { turn: 2,  msg: 'Beli 2',                   check: s => s?.step === 2 },
    { turn: 3,  msg: 'Mau',                      check: s => s?.step === 3 },
    { turn: 4,  msg: 'Budi Santoso',             check: s => s?.namaLengkap === 'Budi Santoso' },
    { turn: 5,  msg: 'Tamantirto, Kasihan, Bantul', check: s => s?.desa === 'Tamantirto' && s?.kecamatan === 'Kasihan' },
    { turn: 6,  msg: 'Gak ada rt/rw',            check: s => s?.rtRw === '-' },
    { turn: 7,  msg: 'Deket warung',             check: s => s?.patokan === 'Deket warung' },
    { turn: 8,  msg: '081234567890',             check: s => s?.noHp === '081234567890' },
    { turn: 9,  msg: 'Iya',                      check: s => s?.step === 4 },
  ];

  const results = [];
  for (const turn of FLOW) {
    // Push reply dari turn SEBELUMNYA (simulasi server真实行为)
    if (turn.turn > 1) {
      messages.push({ from: PHONE2, id: Date.now() + turn.turn - 1, body: FLOW[turn.turn - 2].msg, aiReply: '[sim]', replied: true, cancelledEntry: false });
    }
    const state = updateOrderState(PHONE2, turn.msg);
    const pass = turn.check(state);
    results.push({ turn: turn.turn, pass });
    console.log(`${pass ? '✅' : '❌'} Turn ${turn.turn}: "${turn.msg}" → rtRw=${state?.rtRw}, step=${state?.step}`);
  }

  const missing = getMissingFields(orderStates.get(PHONE2));
  console.log(`\nMissing: ${missing.length ? missing.join(', ') : '(tidak ada)'}`);
  const hasRtRwMissing = missing.includes('RT/RW');
  console.log(`RT/RW missing: ${hasRtRwMissing ? '❌ YA (seharusnya TIDAK)' : '✅ TIDAK (benar)'}`);

  const failed = results.filter(r => !r.pass).length + (hasRtRwMissing ? 1 : 0);
  console.log(`\n✅ PASS: ${results.length + 1 - failed}/${results.length + 1}`);
  console.log('═'.repeat(60));

  return failed;
}

const fail1 = runTest();
const fail2 = runTestNoRtRw();
process.exit(fail1 > 0 || fail2 > 0 ? 1 : 0);
