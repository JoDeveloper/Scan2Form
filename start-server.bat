@echo off
setlocal
echo Starting Scan2Form Server...
node "%~dp0dist\bridge-server.js"
pause
