# Panduan Integrasi API Cek Ongkir

Dokumen ini berisi panduan untuk mengintegrasikan module `ongkir-api.js` ke dalam aplikasi Node.js/Express.js utama Anda, sehingga AI atau layanan lain dapat mengakses endpoint cek ongkir tanpa antarmuka frontend.

## 1. Persiapan File
Pastikan file `ongkir-api.js` sudah disalin ke dalam direktori project utama Anda (misalnya di dalam folder `routes/` atau `api/`).

## 2. Instalasi Dependency
Module ini membutuhkan `express`. Pastikan project utama Anda sudah menginstalnya:
```bash
npm install express
```
*(Catatan: Module ini menggunakan global `fetch` API yang tersedia secara bawaan di Node.js versi 18 ke atas. Pastikan server utama Anda menjalankan Node.js >= 18).*

## 3. Cara Mengintegrasikan ke Aplikasi Utama (app.js / server.js)

Di dalam file server utama Anda, Anda dapat melakukan _mounting_ router ini ke path tertentu, misalnya `/api/ongkir`.

```javascript
const express = require('express');
const app = express();

// 1. Import router ongkir
const ongkirRoutes = require('./path/to/ongkir-api'); // Sesuaikan path file

// 2. Gunakan router di path yang diinginkan
app.use('/api/ongkir', ongkirRoutes);

app.listen(3000, () => {
  console.log('Server utama berjalan di port 3000');
});
```

## 4. Daftar Endpoint yang Tersedia untuk AI

Setelah di-_mount_ di path `/api/ongkir`, AI dapat memanggil endpoint berikut:

### A. Cari Alamat (`GET /api/ongkir/address/search`)
Digunakan untuk mencari nama kecamatan/kota dan mendapatkan ID-nya.
- **Query Parameter:** `keyword` (misal: `jakarta selatan`)
- **Contoh URL:** `http://localhost:3000/api/ongkir/address/search?keyword=jakarta`

### B. Cek Ongkir Publik (`GET /api/ongkir/order/estimate-public`)
Digunakan untuk mengecek ongkir umum.
- **Query Parameter yang dibutuhkan:**
  - `originType` (biasanya `SUBLOC`)
  - `originId` (ID asal)
  - `destinationType` (biasanya `SUBLOC`)
  - `destinationId` (ID tujuan)
  - `weight` (berat dalam kilogram)
  - `itemValue` (nilai barang / harga)
- **Contoh URL:** `http://localhost:3000/api/ongkir/order/estimate-public?originType=SUBLOC&originId=123&destinationType=SUBLOC&destinationId=456&weight=1&itemValue=100000`

### C. Cek Ongkir Private / User Spesifik (`GET /api/ongkir/order/estimate-private`)
Digunakan jika Anda ingin mengecek ongkir menggunakan API Key spesifik (misal dari akun pengguna tertentu untuk melihat tarif khusus/markup mereka).
- **Query Parameter yang dibutuhkan:**
  - `apiKey` (API Key Mengantar milik user - Wajib)
  - Parameter lainnya sama seperti cek ongkir publik (`originType`, `originId`, dll).
- **Contoh URL:** `http://localhost:3000/api/ongkir/order/estimate-private?apiKey=API_KEY_DISINI&originType=SUBLOC&originId=123&destinationType=SUBLOC&destinationId=456&weight=1&itemValue=100000`

## 5. Keuntungan Pendekatan Ini
- **Modular:** Kode cek ongkir terisolasi di `ongkir-api.js` sehingga tidak mengotori kode utama.
- **Headless / API-Only:** Tidak meng-host file statis HTML/CSS, 100% respons JSON yang sangat bersahabat untuk diurai oleh AI.
- **Terhindar dari CORS:** Karena panggilan ke API eksternal (Mengantar) dilakukan di level server, AI atau aplikasi Frontend utama Anda tidak akan terkena error CORS saat melakukan fetch.
