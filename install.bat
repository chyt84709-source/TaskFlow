@echo off
setlocal
npm.cmd install --omit=dev
echo.
echo Dependencies installed. Configure .env, then run start.bat to launch the headless server.
pause
