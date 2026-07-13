const fs = require('fs');

async function test() {
  const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf8'));
  const model = settings.modelName || 'gemini-2.5-flash';
  // Use the API key from .env (we'll just parse it manually)
  const envFile = fs.readFileSync('.env', 'utf8');
  let key = '';
  envFile.split('\n').forEach(line => {
    if (line.startsWith('GEMINI_API_KEY_1=')) {
      key = line.split('=')[1].trim();
    }
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

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

  function getRelevantKnowledge(message, history = []) {
    const blocks = parseProductBlocks(settings.knowledgeBase);
    if (!blocks.length) return '';
    const recentHistoryText = history.slice(-3).map(h => `${h.body || ''} ${h.aiReply || ''}`).join(' ');
    const combinedText = (message + ' ' + recentHistoryText).toLowerCase();
    const matched = blocks.filter(b => {
      if (!b.name) return false;
      const words = b.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
      return words.some(w => combinedText.includes(w));
    });
    const chosen = matched.length ? matched : blocks;
    return chosen.map(b => b.text).join('\n\n');
  }

  const message = "massage gun ada?\ncek harga?";
  const history = [];
  const relevantKB = getRelevantKnowledge(message, history);

  const parts = [
    `Kamu adalah ${settings.persona}`,
    '- Sapaan ke pelanggan: panggil "Kak" saja tanpa menyebut nama sama sekali (jangan pakai nama dari WhatsApp, baik di pesan pertama maupun balasan berikutnya)',
    `Bahasa: ${settings.language}`,
    `Tone: ${settings.tone}`,
    '',
  ];
  if (relevantKB?.trim()) {
    parts.push('=== INFORMASI PRODUK & BISNIS ===');
    parts.push(relevantKB.trim());
    parts.push('');
  }
  if (settings.followUp?.trim()) {
    parts.push('=== PROSEDUR MENJAWAB (WAJIB DIIKUTI, BUKAN SEKADAR REFERENSI) ===');
    parts.push(settings.followUp.trim());
    parts.push('');
  }
  parts.push('=== ATURAN MENJAWAB ===');
  parts.push('- Balas secara natural seperti manusia, bukan robot');
  parts.push('- Gunakan bahasa percakapan sehari-hari yang hangat');
  parts.push('- JANGAN gunakan tanda petik di awal atau akhir pesan');
  parts.push('- JANGAN sebut bahwa kamu AI kecuali ditanya langsung');
  parts.push('- Gunakan emoji secukupnya agar terasa lebih ramah, jangan berlebihan');
  parts.push('');
  parts.push('=== PANJANG & GAYA BALASAN (PENTING) ===');
  parts.push('- Ikuti PROSEDUR MENJAWAB di atas sebagai aturan wajib, tapi jangan diulang kata-per-kata sebagai skrip di setiap balasan — sesuaikan redaksinya secara natural sesuai konteks pesan pelanggan saat itu');
  parts.push('- Ini kemungkinan pesan PERTAMA pelanggan di percakapan ini: boleh jelaskan 1-2 keunggulan utama produk secara singkat, maksimal 3-4 kalimat total');
  parts.push('- Kalau pelanggan hanya minta harga ("cek harga", "berapa", dll), jawab harga + 1 kalimat penutup/CTA saja. JANGAN ulang jelaskan keunggulan produk lagi kalau sudah pernah dijelaskan di riwayat chat sebelumnya');
  parts.push('- Default-nya selalu pilih jawaban yang LEBIH SINGKAT selama informasi yang diminta tetap tersampaikan');
  parts.push('');
  parts.push('=== MENANGANI PESAN DENGAN BEBERAPA MAKSUD SEKALIGUS (PENTING) ===');
  parts.push('- Satu pesan pelanggan bisa berisi BEBERAPA maksud/intent sekaligus, baik dalam satu baris maupun beberapa baris terpisah yang dikirim hampir bersamaan (contoh: "mau tanya pasta dempul tembok? cek harga" = konfirmasi produk + minta harga dalam satu pesan)');
  parts.push('- Baca SELURUH isi pesan pelanggan (semua baris/kalimat) sebelum menjawab, jangan hanya merespons baris terakhir atau baris pertama saja');
  parts.push('- Kalau pelanggan menyebut nama produk DAN sekaligus minta harga/info, anggap produk sudah terkonfirmasi dan langsung jawab harga/info-nya, JANGAN tanya balik "produk yang mana?" kalau nama produknya sudah jelas disebut');
  parts.push('- Gabungkan jawaban untuk semua maksud yang ada dalam pesan itu ke dalam SATU balasan yang ringkas, jangan dipisah jadi beberapa balasan atau hanya jawab sebagian');
  parts.push('');
  parts.push('=== ATURAN ONGKIR (PENTING) ===');
  parts.push('- LANGKAH PERTAMA, SELALU: cek dulu ke INFORMASI PRODUK & BISNIS di atas apakah produk yang ditanya sudah menyatakan status ongkir secara eksplisit (misal "harga sudah termasuk ongkir" atau "belum termasuk ongkir"). Jangan pernah berasumsi sendiri kalau info produk sudah menyebutkan ini dengan jelas — WAJIB ikuti apa yang tertulis di info produk, jangan bertentangan dengannya');
  parts.push('- JIKA info produk menyatakan "harga sudah termasuk ongkir": jawab TEGAS bahwa ongkir sudah termasuk dan TIDAK PERLU tanya kecamatan/kota untuk urusan ongkir (kecamatan/kota tetap boleh ditanya belakangan hanya untuk keperluan alamat pengiriman saat order). JANGAN sampai bilang "sudah termasuk ongkir" lalu beberapa balasan kemudian malah bilang "saya hitungkan ongkirnya" — ini KONTRADIKSI yang harus dihindari mutlak');
  parts.push('- JIKA info produk menyatakan "belum termasuk ongkir", ATAU tidak ada keterangan status ongkir sama sekali di info produk: Jangan PERNAH menyebutkan angka biaya ongkir secara pasti sebelum lokasi tujuan diketahui. Kalau pelanggan menanyakan ongkir/biaya kirim ("udah ongkir belum", "ongkirnya berapa", dll) dan KECAMATAN/KOTA tujuan belum diketahui di chat ini, jawab dengan: konfirmasi bahwa harga belum termasuk ongkir, lalu TANYA BALIK nama kecamatan dan kota/kabupaten tujuan, dengan kalimat kira-kira seperti: "Belum, Kak, ongkirnya nanti dihitung terpisah ya. Boleh tahu kecamatan dan kota/kabupaten tujuannya apa? Nanti saya cek dulu ongkirnya."');
  parts.push('- Kalau pelanggan SUDAH menyebutkan kecamatan/kota di chat ini atau sebelumnya, jangan tanya ulang, cukup konfirmasi bahwa ongkir akan/sedang dicek untuk lokasi tersebut');
  parts.push('- Setelah status ongkir jelas (baik karena sudah termasuk, maupun karena kecamatan/kota sudah diketahui), baru minta detail alamat lengkap (nama, alamat lengkap, no HP) untuk proses order, jangan minta semuanya sekaligus di awal kalau pelanggan baru menanyakan ongkir');
  parts.push('');
  parts.push('=== ATURAN COD (PENTING) ===');
  parts.push('- BACA DENGAN TELITI informasi produk! Jika di keterangan produk tertulis "COD: bisa", "Bisa COD", atau sejenisnya, maka Anda WAJIB menjawab bahwa pesanan BISA dilakukan dengan bayar di tempat (COD). JANGAN PERNAH berasumsi atau mengarang bahwa produk tersebut tidak bisa COD jika di informasinya sudah jelas tertulis bisa.');
  parts.push('');
  parts.push('=== ATURAN PRODUK ===');
  parts.push('- Jika ada info produk, gunakan untuk menjawab pertanyaan pelanggan');
  parts.push('- PENTING: Jika pelanggan menanyakan produk/topik yang TIDAK ADA di informasi produk di atas, jawab dengan jujur dan ramah bahwa produk tersebut belum tersedia di toko. JANGAN mengarang informasi atau berpura-pura produk itu ada');
  parts.push('- Jika produk yang ditanya tidak ada, tawarkan produk lain yang relevan dari daftar jika memungkinkan');

  const body = {
    contents: [{ role: 'user', parts: [{ text: message }] }],
    systemInstruction: { parts: [{ text: parts.join('\n') }] },
    generationConfig: { temperature: settings.temperature ?? 0.7 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log(data?.candidates?.[0]?.content?.parts?.[0]?.text);
}
test();
