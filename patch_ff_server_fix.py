with open('/Users/a1/Project/wa-ai-gemini2/server_edit.js', 'r', encoding='utf-8') as f:
    js = f.read()

# FIX: Hapus LEFT JOIN orders — cukup query fulfillment_orders langsung
# Semua data (nama, hp, alamat_asli) sudah dicopy saat sync
old_query = """app.get('/api/fulfillment', async (_, res) => {
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
});"""

new_query = """app.get('/api/fulfillment', async (_, res) => {
  try {
    const result = await db.pool.query(`
      SELECT * FROM fulfillment_orders
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});"""

if old_query in js:
    js = js.replace(old_query, new_query, 1)
    print('FIX OK: GET /api/fulfillment tidak pakai LEFT JOIN lagi')
else:
    print('GAGAL: string tidak match')

with open('/Users/a1/Project/wa-ai-gemini2/server_fixed.js', 'w', encoding='utf-8') as f:
    f.write(js)
print('Disimpan ke server_fixed.js')
