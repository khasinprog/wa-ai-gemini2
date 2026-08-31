with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'r', encoding='utf-8') as f:
    html = f.read()

# ── FIX 1: Panel chat konfirmasi — hapus display:flex konflik, ganti jadi hidden class ──
old_panel = '<div id="ff-chat-panel" style="display:none;position:fixed;top:0;right:0;width:360px;height:100vh;background:#fff;box-shadow:-4px 0 20px rgba(0,0,0,0.15);z-index:1000;display:flex;flex-direction:column">'
new_panel = '<div id="ff-chat-panel" style="display:none;position:fixed;top:0;right:0;width:360px;height:100vh;background:#fff;box-shadow:-4px 0 20px rgba(0,0,0,0.15);z-index:1000;flex-direction:column">'
if old_panel in html:
    html = html.replace(old_panel, new_panel, 1)
    print('FIX 1 OK: panel chat tidak auto-open lagi')
else:
    print('FIX 1 GAGAL')

# ── FIX 2: Rapikan header Fulfillment — tombol lebih kecil, layout lebih rapi ──
old_header = '''      <header style="background:var(--blue);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span style="font-weight:700;font-size:1rem;color:#fff">📬 Fulfillment</span>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="ff-filter-status" onchange="renderFulfillment()" style="padding:5px 10px;border-radius:6px;border:none;font-size:0.8rem">
            <option value="">Semua Status</option>
            <option value="order">🆕 Order</option>
            <option value="preparing">🔧 Preparing</option>
            <option value="submitted">📋 Submitted</option>
            <option value="request_komship">⏳ Request Komship</option>
            <option value="request_delivery">🚚 Request Delivery</option>
            <option value="on_delivery">📦 On Delivery</option>
            <option value="delivered">✅ Delivered</option>
            <option value="cancelled">❌ Cancelled</option>
          </select>
          <input id="ff-search" oninput="renderFulfillment()" placeholder="🔍 Cari nama/produk..." style="padding:5px 10px;border-radius:6px;border:none;font-size:0.8rem;width:160px">
          <button onclick="syncFulfillment()" style="padding:6px 12px;background:#fff;color:var(--blue);border:none;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer">🔄 Sync Order</button>
          <button onclick="processAllAI()" style="padding:6px 12px;background:#10b981;color:#fff;border:none;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer" id="btn-process-all">⚡ Proses AI</button>
        </div>
      </header>'''

new_header = '''      <div style="background:var(--blue);padding:10px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex-shrink:0">
        <span style="font-weight:700;font-size:1rem;color:#fff;margin-right:4px">📬 Fulfillment</span>
        <select id="ff-filter-status" onchange="renderFulfillment()" style="padding:4px 8px;border-radius:6px;border:none;font-size:0.78rem;flex:0 0 auto">
          <option value="">Semua Status</option>
          <option value="order">🆕 Order</option>
          <option value="preparing">🔧 Preparing</option>
          <option value="submitted">📋 Submitted</option>
          <option value="request_komship">⏳ Req. Komship</option>
          <option value="request_delivery">🚚 Req. Delivery</option>
          <option value="on_delivery">📦 On Delivery</option>
          <option value="delivered">✅ Delivered</option>
          <option value="cancelled">❌ Cancelled</option>
        </select>
        <input id="ff-search" oninput="renderFulfillment()" placeholder="🔍 Cari nama/produk..." style="padding:4px 8px;border-radius:6px;border:none;font-size:0.78rem;width:140px;flex:0 0 auto">
        <button onclick="syncFulfillment(this)" style="padding:5px 11px;background:#fff;color:var(--blue);border:none;border-radius:6px;font-size:0.78rem;font-weight:600;cursor:pointer;flex:0 0 auto">🔄 Sync</button>
        <button onclick="processAllAI()" id="btn-process-all" style="padding:5px 11px;background:#10b981;color:#fff;border:none;border-radius:6px;font-size:0.78rem;font-weight:600;cursor:pointer;flex:0 0 auto">⚡ Proses AI</button>
      </div>'''

if old_header in html:
    html = html.replace(old_header, new_header, 1)
    print('FIX 2 OK: header rapi')
else:
    print('FIX 2 GAGAL')

# ── FIX 3: Update fungsi showFfChat agar pakai display:flex ──
old_show = "  panel.style.display = 'flex';"
new_show = "  panel.style.display = 'flex';\n  panel.style.flexDirection = 'column';"
if old_show in html:
    html = html.replace(old_show, new_show, 1)
    print('FIX 3 OK: showFfChat fixed')
else:
    print('FIX 3 GAGAL')

# ── FIX 4: Perbaiki syncFulfillment agar terima parameter btn ──
old_sync = "async function syncFulfillment() {\n  const btn = event.target;"
new_sync = "async function syncFulfillment(btn) {\n  if (!btn) btn = document.querySelector('[onclick*=\"syncFulfillment\"]');"
if old_sync in html:
    html = html.replace(old_sync, new_sync, 1)
    print('FIX 4 OK: syncFulfillment param fixed')
else:
    print('FIX 4 GAGAL')

with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'w', encoding='utf-8') as f:
    f.write(html)
print('Disimpan.')
