@echo off
title WA AI Assistant
color 0A
cd /d "%~dp0"

echo.
echo  ========================================
echo    WA AI Assistant - Gemini Edition
echo  ========================================
echo.

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js tidak terinstall!
    echo  Download di: https://nodejs.org
    pause & exit /b 1
)

if not exist ".env" (
    echo GEMINI_API_KEY=> .env
    echo PORT=3000>> .env
)

if not exist "node_modules\express" (
    echo  [SETUP] Install dependencies, mohon tunggu...
    call npm install
    if %errorlevel% neq 0 (
        echo  [ERROR] Gagal install!
        pause & exit /b 1
    )
    echo  [OK] Install selesai!
)

echo  [OK] Menjalankan server...
echo  [OK] Buka browser: http://localhost:3000
echo.
echo  Jangan tutup window ini!
echo  Tekan Ctrl+C untuk berhenti.
echo.

start /min cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"
node server.js

echo.
pause
