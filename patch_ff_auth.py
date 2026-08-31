with open('/Users/a1/Project/wa-ai-gemini2/public/index_fixed.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Helper: tambah authHeader ke semua fetch di fungsi fulfillment
# Ganti semua fetch tanpa Authorization di blok fulfillment

replacements = [
    # loadFulfillment
    (
        "const res = await fetch('/api/fulfillment');",
        "const res = await fetch('/api/fulfillment', { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });"
    ),
    # syncFulfillment
    (
        "const res = await fetch('/api/fulfillment/sync', { method: 'POST' });",
        "const res = await fetch('/api/fulfillment/sync', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });"
    ),
    # processSingleAI
    (
        "const res = await fetch('/api/fulfillment/' + id + '/process-ai', { method: 'POST' });",
        "const res = await fetch('/api/fulfillment/' + id + '/process-ai', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });"
    ),
    # processAllAI loop
    (
        "await fetch('/api/fulfillment/' + r.id + '/process-ai', { method: 'POST' });",
        "await fetch('/api/fulfillment/' + r.id + '/process-ai', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });"
    ),
    # advanceFfStatus
    (
        """const res = await fetch('/api/fulfillment/' + id + '/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });""",
        """const res = await fetch('/api/fulfillment/' + id + '/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('authToken')}` },
      body: JSON.stringify({ status })
    });"""
    ),
]

ok = 0
for old, new in replacements:
    if old in html:
        html = html.replace(old, new, 1)
        print(f'OK: {old[:60]}...')
        ok += 1
    else:
        print(f'GAGAL: {old[:60]}...')

with open('/Users/a1/Project/wa-ai-gemini2/public/index_fixed.html', 'w', encoding='utf-8') as f:
    f.write(html)
print(f'\n{ok}/{len(replacements)} fix berhasil. Disimpan.')
