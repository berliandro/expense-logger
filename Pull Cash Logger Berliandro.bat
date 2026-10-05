@echo off
rem ============================================================
rem  Pull Cash Logger Berliandro — double-click insta-update.
rem  Pulls the latest version of this project from GitHub.
rem
rem  ONLY the link below is project-specific. To reuse this
rem  file for another project, change just the REPO_URL line.
rem ============================================================
set "REPO_URL=https://github.com/berliandro/expense-logger.git"

setlocal
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git not found. Install "Git for Windows", then double-click again.
  pause
  exit /b 1
)

if not exist ".git" (
  echo [ERROR] This folder is not a git clone yet.
  echo Clone it first with:
  echo   git clone "%REPO_URL%"
  pause
  exit /b 1
)

echo Pulling latest Cash Logger from GitHub...
git pull --rebase origin main
if errorlevel 1 (
  echo [ERROR] Pull failed - resolve any conflicts, then double-click again.
  pause
  exit /b 1
)

echo Done - project is up to date.
pause
