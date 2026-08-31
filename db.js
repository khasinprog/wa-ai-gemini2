// db.js — PostgreSQL connection & schema setup
// Load .env lebih awal agar DATABASE_URL tersedia saat Pool dibuat (fix SASL error)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        wa_id VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100),
        first_seen_at TIMESTAMP DEFAULT NOW(),
        last_active_at TIMESTAMP DEFAULT NOW(),
        tags TEXT[] DEFAULT '{}',
        is_blocked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        waba_message_id VARCHAR(100) UNIQUE,
        wa_id VARCHAR(50) NOT NULL,
        sender_name VARCHAR(100),
        direction VARCHAR(10) NOT NULL DEFAULT 'inbound',
        sender_type VARCHAR(10) DEFAULT 'customer',
        message_type VARCHAR(20) NOT NULL DEFAULT 'text',
        body TEXT,
        ai_reply TEXT,
        replied BOOLEAN DEFAULT FALSE,
        manual BOOLEAN DEFAULT FALSE,
        cancelled_entry BOOLEAN DEFAULT FALSE,
        retry_count INTEGER DEFAULT 0,
        media_url TEXT,
        media_mime_type VARCHAR(50),
        media_filename VARCHAR(200),
        link_url TEXT,
        link_title VARCHAR(300),
        link_description TEXT,
        link_thumbnail TEXT,
        link_domain VARCHAR(100),
        source VARCHAR(30) DEFAULT 'organic',
        ad_id VARCHAR(50),
        raw_payload JSONB,
        timestamp TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_waba_id ON messages(waba_message_id);

      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(50) PRIMARY KEY,
        wa_id VARCHAR(50),
        nama VARCHAR(100),
        hp VARCHAR(20),
        produk VARCHAR(200),
        alamat TEXT,
        ai_alamat TEXT,
        ai_cod VARCHAR(100),
        payment_method VARCHAR(30) DEFAULT NULL,
        cold_lead BOOLEAN DEFAULT FALSE,
        status VARCHAR(30) DEFAULT 'baru',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS settings_store (
        key VARCHAR(50) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS webhook_logs (
        id BIGSERIAL PRIMARY KEY,
        event_type VARCHAR(50),
        payload JSONB NOT NULL,
        processed BOOLEAN DEFAULT FALSE,
        error_message TEXT,
        received_at TIMESTAMP DEFAULT NOW()
      );

      -- Dedup: track processed webhook message IDs to prevent duplicate processing
      CREATE TABLE IF NOT EXISTS processed_wamids (
        wamid VARCHAR(100) PRIMARY KEY,
        processed_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_processed_wamids_cleanup
        ON processed_wamids(processed_at);

      -- Active warranty claims: persist across server restarts
      CREATE TABLE IF NOT EXISTS active_claims (
        wa_id VARCHAR(50) PRIMARY KEY,
        description TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // F1: Migration — tambah kolom payment_method jika belum ada
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30) DEFAULT NULL`);
    // F3-D: Migration — tambah kolom cold_lead jika belum ada
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cold_lead BOOLEAN DEFAULT FALSE`);

    // Cleanup old processed_wamids (older than 7 days) — non-fatal
    try {
      await client.query(`DELETE FROM processed_wamids WHERE processed_at < NOW() - INTERVAL '7 days'`);
    } catch(e) { /* ignore */ }

    console.log('✅ Database schema ready');
  } finally {
    client.release();
  }
}

// ── Messages ──────────────────────────────────────────────────────

