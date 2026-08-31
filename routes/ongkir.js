const express = require('express');
const router = express.Router();

// Base URL API Mengantar
const MENGANTAR_BASE = 'https://app.mengantar.com';

// Helper: Proxy generic ke API Mengantar
async function proxyToMengantar(req, res, mengantarPath) {
  try {
    const queryString = new URLSearchParams(req.query).toString();
    const url = `${MENGANTAR_BASE}${mengantarPath}${queryString ? '?' + queryString : ''}`;
    console.log('[Ongkir] proxy ->', url);

    const upstream = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const text = await upstream.text();

    res.status(upstream.status).type('application/json').send(text);
  } catch (err) {
    console.error('[Ongkir] proxy error:', err.message);
    res.status(502).json({ success: false, message: 'Proxy error: ' + err.message });
  }
}

// 1. Search alamat — cari ID lokasi asal/tujuan
//    GET /api/ongkir/address/search?keyword=cibinong+bogor
router.get('/address/search', (req, res) => {
  proxyToMengantar(req, res, '/api/public/dummykey/address/search');
});

// 2. Estimate publik — tanpa API key user, tarif umum
// ⚠️ CATATAN: Endpoint ini sering timeout (HTTP 524 Cloudflare) karena server Mengantar lambat.
//    Gunakan estimate-private dengan API key untuk hasil yang lebih andal.
router.get('/order/estimate-public', (req, res) => {
  proxyToMengantar(req, res, '/api/order/allEstimatePublic');
});

// 3. Estimate private — dengan API key Mengantar user (tarif bisa berbeda/markup)
router.get('/order/estimate-private', (req, res) => {
  const { apiKey, ...rest } = req.query;
  if (!apiKey) {
    return res.status(400).json({ success: false, message: 'apiKey wajib diisi sebagai query parameter' });
  }
  req.query = rest;
  proxyToMengantar(req, res, `/api/public/${encodeURIComponent(apiKey)}/order/estimate`);
});

module.exports = router;
