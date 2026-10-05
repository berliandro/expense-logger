@echo off
rem ============================================================
rem  Pull & Deploy Cash Logger — All-in-One Automation Script
rem ============================================================
set "REPO_URL=https://github.com/berliandro/expense-logger.git"

setlocal
cd /d "%~dp0"

echo =======================================================
echo    1/3. CHECKING & DOWNLOADING GIT / PROJECT
echo =======================================================

where git >nul 2>nul
if errorlevel 1 (
  echo [INFO] Git not found. Installing automatically via winget...
  echo.
  winget install Git.Git -e --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [ERROR] Git installation failed. Please install it manually from https://git-scm.com/
    pause
    exit /b 1
  )
  echo.
  echo [!] Git has been installed! Please close this window and double-click the script again.
  pause
  exit /b 0
)

if not exist ".git" (
  echo [INFO] Project files not found here yet. Downloading for the first time...
  git init
  git remote add origin "%REPO_URL%"
  git fetch origin main
  git reset --hard origin/main
) else (
  echo [INFO] Fetching latest updates from GitHub...
  git fetch origin main
  git reset --hard origin/main
)

if errorlevel 1 (
  echo [ERROR] Git sync failed. Check your internet connection and try again.
  pause
  exit /b 1
)

echo.
echo =======================================================
echo    2/3. CHECKING & DOWNLOADING NODE.JS / CLASP
echo =======================================================

where npm >nul 2>nul
if errorlevel 1 (
  echo [INFO] Node.js not found. Installing automatically via winget...
  echo.
  winget install OpenJS.NodeJS -e --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [ERROR] Node.js installation failed.
    pause
    exit /b 1
  )
  echo.
  echo [!] Node.js has been installed! Please close this window and double-click the script again.
  pause
  exit /b 0
)

where clasp >nul 2>nul
if errorlevel 1 (
  echo [INFO] Installing Google Clasp tools...
  call npm install -g @google/clasp
)

echo.
echo =======================================================
echo    3/3. CONFIGURING GOOGLE SCRIPT ID & DEPLOYING
echo =======================================================

if not exist ".clasp.json" (
  echo.
  set /p SCRIPT_ID="Please paste your Google Apps Script ID and press Enter: "
  echo {"scriptId":"%SCRIPT_ID%","rootDir":"."} > .clasp.json
) else (
  echo [INFO] Using existing .clasp.json configuration.
)

echo.
echo =======================================================
echo                   [ ACTION REQUIRED ]
echo A browser window will open. Log into the Google account
echo that owns the target Google Sheet and click "Allow".
echo =======================================================
pause
call clasp login

echo.
echo [INFO] Pushing the latest code to your Google Sheet...
call clasp push -f

echo.
echo =======================================================
echo    SUCCESS! Cash Logger is updated and deployed!
echo =======================================================
pause
