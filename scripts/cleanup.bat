@echo off
title 3D_CG_GS Cleanup
echo.
echo === 3D_CG_GS Cleanup ===
echo.

echo [1/2] Closing Chrome / Edge background processes...
taskkill /F /IM chrome.exe /T 2>nul
taskkill /F /IM msedge.exe /T 2>nul
echo     done.

echo.
echo [2/2] Releasing old Vite ports (5174-5180)...
for %%p in (5174 5175 5176 5177 5178 5179 5180) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p "') do (
    taskkill /F /PID %%a 2>nul
  )
)
echo     done.

echo.
echo === Done ===
echo Open http://localhost:5173/ in a fresh browser tab.
echo (Press any key to close this window)
pause >nul
