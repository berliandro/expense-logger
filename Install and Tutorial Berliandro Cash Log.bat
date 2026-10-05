@echo off
setlocal EnableDelayedExpansion

rem ===============================================================
rem  BERLIANDRO CASH LOGGER - INSTALLER
rem ===============================================================

rem --- GENERATE COLORS ---
for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"

set "cRed=!ESC![91m"
set "cGreen=!ESC![92m"
set "cYellow=!ESC![93m"
set "cCyan=!ESC![96m"
set "cReset=!ESC![0m"

set "REPO_URL=https://github.com/berliandro/expense-logger.git"
set "DEPLOYMENT_FILE=.cashlogger-deployment-id"

cd /d "%~dp0"

echo.
echo !cCyan!=======================================================!cReset!
echo !cCyan!   BERLIANDRO CASH LOGGER - INSTALLER!cReset!
echo !cCyan!=======================================================!cReset!
echo.

rem ===============================================================
rem  1/4. DOWNLOAD GIT / PROJECT
rem ===============================================================

echo !cCyan!=======================================================!cReset!
echo !cCyan!   1/4. DOWNLOADING GIT / PROJECT!cReset!
echo !cCyan!=======================================================!cReset!

where git >nul 2>nul

if errorlevel 1 (
    echo !cYellow![INFO]!cReset! Git not found. Downloading Git for Windows...
    echo.

    winget install Git.Git -e --accept-package-agreements --accept-source-agreements

    if errorlevel 1 (
        echo.
        echo !cRed![ERROR]!cReset! Git installation failed.
        echo Please install Git for Windows manually and run this installer again.
        pause
        exit /b 1
    )

    echo.
    echo !cGreen![SUCCESS]!cReset! Git installed successfully.
    echo !cYellow![ACTION]!cReset! Please close this window and run this installer again.
    pause
    exit /b 0
)

if not exist ".git" (
    echo !cYellow![INFO]!cReset! Initializing project repository...

    git init

    if errorlevel 1 (
        echo !cRed![ERROR]!cReset! Could not initialize Git repository.
        pause
        exit /b 1
    )

    git remote add origin "!REPO_URL!"

    if errorlevel 1 (
        echo !cRed![ERROR]!cReset! Could not add GitHub repository.
        pause
        exit /b 1
    )

    echo !cYellow![INFO]!cReset! Downloading latest project from GitHub...

    git fetch origin main

    if errorlevel 1 (
        echo.
        echo !cRed![ERROR]!cReset! Could not download the project from GitHub.
        echo Check your internet connection and try again.
        pause
        exit /b 1
    )

    rem Initial installation only (fresh folder, no local work to preserve):
    rem Make this folder match the GitHub project.
    rem NOTE: Update.bat also syncs tracked files to GitHub with
    rem git fetch + git reset --hard origin/main (family installs are
    rem deployment clients). Ignored per-user files (.clasp.json,
    rem .cashlogger-deployment-id) are untouched by that command.
    git reset --hard origin/main

    if errorlevel 1 (
        echo.
        echo !cRed![ERROR]!cReset! Could not install the project files.
        pause
        exit /b 1
    )

    echo !cGreen![SUCCESS]!cReset! Project downloaded successfully.
) else (
    echo !cYellow![INFO]!cReset! Project repository already exists here.
    echo !cYellow![INFO]!cReset! Existing project files will not be replaced.
)

echo.

rem ===============================================================
rem  2/4. DOWNLOAD NODE.JS / CLASP
rem ===============================================================

echo !cCyan!=======================================================!cReset!
echo !cCyan!   2/4. DOWNLOADING NODE.JS / CLASP!cReset!
echo !cCyan!=======================================================!cReset!

where npm >nul 2>nul

