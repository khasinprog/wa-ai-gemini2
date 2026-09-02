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
const DELAY  = parseInt(process.env.DELAY || '30000', 10); // 30 detik
const DELAY_SHORT = 5000; // 5 detik untuk cek response

const TEST_FLOW = [
  { turn: 1,  msg: 'Halo kak ada pasta dempul?',        expect: 'Step 1 — produk dijelaskan' },
  { turn: 2,  msg: 'Harganya berapa?',                  expect: 'Step 1 — harga disebutkan' },
  { turn: 3,  msg: 'Ini 1 botol brpa gram',             expect: 'Step 2 — jawaban singkat (250 gram)' },
  { turn: 4,  msg: 'Iya ka',                            expect: 'Step 3 — tanya nama' },
  { turn: 5,  msg: 'Khasin',                            expect: 'Step 3 — verifikasi nama (1 kata)' },
  { turn: 6,  msg: 'Khasin Khafabi',                    expect: 'Step 3 — nama verified, tanya alamat' },
  { turn: 7,  msg: 'Tamantirto, Kasihan, Bantul',       expect: 'Step 3 — catat desa/kec/kota, tanya detail' },
  { turn: 8,  msg: 'Perum Dalem Tamantirto C3, RT 03/05', expect: 'Step 3 — catat RT/RW, tanya patokan' },
  { turn: 9,  msg: 'Deket masjid',                      expect: 'Step 3 — catat patokan, tanya HP' },
  { turn: 10, msg: 'Boleh pakai nomor ini aja',         expect: 'Step 3 → Step 4 — rekap semua data' },
  { turn: 11, msg: 'Iya',                               expect: 'Step 4 — [ORDER_DATA] terkirim' },
  { turn: 12, msg: 'Ini dikirim kapn',                  expect: 'Step 5 — eskalasi ke Telegram' },
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

function printTurn(turn, msg, response, expected) {
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
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTest() {
  console.log('═'.repeat(60));
  console.log('🧪 AUTOMATED TEST FLOW — WhatsApp AI');
  console.log('═'.repeat(60));
  console.log(`Server: ${SERVER}`);
  console.log(`Phone:  ${PHONE}`);
  console.log(`Delay:  ${DELAY / 1000} detik antar turn`);
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

    // Wait for AI to process
    console.log(`⏳ Menunggu ${DELAY / 1000} detik...`);
    await sleep(DELAY);

    // Check response
    const response = await getResponse();
    printTurn(turn.turn, turn.msg, response, turn.expect);

    const lastEntry = response?.last5?.[response.last5.length - 1];
    const hasReply = lastEntry?.aiReply && lastEntry.aiReply !== null;
    results.push({
      turn: turn.turn,
      status: hasReply ? 'OK' : 'NO_REPLY',
      reply: lastEntry?.aiReply?.slice(0, 100),
    });
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
