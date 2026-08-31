const express = require('express');
const router = express.Router();

// Base URL API Mengantar
const MENGANTAR_BASE = 'https://app.mengantar.com';

// Helper: Proxy generic untuk meneruskan request ke API Mengantar
async function proxyToMengantar(req, res, mengantarPath) {
  try {
    const queryString = new URLSearchParams(req.query).toString();
    const url = `${MENGANTAR_BASE}${mengantarPath}${queryString ? '?' + queryString : ''}`;
    console.log('[Ongkir API Proxy] ->', url);

    const upstream = await fetch(url);
    const text = await upstream.text();

    res.status(upstream.status);
    res.type('application/json');
    res.send(text);
  } catch (err) {
    console.error('[Ongkir API Proxy] error:', err);
    res.status(502).json({ success: false, message: 'Proxy error: ' + err.message });
  }
}

// 1. Endpoint: Search alamat (publik, tanpa API key)
// Digunakan AI untuk mencari ID lokasi asal/tujuan
router.get('/address/search', (req, res) => {
  proxyToMengantar(req, res, '/api/public/dummykey/address/search');
});

// 2. Endpoint: Cek ongkir publik (tanpa API key user)
// Digunakan AI untuk mengecek ongkir secara umum (tanpa markup custom user)
router.get('/order/estimate-public', (req, res) => {
  proxyToMengantar(req, res, '/api/order/allEstimatePublic');
});

// 3. Endpoint: Cek ongkir private (dengan API key milik user)
// Digunakan AI untuk mengecek ongkir berdasarkan akun spesifik (mendukung markup dll)
router.get('/order/estimate-private', (req, res) => {
  const { apiKey, ...rest } = req.query;
  if (!apiKey) {
    return res.status(400).json({ success: false, message: 'apiKey wajib diisi sebagai query parameter' });
  }
  req.query = rest; // Sisa query diteruskan ke API Mengantar
  proxyToMengantar(req, res, `/api/public/${encodeURIComponent(apiKey)}/order/estimate`);
});

module.exports = router;
