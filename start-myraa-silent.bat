@echo off
chcp 65001 >nul
set "PROJECT_DIR=D:\project\new_jarvis\Sara\Sara-main"
set "PYTHON_EXE=python"
cd /d "%PROJECT_DIR%"
start "" /B "%PYTHON_EXE%" -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765
timeout /t 3 /nobreak >nul
start "" /B npm run dev
timeout /t 6 /nobreak >nul
start "" "http://localhost:3000"
