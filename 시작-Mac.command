#!/bin/bash
# HR 인사평가 시스템 서버 시작 스크립트 (Mac/Linux)
# 이 파일을 더블클릭하면 터미널이 열리면서 서버가 시작됩니다.

cd "$(dirname "$0")"

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║   HR 인사평가 시스템 서버 시작   ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# Node.js 설치 확인
if ! command -v node &> /dev/null; then
  echo "  [오류] Node.js가 설치되어 있지 않습니다."
  echo ""
  echo "  설치 방법:"
  echo "  1. https://nodejs.org 접속"
  echo "  2. LTS 버전 다운로드 및 설치"
  echo "  3. 설치 완료 후 이 파일을 다시 실행"
  echo ""
  read -p "  엔터를 눌러 닫기..."
  exit 1
fi

# 패키지 설치 (최초 1회)
if [ ! -d "node_modules" ]; then
  echo "  패키지 설치 중... (최초 1회만 실행됩니다)"
  npm install --omit=optional
  echo ""
fi

echo "  서버를 시작합니다. 브라우저에서 아래 주소로 접속하세요."
echo "  종료하려면 이 창을 닫거나 Ctrl+C 를 누르세요."
echo ""

node server.js

read -p "  서버가 종료되었습니다. 엔터를 눌러 닫기..."