async function saveMessage(msg) {
  const q = `
    INSERT INTO messages 
      (waba_message_id, wa_id, sender_name, direction, sender_type, message_type,
       body, ai_reply, replied, manual, cancelled_entry, retry_count,
       media_url, media_mime_type, media_filename,
       link_url, link_title, link_description, link_thumbnail, link_domain,
       source, ad_id, raw_payload, timestamp)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    ON CONFLICT (waba_message_id) DO UPDATE SET
      ai_reply = EXCLUDED.ai_reply,
      replied = EXCLUDED.replied,
      manual = EXCLUDED.manual,
      cancelled_entry = EXCLUDED.cancelled_entry,
      retry_count = EXCLUDED.retry_count
    RETURNING *
  `;
  const vals = [
    msg.waba_message_id || msg.wamid || null,
    msg.wa_id || msg.from,
    msg.sender_name || msg.senderName || null,
    msg.direction || 'inbound',
    msg.sender_type || msg.senderType || 'customer',
    msg.message_type || msg.messageType || 'text',
    msg.body || null,
    msg.ai_reply || msg.aiReply || null,
    msg.replied || false,
    msg.manual || false,
    msg.cancelled_entry || msg.cancelledEntry || false,
    msg.retry_count || msg.retryCount || 0,
    msg.media_url || msg.mediaUrl || null,
    msg.media_mime_type || msg.mediaMimeType || null,
    msg.media_filename || msg.mediaFilename || null,
    msg.link_url || msg.linkUrl || null,
    msg.link_title || msg.linkTitle || null,
    msg.link_description || msg.linkDescription || null,
    msg.link_thumbnail || msg.linkThumbnail || null,
    msg.link_domain || msg.linkDomain || null,
    msg.source || 'organic',
    msg.ad_id || msg.adId || null,
    msg.raw_payload ? JSON.stringify(msg.raw_payload) : null,
    msg.timestamp ? new Date(msg.timestamp) : new Date(),
  ];
  const res = await pool.query(q, vals);
  return dbRowToMsg(res.rows[0]);
}

