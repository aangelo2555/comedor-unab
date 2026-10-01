@echo off
chcp 65001 >nul
title COMEDOR UNAB - Portal y Francotirador de Reservas

set "NODE_CMD="

:: 1. Check system node
where node.exe >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "NODE_CMD=node.exe"
    goto :FoundNode
)

:: 2. Check Codex runtime node
if exist "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\13827bafdc0b5422\bin\node.exe" (
    set "NODE_CMD=%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\13827bafdc0b5422\bin\node.exe"
    goto :FoundNode
)

:: 3. Check other common locations
for /f "delims=" %%i in ('where /r "%LOCALAPPDATA%\OpenAI\Codex\runtimes" node.exe 2^>nul') do (
    set "NODE_CMD=%%i"
    goto :FoundNode
)

:FoundNode
if "%NODE_CMD%"=="" (
    echo [ERROR] No se encontro el ejecutable de Node.js en su sistema.
    echo Por favor instale Node.js desde https://nodejs.org/ o contacte soporte.
    pause
    exit /b 1
)

echo ========================================================
echo   COMEDOR UNIVERSITARIO UNAB - PORTAL DE ALMUERZO
echo ========================================================
echo [OK] Runtime Node detectado: %NODE_CMD%
echo [OK] Iniciando servidor web en http://localhost:3000...
echo.

:: Open browser after 1.5 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Start Node Server
"%NODE_CMD%" server.js

pause
