import { Bot } from "grammy";
import { config } from "./config.js";
import { sessionStore } from "./sessionStore.js";

class TelegramService {
  constructor() {
    this.bot = null;
    this.isRunning = false;
    this.replyHandlers = [];
  }

  /**
   * Inisialisasi bot Telegram
   */
  init() {
    if (!config.botToken || config.botToken === "YOUR_TELEGRAM_BOT_TOKEN_HERE") {
      console.warn("[TelegramService] ⚠️ TELEGRAM_BOT_TOKEN belum diset di .env.");
      return false;
    }

    try {
      this.bot = new Bot(config.botToken);
      this.setupHandlers();
      return true;
    } catch (error) {
      console.error("[TelegramService] ❌ Gagal inisialisasi Bot:", error.message);
      return false;
    }
  }

  /**
   * Daftarkan callback saat Admin membalas pesan di Telegram
   */
  onReply(callback) {
    if (typeof callback === "function") {
      this.replyHandlers.push(callback);
    }
  }

  /**
   * Daftarkan handler perintah dan pesan
   */
  setupHandlers() {
    if (!this.bot) return;

    // Perintah /start
    this.bot.command("start", async (ctx) => {
      const chatId = ctx.chat.id;
      const username = ctx.from?.username || ctx.from?.first_name || "Owner";

      config.setAdminChatId(chatId);

      await ctx.reply(
        `👋 <b>Halo ${username}!</b>\n\n` +
        `Bot Eskalasi WhatsApp siap digunakan.\n\n` +
        `🔑 <b>Chat ID Anda:</b> <code>${chatId}</code>\n` +
        `📱 <b>Nomor Terdaftar:</b> <code>${config.ownerPhone}</code>\n\n` +
        `ℹ️ <i>Setiap ada pertanyaan customer WA, bot akan mengirim notifikasi ke sini. Anda bisa <b>Reply</b> langsung untuk menjawab customer.</i>`,
        { parse_mode: "HTML" }
      );

      console.log(`[TelegramService] ✅ Admin terhubung! Chat ID: ${chatId} (${username})`);
    });

    // Perintah /id
    this.bot.command("id", async (ctx) => {
      await ctx.reply(
        `🆔 <b>Informasi Akun:</b>\n` +
        `• Chat ID: <code>${ctx.chat.id}</code>\n` +
        `• Nama: ${ctx.from?.first_name || ""} ${ctx.from?.last_name || ""}\n` +
        `• Username: @${ctx.from?.username || "-"}\n` +
        `• Status Admin: ${String(ctx.chat.id) === String(config.adminChatId) ? "✅ Terdaftar" : "⚠️ Belum terdaftar"}\n` +
        `• Sesi Aktif: ${sessionStore.activeCount} percakapan`,
        { parse_mode: "HTML" }
      );
    });

    // Tangani SEMUA pesan teks masuk dari Telegram
    this.bot.on("message:text", async (ctx) => {
      const replyTo = ctx.message.reply_to_message;
      const replyText = ctx.message.text;
      const fromUser = ctx.from?.first_name || "Owner";

      console.log(`\n[TelegramService] 📩 Pesan teks diterima dari Telegram: "${replyText}" (dari: ${fromUser})`);

      // Abaikan perintah bot yang diawali garis miring /
      if (replyText.startsWith("/")) return;

      let session = null;
      let usedReplyTo = false;

      // 1. Coba cari sesi berdasarkan pesan yang di-Reply
      if (replyTo && replyTo.message_id) {
        session = sessionStore.getSession(replyTo.message_id);
        usedReplyTo = true;
        console.log(`[TelegramService] 🔍 Ditemukan referensi reply_to_message_id: ${replyTo.message_id}`);
      }

      // 2. Jika tidak swipe reply atau pesan lama, coba gunakan sesi customer terakhir yang aktif
      if (!session) {
        session = sessionStore.getLatestSession();
        if (session) {
          console.log(`[TelegramService] ℹ️ Menggunakan sesi customer terbaru: ${session.customerPhone}`);
        }
      }

      // 3. Jika sesi ditemukan
      if (session) {
        console.log(`[TelegramService] 🎯 Meneruskan balasan ke Customer: ${session.customerName} (${session.customerPhone})`);

        // Trigger semua registered handler (meneruskan ke WA bot/backend)
        for (const handler of this.replyHandlers) {
          try {
            await handler({
              customerPhone: session.customerPhone,
              customerName: session.customerName,
              replyText: replyText,
              originalMessageId: session.messageId || (replyTo ? replyTo.message_id : null),
              originalQuestion: session.question
            });
          } catch (err) {
            console.error("[TelegramService] ❌ Error saat menjalankan reply handler:", err.message);
          }
        }

        // Kirim konfirmasi visual kembali ke Telegram Admin
        await ctx.reply(
          `✅ <b>Jawaban Diteruskan ke WhatsApp!</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 <b>Kepada:</b> ${session.customerName} (<code>${session.customerPhone}</code>)\n` +
          `💬 <b>Jawaban Anda:</b>\n<i>"${replyText}"</i>`,
          {
            parse_mode: "HTML",
            reply_to_message_id: ctx.message.message_id
          }
        );
        return;
      }

      // 4. Jika benar-benar belum ada sesi customer aktif
      await ctx.reply(
        `💡 <b>Belum ada antrean pertanyaan customer yang aktif.</b>\n\n` +
        `Saat ada notifikasi customer WA masuk, Anda bisa membalas langsung dengan cara <b>Reply</b> notifikasi tersebut.`,
        { parse_mode: "HTML" }
      );
    });

    // Error handling global grammy
    this.bot.catch((err) => {
      console.error("[TelegramService] ❌ Error pada bot:", err.error || err.message);
    });
  }

