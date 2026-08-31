with open('/Users/a1/Project/wa-ai-gemini2/public/index_latest.html', 'r', encoding='utf-8') as f:
    html = f.read()

results = []

# ══════════════════════════════════════════════════
# PATCH 1: Tambah menu Fulfillment di sidebar
# ══════════════════════════════════════════════════
old = '      <div class="menu-item" id="menu-settings" onclick="switchMainView(\'settings\')">⚙️ Pengaturan</div>'
new = '      <div class="menu-item" id="menu-fulfillment" onclick="switchMainView(\'fulfillment\')">📬 Fulfillment</div>\n      <div class="menu-item" id="menu-settings" onclick="switchMainView(\'settings\')">⚙️ Pengaturan</div>'
if old in html:
    html = html.replace(old, new, 1); results.append('P1 OK: menu Fulfillment')
else:
    results.append('P1 GAGAL: menu Fulfillment')

# ══════════════════════════════════════════════════
# PATCH 2: Tambah case fulfillment di switchMainView
# ══════════════════════════════════════════════════
old = "  if (view === 'gambar') renderGambarList();\n}"
new = "  if (view === 'gambar') renderGambarList();\n  if (view === 'fulfillment') initFulfillment();\n}"
if old in html:
    html = html.replace(old, new, 1); results.append('P2 OK: switchMainView')
else:
    results.append('P2 GAGAL: switchMainView')

# ══════════════════════════════════════════════════
# PATCH 3: Tambah view-fulfillment HTML sebelum view-data
# ══════════════════════════════════════════════════
FULFILLMENT_VIEW = '''    <div id="view-fulfillment" class="view" style="flex-direction:column;height:100%;overflow:hidden">
      <div style="background:var(--blue);padding:10px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex-shrink:0">
        <span style="font-weight:700;font-size:1rem;color:#fff;margin-right:4px">📬 Fulfillment</span>
        <select id="ff-filter-status" onchange="renderFulfillment()" style="padding:4px 8px;border-radius:6px;border:none;font-size:0.78rem">
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
        <input id="ff-search" oninput="renderFulfillment()" placeholder="🔍 Cari nama/produk..." style="padding:4px 8px;border-radius:6px;border:none;font-size:0.78rem;width:140px">
        <button onclick="syncFulfillment(this)" style="padding:5px 11px;background:#fff;color:var(--blue);border:none;border-radius:6px;font-size:0.78rem;font-weight:600;cursor:pointer">🔄 Sync</button>
        <button onclick="processAllAI()" id="btn-process-all" style="padding:5px 11px;background:#10b981;color:#fff;border:none;border-radius:6px;font-size:0.78rem;font-weight:600;cursor:pointer">⚡ Proses AI</button>
      </div>
      <div id="ff-progress" style="display:none;padding:7px 16px;background:#eff6ff;font-size:0.8rem;color:var(--blue);font-weight:500;flex-shrink:0"></div>
      <div style="overflow:auto;padding:12px;flex:1;min-height:0">
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
          Belum ada data. Klik <b>🔄 Sync</b> untuk menarik data dari tabel order.
        </div>
      </div>
      <div id="ff-chat-panel" style="display:none;position:fixed;top:0;right:0;width:360px;height:100vh;background:#fff;box-shadow:-4px 0 20px rgba(0,0,0,0.15);z-index:1000;flex-direction:column">
        <div style="padding:14px 16px;background:var(--blue);color:#fff;display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          <span style="font-weight:600;font-size:0.9rem" id="ff-chat-title">Chat Konfirmasi</span>
          <button onclick="closeFfChat()" style="background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer">&times;</button>
        </div>
        <div id="ff-chat-body" style="flex:1;overflow-y:auto;padding:14px;font-size:0.82rem;line-height:1.6;white-space:pre-wrap;color:#374151;background:#f9fafb"></div>
      </div>
    </div>

'''

