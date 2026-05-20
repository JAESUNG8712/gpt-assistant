@echo off
:: 관리자 권한 확인
net session >nul 2>&1
if errorlevel 1 (
    echo 관리자 권한으로 다시 실행합니다...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo === Windows 방화벽 - AI 포트 3000 열기 ===
echo.

:: 기존 규칙 제거 후 새로 추가
netsh advfirewall firewall delete rule name="AI Assistant Port 3000" >nul 2>&1
netsh advfirewall firewall add rule ^
    name="AI Assistant Port 3000" ^
    dir=in ^
    action=allow ^
    protocol=TCP ^
    localport=3000 ^
    profile=private

if errorlevel 1 (
    echo [오류] 방화벽 규칙 추가 실패
) else (
    echo [완료] 포트 3000 개방됨
    echo.
    :: 현재 IP 표시
    for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /r "IPv4.*10\.\|IPv4.*192\.\|IPv4.*172\."') do (
        set IP=%%a
        set IP=!IP: =!
        echo iPad 접속 주소: http://!IP!:3000/ai-chat.html
    )
)

echo.
pause
