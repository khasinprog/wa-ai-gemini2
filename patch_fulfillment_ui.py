with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'r', encoding='utf-8') as f:
    html = f.read()

# ── PATCH 1: Tambah menu item Fulfillment di sidebar ──
old_menu = '      <div class="menu-item" id="menu-settings" onclick="switchMainView(\'settings\')">⚙️ Pengaturan</div>'
new_menu = '      <div class="menu-item" id="menu-fulfillment" onclick="switchMainView(\'fulfillment\')">📬 Fulfillment</div>\n      <div class="menu-item" id="menu-settings" onclick="switchMainView(\'settings\')">⚙️ Pengaturan</div>'
if old_menu in html:
    html = html.replace(old_menu, new_menu, 1)
    print('PATCH 1 OK: menu Fulfillment ditambahkan')
else:
    print('PATCH 1 GAGAL')

# ── PATCH 2: Tambah switchMainView case untuk fulfillment ──
old_switch = "  if (view === 'gambar') renderGambarList();\n}"
new_switch = "  if (view === 'gambar') renderGambarList();\n  if (view === 'fulfillment') initFulfillment();\n}"
if old_switch in html:
    html = html.replace(old_switch, new_switch, 1)
    print('PATCH 2 OK: switchMainView updated')
else:
    print('PATCH 2 GAGAL')

# ── PATCH 3: Tambah view-fulfillment HTML setelah view-data ──
old_view_end = '    <div id="view-data" class="view">'
new_fulfillment_view = '''    <div id="view-fulfillment" class="view">
      <header style="background:var(--blue);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
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
      </header>
      <div id="ff-progress" style="display:none;padding:8px 20px;background:#eff6ff;font-size:0.8rem;color:var(--blue);font-weight:500"></div>
      <div style="overflow-x:auto;padding:12px">
        <table style="width:100%;border-collapse:collapse;font-size:0.78rem;min-width:1100px">
          <thead>
            <tr style="background:#f1f5f9;text-align:left">
              <th style="padding:8px;border:1px solid #e2e8f0;white-space:nowrap">Nama</th>
              <th style="padding:8px;border:1px solid #e2e8f0">Telepon</th>
              <th style="padding:8px;border:1px solid #e2e8f0">Desa, Kec, Kab</th>
              <th style="padding:8px;border:1px solid #e2e8f0">Alamat Detail (120)</th>
              <th style="padding:8px;border:1px solid #e2e8f0">Produk</th>
              <th style="padding:8px;border:1px solid #e2e8f0;text-align:center">Harga</th>
              <th style="padding:8px;border:1px solid #e2e8f0;text-align:center">Qty</th>
              <th style="padding:8px;border:1px solid #e2e8f0">Status</th>
              <th style="padding:8px;border:1px solid #e2e8f0;text-align:center">Aksi</th>
            </tr>
          </thead>
          <tbody id="ff-tbody"></tbody>
        </table>
        <div id="ff-empty" style="text-align:center;padding:40px;color:#94a3b8;display:none">
          Belum ada data. Klik <b>Sync Order</b> untuk menarik data dari tabel order.
        </div>
      </div>
      <!-- Panel Chat Konfirmasi -->
      <div id="ff-chat-panel" style="display:none;position:fixed;top:0;right:0;width:360px;height:100vh;background:#fff;box-shadow:-4px 0 20px rgba(0,0,0,0.15);z-index:1000;display:flex;flex-direction:column">
        <div style="padding:14px 16px;background:var(--blue);color:#fff;display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600;font-size:0.9rem" id="ff-chat-title">Chat Konfirmasi</span>
          <button onclick="closeFfChat()" style="background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer">&times;</button>
        </div>
        <div id="ff-chat-body" style="flex:1;overflow-y:auto;padding:14px;font-size:0.82rem;line-height:1.6;white-space:pre-wrap;color:#374151;background:#f9fafb"></div>
      </div>
    </div>

'''
if old_view_end in html:
    html = html.replace(old_view_end, new_fulfillment_view + old_view_end, 1)
    print('PATCH 3 OK: view-fulfillment ditambahkan')
else:
    print('PATCH 3 GAGAL')

