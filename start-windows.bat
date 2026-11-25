@echo off
setlocal
cd /d "%~dp0"
where java >nul 2>nul
if errorlevel 1 (
  echo Java 17 or newer is required. Install it or add Java to PATH.
  pause
  exit /b 1
)
java -jar ClassroomNoiseMeter.jar
if errorlevel 1 pause
