import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_FILE = path.resolve(__dirname, "../sessions.json");

/**
 * SessionStore untuk mengelola pemetaan pesan Telegram dan nomor customer WhatsApp
 * Dilengkapi penyimpanan persisten ke file JSON.
 */
class SessionStore {
  constructor() {
    // Map: messageId (number) -> { customerPhone, customerName, question, createdAt }
    this.sessions = new Map();
    this.latestMessageId = null;
    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
        const data = JSON.parse(raw);
        for (const [key, val] of Object.entries(data)) {
          this.sessions.set(Number(key), val);
        }
        if (this.sessions.size > 0) {
          const keys = Array.from(this.sessions.keys());
          this.latestMessageId = keys[keys.length - 1];
        }
        console.log(`[SessionStore] 📂 Dimuat ${this.sessions.size} sesi dari sessions.json`);
      }
    } catch (err) {
      console.warn("[SessionStore] ⚠️ Gagal memuat sessions.json:", err.message);
    }
  }

  saveToDisk() {
    try {
      const obj = {};
      for (const [key, val] of this.sessions.entries()) {
        obj[key] = val;
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      console.error("[SessionStore] ❌ Gagal menyimpan sessions.json:", err.message);
    }
  }

  /**
   * Simpan sesi eskalasi baru
   */
  saveSession(messageId, data) {
    const numId = Number(messageId);
    this.sessions.set(numId, {
      ...data,
      createdAt: Date.now()
    });
    this.latestMessageId = numId;
    this.saveToDisk();
    console.log(`[SessionStore] 💾 Sesi tersimpan untuk Msg ID ${numId} -> Customer: ${data.customerPhone}`);
  }

  /**
   * Ambil data customer berdasarkan ID pesan yang di-reply
   */
  getSession(messageId) {
    return this.sessions.get(Number(messageId)) || null;
  }

  /**
   * Ambil sesi paling terakhir (fallback jika user tidak swipe reply)
   */
  getLatestSession() {
    if (!this.latestMessageId) return null;
    return this.sessions.get(this.latestMessageId) || null;
  }

  /**
   * Hapus sesi
   */
  deleteSession(messageId) {
    this.sessions.delete(Number(messageId));
    this.saveToDisk();
  }

  /**
   * Bersihkan sesi lama (> 48 jam)
   */
  cleanupOldSessions(maxAgeMs = 48 * 60 * 60 * 1000) {
    const now = Date.now();
    let modified = false;
    for (const [msgId, session] of this.sessions.entries()) {
      if (now - session.createdAt > maxAgeMs) {
        this.sessions.delete(msgId);
        modified = true;
      }
    }
    if (modified) this.saveToDisk();
  }

  get activeCount() {
    return this.sessions.size;
  }
}

export const sessionStore = new SessionStore();
