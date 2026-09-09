/**
 * chat-helpers.js — History building & reply delay utilities
 */

'use strict';

const store = require('./state-store');
const { parseProductBlocks } = require('./knowledge-base');

const REPLY_LENGTH_THRESHOLD = 80;

function buildHistory(from, currentEntryId, maxEntries = 20) {
  const relevantMessages = store.messages
    .filter(m => m.from === from && m.id !== currentEntryId && !m.cancelledEntry && m.aiReply)
    .sort((a, b) => a.id - b.id);

  if (relevantMessages.length <= maxEntries) return relevantMessages;

  const recent = relevantMessages.slice(-maxEntries);
  const old = relevantMessages.slice(0, -maxEntries);
  const summary = buildConversationSummary(old);
  return [{ _summary: true, summary }, ...recent];
}

function buildConversationSummary(oldEntries) {
  const products = new Set();
  const discussed = [];

  // Dynamic: detect products from Knowledge Base
  const blocks = parseProductBlocks(store.settings.knowledgeBase);
  const recentEntries = oldEntries.slice(-5);
  for (const entry of recentEntries) {
    const userText = (entry.body || '').toLowerCase();

    // Match any product from KB
    for (const block of blocks) {
      if (!block.name) continue;
      const words = block.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
      if (words.some(w => userText.includes(w))) products.add(block.name);
    }

    if (userText.includes('harga') || userText.includes('berapa')) discussed.push('harga');
    if (userText.includes('warna') || userText.includes('biru') || userText.includes('pink')) discussed.push('warna');
    if (userText.includes('order') || userText.includes('mau')) discussed.push('order');
    if (userText.includes('alamat') || userText.includes('jalan') || userText.includes('jl')) discussed.push('alamat');
    if (userText.includes('ongkir') || userText.includes('kirim')) discussed.push('ongkir');
  }
  const parts = [];
  if (products.size) parts.push(`Produk dibahas: ${[...products].join(', ')}`);
  if (discussed.length) parts.push(`Topik: ${[...new Set(discussed)].join(', ')}`);
  return parts.join('. ') || 'Percakapan sebelumnya.';
}

function getReplyDelayMs(text) {
  const settings = store.settings;
  const shortSec = Math.max(0, Number(settings.replyDelayMin) || 10);
  const longSec  = Math.max(shortSec, Number(settings.replyDelayMax) || 15);
  const baseSec  = (text?.length || 0) > REPLY_LENGTH_THRESHOLD ? longSec : shortSec;
  const jitterSec = (Math.random() * 4) - 2;
  const sec = Math.max(1, baseSec + jitterSec);
  return sec * 1000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { buildHistory, buildConversationSummary, getReplyDelayMs, sleep, REPLY_LENGTH_THRESHOLD };
