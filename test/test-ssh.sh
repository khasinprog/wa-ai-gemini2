#!/bin/bash
# test-ssh.sh — Test via SSH langsung ke server (lebih cepat)
# Usage: bash test-ssh.sh "pesan1" "pesan2" "pesan3" ...

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.deploy.env" ]; then
  export $(grep -v '^\s*#' "$SCRIPT_DIR/.deploy.env" | grep -v '^\s*$' | xargs)
fi

SSH_HOST="${SSH_HOST:-}"
SSH_USER="${SSH_USER:-}"
SSH_KEY="${SSH_KEY:-}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/wa-ai-gemini2}"
BASE_URL="http://localhost:3000"

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
if [ -n "$SSH_KEY" ]; then
  SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

run_cmd() {
  ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "$1"
}

echo "🔄 Reset state..."
run_cmd "curl -s -X POST $REMOTE_DIR/../.. 2>/dev/null; curl -s -X POST $BASE_URL/api/test/internal/reset -H 'Authorization: Bearer \$(curl -s -X POST $BASE_URL/api/login -H \"Content-Type: application/json\" -d {\"password\":\"@Asdw1234\"} | python3 -c \"import json,sys;print(json.load(sys.stdin)[\\\"token\\\"])\")' 2>/dev/null || true"

# Get fresh token
TOKEN=$(run_cmd "curl -s -X POST $BASE_URL/api/login -H 'Content-Type: application/json' -d '{\"password\":\"@Asdw1234\"}' | python3 -c \"import json,sys;print(json.load(sys.stdin)['token'])\"")
echo "Token: ${TOKEN:0:12}..."

# Reset
run_cmd "curl -s -X POST $BASE_URL/api/test/internal/reset -H 'Authorization: Bearer $TOKEN'" > /dev/null
echo "✅ State direset"

# Send each message
MSG_NUM=0
for MSG in "$@"; do
  MSG_NUM=$((MSG_NUM + 1))
  echo ""
  echo "📨 [$MSG_NUM] $MSG"

  # Send message
  run_cmd "curl -s -X POST $BASE_URL/api/test/internal/send -H 'Content-Type: application/json' -H 'Authorization: Bearer $TOKEN' -d '{\"phone\":\"test\",\"message\":\"$MSG\"}'" > /dev/null

  # Wait for processing
  sleep 5

  # Get last capture and display
  run_cmd "curl -s $BASE_URL/api/test/internal/raw-captures -H 'Authorization: Bearer $TOKEN'" | python3 -c "
import json,sys
data = json.load(sys.stdin)
caps = data.get('captures',[])
if not caps:
    print('  ❌ Tidak ada capture')
    sys.exit()
last = caps[-1]
sp = last.get('systemPrompt','')
raw = last.get('rawGemini','')

# Extract status
in_status = False
for line in sp.split('\n'):
    if 'STATUS SAAT INI' in line:
        in_status = True
    elif in_status and line.startswith('==='):
        in_status = False
    elif in_status and line.strip():
        print(f'  {line}')

# Gemini response
print(f'  💬 {raw[:300]}')
"
done

echo ""
echo "✅ Test selesai — $MSG_NUM messages dikirim"
