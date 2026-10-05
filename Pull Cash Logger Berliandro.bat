@echo off
setlocal

rem ===================================================================
rem  ROUTING LOGIC (Determines which stage is currently running)
rem ===================================================================
if "%~1"=="--temp-updater" goto :TempUpdater
if "%~1"=="--run-main" goto :MainTask

rem ===================================================================
rem  STAGE 1: HANDOFF TO TEMP SCRIPT
rem ===================================================================
echo [INFO] Preparing for self-update...
set "TEMP_SCRIPT=%TEMP%\cash_logger_updater.bat"

rem Copy this currently running file to the Windows Temp folder
copy /y "%~f0" "%TEMP_SCRIPT%" >nul

rem Transfer execution to the Temp script (without using 'call').
rem This permanently closes THIS file, releasing the Windows file lock,
rem allowing Git to safely overwrite it without crashing.
"%TEMP_SCRIPT%" --temp-updater "%~dp0"
exit /b

rem ===================================================================
rem  STAGE 2: THE TEMP UPDATER (Runs safely from %TEMP%)
rem ===================================================================
:TempUpdater
set "PROJECT_DIR=%~2"
cd /d "%PROJECT_DIR%"

echo [INFO] Downloading latest updates from GitHub...
git fetch origin main
git reset --hard origin/main

if errorlevel 1 (
    echo [ERROR] Update failed. Check your internet connection.
    pause
    exit /b 1
)

echo [SUCCESS] Script updated successfully!

rem Transfer execution back to the newly downloaded main script!
"%PROJECT_DIR%Pull Cash Logger Berliandro.bat" --run-main
exit /b

rem ===================================================================
rem  STAGE 3: THE MAIN TASKS (Runs from the freshly updated file)
rem ===================================================================
:MainTask
cd /d "%~dp0"

echo [INFO] Pushing the latest code to your Google Sheet...
call clasp push -f

echo.
echo =======================================================
echo    SUCCESS! Cash Logger is fully updated and deployed!
echo =======================================================
pause