@echo off
setlocal DisableDelayedExpansion

rem ===============================================================
rem  BERLIANDRO CASH LOGGER - UPDATE
rem ===============================================================

rem ===============================================================
rem  ROUTING
rem ===============================================================

if "%~1"=="--temp-updater" goto TempUpdater
if "%~1"=="--run-main" goto MainTask

rem ===============================================================
rem  STAGE 1
rem  COPY THIS SCRIPT TO TEMP SO GIT CAN UPDATE Update.bat
rem ===============================================================

echo.
echo =======================================================
echo    BERLIANDRO CASH LOGGER - UPDATE
echo =======================================================
echo.

echo [INFO] Preparing updater...

set "TEMP_SCRIPT=%TEMP%\cash_logger_updater_%RANDOM%_%RANDOM%.bat"

copy /b /y "%~f0" "%TEMP_SCRIPT%"

if errorlevel 1 goto PrepareUpdaterFailed

echo [SUCCESS] Temporary updater prepared.
echo.

rem Run the temporary updater.
rem The original Update.bat can now be replaced by Git.
"%TEMP_SCRIPT%" --temp-updater "%~dp0"

set "TEMP_EXIT_CODE=%ERRORLEVEL%"

rem Clean up temporary updater.
del /f /q "%TEMP_SCRIPT%" >nul 2>nul

exit /b %TEMP_EXIT_CODE%


:PrepareUpdaterFailed

echo.
echo =======================================================
echo    ERROR - COULD NOT PREPARE UPDATER
echo =======================================================
echo.
echo [ERROR] Windows could not copy the updater to TEMP.
echo.
echo Source:
echo "%~f0"
echo.
echo Destination:
echo "%TEMP_SCRIPT%"
echo.
echo The project has NOT been modified.
echo.
pause
exit /b 1


rem ===============================================================
rem  STAGE 2
rem  TEMP UPDATER
rem ===============================================================

:TempUpdater

set "PROJECT_DIR=%~2"

if "%PROJECT_DIR%"=="" (
    echo.
    echo [ERROR] Project directory was not provided.
    pause
    exit /b 1
)

rem Normalize project directory.
for %%I in ("%PROJECT_DIR%") do set "PROJECT_DIR=%%~fI"

setlocal EnableDelayedExpansion

if not exist "!PROJECT_DIR!\." (
    echo.
    echo =======================================================
    echo    ERROR - PROJECT DIRECTORY NOT FOUND
    echo =======================================================
    echo.
    echo [ERROR] The project directory does not exist:
    echo.
    echo !PROJECT_DIR!
    echo.
    echo The updater has not changed anything.
    echo.
    pause
    exit /b 1
)

cd /d "!PROJECT_DIR!"

if errorlevel 1 (
    echo.
    echo [ERROR] Could not access the project directory:
    echo !PROJECT_DIR!
    pause
    exit /b 1
)

echo.
echo =======================================================
echo    1/3. UPDATING PROJECT
echo =======================================================
echo.

rem ===============================================================
rem  CHECK GIT
rem ===============================================================

where git >nul 2>nul

if errorlevel 1 (
    echo [ERROR] Git is not installed.
    echo Please run the installer first.
    pause
    exit /b 1
)

rem ===============================================================
rem  CHECK CLASP
rem ===============================================================

where clasp >nul 2>nul

if errorlevel 1 (
    echo [ERROR] Google clasp is not installed.
    echo Please run the installer first.
    pause
    exit /b 1
)

rem ===============================================================
rem  CHECK GIT REPOSITORY
rem ===============================================================

if not exist ".git\." (
    echo [ERROR] This folder is not a Git project.
    echo Please run the installer first.
    pause
    exit /b 1
)

rem ===============================================================
rem  CHECK CLASP CONFIG
rem ===============================================================

if not exist ".clasp.json" (
    echo [ERROR] .clasp.json was not found.
    echo Please run the installer first.
    pause
    exit /b 1
)

rem ===============================================================
rem  CHECK DEPLOYMENT ID
rem ===============================================================

set "DEPLOYMENT_FILE=.cashlogger-deployment-id"

if not exist "!DEPLOYMENT_FILE!" (
    echo [ERROR] Web App deployment ID was not found.
    echo.
    echo Expected:
    echo !PROJECT_DIR!\!DEPLOYMENT_FILE!
    echo.
    echo Please run the installer first.
    pause
    exit /b 1
)

set "DEPLOYMENT_ID="
set /p DEPLOYMENT_ID=<"!DEPLOYMENT_FILE!"

if "!DEPLOYMENT_ID!"=="" (
    echo [ERROR] The deployment ID file is empty.
    echo Please run the installer again.
    pause
    exit /b 1
)

echo [INFO] Deployment ID found:
echo !DEPLOYMENT_ID!
echo.

rem ===============================================================
rem  FETCH LATEST VERSION
rem ===============================================================

echo [INFO] Contacting GitHub...

