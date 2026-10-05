@echo off
setlocal

rem ===================================================================
rem  STAGE 1: CLEANUP HANDOFF
rem  If launched by an older version of this script, delete the old one
rem ===================================================================
if "%~1"=="--cleanup" (
    rem Wait 1 second to ensure the old script has completely closed its process
    timeout /t 1 /nobreak >nul
    del "old_pull.bat" 2>nul
    goto :RunMainTask
)

rem ===================================================================
rem  STAGE 2: RENAME AND UPDATE
rem ===================================================================
echo [INFO] Preparing for self-update...
rem Rename the currently running script so Git can safely write the new one
ren "%~nx0" "old_pull.bat"

echo [INFO] Downloading latest updates from GitHub...
git fetch origin main
git reset --hard origin/main

if errorlevel 1 (
    echo [ERROR] Update failed. Reverting to old script...
    ren "old_pull.bat" "%~nx0"
    pause
    exit /b 1
)

rem Launch the newly downloaded script and pass the cleanup flag, then exit
echo [INFO] Handoff to updated script...
start "" "%~dp0Pull Cash Logger Berliandro.bat" --cleanup
exit

rem ===================================================================
rem  STAGE 3: THE MAIN TASKS (This runs after the update is finished)
rem ===================================================================
:RunMainTask

echo [SUCCESS] Script updated successfully!
echo [INFO] Pushing the latest code to your Google Sheet...
call clasp push -f

echo.
echo =======================================================
echo    SUCCESS! Cash Logger is fully updated and deployed!
echo =======================================================
pause