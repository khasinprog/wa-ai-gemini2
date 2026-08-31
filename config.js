// ── Configuration Constants ──────────────────────────────────────────
// Centralized configuration to avoid magic numbers throughout the codebase

module.exports = {
  // ── Message Limits ──────────────────────────────────────────────
  MESSAGE_LIMIT: 3000,              // Max messages to keep in memory
  DEDUP_CACHE_SIZE: 2000,           // Max wamids to keep in dedup cache
  DEDUP_CLEANUP_DAYS: 7,            // Days to keep processed wamids in DB
  HISTORY_MESSAGE_COUNT: 8,         // Number of history messages to send to AI

  // ── Retry & Timing ─────────────────────────────────────────────
  MAX_RETRY_COUNT: 5,               // Max retry attempts for failed messages
  RETRY_WINDOW_MS: 7200000,         // 2 hours - window for retry eligibility
  REPLY_LENGTH_THRESHOLD: 80,       // Characters - short vs long reply threshold
  BUBBLE_DELAY_MS: 1200,            // Delay between split bubbles

  // ── Dedup & Rate Limiting ──────────────────────────────────────
  ORDER_DEDUP_WINDOW_MS: 300000,    // 5 minutes - duplicate order prevention
  LOGIN_MAX_ATTEMPTS: 5,            // Max login attempts per IP
  LOGIN_WINDOW_MS: 60000,           // 1 minute - login rate limit window

  // ── Scheduling ─────────────────────────────────────────────────
  ORDER_SUMMARY_DELAY_MS: 900000,   // 15 minutes - order summary delay
  TRANSFER_FOLLOWUP_MS: 10800000,   // 3 hours - transfer follow-up delay

  // ── API Configuration ──────────────────────────────────────────
  MAX_API_KEY_SLOTS: 15,            // Number of API key slots supported
  DEFAULT_TEMPERATURE: 0.7,         // Default AI temperature
  DEFAULT_MODEL: 'gemini-3.1-flash-lite', // Default Gemini model

  // ── Knowledge Base ─────────────────────────────────────────────
  MAX_FALLBACK_BLOCKS: 5,           // Max KB blocks for non-product queries
  ALL_PRODUCTS_KEYWORDS: [
    'apa saja', 'apa aja', 'semua produk', 'produk apa',
    'jual apa', 'ada apa', 'ada apa saja', 'produk lain', 'ada produk'
  ],
};