async function updateMessage(id, fields) {
  const allowed = ['ai_reply','replied','manual','cancelled_entry','retry_count','media_url','link_url','link_title','link_thumbnail','link_domain'];
  const sets = [], vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = $${i++}`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE messages SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

async function getMessages(limit = 3000) {
  const res = await pool.query(
    'SELECT * FROM messages ORDER BY timestamp DESC LIMIT $1', [limit]
  );
  return res.rows.map(dbRowToMsg);
}

async function getMessageById(id) {
  const res = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
  return res.rows[0] ? dbRowToMsg(res.rows[0]) : null;
}

async function getUnrepliedMessages() {
  const res = await pool.query(`
    SELECT * FROM messages 
    WHERE replied = false 
      AND cancelled_entry = false
      AND direction = 'inbound'
      AND timestamp > NOW() - INTERVAL '2 hours'
      AND retry_count < 5
    ORDER BY timestamp ASC
  `);
  return res.rows.map(dbRowToMsg);
}

function dbRowToMsg(row) {
  if (!row) return null;
  return {
    id: row.id,
    from: row.wa_id,
    wa_id: row.wa_id,
    wamid: row.waba_message_id,
    waba_message_id: row.waba_message_id,
    senderName: row.sender_name,
    sender_name: row.sender_name,
    direction: row.direction,
    messageType: row.message_type,
    message_type: row.message_type,
    body: row.body,
    aiReply: row.ai_reply,
    ai_reply: row.ai_reply,
    replied: row.replied,
    manual: row.manual,
    cancelledEntry: row.cancelled_entry,
    cancelled_entry: row.cancelled_entry,
    retryCount: row.retry_count,
    retry_count: row.retry_count,
    mediaUrl: row.media_url,
    media_url: row.media_url,
    mediaMimeType: row.media_mime_type,
    mediaFilename: row.media_filename,
    linkUrl: row.link_url,
    link_url: row.link_url,
    linkTitle: row.link_title,
    link_title: row.link_title,
    linkDescription: row.link_description,
    linkThumbnail: row.link_thumbnail,
    link_thumbnail: row.link_thumbnail,
    linkDomain: row.link_domain,
    link_domain: row.link_domain,
    source: row.source,
    adId: row.ad_id,
    timestamp: row.timestamp ? row.timestamp.toISOString() : new Date().toISOString(),
  };
}

// ── Contacts ─────────────────────────────────────────────────────

async function upsertContact(waId, name) {
  await pool.query(`
    INSERT INTO contacts (wa_id, name, last_active_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (wa_id) DO UPDATE SET
      last_active_at = NOW(),
      name = COALESCE(EXCLUDED.name, contacts.name)
  `, [waId, name || null]);
}

// ── Orders ────────────────────────────────────────────────────────

async function saveOrder(order) {
  await pool.query(`
    INSERT INTO orders (id, wa_id, nama, hp, produk, alamat, ai_alamat, ai_cod, payment_method, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET
      ai_alamat = EXCLUDED.ai_alamat,
      ai_cod = EXCLUDED.ai_cod,
      payment_method = EXCLUDED.payment_method,
      status = EXCLUDED.status
  `, [order.id, order.jid || order.wa_id, order.nama, order.hp, order.produk, order.alamat, order.ai_alamat || null, order.ai_cod || null, order.payment_method || null, order.status || 'baru']);
}

async function getOrders() {
  const res = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500');
  return res.rows.map(r => ({
    id: r.id, jid: r.wa_id, wa_id: r.wa_id,
    nama: r.nama, hp: r.hp, produk: r.produk,
    alamat: r.alamat, ai_alamat: r.ai_alamat, ai_cod: r.ai_cod,
    payment_method: r.payment_method || null,
    cold_lead: r.cold_lead || false,
    status: r.status, created_at: r.created_at,
  }));
}

async function updateOrder(id, fields) {
  const allowed = ['ai_alamat','ai_cod','payment_method','cold_lead','status'];
  const sets = [], vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = $${i++}`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

async function getOrderById(id) {
  const res = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function deleteOrder(id) {
  await pool.query('DELETE FROM orders WHERE id = $1', [id]);
}

// ── Settings ─────────────────────────────────────────────────────

async function loadSettings() {
  const res = await pool.query("SELECT value FROM settings_store WHERE key = 'main'");
  return res.rows[0] ? res.rows[0].value : null;
}

async function saveSettings(data) {
  await pool.query(`
    INSERT INTO settings_store (key, value, updated_at)
    VALUES ('main', $1, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
  `, [JSON.stringify(data)]);
}

// ── Webhook Log ──────────────────────────────────────────────────

async function logWebhook(eventType, payload) {
  try {
    await pool.query(
      'INSERT INTO webhook_logs (event_type, payload) VALUES ($1, $2)',
      [eventType, JSON.stringify(payload)]
    );
  } catch(e) { /* non-fatal */ }
}

// ── Processed Wamids (Dedup) ─────────────────────────────────────
// Persist webhook dedup state to survive server restarts

async function saveProcessedWamid(wamid) {
  if (!wamid) return;
  try {
    await pool.query(
      `INSERT INTO processed_wamids (wamid, processed_at)
       VALUES ($1, NOW())
       ON CONFLICT (wamid) DO NOTHING`,
      [wamid]
    );
  } catch(e) { /* non-fatal */ }
}

async function isWamidProcessed(wamid) {
  if (!wamid) return false;
  try {
    const res = await pool.query(
      'SELECT 1 FROM processed_wamids WHERE wamid = $1',
      [wamid]
    );
    return res.rowCount > 0;
  } catch(e) { return false; }
}

// ── Active Claims (Warranty) ─────────────────────────────────────
// Persist active warranty claims across server restarts

async function saveActiveClaim(waId, description) {
  if (!waId) return;
  try {
    await pool.query(
      `INSERT INTO active_claims (wa_id, description, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (wa_id) DO UPDATE SET description = $2, created_at = NOW()`,
      [waId, description]
    );
  } catch(e) { /* non-fatal */ }
}

async function getActiveClaim(waId) {
  if (!waId) return null;
  try {
    const res = await pool.query(
      'SELECT * FROM active_claims WHERE wa_id = $1',
      [waId]
    );
    return res.rows[0] || null;
  } catch(e) { return null; }
}

async function deleteActiveClaim(waId) {
  if (!waId) return;
  try {
    await pool.query('DELETE FROM active_claims WHERE wa_id = $1', [waId]);
  } catch(e) { /* non-fatal */ }
}

// Load all active claims on startup
async function loadActiveClaims() {
  try {
    const res = await pool.query('SELECT * FROM active_claims');
    return res.rows;
  } catch(e) { return []; }
}

module.exports = {
  pool, initDB,
  saveMessage, updateMessage, getMessages, getMessageById, getUnrepliedMessages,
  upsertContact,
  saveOrder, getOrders, updateOrder, getOrderById, deleteOrder,
  loadSettings, saveSettings,
  logWebhook,
  saveProcessedWamid, isWamidProcessed,
  saveActiveClaim, getActiveClaim, deleteActiveClaim, loadActiveClaims,
};
