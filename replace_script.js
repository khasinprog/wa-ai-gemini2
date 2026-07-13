const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

// Replace CSS
html = html.replace(/<style>[\s\S]*?<\/style>/, `<style>
:root{--bg:#F0F4F8;--s1:#FFFFFF;--s2:#F8FAFC;--s3:#E2E8F0;--text:#1E293B;--muted:#64748B;--border:#E2E8F0;
--green:#10B981;--green2:#059669;--red:#EF4444;--yellow:#F59E0B;--blue:#3B82F6;--darkblue:#1E3A8A;
--radius:8px;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden;display:flex}
.app-layout{display:flex;width:100%;height:100%;}
.sidebar{width:260px;background:#1b2b4d;color:#fff;display:flex;flex-direction:column;flex-shrink:0;}
.sidebar-logo{padding:20px;font-size:1.2rem;font-weight:700;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.1);}
.logo-badge{background:var(--green);color:#000;padding:4px 8px;border-radius:6px;font-size:.8rem;font-weight:800}
.sidebar-menu{padding:20px 10px;display:flex;flex-direction:column;gap:5px;}
.menu-item{padding:12px 15px;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:500;color:rgba(255,255,255,0.7);transition:all 0.2s;}
.menu-item:hover{background:rgba(255,255,255,0.1);color:#fff;}
.menu-item.active{background:var(--blue);color:#fff;}

.main-content{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--bg);}
.view{display:none;width:100%;height:100%;flex-direction:column;overflow:hidden;}
.view.active{display:flex;}

/* AI View styles (Current main layout) */
header{display:flex;justify-content:space-between;align-items:center;padding:12px 24px;background:var(--s1);border-bottom:1px solid var(--border);flex-shrink:0}
.status-pill{display:flex;align-items:center;gap:8px;padding:6px 14px;border-radius:20px;font-size:.78rem;font-weight:600;background:var(--s2);color:var(--muted);border:1px solid var(--border)}
.status-pill.connected{color:var(--green2);background:#ecfdf5;border-color:#d1fae5}
.status-pill .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.status-pill.connected .dot{background:var(--green)}
.main-cols{flex:1;display:flex;overflow:hidden;padding:16px;gap:16px}
.col{background:var(--s1);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;width:320px;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
.col-inner{padding:16px;overflow-y:auto;flex:1}
.col-title{font-size:.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}

/* Data Table styles */
.data-container{padding:24px;overflow-y:auto;flex:1;}
.data-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;background:var(--s1);padding:16px 20px;border-radius:12px;border:1px solid var(--border);box-shadow:0 1px 3px rgba(0,0,0,0.05);}
.data-title{font-size:1.2rem;font-weight:600;color:var(--darkblue);}
.table-wrapper{background:var(--s1);border-radius:12px;border:1px solid var(--border);overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);}
.data-table{width:100%;border-collapse:collapse;font-size:0.85rem;}
.data-table th{background:var(--s2);text-align:left;padding:14px 16px;font-weight:600;color:var(--muted);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid var(--border);}
.data-table td{padding:16px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:top;}
.data-table tr:hover td{background:var(--s2);}
.badge{padding:4px 10px;border-radius:20px;font-size:0.75rem;font-weight:600;display:inline-block;text-transform:uppercase;}
.badge-order{background:#fef3c7;color:#b45309;}
.badge-diproses{background:#dbeafe;color:#1e40af;}
.badge-terkirim{background:#d1fae5;color:#065f46;}
.badge-retur{background:#fee2e2;color:#991b1b;}
.badge-batal{background:#f1f5f9;color:#475569;}

select.badge-select { border:none; appearance:none; font-family:inherit; cursor:pointer; font-weight:600; outline:none; }

.btn{padding:8px 14px;border:none;border-radius:6px;font-size:.8rem;font-weight:600;cursor:pointer;transition:background .2s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-green{background:var(--green);color:#fff}.btn-green:hover{background:var(--green2)}
.btn-blue{background:var(--blue);color:#fff}.btn-blue:hover{background:#2563EB}
.btn-red{background:transparent;color:var(--red);border:1px solid var(--red);padding:4px 8px;font-size:0.7rem;}.btn-red:hover{background:var(--red);color:#fff;}
.btn-block{display:block;width:100%;text-align:center}

.fg{margin-bottom:16px}.lbl{display:block;font-size:.75rem;font-weight:600;color:var(--muted);margin-bottom:6px}
.fg textarea,.fg input[type="text"],.fg select{width:100%;background:var(--s1);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;color:var(--text);font-family:'Inter',sans-serif;font-size:.85rem;outline:none}
.fg textarea:focus,.fg input[type="text"]:focus,.fg select:focus{border-color:var(--blue)}
.ts{font-size:.75rem;color:var(--muted)}
.save-ok{font-size:.7rem;color:var(--green2);margin-top:6px;min-height:14px}
.toggle{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--s2);border-radius:8px;border:1px solid var(--border);margin-bottom:12px}
.toggle-lbl{font-size:.8rem;font-weight:600}
.toggle-sub{font-size:.65rem;color:var(--muted)}
.switch{position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:var(--s3);transition:.3s;border-radius:22px}
.slider:before{position:absolute;content:"";height:16px;width:16px;left:3px;bottom:3px;background-color:#fff;transition:.3s;border-radius:50%}
input:checked+.slider{background-color:var(--green)}
input:checked+.slider:before{transform:translateX(18px)}
.qr-area{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 0}
.qr-box{width:200px;height:200px;background:#fff;border-radius:12px;padding:10px;margin-bottom:16px;box-shadow:0 4px 12px rgba(0,0,0,.15);display:flex;align-items:center;justify-content:center}
.qr-box img{width:100%;height:100%;display:block}
.qr-hint{text-align:center;font-size:.75rem;color:var(--muted);line-height:1.5}
.qr-loading{display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--muted);font-size:.8rem;font-weight:600}
.spinner{border:3px solid var(--s3);border-top:3px solid var(--green);border-radius:50%;width:30px;height:30px;animation:spin 1s linear infinite}
@keyframes spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
.connected-box{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px 0;text-align:center}
.conn-icon{font-size:48px;margin-bottom:16px}
.conn-label{font-size:1.1rem;font-weight:700;color:var(--green2);margin-bottom:6px}
.conn-sub{font-size:.75rem;color:var(--muted);margin-bottom:24px}
.contact-item{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .15s}
.contact-item:hover{background:var(--s2)}
.contact-item.active{background:var(--s2);border-left:4px solid var(--blue)}
.contact-avatar{width:40px;height:40px;border-radius:50%;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;flex-shrink:0;color:var(--muted)}
.contact-info{flex:1;min-width:0}
.contact-name{font-size:.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.contact-preview{font-size:.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.contact-time{font-size:.65rem;color:var(--muted)}
.chat-header{padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0;background:var(--s1)}
.chat-avatar{width:36px;height:36px;border-radius:50%;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:var(--muted)}
.chat-name{font-size:.95rem;font-weight:600}.chat-sub{font-size:.7rem;color:var(--muted)}
.chat-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px;background:var(--s2)}
.empty-chat{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;color:var(--muted);text-align:center}
.empty-chat .ei{font-size:48px;opacity:.2}
.empty-chat p{font-size:.85rem;line-height:1.6}
.bubble-wrap{display:flex;flex-direction:column;gap:2px}
.bubble-wrap.incoming{align-items:flex-start}.bubble-wrap.outgoing{align-items:flex-end}
.bubble{max-width:80%;padding:10px 14px;border-radius:12px;font-size:.85rem;line-height:1.5;box-shadow:0 1px 2px rgba(0,0,0,0.05)}
.bubble.incoming{background:var(--s1);border:1px solid var(--border);border-bottom-left-radius:4px}
.bubble.outgoing{background:var(--green);color:#fff;border-bottom-right-radius:4px}
.bubble-time{font-size:.65rem;color:var(--muted);padding:0 4px;margin-top:2px}
.bubble-ai-label{font-size:.65rem;color:var(--green2);padding:0 4px;margin-top:2px}
.no-reply-note{font-size:.65rem;color:var(--yellow);padding:0 4px}
.tabs{display:flex;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--s1)}
.tab{flex:1;padding:14px;text-align:center;font-size:.75rem;font-weight:600;cursor:pointer;color:var(--muted);border-bottom:2px solid transparent;transition:all .2s}
.tab:hover{background:var(--s2)}
.tab.active{color:var(--blue);border-bottom-color:var(--blue)}
.tab-content{display:none;overflow-y:auto}
.tab-content.active{display:block}
.tab-panel{padding:20px}
#setup{position:fixed;inset:0;background:rgba(15,23,42,.95);z-index:999;display:none;align-items:center;justify-content:center}
.setup-box{background:var(--s1);border:1px solid var(--border);border-radius:16px;padding:32px;width:420px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.1)}
.setup-ico{font-size:42px;margin-bottom:12px}
.setup-title{font-size:1.2rem;font-weight:700;margin-bottom:8px}
.setup-sub{font-size:.8rem;color:var(--muted);line-height:1.6;margin-bottom:20px}
.setup-link{font-size:.75rem;color:var(--blue);cursor:pointer;margin-bottom:16px;display:block;text-decoration:underline}
.setup-input{width:100%;background:var(--s2);border:1px solid var(--border);border-radius:var(--radius);padding:12px;color:var(--text);font-family:'Inter',sans-serif;font-size:.85rem;outline:none;margin-bottom:12px}
.setup-input:focus{border-color:var(--blue);background:var(--s1)}
.setup-err{font-size:.7rem;color:var(--red);margin-top:8px;min-height:14px;line-height:1.5;word-break:break-word}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:4px}
</style>`);

