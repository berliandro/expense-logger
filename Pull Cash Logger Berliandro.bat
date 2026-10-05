@echo off
rem ============================================================
rem  Pull & Deploy Cash Logger — All-in-One Automation Script
rem ============================================================
set "REPO_URL=https://github.com/berliandro/expense-logger.git"

setlocal
cd /d "%~dp0"

echo =======================================================
echo    1/4. CHECKING & DOWNLOADING GIT / PROJECT
echo =======================================================
echo [INFO] Git is required to securely download the project files from GitHub.

where git >nul 2>nul
if errorlevel 1 (
  echo [INFO] Git was not found on your system.
  echo [INFO] Contacting Microsoft servers to download Git for Windows quietly...
  echo [INFO] Please wait, this might take a minute...
  winget install Git.Git -e --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [ERROR] Git installation failed. Please install it manually from https://git-scm.com/
    pause
    exit /b 1
  )
  echo.
  echo [SUCCESS] Git installed successfully!
  echo [!] Because a new core program was installed, Windows needs to refresh.
  echo [!] Please close this black window and double-click the script again!
  pause
  exit /b 0
)

if not exist ".git" (
  echo [INFO] Project folder is empty. Initializing a new connection to GitHub...
  git init
  git remote add origin "%REPO_URL%"
  echo [INFO] Downloading the entire Cash Logger project for the first time...
  git fetch origin main
  git reset --hard origin/main
) else (
  echo [INFO] Checking GitHub for any new updates to the Cash Logger...
  git fetch origin main
  echo [INFO] Applying the latest updates to your local folder...
  git reset --hard origin/main
)

if errorlevel 1 (
  echo [ERROR] Failed to download the files. Check your internet connection and try again.
  pause
  exit /b 1
)

echo [SUCCESS] Project files are up to date!
echo.
echo =======================================================
echo    2/4. CHECKING & DOWNLOADING NODE.JS / CLASP
echo =======================================================
echo [INFO] Node.js is required to run Google's 'clasp' tool.
echo [INFO] 'clasp' is what automatically pushes code to your Google Sheet.

where npm >nul 2>nul
if errorlevel 1 (
  echo [INFO] Node.js was not found on your system.
  echo [INFO] Contacting Microsoft servers to download Node.js quietly...
  winget install OpenJS.NodeJS -e --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [ERROR] Node.js installation failed.
    pause
    exit /b 1
  )
  echo.
  echo [SUCCESS] Node.js installed successfully!
  echo [!] Because a new core program was installed, Windows needs to refresh.
  echo [!] Please close this black window and double-click the script again!
  pause
  exit /b 0
)

where clasp >nul 2>nul
if errorlevel 1 (
  echo [INFO] Node.js is ready. Downloading Google Clasp tools...
  call npm install -g @google/clasp
  echo [SUCCESS] Clasp installed!
) else (
  echo [INFO] Node.js and Google Clasp are already installed and ready.
)

echo.
echo =======================================================
echo    3/4. API KEYS & SCRIPT ID SETUP
echo =======================================================
echo [INFO] To run this project, you may need a Gemini API Key.
echo [INFO] You also MUST have the Google Apps Script API turned ON.
echo.
set /p NEED_HELP="Do you need help opening the links to set these up? (y/help/n): "

if /I "%NEED_HELP%"=="y" goto :ShowHelp
if /I "%NEED_HELP%"=="help" goto :ShowHelp
goto :SkipHelp

:ShowHelp
echo.
echo [INFO] Opening Google AI Studio so you can generate a Gemini API Key...
start https://aistudio.google.com/app/apikey
echo [INFO] Opening Google Apps Script Settings so you can turn ON the API...
start https://script.google.com/home/userSettings
echo.
echo [ACTION REQUIRED]
echo 1. In AI Studio, create and copy your Gemini API key.
echo 2. In Google Apps Script Settings, ensure the toggle is set to ON.
echo.
pause
:SkipHelp

echo.
if not exist ".clasp.json" (
  echo [INFO] We need to link this folder to your specific Google Sheet.
  set /p SCRIPT_ID="Please paste your Google Apps Script ID and press Enter: "
  echo {"scriptId":"%SCRIPT_ID%","rootDir":"."} > .clasp.json
  echo [SUCCESS] Script ID saved!
) else (
  echo [INFO] Found existing Script ID link (.clasp.json). Using it automatically.
)

echo.
echo =======================================================
echo    4/4. GOOGLE LOGIN & DEPLOYMENT
echo =======================================================
echo [INFO] Clasp needs permission to upload the code to your Google Account.
echo.
echo [ACTION REQUIRED] A browser window will open. Log into the Google account
echo that owns the target Google Sheet and click "Allow".
echo.
echo Once the browser says success, return to this window and press a key.
pause
call clasp login

echo.
echo [INFO] Authenticated! Now pushing the project files directly to your Sheet...
call clasp push -f

echo.
echo =======================================================
echo    SUCCESS! Cash Logger is fully updated and deployed!
echo =======================================================
pause