if errorlevel 1 (
    echo !cYellow![INFO]!cReset! Node.js not found. Downloading Node.js...

    winget install OpenJS.NodeJS -e --accept-package-agreements --accept-source-agreements

    if errorlevel 1 (
        echo.
        echo !cRed![ERROR]!cReset! Node.js installation failed.
        echo Please install Node.js manually and run this installer again.
        pause
        exit /b 1
    )

    echo.
    echo !cGreen![SUCCESS]!cReset! Node.js installed successfully.
    echo !cYellow![ACTION]!cReset! Please close this window and run this installer again.
    pause
    exit /b 0
)

where clasp >nul 2>nul

if errorlevel 1 (
    echo !cYellow![INFO]!cReset! Google clasp not found. Installing...

    call npm install -g @google/clasp

    if errorlevel 1 (
        echo.
        echo !cRed![ERROR]!cReset! Could not install Google clasp.
        pause
        exit /b 1
    )

    echo !cGreen![SUCCESS]!cReset! Google clasp installed successfully.
) else (
    echo !cGreen![INFO]!cReset! Google clasp is already installed.
)

echo.

rem ===============================================================
rem  3/4. API KEYS AND SCRIPT ID SETUP
rem ===============================================================

echo !cCyan!=======================================================!cReset!
echo !cCyan!   3/4. API KEYS AND SCRIPT ID SETUP!cReset!
echo !cCyan!=======================================================!cReset!

set /p NEED_HELP="!cYellow!Do you need help opening the API setup links? (y/n): !cReset!"

if /I "!NEED_HELP!"=="y" (
    start "" "https://aistudio.google.com/app/apikey"
    start "" "https://script.google.com/home/usersettings"

    echo.
    echo !cRed![ACTION REQUIRED]!cReset!
    echo Create your Gemini API key and turn ON the Apps Script API toggle.
    echo.
    pause
)

if not exist ".clasp.json" (
    echo.
    set /p SCRIPT_ID="!cYellow!Paste your Google Apps Script ID and press Enter: !cReset!"

    rem Trim accidental spaces (Script IDs never contain spaces).
    set "SCRIPT_ID=!SCRIPT_ID: =!"

    if "!SCRIPT_ID!"=="" (
        echo.
        echo !cRed![ERROR]!cReset! No Script ID was provided.
        pause
        exit /b 1
    )

    echo {"scriptId":"!SCRIPT_ID!","rootDir":"."} > ".clasp.json"

    if errorlevel 1 (
        echo.
        echo !cRed![ERROR]!cReset! Could not create .clasp.json.
        pause
        exit /b 1
    )

    echo !cGreen![SUCCESS]!cReset! Script ID saved.
) else (
    echo !cYellow![INFO]!cReset! .clasp.json already exists.
    echo !cYellow![INFO]!cReset! Keeping the existing Apps Script connection.
)

echo.

rem ===============================================================
rem  4/4. GOOGLE LOGIN AND INITIAL WEB APP DEPLOYMENT
rem ===============================================================

echo !cCyan!=======================================================!cReset!
echo !cCyan!   4/4. GOOGLE LOGIN AND WEB APP DEPLOYMENT!cReset!
echo !cCyan!=======================================================!cReset!

echo !cRed![ACTION REQUIRED]!cReset!
echo A browser will open for Google authentication.
echo Log into the Google account that should own the Cash Logger.
echo Review the requested permissions and click "Allow".
echo.
pause

call clasp login

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Google clasp login failed.
    echo The project has not been deployed.
    pause
    exit /b 1
)

echo.
echo !cYellow![INFO]!cReset! Uploading project files to Google Apps Script...

call clasp push -f

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Apps Script upload failed.
    echo The Web App has not been deployed.
    pause
    exit /b 1
)

echo !cGreen![SUCCESS]!cReset! Project uploaded successfully.
echo.

rem ===============================================================
rem  CREATE INITIAL DEPLOYMENT
rem ===============================================================

echo !cYellow![INFO]!cReset! Creating your Web App deployment...
echo.