// Replace HTML structure (Wrap header and main in new structure)
html = html.replace(/<header>[\s\S]*?<\/header>\s*<main>/, `<div class="app-layout">
  <aside class="sidebar">
    <div class="sidebar-logo"><div class="logo-badge">WA</div> AI Assistant</div>
    <div class="sidebar-menu">
      <div class="menu-item" id="menu-data" onclick="switchMainView('data')">📊 Menu Data</div>
      <div class="menu-item active" id="menu-ai" onclick="switchMainView('ai')">🤖 AI WA Assistant</div>
    </div>
  </aside>
  <div class="main-content">
    
    <div id="view-ai" class="view active">
      <header>
        <div class="data-title">AI WA Assistant</div>
        <div class="status-pill" id="statusPill"><div class="dot"></div><span id="statusTxt">Memuat...</span></div>
      </header>
      <div class="main-cols">`);

// Replace the end of main
html = html.replace(/<\/main>/, `      </div>
    </div>

    <!-- VIEW DATA ORDER -->
    <div id="view-data" class="view">
      <div class="data-container">
        <div class="data-header">
          <div class="data-title">Data Order (Ticket Log)</div>
          <button class="btn btn-blue" onclick="downloadExcel()">📥 Download Excel</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>NO. TIKET / TGL</th>
                <th>CUSTOMER</th>
                <th>PRODUK</th>
                <th>ALAMAT LENGKAP</th>
                <th>STATUS</th>
                <th>AKSI</th>
              </tr>
            </thead>
            <tbody id="orderListTable">
              <!-- rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>`);

