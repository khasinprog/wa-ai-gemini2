with open('/Users/a1/Project/wa-ai-gemini2/server_fixed.js', 'r', encoding='utf-8') as f:
    js = f.read()

# Ganti hardcode gemini-2.0-flash dengan ambil dari settings (sama seperti endpoint lain)
old = """`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,"""

new = """`https://generativelanguage.googleapis.com/v1beta/models/${(settings.modelName || 'gemini-3.5-flash-lite')}:generateContent?key=${geminiKey}`,"""

if old in js:
    js = js.replace(old, new, 1)
    print('FIX OK: model diganti dari hardcode ke settings.modelName')
else:
    print('GAGAL — cari posisi...')
    idx = js.find('gemini-2.0-flash')
    print(f'posisi: {idx}')
    print(repr(js[idx-20:idx+80]))

with open('/Users/a1/Project/wa-ai-gemini2/server_fixed.js', 'w', encoding='utf-8') as f:
    f.write(js)
print('Disimpan.')
