@echo off
setlocal

cd /d "%~dp0"

echo ========================================
echo   Blueberry - install and run
echo ========================================
echo.

REM --- 1. Check Node.js is installed ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on your PATH.
  echo Install it from https://nodejs.org/ ^(LTS^) and run this again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo Using Node %NODE_VER%
echo.

REM --- 2. Create .env.local from the example on first run ---
if not exist ".env.local" (
  if exist ".env.example" (
    echo Creating .env.local from .env.example ...
    copy /y ".env.example" ".env.local" >nul
    echo   -^> Edit .env.local and set GEMINI_API_KEY ^(or add a key under Settings in the app^).
    echo.
  )
)

REM --- 3. Install dependencies ---
echo [1/3] Installing dependencies ^(npm install^)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)
echo.

REM --- 4. Free the dev port (3000) and Vite HMR port (24678) ---
echo [2/3] Freeing ports 3000 and 24678 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach ($p in 3000,24678) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"
echo.

REM --- 5. Run the app (server + frontend) in this window ---
echo [3/3] Starting the app on http://localhost:3000
echo Press Ctrl+C to stop.
echo.
call npm run dev

endlocal
