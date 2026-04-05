export class Setup {
  static async generateUninstalls() {
    const isWin = Deno.build.os === "windows";

    if (isWin) {
      const batContent = `@echo off
echo ======================================
echo       UNINSTALL APERIO-LITE
echo ======================================
set /p confirm="Are you sure? (y/n): "
if /i "%confirm%" neq "y" exit /b

taskkill /F /IM node.exe /T 2>nul
taskkill /F /IM ollama.exe /T 2>nul

rd /s /q node_modules 2>nul
del .aperio-config.json 2>nul
rd /s /q data 2>nul

echo Done!
pause`;
      await Deno.writeTextFile("uninstall.bat", batContent);
    } else {
      // Use \x1b instead of \033
      const shContent = `#!/bin/bash
RD='\\x1b[0;31m'
GR='\\x1b[0;32m'
R='\\x1b[0m'
printf "\\n  \${RD}Uninstalling Aperio-lite...\\n"
# ... rest of your bash logic ...
`;
      await Deno.writeTextFile("uninstall.sh", shContent);
      await new Deno.Command("chmod", { args: ["+x", "uninstall.sh"] }).output();
    }
  }
}
