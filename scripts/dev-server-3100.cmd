@echo off
rem Development server on port 3100, for testing while the installed MYRAA uses 3000.
set MYRAA_PORT=3100
cd /d "%~dp0.."
npx tsx server.ts
