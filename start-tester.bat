@echo off
setlocal

set "ROOT=%~dp0"
set "PORT=%PORT%"
if "%PORT%"=="" set "PORT=3000"
set "SERVER_URL=http://localhost:%PORT%"

cd /d "%ROOT%"

echo Starting Undercover server on %SERVER_URL%
start "Undercover server" cmd /k "pushd "%ROOT%" && set "PORT=%PORT%" && npm start"

echo Opening tester...
timeout /t 2 /nobreak >nul
start "" "%SERVER_URL%/test-console.html?server=%SERVER_URL%"

echo.
echo Host page:   %SERVER_URL%
echo Tester page: %SERVER_URL%/test-console.html?server=%SERVER_URL%
echo.
echo Close the "Undercover server" window to stop the server.

endlocal
