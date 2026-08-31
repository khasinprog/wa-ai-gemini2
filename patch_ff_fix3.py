with open('/Users/a1/Project/wa-ai-gemini2/public/index_edit.html', 'r', encoding='utf-8') as f:
    html = f.read()

# ══════════════════════════════════════════════════════
# FIX 1: Hapus inline style display:flex yang override CSS
# CSS .view sudah handle display via .active class
# Cukup pertahankan flex-direction dan overflow saja
# ══════════════════════════════════════════════════════
old_view = '<div id="view-fulfillment" class="view" style="display:flex;flex-direction:column;height:100%;overflow:hidden">'
new_view = '<div id="view-fulfillment" class="view" style="flex-direction:column;height:100%;overflow:hidden">'
if old_view in html:
    html = html.replace(old_view, new_view, 1)
    print('FIX 1 OK: view-fulfillment tidak lagi override display')
else:
    print('FIX 1 GAGAL — cek string:')
    idx = html.find('view-fulfillment')
    print(repr(html[idx:idx+120]))

with open('/Users/a1/Project/wa-ai-gemini2/public/index_fixed.html', 'w', encoding='utf-8') as f:
    f.write(html)
print('Disimpan ke index_fixed.html')