old = '    <div id="view-data" class="view">'
if old in html:
    html = html.replace(old, FULFILLMENT_VIEW + old, 1); results.append('P3 OK: view-fulfillment HTML')
else:
    results.append('P3 GAGAL: view-data tidak ditemukan')

# ══════════════════════════════════════════════════
# PATCH 4: Tambah tombol Chat di kolom order
# ══════════════════════════════════════════════════
old = '      <td>\n        <button class="btn-red" onclick="deleteOrder(\'${o.id}\')">Hapus</button>\n      </td>'
new = '      <td style="white-space:nowrap;min-width:80px">\n        <button onclick="openChatFromOrder(\'${o.hp}\',\'${o.nama}\')" style="margin-bottom:5px;display:block;width:100%;padding:5px 8px;border-radius:6px;border:1px solid var(--blue);background:#eff6ff;color:var(--blue);font-size:0.75rem;font-weight:600;cursor:pointer;">💬 Chat</button>\n        <button class="btn-red" onclick="deleteOrder(\'${o.id}\')">Hapus</button>\n      </td>'
if old in html:
    html = html.replace(old, new, 1); results.append('P4 OK: tombol Chat di order')
else:
    results.append('P4 GAGAL: tombol order tidak ditemukan')

# ══════════════════════════════════════════════════
# PATCH 5: Tambah JS (openChatFromOrder + Fulfillment module)
#          sebelum </script> terakhir
# ══════════════════════════════════════════════════
FF_JS = r"""
// ═══════════════════════════════════════════════════════════
// openChatFromOrder — dari menu Order ke chat customer
// ═══════════════════════════════════════════════════════════
function openChatFromOrder(waId, nama) {
  const num = String(waId).replace(/\D/g, '');
  switchMainView('ai');
  setTimeout(() => {
    const candidates = [num + '@s.whatsapp.net', num + '@c.us', num];
    let foundJid = null;
    for (const jid of candidates) {
      if (contacts[jid]) { foundJid = jid; break; }
    }
    if (!foundJid) {
      foundJid = Object.keys(contacts).find(jid => jid.startsWith(num) || jid.includes(num));
    }
    if (foundJid) { selectContact(foundJid); }
    else { alert('Chat dengan ' + nama + ' (' + num + ') tidak ditemukan di kontak aktif.'); }
  }, 300);
}

// ═══════════════════════════════════════════════════════════
// FULFILLMENT MODULE
// ═══════════════════════════════════════════════════════════
let ffData = [];

const FF_STATUS = {
  order:            { label: '🆕 Order',           color: '#dbeafe', text: '#1e40af' },
  preparing:        { label: '🔧 Preparing',        color: '#fef3c7', text: '#92400e' },
  submitted:        { label: '📋 Submitted',        color: '#e0e7ff', text: '#3730a3' },
  request_komship:  { label: '⏳ Req. Komship',     color: '#fce7f3', text: '#9d174d' },
  request_delivery: { label: '🚚 Req. Delivery',    color: '#d1fae5', text: '#065f46' },
  on_delivery:      { label: '📦 On Delivery',      color: '#cffafe', text: '#164e63' },
  delivered:        { label: '✅ Delivered',         color: '#dcfce7', text: '#14532d' },
  cancelled:        { label: '❌ Cancelled',         color: '#fee2e2', text: '#7f1d1d' },
};
const FF_NEXT = {
  order: 'preparing', preparing: 'submitted', submitted: 'request_komship',
  request_komship: 'request_delivery', request_delivery: 'on_delivery',
  on_delivery: 'delivered'
};

function getAuthHeader() {
  return { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` };
}

async function initFulfillment() {
  if (!Array.isArray(ffData) || ffData.length === 0) await loadFulfillment();
  else renderFulfillment();
}

async function loadFulfillment() {
  const tbody = document.getElementById('ff-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#94a3b8">⏳ Memuat data...</td></tr>';
  try {
    const res = await fetch('/api/fulfillment', { headers: getAuthHeader() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    ffData = await res.json();
    renderFulfillment();
  } catch(e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#ef4444">❌ Gagal load: ' + e.message + '</td></tr>';
  }
}

function renderFulfillment() {
  const filterStatus = document.getElementById('ff-filter-status')?.value || '';
  const search = (document.getElementById('ff-search')?.value || '').toLowerCase();
  const tbody = document.getElementById('ff-tbody');
  const empty = document.getElementById('ff-empty');
  if (!tbody) return;

  let rows = Array.isArray(ffData) ? ffData : [];
  if (filterStatus) rows = rows.filter(r => r.status_fulfillment === filterStatus);
  if (search) rows = rows.filter(r =>
    (r.nama||'').toLowerCase().includes(search) ||
    (r.produk||'').toLowerCase().includes(search) ||
    (r.hp||'').includes(search)
  );

  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = rows.map(r => {
    const st = FF_STATUS[r.status_fulfillment] || { label: r.status_fulfillment, color: '#f1f5f9', text: '#374151' };
    const aiDone = r.ai_processed;
    const harga = r.harga ? 'Rp' + Number(r.harga).toLocaleString('id-ID') : '-';
    const nextSt = FF_NEXT[r.status_fulfillment] || '';
    const nextLabel = nextSt ? (FF_STATUS[nextSt]?.label || nextSt) : '';
    const rid = Number(r.id);
    const opacity = r.status_fulfillment === 'cancelled' ? 'opacity:0.55;' : '';

    const btnAI     = !aiDone ? `<button onclick="processSingleAI(${rid})" style="padding:3px 8px;background:#8b5cf6;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer;white-space:nowrap;display:block;width:100%;margin-bottom:3px">⚡ AI</button>` : '';
    const btnChat   = r.chat_konfirmasi ? `<button onclick="showFfChat(${rid})" style="padding:3px 8px;background:#0ea5e9;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer;white-space:nowrap;display:block;width:100%;margin-bottom:3px">💬 Chat</button>` : '';
    const btnNext   = nextLabel ? `<button onclick="advanceFfStatus(${rid},'${nextSt}')" style="padding:3px 8px;background:#10b981;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer;white-space:nowrap;display:block;width:100%;margin-bottom:3px">→ ${nextLabel}</button>` : '';
    const btnCancel = (r.status_fulfillment !== 'cancelled' && r.status_fulfillment !== 'delivered') ? `<button onclick="advanceFfStatus(${rid},'cancelled')" style="padding:3px 8px;background:#ef4444;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer;white-space:nowrap;display:block;width:100%">✕ Cancel</button>` : '';

    return `<tr style="border-bottom:1px solid #f1f5f9;${opacity}">
      <td style="padding:8px;border:1px solid #e2e8f0;font-weight:600;min-width:110px">${r.nama||'-'}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;white-space:nowrap;font-size:0.75rem">${r.hp||'-'}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;min-width:160px;font-size:0.75rem">${aiDone ? (r.alamat_desa_kec_kab||'-') : '<em style="color:#94a3b8">Belum diproses AI</em>'}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;min-width:180px;font-size:0.73rem">${aiDone ? (r.alamat_detail_120||'-') : '<em style="color:#94a3b8">-</em>'}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;min-width:140px;font-size:0.75rem">${r.produk||'-'}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center;white-space:nowrap;font-size:0.75rem">${harga}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center;font-size:0.75rem">${r.qty||1}</td>
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center">
        <span style="background:${st.color};color:${st.text};padding:3px 8px;border-radius:12px;font-size:0.7rem;font-weight:600;white-space:nowrap">${st.label}</span>
      </td>
      <td style="padding:8px;border:1px solid #e2e8f0;min-width:100px">
        ${btnAI}${btnChat}${btnNext}${btnCancel}
      </td>
    </tr>`;
  }).join('');
}

async function syncFulfillment(btn) {
  if (!btn) btn = document.querySelector('[onclick*="syncFulfillment"]');
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Sync...';
  try {
    const res = await fetch('/api/fulfillment/sync', { method: 'POST', headers: getAuthHeader() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    alert('Sync selesai!\nDitambahkan: ' + d.inserted + '\nSudah ada: ' + d.skipped + '\nTotal: ' + d.total);
    await loadFulfillment();
  } catch(e) { alert('Sync gagal: ' + e.message); }
  btn.disabled = false; btn.textContent = orig;
}

async function processSingleAI(id) {
  const prog = document.getElementById('ff-progress');
  prog.style.display = 'block';
  prog.textContent = '⚡ Memproses AI...';
  try {
    const res = await fetch('/api/fulfillment/' + id + '/process-ai', {
      method: 'POST', headers: getAuthHeader()
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'HTTP ' + res.status);
    }
    await loadFulfillment();
    prog.textContent = '✅ Selesai!';
    setTimeout(() => { prog.style.display = 'none'; }, 2000);
  } catch(e) {
    prog.textContent = '❌ Error: ' + e.message;
    setTimeout(() => { prog.style.display = 'none'; }, 4000);
  }
}

async function processAllAI() {
  const pending = (Array.isArray(ffData) ? ffData : []).filter(r => !r.ai_processed);
  if (!pending.length) { alert('Semua order sudah diproses AI.'); return; }
  const menit = Math.ceil(pending.length * 4 / 60);
  if (!confirm('Proses AI untuk ' + pending.length + ' order?\nEstimasi: ~' + menit + ' menit (rate limit 15 RPM)')) return;

  const btn = document.getElementById('btn-process-all');
  const prog = document.getElementById('ff-progress');
  btn.disabled = true; prog.style.display = 'block';

  for (let i = 0; i < pending.length; i++) {
    const r = pending[i];
    prog.textContent = '⚡ Memproses ' + (i+1) + '/' + pending.length + ': ' + (r.nama||r.hp) + '...';
    try {
      await fetch('/api/fulfillment/' + r.id + '/process-ai', {
        method: 'POST', headers: getAuthHeader()
      });
    } catch(e) { console.error('AI error id=' + r.id, e); }
    if (i < pending.length - 1) await new Promise(res => setTimeout(res, 4200));
  }

  await loadFulfillment();
  prog.textContent = '✅ Selesai! ' + pending.length + ' order diproses.';
  btn.disabled = false;
  setTimeout(() => { prog.style.display = 'none'; }, 3000);
}

async function advanceFfStatus(id, status) {
  try {
    const res = await fetch('/api/fulfillment/' + id + '/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const idx = (Array.isArray(ffData) ? ffData : []).findIndex(r => r.id == id);
    if (idx >= 0) ffData[idx].status_fulfillment = status;
    renderFulfillment();
  } catch(e) { alert('Gagal update status: ' + e.message); }
}

function showFfChat(id) {
  const r = (Array.isArray(ffData) ? ffData : []).find(r => r.id == id);
  if (!r) return;
  const panel = document.getElementById('ff-chat-panel');
  document.getElementById('ff-chat-title').textContent = '💬 Chat — ' + (r.nama||r.hp||id);
  document.getElementById('ff-chat-body').textContent = r.chat_konfirmasi || '(tidak ada chat konfirmasi)';
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
}

function closeFfChat() {
  document.getElementById('ff-chat-panel').style.display = 'none';
}
"""

last_script = html.rfind('</script>')
if last_script >= 0:
    html = html[:last_script] + FF_JS + '\n' + html[last_script:]
    results.append('P5 OK: JS Fulfillment + openChatFromOrder')
else:
    results.append('P5 GAGAL: </script> tidak ditemukan')

# Simpan
with open('/Users/a1/Project/wa-ai-gemini2/public/index_patched.html', 'w', encoding='utf-8') as f:
    f.write(html)

print('\n'.join(results))
print(f'\nDisimpan ke index_patched.html')
