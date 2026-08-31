with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'r', encoding='utf-8') as f:
    html = f.read()

old_func = """function openChatFromOrder(waId, nama) {
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
}"""

new_func = """function openChatFromOrder(waId, nama) {
  const num = String(waId).replace(/\\D/g, '');
  switchMainView('ai');
  setTimeout(() => {
    // contacts adalah object {jid: {...}}, bukan array
    const candidates = [
      num + '@s.whatsapp.net',
      num + '@c.us',
      num
    ];
    let foundJid = null;
    for (const jid of candidates) {
      if (contacts[jid]) { foundJid = jid; break; }
    }
    if (!foundJid) {
      foundJid = Object.keys(contacts).find(jid => jid.startsWith(num) || jid.includes(num));
    }
    if (foundJid) {
      selectContact(foundJid);
    } else {
      alert('Chat dengan ' + nama + ' (' + num + ') tidak ditemukan di kontak aktif.');
    }
  }, 300);
}"""

if old_func in html:
    html = html.replace(old_func, new_func, 1)
    print('PATCH OK')
else:
    print('GAGAL - cari posisi fungsi...')
    idx = html.find('function openChatFromOrder')
    print(f'posisi: {idx}')
    if idx >= 0:
        print(repr(html[idx:idx+300]))

with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'w', encoding='utf-8') as f:
    f.write(html)
print('Selesai.')
