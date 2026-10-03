@echo off
rem Roster Tim Ops + NOC - klik dua kali file ini (Windows).
chcp 65001 >nul
title Roster Tim Ops + NOC
rem pushd also works from a network folder (\\server\share), where cd /d fails.
pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto oldnode

if exist "automation\v2\node_modules\exceljs" goto run
echo Menyiapkan program untuk pertama kali. Butuh internet, sekitar 1 menit...
pushd automation\v2
call npm install --no-audit --no-fund
if errorlevel 1 goto installfailed
popd

:run
node automation\v2\roster-cli.mjs menu
echo.
pause
exit /b 0

:nonode
echo Node.js belum terpasang di komputer ini.
echo 1. Halaman nodejs.org akan terbuka. Unduh versi LTS lalu pasang.
echo 2. Setelah selesai, klik dua kali Buat Roster lagi.
start "" "https://nodejs.org/"
pause
exit /b 1

:oldnode
echo Versi Node.js di komputer ini terlalu lama. Pasang versi LTS terbaru dari https://nodejs.org lalu coba lagi.
start "" "https://nodejs.org/"
pause
exit /b 1

:installfailed
popd
echo Gagal menyiapkan program. Pastikan ada koneksi internet lalu coba lagi.
pause
exit /b 1
