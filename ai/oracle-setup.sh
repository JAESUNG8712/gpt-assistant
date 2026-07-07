#!/bin/bash
# GPT Assistant — Oracle Cloud Always Free 자동 설치 스크립트
# Ubuntu 22.04 ARM (Ampere A1) 기준
set -e

REPO_URL="https://github.com/jaesung8712/gpt-assistant.git"
APP_DIR="/home/ubuntu/gpt-assistant"
DATA_DIR="/home/ubuntu/data"
SERVICE_NAME="gpt-assistant"
APP_PORT=8000

echo "=== [1/7] 시스템 패키지 업데이트 ==="
sudo apt-get update -y
sudo apt-get install -y python3-pip python3-venv git nginx certbot python3-certbot-nginx ufw

echo "=== [2/7] 방화벽 설정 ==="
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

# Oracle Linux 전용: iptables에서도 포트 개방
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
sudo netfilter-persistent save 2>/dev/null || true

echo "=== [3/7] 레포지토리 클론 ==="
if [ -d "$APP_DIR" ]; then
  echo "이미 존재 — git pull 실행"
  git -C "$APP_DIR" pull origin main
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "=== [4/7] Python 가상환경 + 패키지 설치 ==="
python3 -m venv "$APP_DIR/ai/.venv"
"$APP_DIR/ai/.venv/bin/pip" install --upgrade pip
"$APP_DIR/ai/.venv/bin/pip" install -r "$APP_DIR/ai/requirements.txt"

echo "=== [5/7] 데이터 디렉토리 생성 ==="
mkdir -p "$DATA_DIR"

echo "=== [6/7] 환경변수 파일 생성 ==="
ENV_FILE="$APP_DIR/ai/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'ENVEOF'
# ── 필수 ──────────────────────────────────────
GROQ_API_KEY=여기에_Groq_API_키_입력
DB_PATH=/home/ubuntu/data/memory.db

# ── 선택 ──────────────────────────────────────
# ANTHROPIC_API_KEY=여기에_Claude_API_키_입력
# DART_API_KEY=여기에_DART_API_키_입력
# BOK_API_KEY=여기에_한국은행_API_키_입력
ENVEOF
  echo "⚠️  $ENV_FILE 파일 생성됨 — GROQ_API_KEY를 직접 수정하세요"
else
  echo ".env 파일 이미 존재, 스킵"
fi

echo "=== [7/7] systemd 서비스 등록 ==="
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null << SVCEOF
[Unit]
Description=GPT Assistant FastAPI Server
After=network.target

[Service]
User=ubuntu
WorkingDirectory=${APP_DIR}/ai
ExecStart=${APP_DIR}/ai/.venv/bin/uvicorn main:app --host 127.0.0.1 --port ${APP_PORT} --workers 2
Restart=always
RestartSec=5
EnvironmentFile=${APP_DIR}/ai/.env

[Install]
WantedBy=multi-user.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}

echo ""
echo "======================================"
echo "✅ 설치 완료!"
echo "======================================"
echo ""
echo "▶ 다음 단계:"
echo "  1. $ENV_FILE 를 nano로 열어 GROQ_API_KEY 입력"
echo "     $ nano $ENV_FILE"
echo "     입력 후: sudo systemctl restart gpt-assistant"
echo ""
echo "  2. nginx + HTTPS 설정:"
echo "     $ sudo bash $APP_DIR/ai/oracle-nginx-setup.sh"
echo ""
echo "  3. 서비스 상태 확인:"
echo "     $ sudo systemctl status gpt-assistant"
echo "     $ sudo journalctl -u gpt-assistant -f"
echo ""