set "DEPLOYMENT_JSON=!TEMP!\cash_logger_deployment.json"
set "DEPLOYMENT_ID_OUTPUT=!TEMP!\cash_logger_deployment_id.txt"

del /f /q "!DEPLOYMENT_JSON!" >nul 2>nul
del /f /q "!DEPLOYMENT_ID_OUTPUT!" >nul 2>nul

call clasp create-deployment --description "Cash Logger" --json > "!DEPLOYMENT_JSON!"

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Web App deployment failed.
    echo.
    echo Clasp returned:
    echo -------------------------------------------------------
    type "!DEPLOYMENT_JSON!"
    echo.
    echo -------------------------------------------------------
    echo.
    echo Possible causes:
    echo - Apps Script API is not enabled.
    echo - Google authentication did not complete.
    echo - The account cannot deploy this project.
    echo - The manifest contains an invalid Web App configuration.
    echo.
    pause
    exit /b 1
)

echo !cGreen![SUCCESS]!cReset! Web App deployment created.
echo.

rem ===============================================================
rem  EXTRACT DEPLOYMENT ID
rem ===============================================================

echo !cYellow![INFO]!cReset! Reading deployment ID...

powershell -NoProfile -Command ^
    "$json = Get-Content -Raw -LiteralPath '!DEPLOYMENT_JSON!' | ConvertFrom-Json; if ($json.deploymentId) { Write-Output $json.deploymentId } else { exit 2 }" ^
    > "!DEPLOYMENT_ID_OUTPUT!"

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Deployment was created, but the deployment ID could not be extracted.
    echo.
    echo Raw clasp response:
    echo -------------------------------------------------------
    type "!DEPLOYMENT_JSON!"
    echo.
    echo -------------------------------------------------------
    echo.
    pause
    exit /b 1
)

set "DEPLOYMENT_ID="
set /p DEPLOYMENT_ID=<"!DEPLOYMENT_ID_OUTPUT!"

if "!DEPLOYMENT_ID!"=="" (
    echo.
    echo !cRed![ERROR]!cReset! The deployment ID is empty.
    echo.
    echo Raw clasp response:
    echo -------------------------------------------------------
    type "!DEPLOYMENT_JSON!"
    echo.
    echo -------------------------------------------------------
    echo.
    pause
    exit /b 1
)

rem ===============================================================
rem  SAVE DEPLOYMENT ID (local only, never committed)
rem ===============================================================

echo !DEPLOYMENT_ID!> "!DEPLOYMENT_FILE!"

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Could not save the deployment ID.
    pause
    exit /b 1
)

rem ===============================================================
rem  BUILD WEB APP URL
rem ===============================================================

set "WEB_APP_URL=https://script.google.com/macros/s/!DEPLOYMENT_ID!/exec"

rem ===============================================================
rem  CLEAN TEMP FILES
rem ===============================================================

del /f /q "!DEPLOYMENT_JSON!" >nul 2>nul
del /f /q "!DEPLOYMENT_ID_OUTPUT!" >nul 2>nul

rem ===============================================================
rem  FINAL SUCCESS
rem ===============================================================

echo.
echo !cGreen!=======================================================!cReset!
echo !cGreen!   SUCCESS! INSTALLATION COMPLETE! !cReset!
echo !cGreen!=======================================================!cReset!
echo.
echo !cGreen!Web App URL:!cReset!
echo !WEB_APP_URL!
echo.
echo !cGreen!Deployment ID:!cReset!
echo !DEPLOYMENT_ID!
echo.
echo !cGreen!Saved locally to:!cReset!
echo !DEPLOYMENT_FILE!
echo This file is git-ignored; each installation keeps its own ID.
echo.
echo !cYellow!Use "Update.bat" for future updates.!cReset!
echo !cYellow!The updater will reuse this same deployment.!cReset!
echo.
echo !cYellow![INFO]!cReset! Opening your Cash Logger Web App...
echo.

start "" "!WEB_APP_URL!"

pause
exit /b 0
