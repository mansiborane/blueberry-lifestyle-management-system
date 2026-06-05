@echo off
setlocal

cd /d "%~dp0"

echo ========================================
echo  Blueberry - install deps and run dev
echo ========================================
echo.

echo [1/2] npm install...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)
echo.

echo [2/2] Freeing ports 3000, 24678...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports = 3000,24678; foreach ($p in $ports) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('Stopping PID' $_.OwningProcess 'on port' $p); Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"
echo Port cleanup complete.
echo.

start "Blueberry App Server + Frontend" cmd /k "cd /d ""%~dp0"" && npm run dev"

echo Launched:
echo - Node backend + frontend ^(port 3000^)
echo.
echo AI features use Google Gemini directly (set GEMINI_API_KEY in .env.local
echo or save a key under Settings in the app).
echo.

endlocal
