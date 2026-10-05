@echo off
setlocal EnableDelayedExpansion

rem ===============================================================
rem  BERLIANDRO CASH LOGGER - UPDATE
rem ===============================================================

rem --- GENERATE COLORS ---
for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"

set "cRed=!ESC![91m"
set "cGreen=!ESC![92m"
set "cYellow=!ESC![93m"
set "cCyan=!ESC![96m"
set "cReset=!ESC![0m"

set "DEPLOYMENT_FILE=.cashlogger-deployment-id"

rem ===============================================================
rem  ROUTING
rem ===============================================================

if "%~1"=="--temp-updater" goto :TempUpdater
if "%~1"=="--run-main" goto :MainTask

rem ===============================================================
rem  STAGE 1
rem  COPY THIS SCRIPT TO TEMP SO GIT CAN UPDATE Update.bat
rem ===============================================================

echo.
echo !cCyan!=======================================================!cReset!
echo !cCyan!   BERLIANDRO CASH LOGGER - UPDATE!cReset!
echo !cCyan!=======================================================!cReset!
echo.

echo !cYellow![INFO]!cReset! Preparing updater...

set "TEMP_SCRIPT=!TEMP!\cash_logger_updater_!RANDOM!_!RANDOM!.bat"

copy /y "%~f0" "!TEMP_SCRIPT!" >nul

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Could not prepare the updater.
    pause
    exit /b 1
)

rem Run the temporary copy.
rem The original Update.bat can now be renamed/replaced by Git safely.
"!TEMP_SCRIPT!" --temp-updater "%~dp0"

set "TEMP_EXIT_CODE=!ERRORLEVEL!"

rem Clean up the temporary copy; the project folder keeps the real Update.bat.
del /f /q "!TEMP_SCRIPT!" >nul 2>nul

exit /b !TEMP_EXIT_CODE!


rem ===============================================================
rem  STAGE 2
rem  TEMP UPDATER
rem ===============================================================

:TempUpdater

set "PROJECT_DIR=%~2"

if "!PROJECT_DIR!"=="" (
    echo.
    echo !cRed![ERROR]!cReset! Could not determine the project directory.
    pause
    exit /b 1
)

cd /d "!PROJECT_DIR!"

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Could not access the project directory.
    pause
    exit /b 1
)

echo.
echo !cCyan!=======================================================!cReset!
echo !cCyan!   1/3. CHECKING FOR UPDATES!cReset!
echo !cCyan!=======================================================!cReset!
echo.

rem ---------------------------------------------------------------
rem CHECK GIT
rem ---------------------------------------------------------------

where git >nul 2>nul

if errorlevel 1 (
    echo !cRed![ERROR]!cReset! Git is not installed.
    echo Please run the installer first.
    pause
    exit /b 1
)

rem ---------------------------------------------------------------
rem CHECK CLASP
rem ---------------------------------------------------------------

where clasp >nul 2>nul

if errorlevel 1 (
    echo !cRed![ERROR]!cReset! Google clasp is not installed.
    echo Please run the installer first.
    pause
    exit /b 1
)

rem ---------------------------------------------------------------
rem CHECK GIT REPOSITORY
rem ---------------------------------------------------------------

if not exist ".git" (
    echo !cRed![ERROR]!cReset! This folder is not a Git project.
    echo Please run the installer first.
    pause
    exit /b 1
)

rem ---------------------------------------------------------------
rem CHECK CLASP CONFIG
rem ---------------------------------------------------------------

if not exist ".clasp.json" (
    echo !cRed![ERROR]!cReset! .clasp.json was not found.
    echo Please run the installer first.
    pause
    exit /b 1
)

rem ---------------------------------------------------------------
rem CHECK DEPLOYMENT ID
rem ---------------------------------------------------------------

if not exist "!DEPLOYMENT_FILE!" (
    echo !cRed![ERROR]!cReset! Web App deployment ID was not found.
    echo.
    echo Expected file:
    echo !DEPLOYMENT_FILE!
    echo.
    echo Please run the installer again.
    pause
    exit /b 1
)

set "DEPLOYMENT_ID="
set /p DEPLOYMENT_ID=<"!DEPLOYMENT_FILE!"

if "!DEPLOYMENT_ID!"=="" (
    echo !cRed![ERROR]!cReset! The deployment ID file is empty.
    echo Please run the installer again.
    pause
    exit /b 1
)

echo !cGreen![INFO]!cReset! Deployment ID found:
echo !DEPLOYMENT_ID!
echo.

rem ===============================================================
rem  FETCH REMOTE
rem ===============================================================

echo !cYellow![INFO]!cReset! Contacting GitHub...

