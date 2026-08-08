#!/bin/bash
# ============================================================
# deploy_to_server.sh - Script deploy otomatis via SSH/SCP
# Jalankan: bash deploy_to_server.sh
# Konfigurasi: isi file .deploy.env (satu kali saja)
# ============================================================

set -e

# ── Load konfigurasi dari .deploy.env ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ENV="$SCRIPT_DIR/.deploy.env"

if [ -f "$DEPLOY_ENV" ]; then
  echo "📋 Membaca konfigurasi dari .deploy.env..."
  # Load variabel, skip baris komentar & kosong
  export $(grep -v '^\s*#' "$DEPLOY_ENV" | grep -v '^\s*$' | xargs)
else
  echo "⚠️  File .deploy.env tidak ditemukan, menggunakan variabel environment yang ada..."
fi

# ── Konfigurasi (override dari .deploy.env atau env var) ──
SSH_HOST="${SSH_HOST:-}"
SSH_USER="${SSH_USER:-}"
SSH_PASS="${SSH_PASS:-}"
SSH_KEY="${SSH_KEY:-}"
SSH_PORT="${SSH_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/wa-ai-gemini2}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_REPO="${GITHUB_REPO:-khasinprog/wa-ai-gemini2}"
LOCAL_ZIP="deploy.zip"

# ── Validasi ──
if [ -z "$SSH_HOST" ] || [ -z "$SSH_USER" ]; then
  echo ""
  echo "❌ SSH_HOST dan SSH_USER belum diisi!"
  echo "   Buka file .deploy.env dan isi konfigurasi server."
  echo "   Path: $DEPLOY_ENV"
  exit 1
fi

echo ""
echo "🚀 Deploy ke: ${SSH_USER}@${SSH_HOST}:${SSH_PORT}"
echo "📁 Remote dir: $REMOTE_DIR"
echo ""

# ── Step 1: Push ke GitHub (opsional, jika token diisi) ──
if [ -n "$GITHUB_TOKEN" ] && [ -n "$GITHUB_REPO" ]; then
  echo "📦 [1/4] Push ke GitHub..."
  cd "$SCRIPT_DIR"
  git remote set-url origin "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
  if git push origin main 2>&1; then
    echo "✅ GitHub push berhasil!"
    # Reset remote URL (hapus token dari URL setelah push)
    git remote set-url origin "https://github.com/${GITHUB_REPO}.git"
  else
    echo "⚠️  GitHub push gagal, lanjut deploy ke server..."
    git remote set-url origin "https://github.com/${GITHUB_REPO}.git"
  fi
else
  echo "ℹ️  [1/4] Skip GitHub push (GITHUB_TOKEN tidak diisi di .deploy.env)"
fi

# ── Step 2: Buat deploy.zip ──
echo ""
# Hapus zip lama jika ada agar isi zip selalu fresh (Mencegah data lama ikut terbawa)
rm -f "$LOCAL_ZIP"

echo "📦 [2/4] Membuat deploy.zip..."
cd "$SCRIPT_DIR"
zip -r "$LOCAL_ZIP" \
  server.js \
  package.json \
  package-lock.json \
  public/ \
  manifest.json \
  icon-192.png \
  icon-512.png \
  sw.js \
  start.sh \
  db.js \
  migrate-to-pg.js \
  --exclude "*.DS_Store" \
  --exclude "node_modules/*" \
  --exclude "data/*" \
  --exclude ".env" \
  --exclude ".deploy.env" \
  2>/dev/null || true
echo "✅ deploy.zip siap ($(du -sh $LOCAL_ZIP | cut -f1))"

# ── Step 3: Upload ZIP ke server ──
echo ""
echo "📤 [3/4] Upload ke server..."
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15"
SCP_OPTS="-P $SSH_PORT"
SSH_PORT_OPT="-p $SSH_PORT"
if [ -n "$SSH_KEY" ]; then
  SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

if [ -n "$SSH_PASS" ]; then
  if ! command -v sshpass &> /dev/null; then
    echo "❌ sshpass tidak terinstall. Install dengan: brew install hudochenkov/sshpass/sshpass"
    exit 1
  fi
  sshpass -p "$SSH_PASS" scp $SCP_OPTS $SSH_OPTS "$LOCAL_ZIP" "${SSH_USER}@${SSH_HOST}:/tmp/deploy.zip"
else
  scp $SCP_OPTS $SSH_OPTS "$LOCAL_ZIP" "${SSH_USER}@${SSH_HOST}:/tmp/deploy.zip"
fi

echo "✅ Upload selesai!"

# ── Step 4: Ekstrak & restart di server ──
echo ""
echo "⚙️  [4/4] Ekstrak dan restart server..."

REMOTE_CMDS=$(cat <<HEREDOC
set -e
echo "[1/3] Backup file lama..."
if [ -d "$REMOTE_DIR" ]; then
  cp "$REMOTE_DIR/server.js" /tmp/server_backup.js 2>/dev/null || true
fi

echo "[2/3] Ekstrak file baru..."
mkdir -p "$REMOTE_DIR"
cd "$REMOTE_DIR"
unzip -o /tmp/deploy.zip -d "$REMOTE_DIR"

echo "[3/4] Migrasi data lama ke PostgreSQL..."
if [ -f "migrate-to-pg.js" ]; then
  node migrate-to-pg.js || true
fi

echo "[4/4] Restart dengan PM2..."
if command -v pm2 &> /dev/null; then
  pm2 restart all --update-env 2>/dev/null || pm2 start server.js --name wa-ai
  echo "✅ PM2 restart selesai!"
else
  echo "⚠️  PM2 tidak ditemukan, mencoba manual reload..."
  kill \$(lsof -t -i:3000) 2>/dev/null || true
  sleep 1
  nohup node server.js > /tmp/wa-ai.log 2>&1 &
fi

rm /tmp/deploy.zip 2>/dev/null || true
echo "✅ Deployment selesai!"
HEREDOC
)

if [ -n "$SSH_PASS" ]; then
  sshpass -p "$SSH_PASS" ssh $SSH_PORT_OPT $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "bash -s" <<< "$REMOTE_CMDS"
else
  ssh $SSH_PORT_OPT $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "bash -s" <<< "$REMOTE_CMDS"
fi

# ── Selesai ──
echo ""
echo "🎉 Deployment berhasil!"
echo ""
echo "🔍 Testing server..."
sleep 3
RESPONSE=$(curl -s --max-time 10 "https://app.trustiomart.com/api/status" || echo "FAILED")
if echo "$RESPONSE" | grep -qE "error|ok|status|connected"; then
  echo "✅ Server merespon dengan baik!"
  echo "   Response: $RESPONSE"
else
  echo "⚠️  Server belum merespon (mungkin butuh beberapa detik lagi)"
  echo "   Cek: https://app.trustiomart.com"
fi
echo ""