// Remove old order tab in settings
html = html.replace(/<div class="tab" onclick="switchTab\('order'\)">🛒 Order<\/div>/, '');
html = html.replace(/<div class="tab-content" id="tab-order"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '');

// Update JS for switchMainView
const switchMainJs = `
function switchMainView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
  document.getElementById('menu-' + view).classList.add('active');
}
`;
html = html.replace(/function switchTab\(name\)\{/, switchMainJs + '\nfunction switchTab(name){');

// Update renderOrders to output table rows instead of cards
const newRenderOrders = `
function renderOrders(){
  const list=document.getElementById('orderListTable');
  if(!orders.length){
    list.innerHTML='<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted)">Belum ada data order</td></tr>';
    return;
  }
  
  const getWeight = s => ({'order':1,'diproses':2,'terkirim':3,'retur':4,'batal':5}[s]||99);
  const sorted = [...orders].sort((a,b) => {
    const wa = getWeight(a.status), wb = getWeight(b.status);
    if(wa!==wb) return wa-wb;
    return new Date(b.timestamp) - new Date(a.timestamp); 
  });

  list.innerHTML = sorted.map(o => {
    let badgeClass = 'badge-order';
    let badgeText = 'BARU (ORDER)';
    if(o.status === 'diproses') { badgeClass = 'badge-diproses'; badgeText = 'ESCALATED - PROSES'; }
    if(o.status === 'terkirim') { badgeClass = 'badge-terkirim'; badgeText = 'SOLVED / TERKIRIM'; }
    if(o.status === 'retur') { badgeClass = 'badge-retur'; badgeText = 'RETUR'; }
    if(o.status === 'batal') { badgeClass = 'badge-batal'; badgeText = 'BATAL'; }

    return \`
    <tr>
      <td>
        <div style="font-weight:600;color:var(--blue);margin-bottom:4px">ORD-\${o.id.substring(o.id.length-6)}</div>
        <div style="font-size:0.7rem;color:var(--muted)">\${ft(o.timestamp)}</div>
      </td>
      <td>
        <div style="font-weight:600;margin-bottom:4px">\${x(o.nama)}</div>
        <div style="font-size:0.75rem;color:var(--muted)">\${o.hp}</div>
      </td>
      <td><div style="font-size:0.8rem;font-weight:500">\${x(o.produk)}</div></td>
      <td><div style="font-size:0.75rem;line-height:1.5;max-width:250px">\${x(o.alamat)}</div></td>
      <td>
        <select class="badge \${badgeClass} badge-select" onchange="updateOrderStatus('\${o.id}',this.value)">
          <option value="order" \${o.status==='order'?'selected':''}>NEW TICKET</option>
          <option value="diproses" \${o.status==='diproses'?'selected':''}>PROSES</option>
          <option value="terkirim" \${o.status==='terkirim'?'selected':''}>SOLVED</option>
          <option value="retur" \${o.status==='retur'?'selected':''}>RETUR</option>
          <option value="batal" \${o.status==='batal'?'selected':''}>BATAL</option>
        </select>
      </td>
      <td>
        <button class="btn-red" onclick="deleteOrder('\${o.id}')">Hapus</button>
      </td>
    </tr>
  \`}).join('');
}
`;
html = html.replace(/function renderOrders\(\)\{[\s\S]*?async function updateOrderStatus/, newRenderOrders + '\nasync function updateOrderStatus');

fs.writeFileSync('public/index.html', html);
