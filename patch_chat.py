with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'r', encoding='utf-8') as f:
    html = f.read()

new_func = """function openChatFromOrder(waId, nama) {
  switchMainView('ai');
  setTimeout(() => {
    const candidates = [waId + '@s.whatsapp.net', waId + '@c.us', waId];
    let found = null;
    for (const jid of candidates) {
      found = contacts.find(c => c.jid === jid);
      if (found) break;
    }
    if (!found) found = contacts.find(c => c.jid && c.jid.startsWith(waId));
    if (found) {
      selectContact(found.jid);
    } else {
      alert('Chat dengan ' + nama + ' tidak ditemukan di kontak aktif.');
    }
  }, 200);
}

"""

target = 'async function updateOrderStatus'
if target in html:
    html = html.replace(target, new_func + target, 1)
    print('PATCH 1 OK: fungsi openChatFromOrder ditambahkan')
else:
    print('PATCH 1 GAGAL')

old_td = '      <td>\n        <button class="btn-red" onclick="deleteOrder(\'${o.id}\')">Hapus</button>\n      </td>'
new_td = '      <td style="white-space:nowrap;min-width:80px">\n        <button onclick="openChatFromOrder(\'${o.hp}\',\'${o.nama}\')" style="margin-bottom:5px;display:block;width:100%;padding:5px 8px;border-radius:6px;border:1px solid var(--blue);background:#eff6ff;color:var(--blue);font-size:0.75rem;font-weight:600;cursor:pointer;" title="Buka chat customer">&#128172; Chat</button>\n        <button class="btn-red" onclick="deleteOrder(\'${o.id}\')">Hapus</button>\n      </td>'

if old_td in html:
    html = html.replace(old_td, new_td, 1)
    print('PATCH 2 OK: tombol Chat ditambahkan di kolom order')
else:
    print('PATCH 2 GAGAL - coba debug:')
    idx = html.find('btn-red" onclick="deleteOrder')
    print(f'  posisi: {idx}')
    if idx > 0:
        print(repr(html[idx-60:idx+80]))

with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'w', encoding='utf-8') as f:
    f.write(html)
print('File disimpan.')
