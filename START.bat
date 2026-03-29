@echo off
:: 1. Move to the folder where THIS .bat file is actually located
cd /d "%~dp0"

echo 📍 Working Directory: %cd%

:: 2. Launch PowerShell, bypass execution restrictions, and run the .ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "lib/start.ps1"

:: 3. Keep the window open if the script finishes or crashes
echo.
echo ------------------------------------------
echo 🏁 Process finished. Press any key to exit.
pause >nul
