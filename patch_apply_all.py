# ══════════════════════════════════════════════════════════
# PATCH server_latest.js — tambah fulfillment endpoints
# ══════════════════════════════════════════════════════════
with open('/Users/a1/Project/wa-ai-gemini2/server_latest.js', 'r', encoding='utf-8') as f:
    js = f.read()

FULFILLMENT_ENDPOINTS = r"""
// ═══════════════════════════════════════════════════════════════
// FULFILLMENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// GET semua fulfillment orders
app.get('/api/fulfillment', async (_, res) => {
  try {
    const result = await db.pool.query(`
      SELECT * FROM fulfillment_orders ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST sync: tarik semua order unik dari orders ke fulfillment (skip yang sudah ada)
app.post('/api/fulfillment/sync', async (_, res) => {
  try {
    const ordersRes = await db.pool.query(`
      SELECT DISTINCT ON (wa_id) id, wa_id, nama, hp, produk, alamat, ai_alamat, status, created_at
      FROM orders ORDER BY wa_id, created_at DESC
    `);
    const statusMap = { order:'order', diproses:'preparing', terkirim:'delivered', batal:'cancelled' };
    let inserted = 0, skipped = 0;
    for (const o of ordersRes.rows) {
      const exists = await db.pool.query(
        'SELECT id FROM fulfillment_orders WHERE order_wa_id=$1 LIMIT 1', [o.wa_id]
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

// POST proses AI untuk 1 fulfillment order
app.post('/api/fulfillment/:id/process-ai', async (req, res) => {
  const { id } = req.params;
  try {
    const fRes = await db.pool.query('SELECT * FROM fulfillment_orders WHERE id=$1', [id]);
    if (!fRes.rows.length) return res.status(404).json({ error: 'Not found' });
    const f = fRes.rows[0];

    // Ambil riwayat chat customer
    const numOnly = f.order_wa_id.replace(/\D/g, '');
    const msgRes = await db.pool.query(`
      SELECT body, ai_reply, timestamp FROM messages
      WHERE wa_id LIKE $1
      ORDER BY timestamp DESC LIMIT 40
    `, [numOnly + '%']);
    const chatHistory = msgRes.rows.map(m =>
      `[${new Date(m.timestamp).toLocaleTimeString('id-ID')}] Customer: ${m.body || ''}\nAI: ${m.ai_reply || ''}`
    ).join('\n\n');

    const geminiKey = process.env.GEMINI_API_KEY_1 || '';
    if (!geminiKey) return res.status(500).json({ error: 'Gemini key tidak ada' });

    // Pakai model dari settings (sama seperti endpoint lain)
    const modelName = settings.modelName || 'gemini-3.5-flash-lite';

    const prompt = `Kamu adalah asisten ekstraksi data order COD Indonesia.

Data order:
- Nama: ${f.nama}
- Produk (raw): ${f.produk}
- Alamat asli customer: ${f.alamat_asli}

Riwayat chat (terbaru di atas):
${chatHistory || '(tidak ada)'}

Tugas: ekstrak dan kembalikan JSON berikut SAJA (tanpa markdown, tanpa penjelasan):
{
  "alamat_desa_kec_kab": "nama desa/kelurahan, kecamatan, kabupaten/kota — untuk search di Komship",
  "alamat_detail_120": "alamat lengkap maksimal 120 karakter untuk kurir",
  "produk": "nama produk bersih + varian wajib (contoh: Baby Walking Assistant - Pink)",
  "harga": 95000,
  "qty": 1,
  "chat_konfirmasi": "kutip bagian chat konfirmasi nama/alamat/produk/harga (max 500 karakter)"
}

Catatan:
- alamat_desa_kec_kab: HANYA desa/kel + kecamatan + kab/kota, pisah koma
- alamat_detail_120: WAJIB max 120 karakter
- harga: angka saja tanpa Rp (contoh: 95000)
- qty: 1 jika tidak disebutkan, angka jika customer sebut jumlah
- produk: wajib cantumkan varian warna jika ada`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini HTTP error:', geminiRes.status, errText.substring(0, 200));
      throw new Error('Gemini API error HTTP ' + geminiRes.status + ': ' + errText.substring(0, 100));
    }

    const geminiData = await geminiRes.json();
    const rawCandidate = geminiData?.candidates?.[0];
    if (!rawCandidate) throw new Error('Gemini tidak mengembalikan kandidat');

    const raw = rawCandidate?.content?.parts?.[0]?.text || '';
    if (!raw) throw new Error('Gemini mengembalikan teks kosong');

    // Ekstrak JSON dari response
    let clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Gemini tidak mengembalikan JSON valid: ' + clean.substring(0, 150));
    clean = jsonMatch[0];

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch(e) { throw new Error('JSON parse error: ' + e.message + ' — raw: ' + clean.substring(0, 100)); }

    // Simpan hasil ke DB
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
    console.error('Fulfillment AI error id=' + id + ':', e.message);
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH update field manual
app.patch('/api/fulfillment/:id', async (req, res) => {
  const { id } = req.params;
  const allowed = ['nama','hp','produk','harga','qty','ekspedisi','alamat_desa_kec_kab','alamat_detail_120'];
  const updates = [], vals = [];
  let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) { updates.push(`${k}=$${i++}`); vals.push(req.body[k]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
  vals.push(id);
  try {
    await db.pool.query(
      `UPDATE fulfillment_orders SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${i}`, vals
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

"""

TARGET = 'server.listen(PORT'
if TARGET in js:
    js = js.replace(TARGET, FULFILLMENT_ENDPOINTS + TARGET, 1)
    print('SERVER PATCH OK: fulfillment endpoints ditambahkan')
else:
    print('SERVER PATCH GAGAL: target tidak ditemukan')

with open('/Users/a1/Project/wa-ai-gemini2/server_patched.js', 'w', encoding='utf-8') as f:
    f.write(js)
print('Disimpan ke server_patched.js')
