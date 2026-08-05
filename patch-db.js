const fs = require('fs');

let code = fs.readFileSync('server.js', 'utf8');

// 1. Tambahkan require db.js jika belum ada
if (!code.includes("const db = require('./db');")) {
  code = code.replace("const fs = require('fs');", "const fs = require('fs');\nconst db = require('./db');");
}

// 2. Tambahkan helper DB Sync jika belum ada
const helpers = `
// --- DB Sync Helpers ---
async function persistMessageToDB(msg) {
  if(!msg) return;
  try {
    await db.saveMessage(msg);
    const waId = msg.wa_id || msg.from;
    if (waId) await db.upsertContact(waId, msg.sender_name || msg.senderName || 'Unknown');
  } catch(e) { console.error('DB Msg Error:', e.message); }
}
async function persistOrderToDB(order) {
  if(!order) return;
  try { await db.saveOrder(order); } catch(e) { console.error('DB Order Error:', e.message); }
}
async function persistSettingsToDB(settings) {
  if(!settings) return;
  try { await db.saveSettings(settings); } catch(e) { console.error('DB Settings Error:', e.message); }
}
// -----------------------
`;
if (!code.includes("persistMessageToDB")) {
  code = code.replace("const save = (file, data)", helpers + "\nconst save = (file, data)");
}

// 3. Inisialisasi DB saat server start
if (!code.includes("await db.initDB()")) {
  code = code.replace(
    "console.log('  WA AI Assistant (Cloud API + MacroDroid) berjalan!');", 
    "console.log('  WA AI Assistant (Cloud API + MacroDroid) berjalan!');\n  try { await db.initDB(); } catch(e) { console.error('Failed to init DB:', e.message); }"
  );
}

// 4. Lakukan patch pada semua pemanggilan save() untuk sinkronisasi DB
code = code.replace(/save\(MSG_FILE, messages\);/g, "save(MSG_FILE, messages); if (typeof entry !== 'undefined') persistMessageToDB(entry); else if (typeof msgObj !== 'undefined') persistMessageToDB(msgObj);");
code = code.replace(/save\(ORDER_FILE, orders\);/g, "save(ORDER_FILE, orders); if (typeof order !== 'undefined') persistOrderToDB(order);");
code = code.replace(/save\(SET_FILE, settings\);/g, "save(SET_FILE, settings); persistSettingsToDB(settings);");

// Tulis kembali
fs.writeFileSync('server.js', code);
console.log('✅ server.js berhasil di-patch untuk Dual-Write PostgreSQL!');
