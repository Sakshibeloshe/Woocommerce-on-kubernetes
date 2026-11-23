@echo off
rem One click: rebuild the dashboard for ARM, push to GHCR, optionally turn on chat (Groq key),
rem and roll everything out on the Oracle VM. Needs Docker Desktop running. Log: oracle-update.log
cd /d "%~dp0"
set TAG=0.2.2
set IMG=ghcr.io/sakshibeloshe/mcp-dashboard:%TAG%
set GWTAG=0.3.3
set GWIMG=ghcr.io/sakshibeloshe/mcp-gateway:%GWTAG%
set PVTAG=0.1.0
set PVIMG=ghcr.io/sakshibeloshe/store-provisioner:%PVTAG%
set KEY=%USERPROFILE%\.ssh\oracle.key
set VM=ubuntu@129.154.239.224
set OPTS=-i "%KEY%" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30
echo.
echo Paste a Groq API key to set or change the chat key, or press Enter to keep the current one:
set GROQ=
set /p GROQ=Groq key: 
cls
echo Updating the VM. Do not close this window (5-10 min). Log: %~dp0oracle-update.log
echo === START %DATE% %TIME% === > oracle-update.log
docker info >nul 2>&1
if errorlevel 1 (echo Docker Desktop is not running. Start it, wait for "Engine running", then run this again. & echo === DOCKER NOT RUNNING === >> oracle-update.log & pause & exit /b 1)
echo [1/3] Building dashboard %TAG%, gateway %GWTAG% and store-provisioner %PVTAG% for ARM and pushing...
echo --- build + push %IMG% >> oracle-update.log
docker buildx build --platform linux/arm64 -t %IMG% ..\dashboard --push >> oracle-update.log 2>&1
if errorlevel 1 (echo Build or push failed. If it says unauthorized, run: docker login ghcr.io & echo === BUILD FAILED === >> oracle-update.log & pause & exit /b 1)
echo --- build + push %GWIMG% >> oracle-update.log
docker buildx build --platform linux/arm64 -t %GWIMG% ..\gateway --push >> oracle-update.log 2>&1
if errorlevel 1 (echo Build or push failed. If it says unauthorized, run: docker login ghcr.io & echo === BUILD FAILED === >> oracle-update.log & pause & exit /b 1)
echo --- build + push %PVIMG% >> oracle-update.log
docker buildx build --platform linux/arm64 -f ..\store-provisioner\Dockerfile -t %PVIMG% .. --push >> oracle-update.log 2>&1
if errorlevel 1 (echo Build or push failed. If it says unauthorized, run: docker login ghcr.io & echo === BUILD FAILED === >> oracle-update.log & pause & exit /b 1)
echo [2/3] Uploading to VM...
if defined GROQ (
  >"%TEMP%\llm-key.txt" echo %GROQ%
  scp %OPTS% "%TEMP%\llm-key.txt" %VM%:llm-key.txt >> oracle-update.log 2>&1
  del "%TEMP%\llm-key.txt"
  set GROQ=
)
tar -czf "%TEMP%\charts.tgz" -C .. charts
scp %OPTS% "%TEMP%\charts.tgz" %VM%:charts.tgz >> oracle-update.log 2>&1
del "%TEMP%\charts.tgz"
scp %OPTS% oracle-remote-setup.sh %VM%:oracle-remote-setup.sh >> oracle-update.log 2>&1
echo [3/3] Helm upgrade on VM...
ssh %OPTS% %VM% "chmod 600 ~/llm-key.txt 2>/dev/null; DASHBOARD_TAG=%TAG% GATEWAY_TAG=%GWTAG% PROVISIONER_TAG=%PVTAG% bash ~/oracle-remote-setup.sh" >> oracle-update.log 2>&1
echo === EXIT %ERRORLEVEL% === >> oracle-update.log
echo Finished. Open http://dashboard.129.154.239.224.nip.io (Ctrl+F5 to refresh). You can close this window.
pause
