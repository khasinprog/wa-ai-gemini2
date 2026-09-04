#!/usr/bin/env node
/**
 * test-flow.js — Automated E2E test untuk WhatsApp AI
 *
 * Cara pakai:
 *   node test-flow.js                    # Run test flow
 *   node test-flow.js --phone 628xxx     # Nomor tujuan
 *   node test-flow.js --server 202.155.157.244
 *
 * Flow yang di-test:
 *   1. Tanya produk
 *   2. Tanya harga
 *   3. Tanya ukuran (follow-up)
 *   4. Konfirmasi mau order
 *   5. Kasih nama (1 kata — harus diverifikasi)
 *   6. Kasih nama lengkap
 *   7. Kasih alamat
 *   8. Detail alamat
 *   9. Konfirmasi HP
 *   10. Konfirmasi rekap
 *   11. Tanya estimasi kirim (eskalasi ke Telegram)
 */

const SERVER = process.env.SERVER || '202.155.157.244';
const PHONE  = process.env.PHONE  || '6281233350792'; // nomor test
const POLL_INTERVAL = 3000; // cek response tiap 3 detik
const MAX_WAIT = 180000; // IMP-4C: naikkan dari 120s ke 180s (Gemini bisa lambat)

const TEST_FLOW = [
  { turn: 1,  msg: 'Halo kak ada pasta dempul?',           expect: 'Step 1 — produk dijelaskan',              validate: r => /89|dempul|produk/i.test(r) },
  { turn: 2,  msg: 'Harganya berapa?',                     expect: 'Step 1 — harga disebutkan',               validate: r => /89|harga|rb|ribu/i.test(r) },
  { turn: 3,  msg: 'Ini 1 botol brpa gram',                expect: 'Step 2 — jawaban singkat (250 gram)',      validate: r => /250|gram/i.test(r) },
  { turn: 4,  msg: 'order dong kak',                      expect: 'Step 2→3 — tanya nama',                   validate: r => /nama|penerima/i.test(r) },
  { turn: 5,  msg: 'Khasin',                              expect: 'Step 3 — verifikasi nama (1 kata)',         validate: r => /nama\s+lengkap|lengkap|lengkapnya/i.test(r) },
  { turn: 6,  msg: 'Khasin Khafabi',                      expect: 'Step 3 — nama verified, tanya alamat',    validate: r => /alamat|desa|kecamatan/i.test(r) },
  { turn: 7,  msg: 'Tamantirto, Kasihan, Bantul',          expect: 'Step 3 — catat desa/kec/kota, tanya RT/RW', validate: r => /rt|rw/i.test(r) },
  { turn: 8,  msg: 'Perum Dalem Tamantirto C3, RT 03/05',  expect: 'Step 3 — catat RT/RW, tanya patokan',    validate: r => /patokan|dekat|landmark|warung|masjid/i.test(r) },
  { turn: 9,  msg: 'Deket masjid',                        expect: 'Step 3 — catat patokan, tanya HP',        validate: r => /hp|nomor|whatsapp|wa/i.test(r) },
  { turn: 10, msg: 'Boleh pakai nomor ini aja',           expect: 'Step 3 → Step 4 — rekap semua data',       validate: r => /konfirmasi|rekap|benar|khasin/i.test(r) },
  { turn: 11, msg: 'Iya',                                 expect: 'Step 4 — [ORDER_DATA] terkirim',           validate: r => /proses|siap|terima kasih/i.test(r) },
  { turn: 12, msg: 'Ini dikirim kapn',                    expect: 'Step 5 — eskalasi ke Telegram',            validate: r => /admin|tanyakan|sebentar/i.test(r) },
];

