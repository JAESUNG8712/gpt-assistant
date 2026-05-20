@echo off
setlocal enabledelayedexpansion
title iPad 서버 패키지 내보내기

echo.
echo ============================================
echo   iPad AI 서버 파일 패키지 생성
echo ============================================
echo.

set EXPORT=ai-server-ipad
if exist "%EXPORT%" rmdir /s /q "%EXPORT%"
mkdir "%EXPORT%"

:: 필수 디렉토리 생성
mkdir "%EXPORT%\engine"
mkdir "%EXPORT%\routes"
mkdir "%EXPORT%\public"
mkdir "%EXPORT%\scripts"
mkdir "%EXPORT%\data"

echo [1/4] 엔진 파일 복사...
for %%f in (engine\matrix.js engine\tokenizer.js engine\model.js engine\optimizer.js engine\trainer.js) do (
    copy "%%f" "%EXPORT%\%%f" >nul
    echo      %%f
)

echo [2/4] 라우터 복사...
copy "routes\engine.js" "%EXPORT%\routes\engine.js" >nul
copy "routes\sync.js"   "%EXPORT%\routes\sync.js"   >nul 2>nul

echo [3/4] 서버 및 설정 파일 복사...
copy "server-ipad.js"      "%EXPORT%\server-ipad.js"     >nul
copy "package-ipad.json"   "%EXPORT%\package.json"        >nul
copy "scripts\ipad-setup.sh" "%EXPORT%\scripts\ipad-setup.sh" >nul

echo [4/4] 웹 페이지 복사...
for %%f in (public\engine-studio.html public\engine-ipad.html public\sync.html) do (
    if exist "%%f" (
        copy "%%f" "%EXPORT%\%%f" >nul
        echo      %%f
    )
)

:: 학습된 가중치도 포함 (있으면)
if exist "data\minigpt-weights.json" (
    copy "data\minigpt-weights.json" "%EXPORT%\data\minigpt-weights.json" >nul
    echo      data\minigpt-weights.json (기존 학습 내용 포함)
)

echo.
echo ============================================
echo   완료! 폴더: %EXPORT%\
echo ============================================
echo.
echo iPad 이전 방법:
echo.
echo [방법 1] iCloud Drive
echo   이 폴더를 iCloud Drive에 업로드
echo   iPad iSH에서: cp -r /iCloud/ai-server-ipad/. ~/ai-server/
echo.
echo [방법 2] USB
echo   iPad를 USB로 PC에 연결
echo   iTunes/Finder에서 iSH 앱 → 파일에 폴더 복사
echo.

explorer "%EXPORT%"
pause
