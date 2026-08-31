with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'r', encoding='utf-8') as f:
    html = f.read()

# ══════════════════════════════════════════════════
# FIX 1: view-fulfillment layout — height + overflow
# ══════════════════════════════════════════════════
old_view = '    <div id="view-fulfillment" class="view">'
new_view = '    <div id="view-fulfillment" class="view" style="display:flex;flex-direction:column;height:100%;overflow:hidden">'
if old_view in html:
    html = html.replace(old_view, new_view, 1)
    print('FIX 1 OK: view layout')
else:
    print('FIX 1 GAGAL')

# ══════════════════════════════════════════════════
# FIX 2: area scroll tabel
# ══════════════════════════════════════════════════
old_scroll = '      <div style="overflow-x:auto;padding:12px">'
new_scroll = '      <div style="overflow:auto;padding:12px;flex:1;min-height:0">'
if old_scroll in html:
    html = html.replace(old_scroll, new_scroll, 1)
    print('FIX 2 OK: scroll area')
else:
    print('FIX 2 GAGAL')

# ══════════════════════════════════════════════════
# FIX 3: Ganti seluruh blok JS Fulfillment dengan versi yang diperbaiki
# ══════════════════════════════════════════════════
old_js_start = 'async function initFulfillment() {'
old_js_end   = 'function closeFfChat() {\n  document.getElementById(\'ff-chat-panel\').style.display = \'none\';\n}'

start_idx = html.find(old_js_start)
end_idx   = html.find(old_js_end)

if start_idx == -1 or end_idx == -1:
    print('FIX 3 GAGAL: blok JS tidak ditemukan')
else:
    end_idx += len(old_js_end)

    NEW_JS = r"""async function initFulfillment() {
  if (!Array.isArray(ffData) || ffData.length === 0) {
    await loadFulfillment();
  } else {
    renderFulfillment();
  }
}

async function loadFulfillment() {
  const tbody = document.getElementById('ff-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#94a3b8">⏳ Memuat data...</td></tr>';
  try {
    const res = await fetch('/api/fulfillment');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    ffData = await res.json();
    renderFulfillment();
  } catch(e) {
    console.error('Load fulfillment error:', e);
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#ef4444">❌ Gagal load data: ' + e.message + '</td></tr>';
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

    const btnAI     = !aiDone
      ? `<button onclick="processSingleAI(${rid})" style="padding:3px 8px;background:#8b5cf6;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer;white-space:nowrap">⚡ AI</button>`
      : '';
    const btnChat   = r.chat_konfirmasi
      ? `<button onclick="showFfChat(${rid})" style="padding:3px 8px;background:#0ea5e9;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer;white-space:nowrap">💬 Chat</button>`
      : '';
    const btnNext   = nextLabel
      ? `<button onclick="advanceFfStatus(${rid},'${nextSt}')" style="padding:3px 8px;background:#10b981;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer;white-space:nowrap">→ ${nextLabel}</button>`
      : '';
    const btnCancel = (r.status_fulfillment !== 'cancelled' && r.status_fulfillment !== 'delivered')
      ? `<button onclick="advanceFfStatus(${rid},'cancelled')" style="padding:3px 8px;background:#ef4444;color:#fff;border:none;border-radius:5px;font-size:0.72rem;cursor:pointer;white-space:nowrap">✕ Cancel</button>`
      : '';

    const rowOpacity = r.status_fulfillment === 'cancelled' ? 'opacity:0.55;' : '';

    return `<tr style="border-bottom:1px solid #f1f5f9;${rowOpacity}">
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
      <td style="padding:8px;border:1px solid #e2e8f0;text-align:center">
        <div style="display:flex;flex-direction:column;gap:3px;align-items:stretch;min-width:90px">
          ${btnAI}${btnChat}${btnNext}${btnCancel}
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function syncFulfillment(btn) {
  if (!btn) btn = document.querySelector('[onclick*="syncFulfillment"]');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Sync...';
  try {
    const res = await fetch('/api/fulfillment/sync', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    alert('Sync selesai!\nDitambahkan: ' + d.inserted + '\nSudah ada: ' + d.skipped + '\nTotal: ' + d.total);
    await loadFulfillment();
  } catch(e) {
    alert('Sync gagal: ' + e.message);
  }
  btn.disabled = false;
  btn.textContent = origText;
}

async function processSingleAI(id) {
  const prog = document.getElementById('ff-progress');
  prog.style.display = 'block';
  prog.textContent = '⚡ Memproses AI...';
  try {
    const res = await fetch('/api/fulfillment/' + id + '/process-ai', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await loadFulfillment();
    prog.textContent = '✅ Selesai!';
    setTimeout(() => { prog.style.display = 'none'; }, 2000);
  } catch(e) {
    prog.textContent = '❌ Error: ' + e.message;
    setTimeout(() => { prog.style.display = 'none'; }, 3000);
  }
}

async function processAllAI() {
  const pending = (Array.isArray(ffData) ? ffData : []).filter(r => !r.ai_processed);
  if (!pending.length) { alert('Semua order sudah diproses AI.'); return; }
  const menit = Math.ceil(pending.length * 4 / 60);
  if (!confirm('Proses AI untuk ' + pending.length + ' order?\nEstimasi waktu: ~' + menit + ' menit')) return;

  const btn = document.getElementById('btn-process-all');
  const prog = document.getElementById('ff-progress');
  btn.disabled = true;
  prog.style.display = 'block';

  for (let i = 0; i < pending.length; i++) {
    const r = pending[i];
    prog.textContent = '⚡ Memproses ' + (i+1) + '/' + pending.length + ': ' + (r.nama||r.hp) + '...';
    try {
      await fetch('/api/fulfillment/' + r.id + '/process-ai', { method: 'POST' });
    } catch(e) {
      console.error('AI error for id=' + r.id, e);
    }
    if (i < pending.length - 1) await new Promise(res => setTimeout(res, 4000));
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const idx = ffData.findIndex(r => r.id == id);
    if (idx >= 0) ffData[idx].status_fulfillment = status;
    renderFulfillment();
  } catch(e) {
    alert('Gagal update status: ' + e.message);
  }
}

function showFfChat(id) {
  const r = (Array.isArray(ffData) ? ffData : []).find(r => r.id == id);
  if (!r) return;
  const panel = document.getElementById('ff-chat-panel');
  document.getElementById('ff-chat-title').textContent = '💬 Chat — ' + (r.nama||r.hp||id);
  document.getElementById('ff-chat-body').textContent = r.chat_konfirmasi || '(tidak ada chat konfirmasi)';
  panel.style.cssText = panel.style.cssText.replace('display:none','') ;
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
}

function closeFfChat() {
  document.getElementById('ff-chat-panel').style.display = 'none';
}"""

    html = html[:start_idx] + NEW_JS + html[end_idx:]
    print('FIX 3 OK: JS Fulfillment seluruhnya diganti')

# ══════════════════════════════════════════════════
# Simpan
# ══════════════════════════════════════════════════
with open('/Users/a1/Project/wa-ai-gemini2/public/index_fixed.html', 'w', encoding='utf-8') as f:
    f.write(html)
print('Disimpan ke index_fixed.html — BELUM diupload ke server.')
