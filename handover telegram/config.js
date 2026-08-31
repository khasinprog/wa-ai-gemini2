import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env dari root project
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  ownerPhone: process.env.OWNER_PHONE_NUMBER || "085210127796",
  adminChatId: process.env.ADMIN_CHAT_ID ? process.env.ADMIN_CHAT_ID.trim() : null,
  port: parseInt(process.env.PORT, 10) || 3001,

  // Helper untuk set adminChatId secara runtime
  setAdminChatId(chatId) {
    this.adminChatId = String(chatId);
    console.log(`[Config] Admin Chat ID updated to: ${this.adminChatId}`);
  }
};
