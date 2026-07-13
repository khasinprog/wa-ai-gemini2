#!/bin/bash

# Pindah ke direktori script ini berada
cd "$(dirname "$0")"

echo ""
echo " ========================================"
echo "   WA AI Assistant - Gemini Edition"
echo " ========================================"
echo ""

# Cek Node.js terinstall
if ! command -v node &> /dev/null; then
    echo " [ERROR] Node.js tidak terinstall!"
    echo " Download di: https://nodejs.org"
    exit 1
fi

echo " [OK] Node.js $(node -v) ditemukan"

# Buat .env kalau belum ada
if [ ! -f ".env" ]; then
    echo "GEMINI_API_KEY=" > .env
    echo "PORT=3000" >> .env
    echo " [OK] File .env dibuat"
fi

# Install dependencies kalau belum ada
if [ ! -d "node_modules/express" ]; then
    echo " [SETUP] Install dependencies, mohon tunggu..."
    npm install
    if [ $? -ne 0 ]; then
        echo " [ERROR] Gagal install dependencies!"
        exit 1
    fi
    echo " [OK] Install selesai!"
fi

echo " [OK] Menjalankan server..."
echo " [OK] Buka browser: http://localhost:3000"
echo ""
echo " Jangan tutup terminal ini!"
echo " Tekan Ctrl+C untuk berhenti."
echo ""

# Buka browser otomatis setelah 3 detik
(sleep 3 && open "http://localhost:3000") &

node server.js
