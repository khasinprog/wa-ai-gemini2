// Test script to diagnose AI address + COD check flow
require('dotenv').config({ path: '/var/www/wa-ai-gemini2/.env' });

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const KOMERCE_KEY = 'Yzx2NjTb1c484631212a74562TQwiwSB';
const ORIGIN_ID = '73528';

const alamat = 'Perumahan Tamantirto No. C3, Tamantirto, Kasihan, Bantul';

(async () => {
  const key = (process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY || '').split(',')[0].trim();
  console.log('Using Gemini key:', key.slice(0, 12) + '...');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${encodeURIComponent(key)}`;
  const systemPrompt = `Ekstrak alamat berikut. Kembalikan HANYA JSON murni (tanpa markdown backticks) dengan struktur: {"desa": "nama desa/kelurahan saja", "kecamatan": "nama kecamatan saja", "alamat_baku": "alamat rapi lengkap dengan provinsi dan kodepos"}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: alamat }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.1 }
  };

  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  console.log('Gemini status:', r.status);
  const data = await r.json();

  let text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  console.log('AI raw:', JSON.stringify(text));
  text = text.trim().replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();
  console.log('AI cleaned:', text);

  const parsed = JSON.parse(text);
  console.log('Parsed desa:', parsed.desa, '| kecamatan:', parsed.kecamatan);

  const searchStr = parsed.desa + ' ' + parsed.kecamatan;
  console.log('Search string:', searchStr);

  const searchUrl = `https://rajaongkir.komerce.id/api/v1/destination/domestic-destination?search=${encodeURIComponent(searchStr)}&limit=1`;
  const destRes = await fetch(searchUrl, { headers: { key: KOMERCE_KEY } });
  const destData = await destRes.json();
  console.log('Dest result:', JSON.stringify(destData.data));

  if (destData?.data?.length > 0) {
    const destId = destData.data[0].id;
    console.log('Dest ID:', destId);
    const costPayload = new URLSearchParams();
    costPayload.append('origin', ORIGIN_ID);
    costPayload.append('destination', destId);
    costPayload.append('weight', '1000');
    costPayload.append('courier', 'ide');
    costPayload.append('price', 'lowest');

    const costRes = await fetch('https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost', {
      method: 'POST',
      headers: { key: KOMERCE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: costPayload.toString()
    });
    const costData = await costRes.json();
    console.log('Cost result:', JSON.stringify(costData.data));
    const hasValidService = costData?.data?.some(d => d.cost > 0);
    console.log('FINAL RESULT:', hasValidService ? '✅ BISA' : '❌ TIDAK BISA');
  } else {
    console.log('FINAL RESULT: ⚠️ Area tidak ditemukan');
  }
})().catch(e => console.error('ERROR:', e.message, e.stack));