  /**
   * Mulai mendengarkan pesan masuk (Long Polling)
   */
  async startPolling() {
    if (!this.bot) {
      const initialized = this.init();
      if (!initialized) return false;
    }

    if (this.isRunning) return true;

    try {
      console.log("[TelegramService] 🚀 Memulai Telegram Long Polling...");
      this.bot.start({
        onStart: (botInfo) => {
          this.isRunning = true;
          console.log(`[TelegramService] ✅ Bot aktif sebagai @${botInfo.username} (ID: ${botInfo.id})`);
        }
      });
      return true;
    } catch (error) {
      console.error("[TelegramService] ❌ Gagal start polling:", error.message);
      return false;
    }
  }

  /**
   * Kirim pesan notifikasi eskalasi customer WA ke Telegram Owner
   */
  async sendEscalationAlert({ customerPhone, customerName = "Customer", question, aiContext = "AI belum memiliki data untuk pertanyaan ini." }) {
    if (!this.bot) {
      const initialized = this.init();
      if (!initialized) {
        return { success: false, error: "Bot belum diinisialisasi (Token belum ada)." };
      }
    }

    const targetChatId = config.adminChatId;
    if (!targetChatId) {
      console.warn("[TelegramService] ⚠️ Belum ada ADMIN_CHAT_ID. Silakan buka bot di Telegram dan ketik /start");
      return { success: false, error: "ADMIN_CHAT_ID belum terdaftar. Buka bot di Telegram & ketik /start" };
    }

    const timeString = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

    const messageText =
      `🚨 <b>[ESKALASI PERTANYAAN CUSTOMER WA]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Nama:</b> ${customerName}\n` +
      `📱 <b>Nomor WA:</b> <code>${customerPhone}</code>\n` +
      `⏰ <b>Waktu:</b> ${timeString} WIB\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💬 <b>Pertanyaan:</b>\n<i>"${question}"</i>\n\n` +
      `ℹ️ <b>Konteks AI:</b> ${aiContext}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👉 <b>Balas (Reply)</b> pesan ini untuk mengirim jawaban langsung ke WhatsApp customer!`;

    try {
      const sent = await this.bot.api.sendMessage(targetChatId, messageText, {
        parse_mode: "HTML"
      });

      // Simpan pemetaan message_id ke data customer
      sessionStore.saveSession(sent.message_id, {
        customerPhone,
        customerName,
        question,
        aiContext,
        messageId: sent.message_id
      });

      console.log(`[TelegramService] 📤 Notifikasi terkirim ke Admin (Msg ID: ${sent.message_id}) untuk customer: ${customerPhone}`);
      return { success: true, messageId: sent.message_id };
    } catch (error) {
      console.error("[TelegramService] ❌ Gagal mengirim pesan ke Telegram:", error.message);
      return { success: false, error: error.message };
    }
  }
}

export const telegramService = new TelegramService();
