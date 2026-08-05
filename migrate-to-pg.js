require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');
const ORDER_FILE = path.join(DATA_DIR, 'orders.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`Error membaca file ${filePath}:`, e.message);
    return null;
  }
}

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL belum disetting di .env!');
    process.exit(1);
  }

  console.log('🔄 Memulai migrasi dari file JSON ke PostgreSQL...');
  
  // 1. Inisialisasi Database (Buat Tabel)
  await db.initDB();

  // 2. Migrasi Settings
  const settings = loadJSON(SETTINGS_FILE);
  if (settings) {
    console.log('⚙️ Migrasi pengaturan (settings.json)...');
    await db.saveSettings(settings);
    console.log('✅ Pengaturan berhasil dimigrasi.');
  }

  // 3. Migrasi Orders
  const orders = loadJSON(ORDER_FILE);
  if (orders && Array.isArray(orders)) {
    console.log(`🛒 Migrasi ${orders.length} pesanan (orders.json)...`);
    let orderCount = 0;
    for (const order of orders) {
      try {
        await db.saveOrder(order);
        orderCount++;
      } catch (e) {
        console.error(`Gagal migrasi order ${order.id}:`, e.message);
      }
    }
    console.log(`✅ ${orderCount} pesanan berhasil dimigrasi.`);
  }

  // 4. Migrasi Messages & Contacts
  const messages = loadJSON(MSG_FILE);
  if (messages && Array.isArray(messages)) {
    // Reverse agar insert dari yang paling lama dulu (karena di JSON mungkin disimpan terbaru di atas)
    const sortedMessages = [...messages].reverse(); 
    console.log(`💬 Migrasi ${sortedMessages.length} pesan (messages.json)...`);
    
    let msgCount = 0;
    let contactCount = 0;
    const contactsSet = new Set();

    for (const msg of sortedMessages) {
      try {
        await db.saveMessage(msg);
        msgCount++;

        // Simpan contact jika ada nama dan belum tersimpan di set
        const waId = msg.wa_id || msg.from;
        if (waId && !contactsSet.has(waId)) {
          contactsSet.add(waId);
          await db.upsertContact(waId, msg.sender_name || msg.senderName || 'Unknown');
          contactCount++;
        }
      } catch (e) {
        console.error(`Gagal migrasi pesan dari ${msg.from}:`, e.message);
      }
    }
    console.log(`✅ ${msgCount} pesan dan ${contactCount} kontak berhasil dimigrasi.`);
  }

  console.log('\n🎉 MIGRASI SELESAI!');
  console.log('File JSON asli (messages.json, orders.json, settings.json) TIDAK dihapus dan tetap aman.');
  
  process.exit(0);
}

migrate();
