@echo off
chcp 65001 >nul
title FRANCOTIRADOR UNAB - 17:00:00

set "NODE_CMD="

where node.exe >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "NODE_CMD=node.exe"
    goto :FoundNode
)

if exist "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\81ea4d5168ddd0a3\bin\node.exe" (
    set "NODE_CMD=%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\81ea4d5168ddd0a3\bin\node.exe"
    goto :FoundNode
)

if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_CMD=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    goto :FoundNode
)

if exist "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\13827bafdc0b5422\bin\node.exe" (
    set "NODE_CMD=%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\13827bafdc0b5422\bin\node.exe"
    goto :FoundNode
)

for /f "delims=" %%i in ('where /r "%LOCALAPPDATA%\OpenAI\Codex\runtimes" node.exe 2^>nul') do (
    set "NODE_CMD=%%i"
    goto :FoundNode
)
for /f "delims=" %%i in ('where /r "%USERPROFILE%\.cache" node.exe 2^>nul') do (
    set "NODE_CMD=%%i"
    goto :FoundNode
)

:FoundNode
if "%NODE_CMD%"=="" (
    echo [ERROR] No se encontro Node.js en su sistema.
    pause
    exit /b 1
)

"%NODE_CMD%" sniper_consola.js

pause
