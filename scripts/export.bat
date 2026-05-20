@echo off
setlocal enabledelayedexpansion
title AI Assistant - PC 이전 패키지 생성

echo.
echo ====================================================
echo    로컬 AI 어시스턴트 - PC 이전 패키지 생성
echo ====================================================
echo.

:: 날짜/시간으로 폴더명 생성
for /f "tokens=1-3 delims=-" %%a in ('date /t') do (
    set YEAR=%%a
    set MONTH=%%b
    set DAY=%%c
)
set EXPORT_NAME=ai-assistant-export-%YEAR%%MONTH%%DAY%
set EXPORT_DIR=%~dp0..\%EXPORT_NAME%

echo 내보내기 폴더: %EXPORT_DIR%
echo.

:: 앱 파일 복사 (node_modules, data 제외)
echo [1/4] 앱 파일 복사...
mkdir "%EXPORT_DIR%" 2>nul

for %%f in (
    server.js
    package.json
    package-lock.json
    .env.example
    Dockerfile
    docker-compose.yml
) do (
    if exist "%~dp0..\%%f" (
        copy "%~dp0..\%%f" "%EXPORT_DIR%\%%f" >nul
        echo       복사: %%f
    )
)

:: 디렉토리 복사
for %%d in (services routes public scripts .claude) do (
    if exist "%~dp0..\%%d\" (
        xcopy /E /I /Q "%~dp0..\%%d" "%EXPORT_DIR%\%%d" >nul
        echo       복사: %%d\
    )
)

:: data 폴더 복사 (백업 포함, 선택)
echo.
set /p COPY_DATA="데이터(data/)도 함께 내보내시겠습니까? (y/N): "
if /i "%COPY_DATA%"=="y" (
    if exist "%~dp0..\data\" (
        xcopy /E /I /Q "%~dp0..\data" "%EXPORT_DIR%\data" >nul
        echo       데이터 복사 완료
    )
)

echo 앱 파일 복사 완료

:: Ollama 모델 복사 (선택)
echo.
echo [2/4] Ollama 모델 확인...
set OLLAMA_MODELS=%USERPROFILE%\.ollama\models
if exist "%OLLAMA_MODELS%" (
    echo       Ollama 모델 폴더: %OLLAMA_MODELS%
    for /f "tokens=*" %%s in ('dir /s /b "%OLLAMA_MODELS%\*.gguf" 2^>nul') do (
        set HAS_MODELS=1
    )
    if defined HAS_MODELS (
        set /p COPY_MODELS="Ollama 모델도 함께 복사하시겠습니까? (오프라인 이전 시 필요, y/N): "
        if /i "!COPY_MODELS!"=="y" (
            echo       모델 복사 중... (수 GB일 수 있습니다)
            xcopy /E /I /Q "%OLLAMA_MODELS%" "%EXPORT_DIR%\ollama-models" >nul
            echo       모델 복사 완료
            echo       새 PC에서: xcopy /E /I ollama-models "%USERPROFILE%\.ollama\models"
        )
    ) else (
        echo       설치된 모델 없음
    )
) else (
    echo       Ollama 미설치 또는 모델 없음
)

:: README 생성
echo.
echo [3/4] 설치 가이드 생성...
(
echo # 로컬 AI 어시스턴트 - 새 PC 설치 가이드
echo.
echo ## 방법 1: 일반 설치 (권장)
echo.
echo 1. Node.js 18 이상 설치: https://nodejs.org
echo 2. Ollama 설치: https://ollama.com
echo 3. 이 폴더를 원하는 위치에 복사
echo 4. scripts\setup.bat 실행
echo.
echo ## 방법 2: Docker 설치 (Docker 환경)
echo.
echo 1. Docker Desktop 설치: https://docker.com
echo 2. 터미널에서 이 폴더로 이동 후:
echo    docker-compose up -d
echo    docker-compose exec ollama ollama pull phi4-mini
echo 3. 브라우저: http://localhost:3000/ai-chat.html
echo.
echo ## AI 채팅 접속
echo.
echo http://localhost:3000/ai-chat.html
echo.
echo ## 오프라인 모델 이전 (ollama-models 폴더가 있는 경우)
echo.
echo xcopy /E /I ollama-models "%%USERPROFILE%%\.ollama\models"
echo.
echo ## 환경 설정 (.env 파일)
echo.
echo OLLAMA_MODEL=phi4-mini       # 사용할 모델
echo OLLAMA_URL=http://localhost:11434
echo TAVILY_API_KEY=              # 선택: 고급 웹 검색
) > "%EXPORT_DIR%\새PC설치가이드.md"
echo       가이드 생성 완료

:: 완료
echo.
echo [4/4] 완료!
echo.
echo ====================================================
echo    내보내기 완료: %EXPORT_NAME%
echo ====================================================
echo.
echo 이 폴더를 USB, 공유 드라이브, 또는 네트워크로 새 PC에 복사하세요.
echo 새 PC에서 '새PC설치가이드.md' 파일을 참고하여 설치하세요.
echo.

explorer "%EXPORT_DIR%"
pause