git fetch origin main

if errorlevel 1 (
    echo.
    echo [ERROR] Could not contact GitHub.
    echo Check your internet connection and try again.
    pause
    exit /b 1
)

echo.
echo [INFO] Synchronizing local project with GitHub...

rem ---------------------------------------------------------------
rem IMPORTANT:
rem
rem Family installations are treated as deployment clients.
rem They are not expected to contain local source-code changes.
rem
rem reset --hard updates tracked files to exactly match GitHub.
rem Ignored local files such as:
rem   .clasp.json
rem   .cashlogger-deployment-id
rem remain untouched.
rem
rem The updater itself runs from TEMP, so Update.bat can safely
rem be replaced by this command.
rem ---------------------------------------------------------------

git reset --hard origin/main

if errorlevel 1 (
    echo.
    echo [ERROR] Could not synchronize the project with GitHub.
    echo.
    echo No deployment was performed.
    echo.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Project synchronized with the latest GitHub version.
echo.

rem ===============================================================
rem  VERIFY UPDATE.BAT
rem ===============================================================

if not exist "!PROJECT_DIR!\Update.bat" (
    echo.
    echo [ERROR] Update.bat was not found after the update.
    echo.
    echo The GitHub repository may be incomplete.
    echo.
    pause
    exit /b 1
)

echo [SUCCESS] Latest updater downloaded.
echo.

rem ===============================================================
rem  RUN NEWLY DOWNLOADED UPDATE.BAT
rem ===============================================================

call "!PROJECT_DIR!\Update.bat" --run-main

set "MAIN_EXIT_CODE=!ERRORLEVEL!"

exit /b !MAIN_EXIT_CODE!


rem ===============================================================
rem  STAGE 3
rem  MAIN TASKS
rem ===============================================================

:MainTask

rem Capture our own directory before enabling delayed expansion, so a
rem "!" in the path (e.g. D:\! Coding\...) cannot corrupt expansion.
set "SELF_DIR=%~dp0"

setlocal EnableDelayedExpansion

cd /d "!SELF_DIR!"

if errorlevel 1 (
    echo.
    echo [ERROR] Could not access the project directory.
    pause
    exit /b 1
)

echo.
echo =======================================================
echo    2/3. UPLOADING LATEST PROJECT
echo =======================================================
echo.

rem ===============================================================
rem  CHECK DEPLOYMENT ID
rem ===============================================================

set "DEPLOYMENT_FILE=.cashlogger-deployment-id"

if not exist "!DEPLOYMENT_FILE!" (
    echo [ERROR] Deployment ID file was not found.
    echo.
    echo Expected:
    echo !DEPLOYMENT_FILE!
    echo.
    echo Please run the installer again.
    pause
    exit /b 1
)

set "DEPLOYMENT_ID="
set /p DEPLOYMENT_ID=<"!DEPLOYMENT_FILE!"

if "!DEPLOYMENT_ID!"=="" (
    echo [ERROR] Deployment ID is empty.
    pause
    exit /b 1
)

echo [INFO] Pushing latest code to Google Apps Script...
echo.

call clasp push -f

if errorlevel 1 (
    echo.
    echo =======================================================
    echo    ERROR - APPS SCRIPT UPLOAD FAILED
    echo =======================================================
    echo.
    echo [ERROR] The Apps Script project could not be uploaded.
    echo.
    echo The live Web App was NOT updated.
    echo.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Project uploaded successfully.
echo.

rem ===============================================================
rem  UPDATE EXISTING WEB APP DEPLOYMENT
rem ===============================================================

echo.
echo =======================================================
echo    3/3. UPDATING WEB APP
echo =======================================================
echo.

echo [INFO] Updating existing Web App deployment...
echo Deployment ID:
echo !DEPLOYMENT_ID!
echo.

call clasp update-deployment "!DEPLOYMENT_ID!" -d "Cash Logger Update"

if errorlevel 1 (
    echo.
    echo =======================================================
    echo    ERROR - WEB APP UPDATE FAILED
    echo =======================================================
    echo.
    echo [ERROR] The Web App deployment could not be updated.
    echo.
    echo The project was uploaded successfully,
    echo but the live Web App may still be running
    echo the previous version.
    echo.
    pause
    exit /b 1
)

rem ===============================================================
rem  BUILD WEB APP URL
rem ===============================================================

set "WEB_APP_URL=https://script.google.com/macros/s/!DEPLOYMENT_ID!/exec"

echo.
echo =======================================================
echo    SUCCESS! CASH LOGGER UPDATED!
echo =======================================================
echo.
echo Web App URL:
echo !WEB_APP_URL!
echo.
echo Deployment ID:
echo !DEPLOYMENT_ID!
echo.
echo Your existing Web App link remains unchanged.
echo.
echo [INFO] Opening Cash Logger...
echo.

start "" "!WEB_APP_URL!"

echo.
pause
exit /b 0