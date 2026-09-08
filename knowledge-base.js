/**
 * knowledge-base.js — Knowledge Base parsing & relevance matching
 * Smart filtering: pecah KB jadi blok per produk, cari yang relevan dengan pesan.
 */

'use strict';

const config = require('./config');
const store  = require('./state-store');

// Format KB: pisahkan berdasarkan ---
// === PRODUK: Nama Produk ===
// ...detail...
// ---
// === PRODUK: Produk Lain ===
// ...detail...
function parseProductBlocks(kb) {
  if (!kb?.trim()) return [];
  return kb.split(/^---$/m)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const headerMatch = block.match(/===\s*PRODUK:\s*(.+?)\s*===/i);
      return { name: headerMatch ? headerMatch[1].trim() : null, text: block };
    });
}

// Cari blok produk yang relevan dengan pesan pelanggan
function getRelevantKnowledge(message, history = []) {
  const blocks = parseProductBlocks(store.settings.knowledgeBase);
  if (!blocks.length) return '';

  const recentHistoryText = history.slice(-3).map(h => `${h.body || ''} ${h.aiReply || ''}`).join(' ');
  const combinedText = (message + ' ' + recentHistoryText).toLowerCase();

  const matched = blocks.filter(b => {
    if (!b.name) return false;
    const words = b.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    return words.some(w => combinedText.includes(w));
  });

  const ALL_PRODUCTS_KEYWORDS = config.ALL_PRODUCTS_KEYWORDS;
  const isAskingAllProducts = ALL_PRODUCTS_KEYWORDS.some(kw => combinedText.includes(kw));

  const MAX_FALLBACK_BLOCKS = config.MAX_FALLBACK_BLOCKS;
  const chosen = isAskingAllProducts ? blocks : (matched.length ? matched : blocks.slice(0, MAX_FALLBACK_BLOCKS));
  return chosen.map(b => b.text).join('\n\n');
}

module.exports = { parseProductBlocks, getRelevantKnowledge };
