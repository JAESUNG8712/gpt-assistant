#!/bin/bash
# 코드 업데이트 시 실행 (git pull + 서비스 재시작)
set -e

APP_DIR="/home/ubuntu/gpt-assistant"

echo "=== 코드 업데이트 ==="
git -C "$APP_DIR" pull origin main

echo "=== 패키지 업데이트 ==="
"$APP_DIR/ai/.venv/bin/pip" install -r "$APP_DIR/ai/requirements.txt" -q

echo "=== 서비스 재시작 ==="
sudo systemctl restart gpt-assistant
sleep 2
sudo systemctl status gpt-assistant --no-pager
echo ""
echo "✅ 업데이트 완료"
