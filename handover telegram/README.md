# 📘 DOKUMENTASI HANDOVER BACKEND: TELEGRAM ESCALATION BRIDGE

Modul backend ini berfungsi sebagai **jembatan eskalasi dua arah (two-way live chat bridge)** antara **WhatsApp AI Assistant** dan **Akun Telegram Owner (`085210127796`)**.

Modul ini dibuat untuk mengatasi batasan **24-hour customer service window di WhatsApp Business API (WABA)** secara 100% gratis, realtime, dan tanpa batasan waktu.

---

## 🏗️ 1. Diagram Arsitektur & Alur Dua Arah

```
                                  [WhatsApp Customer]
                                           │
                                           │ 1. Bertanya ke WA
                                           ▼
                                 [App WA Assistant Anda]
                                           │
                        ┌──────────────────┴──────────────────┐
                        ▼                                     ▼
                [Pertanyaan Diketahui]              [AI TIDAK TAHU / RAGU]
                        │                                     │
                        ▼                                     │ 2. Panggil:
                 AI Balas Otomatis                            │ telegramService.sendEscalationAlert(...)
                                                              ▼
                                                 [TELEGRAM ESCALATION BRIDGE]
                                                              │
                                                              │ 3. Kirim notifikasi bot
                                                              ▼
                                                 [Telegram di HP Owner] 🔔
                                                              │
                                                              │ 4. Owner Swipe & Balas (Reply)
                                                              ▼
                                                 [TELEGRAM ESCALATION BRIDGE]
                                                              │
                                                              │ 5. Trigger event:
                                                              │ telegramService.onReply(...)
                                                              ▼
                                                 [Kirim Pesan ke WA Customer]
```

---

## 📂 2. Struktur File Backend yang Disiapkan

Semua file backend modular siap pakai berada di folder `src/`:

```
telegram-bridge/
├── index.js              # Export utama (tinggal import dari file ini)
├── telegramService.js    # Service bot Telegram (Long Polling, Kirim Alert, Tangkap Reply)
├── sessionStore.js       # Manajemen pemetaan pesan Telegram <-> Nomor Customer WA (Persisten ke JSON)
└── config.js             # Pengelola environment variable (Token & Chat ID)
```

---

## ⚙️ 3. Environment Variables (`.env`)

Tambahkan baris berikut ke file `.env` di aplikasi utama Anda:

```env
# Konfigurasi Telegram Escalation Bridge
TELEGRAM_BOT_TOKEN=8971813009:AAFwm5ZwK9gnddvchiSg_1ebpaNGmz6AUA0
ADMIN_CHAT_ID=7122296599
OWNER_PHONE_NUMBER=085210127796
```

---

## 📦 4. Dependensi yang Dibutuhkan

Pastikan di `package.json` aplikasi utama Anda terpasang library `grammy`:

```bash
npm install grammy dotenv
```

---

## 💻 5. Panduan Integrasi ke Kode Aplikasi Utama (`server.js`)

Cukup 3 langkah mudah untuk memasukkan modul ini ke aplikasi besar Anda:

### Langkah A: Import & Jalankan Polling saat Server Start

```javascript
import { telegramService } from "./path/to/telegram-bridge/index.js";

// Jalankan Telegram Bot listener saat server backend Anda start
async function startApp() {
  // ... kode startup server WA Anda ...

  // Mulai dengarkan pesan dari Telegram Owner
  await telegramService.startPolling();
  console.log("✅ Telegram Escalation Bridge aktif mendengarkan balasan Owner.");
}

startApp();
```

---

### Langkah B: Kirim Notifikasi jika Gemini AI Tidak Tahu Jawabannya

Di bagian logic penerimaan pesan WhatsApp dan pengecekan AI Anda:

```javascript
async function handleIncomingWhatsAppMessage(senderPhone, senderName, messageText) {
  // 1. Minta jawaban dari Gemini AI
  const aiResponse = await generateGeminiResponse(messageText);

  // 2. Cek apakah AI tidak tahu / butuh eskalasi ke manusia
  const isNeedHumanAgent = 
    aiResponse.includes("belum memiliki informasi") || 
    aiResponse.includes("hubungi admin") ||
    aiResponse.isFallback; // sesuaikan dengan flag aplikasi Anda

  if (isNeedHumanAgent) {
    // Beri pesan sementara ke customer WA
    await sendWhatsAppMessage(senderPhone, "Pertanyaan Anda sedang kami teruskan ke Admin. Mohon tunggu sebentar ya kak...");

    // KIRIM NOTIFIKASI KE TELEGRAM OWNER:
    await telegramService.sendEscalationAlert({
      customerPhone: senderPhone,
      customerName: senderName || "Customer",
      question: messageText,
      aiContext: "Pertanyaan di luar data AI Gemini"
    });

    return;
  }

  // Jika AI tahu, balas langsung ke WA
  await sendWhatsAppMessage(senderPhone, aiResponse);
}
```

---

### Langkah C: Tangkap Balasan dari Telegram dan Teruskan ke Customer WA

Daftarkan event listener `onReply` sekali saja di file utama server Anda:

```javascript
// Listener otomatis saat Owner membalas pesan di Telegram
telegramService.onReply(async ({ customerPhone, customerName, replyText, originalQuestion }) => {
  console.log(`[Escalation Bridge] Meneruskan balasan Owner ke ${customerPhone}: "${replyText}"`);

  // Panggil fungsi kirim pesan WhatsApp yang sudah ada di aplikasi Anda (Cloud API / Baileys / WABA):
  try {
    await sendWhatsAppMessage(customerPhone, replyText);
    console.log(`✅ Pesan berhasil dikirim ke WhatsApp ${customerPhone}`);
  } catch (error) {
    console.error(`❌ Gagal mengirim pesan ke WhatsApp ${customerPhone}:`, error.message);
  }
});
```

---

## 📚 6. Referensi Fungsi (API Reference)

### 1. `telegramService.startPolling()`
- **Fungsi**: Memulai koneksi Long Polling ke Telegram Bot API secara background.
- **Return**: `Promise<boolean>`

### 2. `telegramService.sendEscalationAlert(options)`
- **Parameter**:
  - `customerPhone` *(string, wajib)*: Nomor telepon customer (misal: `628123456789`).
  - `customerName` *(string, opsional)*: Nama customer.
  - `question` *(string, wajib)*: Pertanyaan asli dari customer.
  - `aiContext` *(string, opsional)*: Catatan mengapa dialihkan ke owner.
- **Return**: `Promise<{ success: boolean, messageId?: number, error?: string }>`

### 3. `telegramService.onReply(callback)`
- **Parameter Callback**: `async ({ customerPhone, customerName, replyText, originalMessageId, originalQuestion }) => {}`
- **Fungsi**: Dipanggil otomatis setiap kali Owner membalas pesan notifikasi di Telegram (mendukung Swipe Reply maupun ketik chat langsung).

---

## 🛡️ 7. Fitur Keandalan (Reliability Features)
1. **Fallback Otomatis**: Jika Owner lupa melakukan swipe-reply dan hanya mengetik chat biasa di bot, sistem otomatis mengaitkan jawaban ke customer terbaru yang aktif.
2. **Penyimpanan Persisten (`sessions.json`)**: Pemetaan nomor customer tidak akan hilang saat server restart.
3. **Multi-Session Safe**: Mendukung banyak customer bertanya di waktu bersamaan tanpa pesan tertukar.