async function sendMessage(msg) {
  const payload = {
    sender: PHONE,
    message: msg,
    senderName: 'TestFlow',
  };

  try {
    const resp = await fetch(`http://${SERVER}/test/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    return data;
  } catch (e) {
    console.error(`❌ Gagal kirim: ${e.message}`);
    return null;
  }
}

async function getResponse() {
  try {
    const resp = await fetch(`http://${SERVER}/test/response/${PHONE}`);
    const data = await resp.json();
    return data;
  } catch (e) {
    console.error(`❌ Gagal baca response: ${e.message}`);
    return null;
  }
}

function printTurn(turn, msg, response, expected, validateFn) {
  const lastEntry = response?.last5?.[response.last5.length - 1];
  const aiReply = lastEntry?.aiReply || '(belum ada response)';
  const stepMatch = aiReply.match(/\[STEP=(\d)\]/);
  const step = stepMatch ? `Step ${stepMatch[1]}` : '-';

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`TURN ${turn}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`📤 Customer: "${msg}"`);
  console.log(`🤖 AI Reply: "${aiReply.slice(0, 200)}${aiReply.length > 200 ? '...' : ''}"`);
  console.log(`📋 Step detected: ${step}`);
  console.log(`📝 Expected: ${expected}`);

  // Quick check
  if (aiReply === '(belum ada response)' || aiReply === null) {
    console.log(`⚠️  BELUM ADA RESPONSE — AI belum selesai proses`);
  } else {
    console.log(`✅ Response diterima`);
    // IMP-4C: validasi konten jika ada validate function
    if (validateFn) {
      const valid = validateFn(aiReply);
      console.log(`${valid ? '✅' : '⚠️ '} Konten: ${valid ? 'VALID (sesuai ekspektasi)' : 'TIDAK SESUAI — cek manual'}`);
    }
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForResponse(maxWaitMs = MAX_WAIT) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const response = await getResponse();
    const lastEntry = response?.last5?.[response.last5.length - 1];
    if (lastEntry?.aiReply && lastEntry.aiReply !== null) {
      return response;
    }
    await sleep(POLL_INTERVAL);
  }
  return null;
}

async function runTest() {
  console.log('═'.repeat(60));
  console.log('🧪 AUTOMATED TEST FLOW — WhatsApp AI');
  console.log('═'.repeat(60));
  console.log(`Server: ${SERVER}`);
  console.log(`Phone:  ${PHONE}`);
  console.log(`Poll:   tiap ${POLL_INTERVAL / 1000} detik, max ${MAX_WAIT / 1000} detik per turn`);
  console.log(`Turns:  ${TEST_FLOW.length}`);
  console.log('═'.repeat(60));

  // Test connection
  console.log('\n🔌 Testing connection...');
  try {
    const resp = await fetch(`http://${SERVER}/test/response/${PHONE}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    console.log('✅ Server connected');
  } catch (e) {
    console.error(`❌ Cannot connect to server: ${e.message}`);
    console.error(`   Pastikan server berjalan di http://${SERVER}:3000`);
    process.exit(1);
  }

  const results = [];

  for (const turn of TEST_FLOW) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📤 SENDING Turn ${turn.turn}: "${turn.msg}"`);
    console.log(`${'═'.repeat(60)}`);

    // Send message
    const sendResult = await sendMessage(turn.msg);
    if (!sendResult?.ok) {
      console.log(`❌ Gagal kirim turn ${turn.turn}`);
      results.push({ turn: turn.turn, status: 'FAIL_SEND' });
      continue;
    }
    console.log(`✅ Pesan terkirim (${sendResult.entryId})`);

    // Poll for response (no fixed delay)
    console.log(`⏳ Menunggu response AI...`);
    const response = await waitForResponse();

    if (response) {
      printTurn(turn.turn, turn.msg, response, turn.expect, turn.validate);
      const lastEntry = response?.last5?.[response.last5.length - 1];
      const aiReply = lastEntry?.aiReply || '';
      const contentValid = turn.validate ? turn.validate(aiReply) : true;
      results.push({
        turn: turn.turn,
        status: contentValid ? 'OK' : 'CONTENT_MISMATCH',
        reply: lastEntry?.aiReply?.slice(0, 100),
      });
    } else {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`TURN ${turn.turn}`);
      console.log(`${'─'.repeat(60)}`);
      console.log(`📤 Customer: "${turn.msg}"`);
      console.log(`🤖 AI Reply: "(timeout — no response after ${MAX_WAIT / 1000}s)"`);
      console.log(`📝 Expected: ${turn.expect}`);
      console.log(`❌ TIMEOUT`);
      results.push({ turn: turn.turn, status: 'TIMEOUT' });
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 TEST SUMMARY');
  console.log('═'.repeat(60));
  const ok = results.filter(r => r.status === 'OK').length;
  const fail = results.filter(r => r.status !== 'OK').length;
  console.log(`✅ OK:    ${ok}/${results.length}`);
  console.log(`❌ FAIL:  ${fail}/${results.length}`);
  console.log('─'.repeat(60));
  for (const r of results) {
    const icon = r.status === 'OK' ? '✅' : '❌';
    console.log(`${icon} Turn ${r.turn}: ${r.status} ${r.reply ? `"${r.reply}..."` : ''}`);
  }
  console.log('═'.repeat(60));
}

// Parse args
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--server' && process.argv[i + 1]) {
    process.env.SERVER = process.argv[++i];
  }
  if (process.argv[i] === '--phone' && process.argv[i + 1]) {
    process.env.PHONE = process.argv[++i];
  }
  if (process.argv[i] === '--delay' && process.argv[i + 1]) {
    process.env.DELAY = process.argv[++i];
  }
}

runTest().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
