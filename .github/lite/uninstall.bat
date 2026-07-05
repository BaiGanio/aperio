@echo off
:: Aperio-lite uninstaller for Windows. Double-click to remove what Aperio
:: installed into this folder (engine, dependencies, database, Desktop launcher).
:: Move to the folder where THIS .bat file lives (the app root).
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0assets\uninstall.ps1"
