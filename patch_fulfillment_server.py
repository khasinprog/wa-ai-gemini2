import re

with open('/Users/a1/Project/wa-ai-gemini2/server_edit.js', 'r', encoding='utf-8') as f:
    js = f.read()

NEW_ENDPOINTS = r"""
// ═══════════════════════════════════════════════════════════════
// FULFILLMENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// GET semua fulfillment orders (join dengan orders)
app.get('/api/fulfillment', async (_, res) => {
  try {
    const result = await db.pool.query(`
      SELECT f.*, o.alamat as alamat_asli_raw, o.ai_alamat, o.ai_cod
      FROM fulfillment_orders f
      LEFT JOIN orders o ON o.wa_id = f.order_wa_id
      ORDER BY f.created_at DESC
    `);
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST sync: tarik semua order dari tabel orders ke fulfillment (skip yang sudah ada)
app.post('/api/fulfillment/sync', async (_, res) => {
  try {
    // Ambil semua order unik (DISTINCT ON wa_id, ambil terbaru)
    const ordersRes = await db.pool.query(`
      SELECT DISTINCT ON (wa_id) id, wa_id, nama, hp, produk, alamat, ai_alamat, ai_cod, status, created_at
      FROM orders
      ORDER BY wa_id, created_at DESC
    `);

    const statusMap = {
      'order':     'order',
      'diproses':  'preparing',
      'terkirim':  'delivered',
      'batal':     'cancelled'
    };

    let inserted = 0, skipped = 0;
    for (const o of ordersRes.rows) {
      // Cek apakah sudah ada di fulfillment
      const exists = await db.pool.query(
        'SELECT id FROM fulfillment_orders WHERE order_wa_id = $1 LIMIT 1',
        [o.wa_id]
      );
      if (exists.rows.length > 0) { skipped++; continue; }

      const sf = statusMap[o.status] || 'order';
      await db.pool.query(`
        INSERT INTO fulfillment_orders
          (order_wa_id, order_ref_id, nama, hp, alamat_asli, produk, status_fulfillment, ekspedisi, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'komship',$8,NOW())
      `, [o.wa_id, String(o.id), o.nama, o.hp, o.alamat || o.ai_alamat || '', o.produk, sf, o.created_at]);
      inserted++;
    }
    res.json({ inserted, skipped, total: ordersRes.rows.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST proses AI untuk 1 fulfillment order (extract alamat, produk, harga, qty)
app.post('/api/fulfillment/:id/process-ai', async (req, res) => {
  const { id } = req.params;
  try {
    const fRes = await db.pool.query('SELECT * FROM fulfillment_orders WHERE id=$1', [id]);
    if (!fRes.rows.length) return res.status(404).json({ error: 'Not found' });
    const f = fRes.rows[0];

    // Ambil chat konfirmasi dari messages
    const msgRes = await db.pool.query(`
      SELECT body, ai_reply, timestamp FROM messages
      WHERE wa_id=$1 OR wa_id LIKE $2
      ORDER BY timestamp DESC LIMIT 30
    `, [f.order_wa_id, f.order_wa_id.replace('@s.whatsapp.net','').replace('@c.us','') + '%']);
    const chatHistory = msgRes.rows.map(m =>
      `[${new Date(m.timestamp).toLocaleTimeString('id-ID')}] Customer: ${m.body || ''}\nAI: ${m.ai_reply || ''}`
    ).join('\n\n');

    // Ambil key Gemini aktif
    const geminiKey = process.env.GEMINI_API_KEY_1 || '';
    if (!geminiKey) return res.status(500).json({ error: 'Gemini key tidak ada' });

    const prompt = `Kamu adalah asisten ekstraksi data order COD Indonesia.

Data order:
- Nama: ${f.nama}
- Produk (raw): ${f.produk}
- Alamat asli customer: ${f.alamat_asli}

Riwayat chat (terbaru di atas):
${chatHistory || '(tidak ada)'}

Tugas kamu: ekstrak dan kembalikan JSON berikut (tanpa markdown, tanpa penjelasan, JSON saja):
{
  "alamat_desa_kec_kab": "nama desa/kelurahan, kecamatan, kabupaten/kota - format untuk search di Komship",
  "alamat_detail_120": "alamat lengkap maksimal 120 karakter, padat dan jelas untuk kurir",
  "produk": "nama produk bersih + varian wajib (contoh: Baby Walking Assistant - Pink)",
  "harga": 95000,
  "qty": 1,
  "chat_konfirmasi": "kutip bagian chat yang berisi konfirmasi nama, alamat, produk, harga (max 500 karakter)"
}

Catatan:
- alamat_desa_kec_kab: hanya desa/kel + kecamatan + kab/kota, pisah koma
- alamat_detail_120: WAJIB max 120 karakter, potong jika perlu
- harga: angka saja tanpa Rp atau titik (contoh: 95000)
- qty: 1 jika tidak disebutkan, angka jika customer sebut "mau 2", "pesan 3", dll
- produk: wajib ada varian warna jika ada di chat atau produk raw`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const geminiData = await geminiRes.json();
    const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Simpan hasil AI ke DB
    await db.pool.query(`
      UPDATE fulfillment_orders SET
        alamat_desa_kec_kab = $1,
        alamat_detail_120   = $2,
        produk              = $3,
        harga               = $4,
        qty                 = $5,
        chat_konfirmasi     = $6,
        ai_processed        = TRUE,
        ai_processed_at     = NOW(),
        updated_at          = NOW()
      WHERE id = $7
    `, [
      parsed.alamat_desa_kec_kab || '',
      (parsed.alamat_detail_120 || '').substring(0, 120),
      parsed.produk || f.produk,
      parseInt(parsed.harga) || 0,
      parseInt(parsed.qty) || 1,
      parsed.chat_konfirmasi || '',
      id
    ]);

    const updated = await db.pool.query('SELECT * FROM fulfillment_orders WHERE id=$1', [id]);
    res.json(updated.rows[0]);
  } catch(e) {
    console.error('Fulfillment AI error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH update status fulfillment
app.patch('/api/fulfillment/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const valid = ['order','preparing','submitted','request_komship','request_delivery','on_delivery','delivered','cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Status tidak valid' });
  try {
    await db.pool.query(
      'UPDATE fulfillment_orders SET status_fulfillment=$1, updated_at=NOW() WHERE id=$2',
      [status, id]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH update field manual (nama, hp, produk, harga, qty, ekspedisi)
app.patch('/api/fulfillment/:id', async (req, res) => {
  const { id } = req.params;
  const allowed = ['nama','hp','produk','harga','qty','ekspedisi','alamat_desa_kec_kab','alamat_detail_120'];
  const updates = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      updates.push(`${k}=$${i++}`);
      vals.push(req.body[k]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
  vals.push(id);
  try {
    await db.pool.query(
      `UPDATE fulfillment_orders SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${i}`,
      vals
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

"""

# Sisipkan sebelum server.listen
TARGET = "server.listen(PORT"
if TARGET in js:
    js = js.replace(TARGET, NEW_ENDPOINTS + TARGET, 1)
    print("PATCH OK: endpoint fulfillment ditambahkan")
else:
    print("GAGAL: target tidak ditemukan")

with open('/Users/a1/Project/wa-ai-gemini2/server_edit.js', 'w', encoding='utf-8') as f:
    f.write(js)
print("server_edit.js disimpan.")
