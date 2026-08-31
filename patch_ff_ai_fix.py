with open('/Users/a1/Project/wa-ai-gemini2/server_fixed.js', 'r', encoding='utf-8') as f:
    js = f.read()

old_parse = """    const geminiData = await geminiRes.json();
    const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);"""

new_parse = """    // Cek HTTP status Gemini dulu
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini HTTP error:', geminiRes.status, errText.substring(0, 200));
      throw new Error('Gemini API error: HTTP ' + geminiRes.status + ' — ' + errText.substring(0, 100));
    }

    const geminiData = await geminiRes.json();

    // Log untuk debug
    const rawCandidate = geminiData?.candidates?.[0];
    if (!rawCandidate) {
      console.error('Gemini no candidates:', JSON.stringify(geminiData).substring(0, 300));
      throw new Error('Gemini tidak mengembalikan kandidat. Response: ' + JSON.stringify(geminiData).substring(0, 200));
    }

    const raw = rawCandidate?.content?.parts?.[0]?.text || '';
    if (!raw) {
      console.error('Gemini empty text, full response:', JSON.stringify(geminiData).substring(0, 300));
      throw new Error('Gemini mengembalikan teks kosong');
    }

    // Bersihkan markdown code block jika ada
    let clean = raw.replace(/```json\\s*/gi, '').replace(/```\\s*/g, '').trim();

    // Ekstrak JSON dari dalam teks jika Gemini tambah penjelasan
    const jsonMatch = clean.match(/\\{[\\s\\S]*\\}/);
    if (!jsonMatch) {
      console.error('Tidak ada JSON di response Gemini:', clean.substring(0, 300));
      throw new Error('Gemini tidak mengembalikan JSON valid. Response: ' + clean.substring(0, 150));
    }
    clean = jsonMatch[0];

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch(parseErr) {
      console.error('JSON.parse gagal, clean:', clean.substring(0, 300));
      throw new Error('JSON parse error: ' + parseErr.message + ' — raw: ' + clean.substring(0, 100));
    }"""

if old_parse in js:
    js = js.replace(old_parse, new_parse, 1)
    print('FIX OK: Gemini error handling diperkuat + debug log ditambahkan')
else:
    print('GAGAL: string tidak match')
    idx = js.find('const geminiData = await geminiRes.json()')
    print(f'posisi: {idx}')

with open('/Users/a1/Project/wa-ai-gemini2/server_fixed.js', 'w', encoding='utf-8') as f:
    f.write(js)
print('Disimpan ke server_fixed.js')
