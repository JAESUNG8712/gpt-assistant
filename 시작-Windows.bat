@echo off
chcp 65001 >nul
title HR 인사평가 시스템 서버
echo.
echo  ╔══════════════════════════════════╗
echo  ║   HR 인사평가 시스템 서버 시작   ║
echo  ╚══════════════════════════════════╝
echo.

:: Node.js 설치 확인
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  [오류] Node.js가 설치되어 있지 않습니다.
  echo.
  echo  설치 방법:
  echo  1. https://nodejs.org 접속
  echo  2. LTS 버전 다운로드 및 설치
  echo  3. 설치 완료 후 이 파일을 다시 실행
  echo.
  pause
  exit /b 1
)

:: 스크립트 위치로 이동
cd /d "%~dp0"

:: 패키지 설치 (최초 1회)
if not exist node_modules (
  echo  패키지 설치 중... (최초 1회만 실행됩니다)
  npm install --omit=optional
  echo.
)

:: 서버 시작
echo  서버를 시작합니다. 브라우저에서 아래 주소로 접속하세요.
echo  종료하려면 이 창을 닫거나 Ctrl+C 를 누르세요.
echo.
node server.js

pause
