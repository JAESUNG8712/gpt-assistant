#!/bin/sh
# iPad iSH 앱에서 실행하는 AI 서버 설치 스크립트
# iSH 앱: App Store에서 무료 설치

echo ""
echo "=============================="
echo " iPad AI 서버 설치 스크립트"
echo "=============================="
echo ""

# 1. 패키지 업데이트
echo "[1/5] 패키지 목록 업데이트..."
apk update
if [ $? -ne 0 ]; then
  echo "오류: apk update 실패. 네트워크 연결을 확인하세요."
  exit 1
fi

# 2. Node.js 설치
echo ""
echo "[2/5] Node.js 설치..."
apk add nodejs npm
if [ $? -ne 0 ]; then
  echo "오류: Node.js 설치 실패"
  exit 1
fi
node --version && echo "Node.js 설치 완료"

# 3. 유틸리티 설치
echo ""
echo "[3/5] 유틸리티 설치..."
apk add git curl

# 4. 프로젝트 파일 복사
echo ""
echo "[4/5] 프로젝트 파일 설정..."
mkdir -p ~/ai-server

# iCloud Drive에서 복사 (파일을 iCloud에 저장한 경우)
if [ -d "/iCloud/ai-server" ]; then
  echo "iCloud Drive에서 파일 복사 중..."
  cp -r /iCloud/ai-server/. ~/ai-server/
  echo "복사 완료"
elif [ -d "/iCloud/gpt-assistant" ]; then
  echo "iCloud Drive에서 파일 복사 중..."
  cp -r /iCloud/gpt-assistant/. ~/ai-server/
  echo "복사 완료"
else
  echo "iCloud에서 파일을 찾을 수 없습니다."
  echo "수동으로 파일을 복사하세요:"
  echo "  cp -r /iCloud/[폴더명]/. ~/ai-server/"
  echo ""
  echo "또는 아래 최소 구조를 직접 생성합니다..."
  mkdir -p ~/ai-server/engine
  mkdir -p ~/ai-server/routes
  mkdir -p ~/ai-server/public
  mkdir -p ~/ai-server/data
fi

# 5. npm 패키지 설치
echo ""
echo "[5/5] npm 패키지 설치..."
cd ~/ai-server

# package.json이 없으면 최소 버전 생성
if [ ! -f "package.json" ]; then
  cat > package.json << 'EOF'
{
  "name": "minigpt-ipad",
  "version": "1.0.0",
  "main": "server-ipad.js",
  "dependencies": {
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1"
  }
}
EOF
fi

npm install
if [ $? -ne 0 ]; then
  echo "오류: npm install 실패"
  exit 1
fi

# 완료
echo ""
echo "=============================="
echo " 설치 완료!"
echo "=============================="
echo ""
echo "서버 시작:"
echo "  cd ~/ai-server && node server-ipad.js"
echo ""
echo "Safari에서 접속:"
echo "  http://localhost:3000/engine-studio.html"
echo ""
echo "백그라운드 실행 (iSH 닫아도 유지):"
echo "  nohup node server-ipad.js > server.log 2>&1 &"
echo ""
