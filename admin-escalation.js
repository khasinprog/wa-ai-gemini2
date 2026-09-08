/**
 * admin-escalation.js — Handle admin escalation answers
 * When admin replies to escalated questions, map answers to pending items.
 */

'use strict';

const store  = require('./state-store');
const { callGeminiRaw } = require('./gemini-service');
const { appendFaqToKB } = require('./message-postprocess');
const { sendWhatsAppText, normalizeIdNumber } = require('./whatsapp-api');

async function handleAdminEscalationAnswer(adminText) {
  if (!store.pendingEscalations.length) return;

  const pendingList = store.pendingEscalations.map(e => `${e.id}. [${e.productTag}] ${e.question}`).join('\n');
  const sysPrompt = [
    'Kamu bertugas memetakan balasan admin toko ke daftar pertanyaan yang sedang pending.',
    'Daftar pertanyaan pending (format: ID. [Produk] Pertanyaan):',
    pendingList,
    '',
    'Petakan tiap bagian balasan admin ke ID pertanyaan yang paling sesuai.',
    'Keluarkan HANYA JSON array valid, TANPA markdown/backtick, format PERSIS:',
    '[{"id": <angka>, "answer": "<jawaban admin>"}]',
    'Kalau ada pertanyaan yang TIDAK terjawab, JANGAN masukkan ke output.',
  ].join('\n');

  const rawResult = await callGeminiRaw(sysPrompt, adminText);
  if (!rawResult) { console.error('⚠️ Gagal memetakan balasan admin'); return; }

  let parsed;
  try {
    parsed = JSON.parse(rawResult.replace(/```json|```/g, '').trim());
  } catch(e) {
    console.error('⚠️ Gagal parse hasil pemetaan:', e.message);
    return;
  }
  if (!Array.isArray(parsed)) return;

  for (const row of parsed) {
    const item = store.pendingEscalations.find(e => e.id === row.id);
    if (!item || !row.answer) continue;

    appendFaqToKB(item.productTag, item.question, row.answer);

    const isGreetingLike = /^(halo|hai|iya|baik|oke|ok)\b/i.test(row.answer.trim());
    const customerMsg = isGreetingLike ? row.answer.trim() : `Halo Kak, ${row.answer.trim()}`;
    try {
      await sendWhatsAppText(item.from, customerMsg);
      console.log(`✅ Jawaban eskalasi #${item.id} terkirim ke ${item.senderName || item.from}`);
      const _escSt = store.orderStates.get(item.from);
      if (_escSt && _escSt.step === 5) {
        const prevStep = _escSt.orderConfirmed ? 4 : 3;
        _escSt.step = prevStep;
        _escSt.lastUpdate = Date.now();
        store.orderStates.set(item.from, _escSt);
      }
    } catch(e) {
      console.error(`❌ Gagal kirim jawaban eskalasi #${item.id}:`, e.message);
    }

    store.pendingEscalations = store.pendingEscalations.filter(e => e.id !== item.id);
  }
  store.saveEscalations();
  store.io?.emit('escalations_updated', store.pendingEscalations);
}

async function notifyAdminEscalations() {
  if (!store.pendingEscalations.length) return;

  const tg = require('./telegram-service');
  if (tg.isConfigured()) {
    const questions = store.pendingEscalations.map(e => ({
      id: e.id, productTag: e.productTag, question: e.question, senderName: e.senderName,
    }));
    await tg.notifyAdminEscalations(questions);
    return;
  }

  if (!store.settings.adminNumber) return;
  const lines = store.pendingEscalations.map(e => `${e.id}. [${e.productTag}] ${e.question}`);
  const text = `🔔 Ada ${store.pendingEscalations.length} pertanyaan yang perlu dijawab manual:\n\n${lines.join('\n')}\n\nBalas semua di 1 pesan aja ya Kak, urut sesuai nomor.`;
  await sendWhatsAppText(normalizeIdNumber(store.settings.adminNumber), text);
}

module.exports = { handleAdminEscalationAnswer, notifyAdminEscalations };