# ── PATCH 4: Tambah JavaScript Fulfillment sebelum </script> terakhir ──
FF_JS = """
// ═══════════════════════════════════════════════════════════
// FULFILLMENT MODULE
// ═══════════════════════════════════════════════════════════
let ffData = [];

const FF_STATUS = {
  order:            { label: '🆕 Order',            color: '#dbeafe', text: '#1e40af' },
  preparing:        { label: '🔧 Preparing',         color: '#fef3c7', text: '#92400e' },
  submitted:        { label: '📋 Submitted',         color: '#e0e7ff', text: '#3730a3' },
  request_komship:  { label: '⏳ Req. Komship',      color: '#fce7f3', text: '#9d174d' },
  request_delivery: { label: '🚚 Req. Delivery',     color: '#d1fae5', text: '#065f46' },
  on_delivery:      { label: '📦 On Delivery',       color: '#cffafe', text: '#164e63' },
  delivered:        { label: '✅ Delivered',          color: '#dcfce7', text: '#14532d' },
  cancelled:        { label: '❌ Cancelled',          color: '#fee2e2', text: '#7f1d1d' },
};
const FF_NEXT = {
  order: 'preparing', preparing: 'submitted', submitted: 'request_komship',
  request_komship: 'request_delivery', request_delivery: 'on_delivery',
  on_delivery: 'delivered'
};

async function initFulfillment() {
  await loadFulfillment();
}

async function loadFulfillment() {
  try {
    const res = await fetch('/api/fulfillment');
    ffData = await res.json();
    renderFulfillment();
  } catch(e) {
    console.error('Load fulfillment error:', e);
  }
}

function renderFulfillment() {
  const filterStatus = document.getElementById('ff-filter-status')?.value || '';
  const search = (document.getElementById('ff-search')?.value || '').toLowerCase();
  const tbody = document.getElementById('ff-tbody');
  const empty = document.getElementById('ff-empty');
  if (!tbody) return;

  let rows = ffData;
  if (filterStatus) rows = rows.filter(r => r.status_fulfillment === filterStatus);
  if (search) rows = rows.filter(r =>
    (r.nama||'').toLowerCase().includes(search) ||
    (r.produk||'').toLowerCase().includes(search) ||
    (r.hp||'').includes(search)
  );

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = rows.map(r => {
    const st = FF_STATUS[r.status_fulfillment] || { label: r.status_fulfillment, color: '#f1f5f9', text: '#374151' };
    const aiDone = r.ai_processed;
    const harga = r.harga ? 'Rp' + Number(r.harga).toLocaleString('id-ID') : '-';
    const nextSt = FF_NEXT[r.status_fulfillment];
    const nextLabel = nextSt ? (FF_STATUS[nextSt]?.label || nextSt) : null;

    return \`<tr style="border-bottom:1px solid #f1f5f9;\${r.status_fulfillment==='cancelled'?'opacity:0.6':''}">
      <td style="padding:8px;border:1px solid #e2e8f0;font-weight:600;min-width:120px">\${r.nama||'-'}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;white-space:nowrap">\${r.hp||'-'}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;min-width:160px">
        \${aiDone ? (r.alamat_desa_kec_kab||'-') : '<span style="color:#94a3b8;font-style:italic">Belum diproses AI</span>'}
      </td>
      <td style="padding:8px;border:1px solid #e2e8f0;min-width:180px;font-size:0.75rem">
        \${aiDone ? (r.alamat_detail_120||'-') : '<span style="color:#94a3b8;font-style:italic">-</span>'}
      </td>
      <td style="padding:8px;border:1px solid #e2e8f0;min-width:150px">
        \${aiDone ? (r.produk||'-') : (r.produk||'-')}
      </td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center;white-space:nowrap">\${harga}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center">\${r.qty||1}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center">
        <span style="background:\${st.color};color:\${st.text};padding:3px 8px;border-radius:12px;font-size:0.72rem;font-weight:600;white-space:nowrap">\${st.label}</span>
      </td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center;white-space:nowrap">
        <div style="display:flex;flex-direction:column;gap:4px;align-items:center">
          \${!aiDone ? \`<button onclick="processSingleAI(\${r.id})" style="padding:3px 8px;background:#8b5cf6;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer">⚡ AI</button>\` : ''}
          \${r.chat_konfirmasi ? \`<button onclick="showFfChat(\${r.id})" style="padding:3px 8px;background:#0ea5e9;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer">💬 Chat</button>\` : ''}
          \${nextLabel ? \`<button onclick="advanceFfStatus(\${r.id},'${nextSt}')" style="padding:3px 8px;background:#10b981;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer">→ \${nextLabel}</button>\` : ''}
          \${r.status_fulfillment !== 'cancelled' && r.status_fulfillment !== 'delivered' ? \`<button onclick="advanceFfStatus(\${r.id},'cancelled')" style="padding:3px 8px;background:#ef4444;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer">✕ Cancel</button>\` : ''}
        </div>
      </td>
    </tr>\`;
  }).join('');
}

async function syncFulfillment() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = '⏳ Sync...';
  try {
    const res = await fetch('/api/fulfillment/sync', { method: 'POST' });
    const d = await res.json();
    alert(\`Sync selesai!\\nDitambahkan: \${d.inserted}\\nSudah ada: \${d.skipped}\\nTotal: \${d.total}\`);
    await loadFulfillment();
  } catch(e) { alert('Sync gagal: ' + e.message); }
  btn.disabled = false; btn.textContent = '🔄 Sync Order';
}

async function processSingleAI(id) {
  const prog = document.getElementById('ff-progress');
  prog.style.display = 'block';
  prog.textContent = '⚡ Memproses AI untuk 1 order...';
  try {
    await fetch(\`/api/fulfillment/\${id}/process-ai\`, { method: 'POST' });
    await loadFulfillment();
    prog.textContent = '✅ Selesai!';
    setTimeout(() => prog.style.display = 'none', 2000);
  } catch(e) {
    prog.textContent = '❌ Error: ' + e.message;
    setTimeout(() => prog.style.display = 'none', 3000);
  }
}

async function processAllAI() {
  const pending = ffData.filter(r => !r.ai_processed);
  if (!pending.length) { alert('Semua order sudah diproses AI.'); return; }
  if (!confirm(\`Proses AI untuk \${pending.length} order?\\nWaktu estimasi: ~\${Math.ceil(pending.length*4/60)} menit (15 RPM limit)\`)) return;

  const btn = document.getElementById('btn-process-all');
  const prog = document.getElementById('ff-progress');
  btn.disabled = true;
  prog.style.display = 'block';

  for (let i = 0; i < pending.length; i++) {
    const r = pending[i];
    prog.textContent = \`⚡ Memproses \${i+1}/\${pending.length}: \${r.nama}...\`;
    try {
      await fetch(\`/api/fulfillment/\${r.id}/process-ai\`, { method: 'POST' });
    } catch(e) {
      console.error('AI error for', r.id, e);
    }
    // Delay 4 detik antar request (aman untuk 15 RPM)
    if (i < pending.length - 1) await new Promise(resolve => setTimeout(resolve, 4000));
  }

  await loadFulfillment();
  prog.textContent = \`✅ Selesai! \${pending.length} order diproses.\`;
  btn.disabled = false;
  setTimeout(() => prog.style.display = 'none', 3000);
}

async function advanceFfStatus(id, status) {
  try {
    await fetch(\`/api/fulfillment/\${id}/status\`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const idx = ffData.findIndex(r => r.id === id);
    if (idx >= 0) ffData[idx].status_fulfillment = status;
    renderFulfillment();
  } catch(e) { alert('Gagal update status: ' + e.message); }
}

function showFfChat(id) {
  const r = ffData.find(r => r.id === id);
  if (!r) return;
  const panel = document.getElementById('ff-chat-panel');
  document.getElementById('ff-chat-title').textContent = '💬 Chat — ' + (r.nama||r.hp);
  document.getElementById('ff-chat-body').textContent = r.chat_konfirmasi || '(tidak ada chat konfirmasi)';
  panel.style.display = 'flex';
}

function closeFfChat() {
  document.getElementById('ff-chat-panel').style.display = 'none';
}
"""

# Sisipkan sebelum </script> terakhir
last_script = html.rfind('</script>')
if last_script >= 0:
    html = html[:last_script] + FF_JS + '\n' + html[last_script:]
    print('PATCH 4 OK: JavaScript Fulfillment ditambahkan')
else:
    print('PATCH 4 GAGAL')

with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'w', encoding='utf-8') as f:
    f.write(html)
print('index_edit.html disimpan.')
