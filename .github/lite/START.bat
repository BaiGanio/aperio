@echo off
:: Aperio-lite ignition for Windows. Double-click this file to start Aperio.
:: Move to the folder where THIS .bat file lives (the app root).
cd /d "%~dp0"

:: Run the ignition script (installs Node/deps if needed, then starts the server).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0assets\start.ps1"

:: If PowerShell exited early (an error before the server started), keep the
:: window open so the message is readable.
echo.
echo Press any key to close this window.
pause >nul
