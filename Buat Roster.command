#!/bin/bash
# Roster Tim Ops + NOC — klik dua kali file ini (Mac).
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

pause_and_exit() {
  echo ""
  read -r -p "Tekan Enter untuk menutup jendela ini..." _
  exit "$1"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum terpasang di komputer ini."
  echo "1. Halaman nodejs.org akan terbuka. Unduh versi LTS lalu pasang."
  echo "2. Setelah selesai, klik dua kali Buat Roster lagi."
  open "https://nodejs.org/"
  pause_and_exit 1
fi

if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"; then
  echo "Versi Node.js di komputer ini terlalu lama ($(node --version))."
  echo "Pasang versi LTS terbaru dari https://nodejs.org lalu coba lagi."
  open "https://nodejs.org/"
  pause_and_exit 1
fi

if [ ! -d "automation/v2/node_modules/exceljs" ]; then
  echo "Menyiapkan program untuk pertama kali. Butuh internet, sekitar 1 menit..."
  if ! (cd automation/v2 && npm install --no-audit --no-fund); then
    echo "Gagal menyiapkan program. Pastikan ada koneksi internet lalu coba lagi."
    pause_and_exit 1
  fi
fi

node automation/v2/roster-cli.mjs menu
pause_and_exit 0
