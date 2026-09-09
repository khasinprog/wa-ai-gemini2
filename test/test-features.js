'use strict';
/**
 * test-features.js — Test semua fitur F1-F5 (offline, tanpa server/DB)
 * Jalankan: node test-features.js
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const results = [];

function ok(label, value) {
  const s = value ? '\u2705' : '\u274c';
  console.log(s + ' ' + label);
  results.push({ label, ok: !!value });
  if (value) passed++; else failed++;
}
function section(t) {
  console.log('\n' + '\u2500'.repeat(56));
  console.log('  ' + t);
  console.log('\u2500'.repeat(56));
}

;(async () => {

// ─ F1: Payment & Kurir Config ─────────────────────────────────────
section('F1 \u2014 Payment & Kurir Config');
ok('ENV: PAYMENT_BANK_NAME ada',         !!process.env.PAYMENT_BANK_NAME);
ok('ENV: PAYMENT_ACCOUNT_NUMBER ada',    !!process.env.PAYMENT_ACCOUNT_NUMBER);
ok('ENV: PAYMENT_ACCOUNT_NAME ada',      !!process.env.PAYMENT_ACCOUNT_NAME);
ok('ENV: TRANSFER_DISCOUNT_PERCENT ada', !!process.env.TRANSFER_DISCOUNT_PERCENT);
ok('ENV: COURIER_PRIORITY ada',          !!process.env.COURIER_PRIORITY);

const couriers = (process.env.COURIER_PRIORITY || '').split(',').map(s => s.trim()).filter(Boolean);
ok('COURIER_PRIORITY minimal 1 kurir',   couriers.length >= 1);
ok('J&T ada di COURIER_PRIORITY',        couriers.some(c => /j.?t/i.test(c)));

// ORDER_DATA payment field parsing
const orderRaw = '{"nama":"Budi","hp":"081234","produk":"Baby Walker","alamat":"Jl. A","pembayaran":"Transfer"}';
const orderObj = JSON.parse(orderRaw);
ok('ORDER_DATA: field pembayaran terbaca',   !!orderObj.pembayaran);
ok('ORDER_DATA: pembayaran=Transfer',        orderObj.pembayaran === 'Transfer');

const payMethod = orderObj.pembayaran?.toLowerCase().includes('transfer') ? 'Transfer'
                : orderObj.pembayaran?.toLowerCase().includes('cod') ? 'COD' : null;
ok('ORDER_DATA: mapping ke Transfer/COD',    payMethod === 'Transfer');

// server.js constants check
const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
ok('server.js: PAYMENT objek dari ENV',         srv.includes('PAYMENT_BANK_NAME'));
ok('server.js: DEFAULT_COURIER_PRIORITY',       srv.includes('DEFAULT_COURIER_PRIORITY'));
ok('server.js: scheduler require',              srv.includes("require('./followup-scheduler')"));

// ─ F2: BUKTI_TRANSFER ─────────────────────────────────────────────
section('F2 \u2014 BUKTI_TRANSFER Tag');
const r2 = '[BUKTI_TRANSFER] Bukti sudah kami terima Kak 🙏';
ok('F2: detect [BUKTI_TRANSFER]',              r2.includes('[BUKTI_TRANSFER]'));
const c2 = r2.replace(/\[BUKTI_TRANSFER\]/gi, '').trim();
ok('F2: tag dihapus dari reply',               !c2.includes('[BUKTI_TRANSFER]'));
ok('F2: teks balasan tersisa setelah strip',   c2.length > 5);

ok('F2: prompt ATURAN BUKTI TRANSFER ada',     srv.includes('=== ATURAN BUKTI TRANSFER ==='));
ok('F2: pipeline parse [BUKTI_TRANSFER]',      srv.includes("cleanReply.includes('[BUKTI_TRANSFER]')"));
ok('F2: call tg.sendTransferProof()',          srv.includes('tg.sendTransferProof('));
ok('F2: boot: tg.onTransferApproved handler',  srv.includes('tg.onTransferApproved('));
ok('F2: boot: kirim WA saat approved',         srv.includes('Transfer approved \u2192 konfirmasi WA'));

let tg;
try {
  tg = require('./telegram-service');
  ok('F2: telegram-service bisa di-require',   true);
  ok('F2: sendTransferProof diekspor',          typeof tg.sendTransferProof === 'function');
  ok('F2: onTransferApproved diekspor',         typeof tg.onTransferApproved === 'function');
  ok('F2: isConfigured diekspor',               typeof tg.isConfigured === 'function');
  ok('F5: sendClaimAlert diekspor',             typeof tg.sendClaimAlert === 'function');
} catch(e) {
  ok('F2: telegram-service bisa di-require (ERROR: ' + e.message.slice(0,40) + ')', false);
}

// ─ F3: followup-scheduler ─────────────────────────────────────────
section('F3 \u2014 Follow-up Scheduler');
let sch;
try {
  sch = require('./followup-scheduler');
  ok('F3: followup-scheduler.js di-require',   true);
  ok('F3: schedule() diekspor',                typeof sch.schedule === 'function');
  ok('F3: cancel() diekspor',                  typeof sch.cancel === 'function');
  ok('F3: cancelAll() diekspor',               typeof sch.cancelAll === 'function');
  ok('F3: isActive() diekspor',                typeof sch.isActive === 'function');
  ok('F3: activeCount() diekspor',             typeof sch.activeCount === 'function');

  const FROM = '6281234@s.whatsapp.net';
  ok('F3: activeCount awal = 0',               sch.activeCount() === 0);

  sch.schedule(FROM, 'transfer', 60000, async () => {});
  ok('F3: isActive = true setelah schedule',   sch.isActive(FROM, 'transfer'));
  ok('F3: activeCount = 1',                    sch.activeCount() === 1);

  sch.cancel(FROM, 'transfer');
  ok('F3: isActive = false setelah cancel',    !sch.isActive(FROM, 'transfer'));
  ok('F3: activeCount = 0 setelah cancel',     sch.activeCount() === 0);

  sch.schedule(FROM, 'transfer', 60000, async () => {});
  sch.schedule(FROM, 'summary', 60000, async () => {});
  ok('F3: activeCount = 2 setelah 2 schedule', sch.activeCount() === 2);
  sch.cancelAll(FROM);
  ok('F3: activeCount = 0 setelah cancelAll',  sch.activeCount() === 0);

  // Test timer fires
  let fired = false;
  sch.schedule(FROM, 'ghost', 80, async () => { fired = true; });
  await new Promise(r => setTimeout(r, 200));
  ok('F3: timer fires setelah delay',          fired === true);
  ok('F3: timer auto-removed setelah fire',    !sch.isActive(FROM, 'ghost'));

} catch(e) {
  ok('F3: followup-scheduler ERROR: ' + e.message.slice(0,50), false);
}

ok('F3: prompt ATURAN FOLLOW-UP ada',          srv.includes('=== ATURAN FOLLOW-UP CUSTOMER'));
ok('F3: cancel transfer saat pesan baru',       srv.includes("scheduler.cancel(from, 'transfer')"));
ok('F3: schedule transfer 3 jam',               srv.includes('3 * 60 * 60 * 1000'));
ok('F3: set cold_lead saat timer habis',        srv.includes("cold_lead: true"));

// DB cold_lead
const db = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
ok('F3: DB cold_lead di schema',               db.includes('cold_lead BOOLEAN DEFAULT FALSE'));
ok('F3: DB ALTER TABLE cold_lead migration',   db.includes('ADD COLUMN IF NOT EXISTS cold_lead'));
ok('F3: DB cold_lead di allowed update',       db.includes("'cold_lead'"));

// ─ F4: DELAY_SUMMARY & buildOrderSummary ─────────────────────────
section('F4 \u2014 DELAY_SUMMARY & buildOrderSummary');
const r4 = 'Siap Kak, pesanan kami terima! [DELAY_SUMMARY]';
ok('F4: detect [DELAY_SUMMARY]',               r4.includes('[DELAY_SUMMARY]'));
const c4 = r4.replace(/\[DELAY_SUMMARY\]/gi, '').trim();
ok('F4: tag dihapus, teks tersisa',            !c4.includes('[DELAY_SUMMARY]') && c4.length > 5);

ok('F4: prompt ATURAN SUMMARY ORDER ada',      srv.includes('=== ATURAN SUMMARY ORDER'));
ok('F4: pipeline parse [DELAY_SUMMARY]',        srv.includes("cleanReply.includes('[DELAY_SUMMARY]')"));
ok('F4: schedule 15 menit',                    srv.includes('15 * 60 * 1000'));
ok('F4: call buildOrderSummary(from)',          srv.includes('buildOrderSummary(from)'));
ok('F4: function buildOrderSummary ada',        srv.includes('function buildOrderSummary(from)'));
ok('F4: summary mencakup garansi 24 jam',      srv.includes('24 jam setelah paket diterima'));
ok('F4: summary mencakup nama, produk, alamat',srv.includes('order.nama') && srv.includes('order.produk'));

// ─ F5: KLAIM_GARANSI ──────────────────────────────────────────────
section('F5 \u2014 KLAIM_GARANSI Tag & activeClaims');
const r5 = 'Mohon maaf Kak! Bisa kirim foto produknya? [KLAIM_GARANSI:produk rusak saat diterima]';
const km  = r5.match(/\[KLAIM_GARANSI:([^\]]*)\]/i);
ok('F5: detect [KLAIM_GARANSI:desc]',          !!km);
ok('F5: deskripsi diekstrak dengan benar',     km?.[1]?.trim() === 'produk rusak saat diterima');
const c5 = r5.replace(/\[KLAIM_GARANSI:[^\]]*\]/gi, '').trim();
ok('F5: tag dihapus dari reply',               !c5.includes('[KLAIM_GARANSI'));
ok('F5: teks permintaan foto masih ada',       c5.includes('foto'));

const claims = new Map();
claims.set('628111@s.whatsapp.net', { description: 'rusak', timestamp: Date.now() });
ok('F5: activeClaims.has() setelah set',       claims.has('628111@s.whatsapp.net'));
ok('F5: activeClaims.get() mengembalikan data',claims.get('628111@s.whatsapp.net')?.description === 'rusak');
claims.delete('628111@s.whatsapp.net');
ok('F5: activeClaims.has() = false setelah delete', !claims.has('628111@s.whatsapp.net'));

ok('F5: prompt ATURAN KLAIM GARANSI ada',      srv.includes('=== ATURAN KLAIM GARANSI ==='));
ok('F5: pipeline parse [KLAIM_GARANSI]',        srv.includes('[KLAIM_GARANSI:'));
ok('F5: activeClaims.set() di pipeline',        srv.includes('activeClaims.set(from,'));
ok('F5: call tg.sendClaimAlert()',              srv.includes('tg.sendClaimAlert('));
ok('F5: sendClaimAlert di telegram-service',   tg ? typeof tg.sendClaimAlert === 'function' : false);

// ─ Dashboard: cold_lead & payment badge ───────────────────────────
section('Dashboard \u2014 Order Badges');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
ok('Dashboard: badge ❄️ Cold ada',             html.includes('❄️ Cold'));
ok('Dashboard: badge 💳 Transfer ada',         html.includes('💳 Transfer'));
ok('Dashboard: badge 📦 COD ada',              html.includes('📦 COD'));
ok('Dashboard: courierSortList drag-reorder',  html.includes('id="courierSortList"'));
ok('Dashboard: loadCourierPriority function',  html.includes('function loadCourierPriority('));
ok('Dashboard: saveCourierPriority function',  html.includes('function saveCourierPriority('));

// ─ Summary ────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(56));
console.log('  HASIL: ' + passed + ' PASSED  |  ' + failed + ' FAILED  |  TOTAL ' + (passed+failed));
console.log('═'.repeat(56));

if (failed > 0) {
  console.log('\n\u274c Yang perlu difix:');
  results.filter(r => !r.ok).forEach(r => console.log('   \u2022 ' + r.label));
  process.exit(1);
} else {
  console.log('\n\u{1F389} Semua ' + passed + ' test passed! Siap deploy.\n');
  process.exit(0);
}

})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
