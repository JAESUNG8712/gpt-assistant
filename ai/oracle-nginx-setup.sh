#!/bin/bash
# nginx 리버스 프록시 + Let's Encrypt HTTPS 설정
# oracle-setup.sh 완료 후 실행
set -e

APP_PORT=8000

echo "Oracle Cloud 공인 IP 확인 중..."
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || curl -s api.ipify.org 2>/dev/null)
echo "공인 IP: $PUBLIC_IP"
echo ""

read -p "도메인이 있으면 입력하세요 (없으면 엔터 — IP로 접속): " DOMAIN

# ── nginx 기본 설정 ─────────────────────────────────────────────────────────
NGINX_CONF=/etc/nginx/sites-available/gpt-assistant

if [ -n "$DOMAIN" ]; then
  SERVER_NAME="$DOMAIN"
else
  SERVER_NAME="$PUBLIC_IP"
fi

sudo tee "$NGINX_CONF" > /dev/null << NGINXEOF
server {
    listen 80;
    server_name ${SERVER_NAME};

    client_max_body_size 50M;

    location / {
        proxy_pass         http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINXEOF

sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/gpt-assistant
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "✅ nginx 설정 완료"

# ── HTTPS (도메인이 있을 때만) ───────────────────────────────────────────────
if [ -n "$DOMAIN" ]; then
  echo ""
  echo "Let's Encrypt SSL 인증서 발급 중..."
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --email admin@${DOMAIN} --redirect
  echo "✅ HTTPS 설정 완료"
  echo ""
  echo "접속 주소: https://${DOMAIN}"
else
  echo ""
  echo "⚠️  도메인 없이 IP로만 접속 시 HTTPS가 없어 iPad PWA 설치가 불가합니다."
  echo ""
  echo "무료 도메인 받는 법:"
  echo "  1. https://www.duckdns.org 가입"
  echo "  2. 서브도메인 생성 후 IP를 $PUBLIC_IP 로 지정"
  echo "  3. 이 스크립트를 다시 실행하고 도메인 입력 (예: myapp.duckdns.org)"
  echo ""
  echo "HTTP 임시 접속 주소: http://${PUBLIC_IP}"
fi
