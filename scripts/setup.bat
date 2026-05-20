@echo off
setlocal enabledelayedexpansion
title AI Assistant - 초기 설치

echo.
echo ====================================================
echo    로컬 AI 어시스턴트 - 초기 설치
echo ====================================================
echo.

:: Node.js 확인
echo [1/4] Node.js 확인...
node --version >nul 2>&1
if errorlevel 1 (
    echo [오류] Node.js가 설치되지 않았습니다.
    echo       https://nodejs.org 에서 Node.js 18 이상을 설치하세요.
    pause & exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo       Node.js %NODE_VER% 확인됨

:: npm 패키지 설치
echo.
echo [2/4] npm 패키지 설치...
npm install
if errorlevel 1 (
    echo [오류] npm install 실패
    pause & exit /b 1
)
echo       완료

:: Ollama 확인
echo.
echo [3/4] Ollama 확인...
where ollama >nul 2>&1
if errorlevel 1 (
    echo [경고] Ollama가 설치되지 않았습니다.
    echo       https://ollama.com 에서 Ollama를 다운로드하여 설치하세요.
    echo       설치 후 이 스크립트를 다시 실행하거나, 수동으로 아래 명령을 실행하세요:
    echo       ollama pull phi4-mini
    echo.
    set /p SKIP="Ollama 설치를 건너뛰고 계속하시겠습니까? (y/N): "
    if /i "!SKIP!" neq "y" (pause & exit /b 1)
) else (
    echo       Ollama 확인됨
    echo.
    echo [3-1] AI 대화 모델 다운로드 (phi4-mini, 약 2.5GB)...
    ollama pull phi4-mini
    if errorlevel 1 (
        echo [경고] phi4-mini 다운로드 실패.
    ) else (
        echo       대화 모델 다운로드 완료
    )
    echo.
    echo [3-2] 임베딩 모델 다운로드 (nomic-embed-text, 약 274MB) - 자가학습에 필요...
    ollama pull nomic-embed-text
    if errorlevel 1 (
        echo [경고] 임베딩 모델 다운로드 실패. 자가학습 기능이 제한됩니다.
    ) else (
        echo       임베딩 모델 다운로드 완료
    )
)

:: .env 파일 생성
echo.
echo [4/4] 설정 파일 생성...
if not exist .env (
    copy .env.example .env >nul 2>&1
    echo       .env 파일 생성됨 (필요시 편집하세요)
) else (
    echo       .env 파일 이미 존재
)

echo.
echo ====================================================
echo    설치 완료!
echo ====================================================
echo.
echo 서버 시작 방법:
echo   1. 새 터미널에서: ollama serve
echo   2. 이 터미널에서: npm start
echo.
echo AI 채팅 접속: http://localhost:3000/ai-chat.html
echo.

set /p START="지금 서버를 시작하시겠습니까? (y/N): "
if /i "%START%"=="y" (
    echo Ollama 서버를 먼저 시작해주세요 (별도 터미널에서 'ollama serve')
    timeout /t 3 >nul
    npm start
)

pause
