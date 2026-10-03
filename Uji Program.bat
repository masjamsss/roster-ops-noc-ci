@echo off
rem Uji program Roster di komputer ini (Windows). Data asli tidak diubah.
chcp 65001 >nul
title Uji Program Roster
rem pushd also works from a network folder (\\server\share), where cd /d fails.
pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist "automation\v2\node_modules\exceljs" goto run
echo Menyiapkan program untuk pertama kali. Butuh internet, sekitar 1 menit...
pushd automation\v2
call npm install --no-audit --no-fund
if errorlevel 1 goto installfailed
popd

:run
echo Menguji program (sekitar 2 menit). Data asli tidak diubah...
node automation\v2\tools\selftest.mjs
echo.
pause
exit /b 0

:nonode
echo Node.js belum terpasang. Pasang versi LTS dari https://nodejs.org lalu coba lagi.
pause
exit /b 1

:installfailed
popd
echo Gagal menyiapkan program. Pastikan ada koneksi internet lalu coba lagi.
pause
exit /b 1
