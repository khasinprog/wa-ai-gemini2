/**
 * followup-scheduler.js — F3
 * Scheduler untuk follow-up otomatis per nomor WA.
 *
 * Mendukung multiple timer per customer (dibedakan by type):
 *   'transfer' — follow-up jika 3 jam belum kirim bukti transfer
 *   'summary'  — delay 15 menit sebelum kirim summary order (F4)
 *
 * Ghost follow-up (1 jam) dikerjakan via AI prompt sesuai keputusan user.
 */

'use strict';

// Map: `${from}:${type}` → { timeoutId, scheduledAt, delayMs }
const timers = new Map();

/**
 * Jadwalkan follow-up.
 * @param {string} from       - nomor WA customer (JID lengkap)
 * @param {string} type       - 'transfer' | 'summary' | 'ghost'
 * @param {number} delayMs    - delay dalam milidetik
 * @param {Function} sendFn   - async function dipanggil saat timer habis
 */
function schedule(from, type, delayMs, sendFn) {
  const key = `${from}:${type}`;
  cancel(from, type); // cancel lama jika ada

  const timeoutId = setTimeout(async () => {
    timers.delete(key);
    try {
      console.log(`[Scheduler] ⏰ Timer '${type}' habis untuk ${from.split('@')[0]}`);
      await sendFn();
    } catch(e) {
      console.error(`[Scheduler] ❌ Error follow-up ${type}:`, e.message);
    }
  }, delayMs);

  timers.set(key, { timeoutId, scheduledAt: Date.now(), delayMs, type });
  const menit = Math.round(delayMs / 60000);
  console.log(`[Scheduler] 📅 Timer '${type}' set untuk ${from.split('@')[0]} (${menit} mnt)`);
}

/** Batalkan timer tertentu untuk satu customer. */
function cancel(from, type) {
  const key = `${from}:${type}`;
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing.timeoutId);
    timers.delete(key);
    console.log(`[Scheduler] 🚫 Timer '${type}' dibatalkan untuk ${from.split('@')[0]}`);
  }
}

/** Batalkan SEMUA timer untuk satu customer. */
function cancelAll(from) {
  for (const [key] of timers) {
    if (key.startsWith(`${from}:`)) {
      clearTimeout(timers.get(key).timeoutId);
      timers.delete(key);
    }
  }
}

/** Cek apakah timer tertentu aktif. */
function isActive(from, type) {
  return timers.has(`${from}:${type}`);
}

/** Jumlah timer aktif (untuk debugging). */
function activeCount() {
  return timers.size;
}

module.exports = { schedule, cancel, cancelAll, isActive, activeCount };