git fetch origin main

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Could not contact GitHub.
    echo Check your internet connection and try again.
    pause
    exit /b 1
)

rem ===============================================================
rem  CHECK FOR LOCAL MODIFICATIONS
rem ===============================================================

git diff --quiet

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Local project files have been modified.
    echo.
    echo The updater will not overwrite local changes.
    echo Restore or commit the changes before updating.
    echo.
    pause
    exit /b 1
)

git diff --cached --quiet

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! There are staged local changes.
    echo.
    echo The updater will not overwrite them.
    echo.
    pause
    exit /b 1
)

rem ===============================================================
rem  PULL LATEST VERSION
rem ===============================================================

echo !cYellow![INFO]!cReset! Downloading the latest Cash Logger version...

git pull --ff-only origin main

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! The project could not be updated safely.
    echo.
    echo No deployment was performed.
    echo.
    echo This can happen if the local repository and GitHub
    echo cannot be fast-forwarded cleanly.
    echo.
    pause
    exit /b 1
)

echo.
echo !cGreen![SUCCESS]!cReset! Latest project downloaded.
echo.

rem ===============================================================
rem  TRANSFER TO NEWLY DOWNLOADED UPDATE.BAT
rem ===============================================================

if not exist "!PROJECT_DIR!Update.bat" (
    echo.
    echo !cRed![ERROR]!cReset! Update.bat was not found after updating.
    echo.
    echo The update may not have completed correctly.
    echo.
    pause
    exit /b 1
)

echo !cGreen![SUCCESS]!cReset! Updater is current.
echo.

rem Run the newly downloaded Update.bat.
call "!PROJECT_DIR!Update.bat" --run-main

set "MAIN_EXIT_CODE=!ERRORLEVEL!"

rem Return the same result.
exit /b !MAIN_EXIT_CODE!


rem ===============================================================
rem  STAGE 3
rem  MAIN TASKS
rem ===============================================================

:MainTask

cd /d "%~dp0"

echo.
echo !cCyan!=======================================================!cReset!
echo !cCyan!   2/3. UPLOADING LATEST PROJECT!cReset!
echo !cCyan!=======================================================!cReset!
echo.

rem ---------------------------------------------------------------
rem CHECK DEPLOYMENT FILE AGAIN
rem ---------------------------------------------------------------

if not exist "!DEPLOYMENT_FILE!" (
    echo !cRed![ERROR]!cReset! Deployment ID file was not found.
    pause
    exit /b 1
)

set "DEPLOYMENT_ID="
set /p DEPLOYMENT_ID=<"!DEPLOYMENT_FILE!"

if "!DEPLOYMENT_ID!"=="" (
    echo !cRed![ERROR]!cReset! Deployment ID is empty.
    pause
    exit /b 1
)

echo !cYellow![INFO]!cReset! Pushing latest code to Google Apps Script...

call clasp push -f

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Apps Script upload failed.
    echo.
    echo The live Web App deployment was NOT updated.
    pause
    exit /b 1
)

echo.
echo !cGreen![SUCCESS]!cReset! Project uploaded successfully.
echo.

rem ===============================================================
rem  UPDATE EXISTING WEB APP DEPLOYMENT
rem ===============================================================

echo !cCyan!=======================================================!cReset!
echo !cCyan!   3/3. UPDATING WEB APP!cReset!
echo !cCyan!=======================================================!cReset!
echo.

echo !cYellow![INFO]!cReset! Updating existing Web App deployment...
echo Deployment ID: !DEPLOYMENT_ID!
echo.

call clasp update-deployment "!DEPLOYMENT_ID!" -d "Cash Logger Update"

if errorlevel 1 (
    echo.
    echo !cRed![ERROR]!cReset! Web App deployment update failed.
    echo.
    echo The project was uploaded successfully,
    echo but the live Web App may still be running the
    echo previous version.
    echo.
    pause
    exit /b 1
)

rem ===============================================================
rem  BUILD WEB APP URL
rem ===============================================================

set "WEB_APP_URL=https://script.google.com/macros/s/!DEPLOYMENT_ID!/exec"

echo.
echo !cGreen!=======================================================!cReset!
echo !cGreen!   SUCCESS! CASH LOGGER UPDATED! !cReset!
echo !cGreen!=======================================================!cReset!
echo.
echo !cGreen!Web App URL:!cReset!
echo !WEB_APP_URL!
echo.
echo !cGreen!Deployment ID:!cReset!
echo !DEPLOYMENT_ID!
echo.
echo !cGreen!Your existing Web App link remains unchanged.!cReset!
echo.

echo !cYellow![INFO]!cReset! Opening Cash Logger...

start "" "!WEB_APP_URL!"

echo.
pause
exit /b 0